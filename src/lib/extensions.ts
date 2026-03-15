import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  Database,
  ExtensionContext,
  ExtensionManifest,
  FeedSource,
  MindSection,
  SystemSection,
} from "@volute/extensions";
import extNotes from "@volute/notes";
import extPages from "@volute/pages";
import type { Hono, MiddlewareHandler } from "hono";
import { getUser, getUserByUsername } from "./auth.js";
import {
  getActiveTurnId,
  getAnyActiveTurnForMind,
  getLastToolUseEventId,
} from "./daemon/turn-tracker.js";
import { publish } from "./events/activity-events.js";
import log from "./logger.js";
import { mindDir, voluteHome, voluteSystemDir } from "./registry.js";
import { hashSkillDir, importSkillFromDir, sharedSkillsDir } from "./skills.js";
import { readSystemsConfig } from "./systems-config.js";

const VALID_EXTENSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

type LoadedExtension = {
  manifest: ExtensionManifest;
  context: ExtensionContext;
};

const loaded: LoadedExtension[] = [];

export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  systemSection?: SystemSection;
  mindSections?: MindSection[];
  feedSource?: FeedSource;
};

function extensionsBaseDir(): string {
  return resolve(voluteHome(), "extensions");
}

function extensionDataDir(id: string): string {
  return resolve(voluteSystemDir(), "extension-data", id);
}

function extensionsConfigPath(): string {
  return resolve(voluteHome(), "system", "extensions.json");
}

function readExtensionsConfig(): string[] {
  const configPath = extensionsConfigPath();
  if (!existsSync(configPath)) return [];
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    log.warn("failed to read extensions config, ignoring installed extensions", {
      path: configPath,
      error: (err as Error).message,
    });
    return [];
  }
}

let _LibsqlDatabase: (new (path: string) => Database) | null = null;

async function getLibsqlDatabase(): Promise<new (path: string) => Database> {
  if (_LibsqlDatabase) return _LibsqlDatabase;
  const mod = await import("libsql");
  _LibsqlDatabase = (mod.default ?? mod) as new (path: string) => Database;
  return _LibsqlDatabase;
}

async function openExtensionDb(_id: string, dataDir: string): Promise<Database> {
  const dbPath = resolve(dataDir, "data.db");
  const Database = await getLibsqlDatabase();
  return new Database(dbPath);
}

async function buildContext(
  manifest: ExtensionManifest,
  dataDir: string,
  authMw: MiddlewareHandler,
): Promise<ExtensionContext> {
  // Only open DB if the extension declares initDb (otherwise it doesn't need one)
  let db: ExtensionContext["db"] = null;
  if (manifest.initDb) {
    const realDb = await openExtensionDb(manifest.id, dataDir);
    try {
      manifest.initDb(realDb);
    } catch (err) {
      realDb.close();
      throw new Error(`initDb failed for extension ${manifest.id}: ${(err as Error).message}`);
    }

    db = realDb;
  }

  return {
    db,
    authMiddleware: authMw,
    resolveUser: (c) => {
      const user = c.get("user");
      if (!user || typeof user !== "object") return null;
      return user as ReturnType<ExtensionContext["resolveUser"]>;
    },
    getUser: async (id: number) => getUser(id),
    getUserByUsername: async (username: string) => getUserByUsername(username),
    publishActivity: (event, c) => {
      // Use session from Hono context for precise turn lookup.
      // Fall back to scanning all sessions when no session header (e.g. sandbox strips env vars).
      const session = c?.get("mindSession") as string | undefined;
      let turnId = getActiveTurnId(event.mind, session);
      let sourceEventId = getLastToolUseEventId(event.mind, session);
      if (!turnId) {
        // Scan fallback for sandbox environments where VOLUTE_SESSION isn't propagated
        const found = getAnyActiveTurnForMind(event.mind);
        if (found) {
          turnId = found.turnId;
          sourceEventId = found.lastToolUseEventId;
        }
      }
      publish({
        ...(event as Parameters<typeof publish>[0]),
        turn_id: turnId,
        source_event_id: sourceEventId,
      }).catch((err) =>
        log.error(`extension ${manifest.id}: failed to publish activity`, log.errorData(err)),
      );
    },
    getMindDir: (name: string) => {
      try {
        const dir = mindDir(name);
        return existsSync(dir) ? dir : null;
      } catch (err) {
        log.warn(
          `extension ${manifest.id}: failed to resolve mind dir for ${name}`,
          log.errorData(err),
        );
        return null;
      }
    },
    getSystemsConfig: () => readSystemsConfig(),
    dataDir,
  };
}

