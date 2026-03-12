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
import { publish } from "./events/activity-events.js";
import log from "./logger.js";
import { mindDir, voluteHome, voluteSystemDir } from "./registry.js";
import { hashSkillDir, importSkillFromDir, sharedSkillsDir } from "./skills.js";
import { readSystemsConfig } from "./systems-config.js";

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
  systemSections?: SystemSection[];
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

/** Migrate notes data from core volute.db to the extension's own DB (one-time). */
async function migrateNotesFromCoreDb(extDb: Database): Promise<void> {
  const coreDbPath = process.env.VOLUTE_DB_PATH || resolve(voluteSystemDir(), "volute.db");
  if (!existsSync(coreDbPath)) return;

  // Check if extension DB already has notes (migration already ran)
  const existing = extDb.prepare("SELECT COUNT(*) as c FROM notes").get() as { c: number };
  if (existing.c > 0) return;

  const Database = await getLibsqlDatabase();
  const coreDb = new Database(coreDbPath);

  try {
    // Check if core DB has notes table
    const tableExists = coreDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'")
      .get();
    if (!tableExists) return;

    const coreNotes = coreDb
      .prepare(
        "SELECT id, author_id, title, slug, content, reply_to_id, created_at, updated_at FROM notes ORDER BY id",
      )
      .all() as {
      id: number;
      author_id: number;
      title: string;
      slug: string;
      content: string;
      reply_to_id: number | null;
      created_at: string;
      updated_at: string;
    }[];

    if (coreNotes.length === 0) return;

    log.info(`migrating ${coreNotes.length} notes from core DB to extension DB`);

    // Migrate comments
    const coreComments = coreDb
      .prepare("SELECT id, note_id, author_id, content, created_at FROM note_comments ORDER BY id")
      .all() as {
      id: number;
      note_id: number;
      author_id: number;
      content: string;
      created_at: string;
    }[];

    // Migrate reactions
    const coreReactions = coreDb
      .prepare("SELECT id, note_id, user_id, emoji, created_at FROM note_reactions ORDER BY id")
      .all() as {
      id: number;
      note_id: number;
      user_id: number;
      emoji: string;
      created_at: string;
    }[];

    // Wrap all inserts in a transaction for atomicity
    extDb.exec("BEGIN TRANSACTION");
    try {
      for (const note of coreNotes) {
        extDb
          .prepare(
            "INSERT OR IGNORE INTO notes (id, author_id, title, slug, content, reply_to_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            note.id,
            note.author_id,
            note.title,
            note.slug,
            note.content,
            note.reply_to_id,
            note.created_at,
            note.updated_at,
          );
      }

      for (const comment of coreComments) {
        extDb
          .prepare(
            "INSERT OR IGNORE INTO note_comments (id, note_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(comment.id, comment.note_id, comment.author_id, comment.content, comment.created_at);
      }

      for (const reaction of coreReactions) {
        extDb
          .prepare(
            "INSERT OR IGNORE INTO note_reactions (id, note_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            reaction.id,
            reaction.note_id,
            reaction.user_id,
            reaction.emoji,
            reaction.created_at,
          );
      }

      extDb.exec("COMMIT");
    } catch (txErr) {
      extDb.exec("ROLLBACK");
      throw txErr;
    }

    log.info(
      `migrated ${coreNotes.length} notes, ${coreComments.length} comments, ${coreReactions.length} reactions`,
    );
  } catch (err) {
    log.error("failed to migrate notes from core DB", log.errorData(err));
  } finally {
    coreDb.close();
  }
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

    // One-time migration for built-in extensions extracted from core
    if (manifest.id === "notes") {
      await migrateNotesFromCoreDb(realDb);
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
    publishActivity: (event) => {
      publish(event as Parameters<typeof publish>[0]).catch((err) =>
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
  const dataDir = extensionDataDir(manifest.id);
  mkdirSync(dataDir, { recursive: true });

  const context = await buildContext(manifest, dataDir, authMw);

  // Mount authenticated API routes
  const routesApp = manifest.routes(context);
  app.use(`/api/ext/${manifest.id}/*`, authMw);
  app.route(`/api/ext/${manifest.id}`, routesApp);

  // Mount public routes (no auth)
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
      if (!filePath.startsWith(assetsDir)) return c.text("Forbidden", 403);
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
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = resolve(skillsDir, entry.name);
        const sourceHash = hashSkillDir(skillPath);
        const destDir = resolve(sharedSkillsDir(), entry.name);
        if (existsSync(destDir)) {
          const destHash = hashSkillDir(destDir);
          if (sourceHash === destHash) continue;
        }
        await importSkillFromDir(skillPath, `ext:${manifest.id}`);
        log.info(`synced skill "${entry.name}" for extension: ${manifest.id}`);
      }
    } catch (err) {
      log.error(`failed to sync skills for extension ${manifest.id}`, log.errorData(err));
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

  for (const pkg of packages) {
    try {
      const mod = await import(pkg);
      const manifest = mod.default ?? mod.extension ?? mod;
      if (manifest?.id && typeof manifest?.routes === "function") {
        manifests.push(manifest);
      } else {
        log.warn(`extension package ${pkg} does not export a valid manifest`);
      }
    } catch (err) {
      log.error(`failed to load extension package: ${pkg}`, log.errorData(err));
    }
  }

  return manifests;
}

async function discoverLocalExtensions(): Promise<ExtensionManifest[]> {
  const baseDir = extensionsBaseDir();
  if (!existsSync(baseDir)) return [];

  const manifests: ExtensionManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    log.error("failed to read local extensions directory", log.errorData(err));
    return [];
  }

  for (const dir of entries) {
    const extDir = resolve(baseDir, dir);
    // Look for an entry point: index.ts, index.js, src/index.ts, src/index.js
    const candidates = [
      resolve(extDir, "src", "index.ts"),
      resolve(extDir, "src", "index.js"),
      resolve(extDir, "index.ts"),
      resolve(extDir, "index.js"),
    ];
    const entryPoint = candidates.find((p) => existsSync(p));
    if (!entryPoint) continue;

    try {
      const mod = await import(entryPoint);
      const manifest = mod.default ?? mod.extension ?? mod;
      if (manifest?.id && typeof manifest?.routes === "function") {
        manifests.push(manifest);
        log.info(`discovered local extension: ${manifest.id} from ${extDir}`);
      } else {
        log.warn(`local extension at ${extDir} does not export a valid manifest`);
      }
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
    systemSections: manifest.ui?.systemSections,
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