async function loadExtension(
  manifest: ExtensionManifest,
  app: Hono,
  authMw: MiddlewareHandler,
): Promise<void> {
  if (!VALID_EXTENSION_ID.test(manifest.id)) {
    log.error(`invalid extension ID "${manifest.id}", skipping (must match ${VALID_EXTENSION_ID})`);
    return;
  }
  const dataDir = extensionDataDir(manifest.id);
  mkdirSync(dataDir, { recursive: true });

  const context = await buildContext(manifest, dataDir, authMw);

  // Mount authenticated API routes
  const routesApp = manifest.routes(context);
  const extApiPath = `/api/ext/${manifest.id}`;
  app.use(extApiPath, authMw);
  app.use(`${extApiPath}/*`, authMw);
  app.route(extApiPath, routesApp);

  // Mount public routes (no auth) — registered before static assets so Hono matches these first
  if (manifest.publicRoutes) {
    const publicApp = manifest.publicRoutes(context);
    app.route(`/ext/${manifest.id}/public`, publicApp);
  }

  // Serve static UI assets with SPA fallback for client-side routing
  // Resolve assetsDir: try direct path first, then search from project root
  // (import.meta.dirname changes after tsup bundling)
  let resolvedAssetsDir = manifest.ui?.assetsDir ?? "";
  if (resolvedAssetsDir && !existsSync(resolvedAssetsDir)) {
    let searchDir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = resolve(searchDir, "packages", "extensions", manifest.id, "dist", "ui");
      if (existsSync(candidate)) {
        resolvedAssetsDir = candidate;
        break;
      }
      searchDir = dirname(searchDir);
    }
  }
  if (resolvedAssetsDir && existsSync(resolvedAssetsDir)) {
    const assetsDir = resolvedAssetsDir;
    const { readFile, stat: fsStat } = await import("node:fs/promises");
    const { extname: ext } = await import("node:path");
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    const prefix = `/ext/${manifest.id}`;
    const indexPath = resolve(assetsDir, "index.html");
    const serveExtAssets = async (c: any) => {
      const urlPath = new URL(c.req.url).pathname;
      const relativePath = urlPath.slice(prefix.length).replace(/^\//, "") || "index.html";
      const filePath = resolve(assetsDir, relativePath);
      // Boundary-aware check: assetsDir must be followed by "/" to prevent
      // prefix confusion (e.g. /path/assets-evil matching /path/assets)
      if (filePath !== assetsDir && !filePath.startsWith(assetsDir + "/"))
        return c.text("Forbidden", 403);
      const s = await fsStat(filePath).catch(() => null);
      if (s?.isFile()) {
        const mime = mimeTypes[ext(filePath)] || "application/octet-stream";
        const body = await readFile(filePath);
        return c.body(body, 200, { "Content-Type": mime });
      }
      // SPA fallback: serve extension's index.html
      if (existsSync(indexPath)) {
        const body = await readFile(indexPath, "utf-8");
        return c.html(body);
      }
      return c.text("Not found", 404);
    };
    app.get(`${prefix}/*`, serveExtAssets);
    app.get(prefix, serveExtAssets);
  }

  // Sync skills if declared (only when content has changed, like syncBuiltinSkills)
  const skillsDir = resolveSkillsDir(manifest);
  if (skillsDir) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch (err) {
      log.error(`failed to read skills dir for extension ${manifest.id}`, log.errorData(err));
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillPath = resolve(skillsDir, entry.name);
        const sourceHash = hashSkillDir(skillPath);
        const destDir = resolve(sharedSkillsDir(), entry.name);
        if (existsSync(destDir)) {
          const destHash = hashSkillDir(destDir);
          if (sourceHash === destHash) continue;
        }
        await importSkillFromDir(skillPath, `ext:${manifest.id}`);
        log.info(`synced skill "${entry.name}" for extension: ${manifest.id}`);
      } catch (err) {
        log.error(
          `failed to sync skill "${entry.name}" for extension ${manifest.id}`,
          log.errorData(err),
        );
      }
    }
  }

  if (manifest.standardSkill && !manifest.skillsDir) {
    log.warn(`extension ${manifest.id}: standardSkill is true but no skillsDir declared`);
  }

  loaded.push({ manifest, context });
  log.info(`loaded extension: ${manifest.id} v${manifest.version}`);
}

/**
 * Resolve the skills directory for an extension.
 * The manifest's skillsDir may be wrong when bundled by tsup (import.meta.dirname
 * resolves to the dist/ directory). Fall back to searching from the project root.
 */
function resolveSkillsDir(manifest: ExtensionManifest): string | null {
  if (!manifest.skillsDir) return null;
  // Search from daemon entry point for extension-specific skills directory first.
  // This is needed because tsup bundling makes import.meta.dirname resolve to dist/,
  // so relative paths like "../skills" can accidentally hit the repo root skills/ dir.
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "packages", "extensions", manifest.id, "skills");
    if (existsSync(candidate)) return candidate;
    searchDir = dirname(searchDir);
  }
  // Fall back to the declared path (works in dev mode where import.meta.dirname is correct)
  if (existsSync(manifest.skillsDir)) return manifest.skillsDir;
  log.warn(`skills dir not found for extension ${manifest.id}: ${manifest.skillsDir}`);
  return null;
}

function discoverBuiltinExtensions(): ExtensionManifest[] {
  // Built-in extensions imported statically so tsup bundles them
  return [extNotes, extPages];
}

async function discoverInstalledExtensions(): Promise<ExtensionManifest[]> {
  const manifests: ExtensionManifest[] = [];
  const packages = readExtensionsConfig();
  // Extensions are installed under ~/.volute/extensions/_npm/node_modules/
  const npmDir = resolve(voluteHome(), "extensions", "_npm");

  // Use createRequire to resolve package entry points from the extensions dir
  const { createRequire } = await import("node:module");

  for (const pkg of packages) {
    try {
      let resolved: string = pkg;
      const npmPkgDir = resolve(npmDir, "node_modules", pkg);
      if (existsSync(npmPkgDir)) {
        // Resolve the package's actual entry point from the extensions dir
        const require = createRequire(resolve(npmDir, "noop.js"));
        resolved = require.resolve(pkg);
      }
      const mod = await import(resolved);
      const manifest = mod.default ?? mod.extension ?? mod;
      if (!validateManifest(manifest, `package ${pkg}`)) continue;
      manifests.push(manifest);
    } catch (err) {
      log.error(`failed to load extension package: ${pkg}`, log.errorData(err));
    }
  }

  return manifests;
}

function validateManifest(manifest: unknown, source: string): manifest is ExtensionManifest {
  if (!manifest || typeof manifest !== "object") {
    log.warn(`extension from ${source} does not export a valid manifest`);
    return false;
  }
  const m = manifest as Record<string, unknown>;
  if (!m.id || typeof m.id !== "string") {
    log.warn(`extension from ${source} is missing a valid id`);
    return false;
  }
  if (!VALID_EXTENSION_ID.test(m.id)) {
    log.warn(`extension from ${source} has invalid id "${m.id}"`);
    return false;
  }
  if (typeof m.routes !== "function") {
    log.warn(`extension from ${source} is missing a routes function`);
    return false;
  }
  if (!m.name || typeof m.name !== "string") {
    log.warn(`extension "${m.id}" from ${source} is missing a name`);
    return false;
  }
  if (!m.version || typeof m.version !== "string") {
    log.warn(`extension "${m.id}" from ${source} is missing a version`);
    return false;
  }
  return true;
}

async function discoverLocalExtensions(): Promise<ExtensionManifest[]> {
  const baseDir = extensionsBaseDir();
  if (!existsSync(baseDir)) return [];

  const manifests: ExtensionManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_npm")
      .map((d) => d.name);
  } catch (err) {
    log.error("failed to read local extensions directory", log.errorData(err));
    return [];
  }

  for (const dir of entries) {
    const extDir = resolve(baseDir, dir);
    // Look for a .js entry point (local extensions must be pre-built)
    const candidates = [resolve(extDir, "src", "index.js"), resolve(extDir, "index.js")];
    const entryPoint = candidates.find((p) => existsSync(p));
    if (!entryPoint) continue;

    try {
      const mod = await import(entryPoint);
      const manifest = mod.default ?? mod.extension ?? mod;
      if (!validateManifest(manifest, `local dir ${extDir}`)) continue;
      manifests.push(manifest);
      log.info(`discovered local extension: ${manifest.id} from ${extDir}`);
    } catch (err) {
      log.error(`failed to load local extension from ${extDir}`, log.errorData(err));
    }
  }

  return manifests;
}

export async function loadAllExtensions(app: Hono, authMw: MiddlewareHandler): Promise<void> {
  const builtins = discoverBuiltinExtensions();
  const installed = await discoverInstalledExtensions();
  const local = await discoverLocalExtensions();
  const all = [...builtins, ...installed, ...local];

  // Deduplicate by ID
  const seen = new Set<string>();
  for (const manifest of all) {
    if (seen.has(manifest.id)) {
      log.warn(`duplicate extension ID: ${manifest.id}, skipping`);
      continue;
    }
    seen.add(manifest.id);
    try {
      await loadExtension(manifest, app, authMw);
    } catch (err) {
      log.error(`failed to load extension: ${manifest.id}`, log.errorData(err));
    }
  }
}

export function getLoadedExtensions(): ExtensionInfo[] {
  return loaded.map(({ manifest }) => ({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    systemSection: manifest.ui?.systemSection,
    mindSections: manifest.ui?.mindSections,
    feedSource: manifest.ui?.feedSource,
  }));
}

export function getExtensionStandardSkills(): string[] {
  const skills: string[] = [];
  for (const { manifest } of loaded) {
    if (!manifest.standardSkill) continue;
    const dir = resolveSkillsDir(manifest);
    if (!dir) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) skills.push(entry.name);
      }
    } catch (err) {
      log.warn(`failed to read skills dir for extension ${manifest.id}`, log.errorData(err));
    }
  }
  return skills;
}

export function notifyExtensionsDaemonStart(): void {
  for (const { manifest } of loaded) {
    try {
      manifest.onDaemonStart?.();
    } catch (err) {
      log.error(`extension ${manifest.id}: onDaemonStart failed`, log.errorData(err));
    }
  }
}

export function notifyExtensionsDaemonStop(): void {
  for (const { manifest, context } of loaded) {
    try {
      manifest.onDaemonStop?.();
    } catch (err) {
      log.error(`extension ${manifest.id}: onDaemonStop failed`, log.errorData(err));
    }
    try {
      context.db?.close();
    } catch (err) {
      log.warn(`extension ${manifest.id}: failed to close db`, log.errorData(err));
    }
  }
  loaded.length = 0;
}

export function notifyExtensionsMindStart(mindName: string): void {
  for (const { manifest } of loaded) {
    try {
      manifest.onMindStart?.(mindName);
    } catch (err) {
      log.error(`extension ${manifest.id}: onMindStart failed for ${mindName}`, log.errorData(err));
    }
  }
}

export function notifyExtensionsMindStop(mindName: string): void {
  for (const { manifest } of loaded) {
    try {
      manifest.onMindStop?.(mindName);
    } catch (err) {
      log.error(`extension ${manifest.id}: onMindStop failed for ${mindName}`, log.errorData(err));
    }
  }
}
