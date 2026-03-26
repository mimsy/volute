import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ArgDef,
  Database,
  ExtensionCommand,
  ExtensionContext,
  ExtensionManifest,
  FeedSource,
  FlagDef,
  MindSection,
  SystemSection,
} from "@volute/extensions";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AuthEnv } from "../web/middleware/auth.js";
import { getUser, getUserByUsername } from "./auth.js";
import { announceToSystem } from "./chat/system-channel.js";
import { readGlobalConfig, writeGlobalConfig } from "./config/setup.js";
import { readSystemsConfig } from "./config/systems-config.js";
import { publish } from "./events/activity-events.js";
import { isIsolationEnabled, mindUserName } from "./mind/isolation.js";
import { mindDir, voluteHome, voluteSystemDir } from "./mind/registry.js";
import { hashSkillDir, importSkillFromDir, removeSharedSkill, sharedSkillsDir } from "./skills.js";
import log from "./util/logger.js";

const VALID_EXTENSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

type LoadedExtension = {
  manifest: ExtensionManifest;
  context: ExtensionContext;
};

const loaded: LoadedExtension[] = [];

export type ExtensionSource = "builtin" | "npm" | "local";

type DiscoveredExtension = {
  manifest: ExtensionManifest;
  source: ExtensionSource;
  /** npm package name (only for npm-installed extensions) */
  package?: string;
};

const discovered: DiscoveredExtension[] = [];

export type DiscoveredExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  source: ExtensionSource;
  enabled: boolean;
  /** npm package name (only for npm-installed extensions) */
  package?: string;
};

export type ExtensionCommandInfo = Omit<ExtensionCommand, "handler">;

function toCommandInfo(cmd: ExtensionCommand): ExtensionCommandInfo {
  const { handler: _, ...info } = cmd;
  return info;
}

export function parseCommandArgs(
  rawArgs: string[],
  argDefs: ArgDef[],
  flagDefs: Record<string, FlagDef>,
): {
  args: Record<string, string | undefined>;
  flags: Record<string, string | number | boolean | undefined>;
  rest: string[];
} {
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean | undefined> = {};

  // Initialize defaults
  for (const [key, def] of Object.entries(flagDefs)) {
    flags[key] = def.type === "boolean" ? false : undefined;
  }

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const def = flagDefs[name];
      if (!def) {
        log.warn(`unknown flag --${name}`);
        continue;
      }
      if (def.type === "boolean") {
        flags[name] = true;
      } else if (i + 1 < rawArgs.length) {
        const val = rawArgs[++i];
        if (def.type === "number") {
          const n = parseInt(val, 10);
          flags[name] = Number.isNaN(n) ? undefined : n;
        } else {
          flags[name] = val;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  const namedArgs: Record<string, string | undefined> = {};
  for (let i = 0; i < argDefs.length; i++) {
    namedArgs[argDefs[i].name] = positional[i];
  }
  const rest = positional.slice(argDefs.length);

  return { args: namedArgs, flags, rest };
}

export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  systemSection?: SystemSection;
  mindSections?: MindSection[];
  feedSource?: FeedSource;
  commands?: Record<string, ExtensionCommandInfo>;
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
    publishActivity: (event) => {
      // Inject extension icon/color into metadata so the UI can render
      // activity cards with the correct branding without hardcoding extension IDs.
      const enriched = {
        ...event,
        metadata: {
          ...event.metadata,
          ...(manifest.icon && !event.metadata?.icon ? { icon: manifest.icon } : {}),
          ...(manifest.color && !event.metadata?.color ? { color: manifest.color } : {}),
        },
      };
      // Insert without turn linkage — when called from skill command handlers, the
      // activity is linked to the correct turn via correlation markers in tool_result.
      // When called from route handlers or lifecycle hooks, the record stays unlinked.
      publish(enriched as Parameters<typeof publish>[0]).catch((err) =>
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
    announceToSystem: (text: string) => announceToSystem(text),
    isIsolationEnabled,
    getMindUser: mindUserName,
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

  // Mount command endpoints
  if (manifest.commands) {
    for (const [cmdName, cmd] of Object.entries(manifest.commands)) {
      app.post(`${extApiPath}/commands/${cmdName}`, async (c: Context<AuthEnv>) => {
        let body: { args?: string[]; mind?: string; stdin?: string };
        try {
          body = await c.req.json();
        } catch {
          return c.json({ error: "Invalid JSON in request body" }, 400);
        }
        const user = c.get("user") as { username: string } | undefined;
        const mindName = body.mind || user?.username;
        const session = c.get("mindSession") as string | undefined;
        try {
          // Collect activity publish promises so we can append correlation markers
          // to the output (linked to the correct turn when the tool_result event
          // arrives at the events endpoint).
          const activityPromises: Promise<number>[] = [];
          const parsed = parseCommandArgs(body.args ?? [], cmd.args ?? [], cmd.flags ?? {});
          const result = await cmd.handler(parsed, {
            ...context,
            publishActivity: (rawEvent) => {
              const event = {
                ...rawEvent,
                metadata: {
                  ...rawEvent.metadata,
                  ...(manifest.icon && !rawEvent.metadata?.icon ? { icon: manifest.icon } : {}),
                  ...(manifest.color && !rawEvent.metadata?.color ? { color: manifest.color } : {}),
                },
              };
              activityPromises.push(
                publish(event as Parameters<typeof publish>[0]).catch((err) => {
                  log.error(
                    `extension ${manifest.id}: failed to publish activity`,
                    log.errorData(err),
                  );
                  return 0;
                }),
              );
            },
            mindName,
            session,
            stdin: body.stdin,
          });
          // Wait for all activity publishes and collect their IDs
          const activityIds = (await Promise.all(activityPromises)).filter((id) => id > 0);
          // Append activity correlation markers to the output
          const markers = activityIds.map((id) => `[volute:activity:${id}]`).join("");
          const output =
            result && typeof result === "object" && "output" in result
              ? { ...result, output: `${(result as { output: string }).output}${markers}` }
              : markers
                ? { ...result, output: markers }
                : result;
          return c.json(output);
        } catch (err) {
          log.error(`extension command ${manifest.id}/${cmdName} failed`, log.errorData(err));
          return c.json({ error: (err as Error).message }, 500);
        }
      });
    }
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
    const serveExtAssets = async (c: Context<AuthEnv>) => {
      const urlPath = new URL(c.req.url).pathname;
      const relativePath = urlPath.slice(prefix.length).replace(/^\//, "") || "index.html";
      const filePath = resolve(assetsDir, relativePath);
      // Boundary-aware check: assetsDir must be followed by "/" to prevent
      // prefix confusion (e.g. /path/assets-evil matching /path/assets)
      if (filePath !== assetsDir && !filePath.startsWith(`${assetsDir}/`))
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
const skillsDirCache = new Map<string, string | null>();

function resolveSkillsDir(manifest: ExtensionManifest): string | null {
  if (!manifest.skillsDir) return null;
  const cached = skillsDirCache.get(manifest.id);
  if (cached !== undefined) return cached;
  // Search from daemon entry point for extension-specific skills directory first.
  // This is needed because tsup bundling makes import.meta.dirname resolve to dist/,
  // so relative paths like "../skills" can accidentally hit the repo root skills/ dir.
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "packages", "extensions", manifest.id, "skills");
    if (existsSync(candidate)) {
      skillsDirCache.set(manifest.id, candidate);
      return candidate;
    }
    searchDir = dirname(searchDir);
  }
  // Fall back to the declared path (works in dev mode where import.meta.dirname is correct)
  if (existsSync(manifest.skillsDir)) {
    skillsDirCache.set(manifest.id, manifest.skillsDir);
    return manifest.skillsDir;
  }
  log.warn(`skills dir not found for extension ${manifest.id}: ${manifest.skillsDir}`);
  skillsDirCache.set(manifest.id, null);
  return null;
}

async function discoverBuiltinExtensions(disabledIds: Set<string>): Promise<ExtensionManifest[]> {
  const builtins: { id: string; load: () => Promise<ExtensionManifest> }[] = [
    { id: "notes", load: async () => (await import("@volute/notes")).default },
    { id: "pages", load: async () => (await import("@volute/pages")).default },
    { id: "plan", load: async () => (await import("@volute/plan")).default },
  ];
  const results: ExtensionManifest[] = [];
  for (const { id, load } of builtins) {
    if (disabledIds.has(id)) continue;
    try {
      results.push(await load());
    } catch (err) {
      log.error(`failed to load built-in extension: ${id}`, log.errorData(err));
    }
  }
  return results;
}

type InstalledExtension = { manifest: ExtensionManifest; package: string };

async function discoverInstalledExtensions(): Promise<InstalledExtension[]> {
  const results: InstalledExtension[] = [];
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
      results.push({ manifest, package: pkg });
    } catch (err) {
      log.error(`failed to load extension package: ${pkg}`, log.errorData(err));
    }
  }

  return results;
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
  const disabledIds = new Set(readGlobalConfig().disabledExtensions ?? []);

  const builtins = await discoverBuiltinExtensions(disabledIds);
  const installed = await discoverInstalledExtensions();
  const local = await discoverLocalExtensions();

  const all: DiscoveredExtension[] = [
    ...builtins.map((m) => ({ manifest: m, source: "builtin" as const })),
    ...installed.map((i) => ({ manifest: i.manifest, source: "npm" as const, package: i.package })),
    ...local.map((m) => ({ manifest: m, source: "local" as const })),
  ];

  // Deduplicate by ID, populate discovered, load enabled
  const seen = new Set<string>();
  for (const entry of all) {
    const { manifest } = entry;
    if (seen.has(manifest.id)) {
      log.warn(`duplicate extension ID: ${manifest.id}, skipping`);
      continue;
    }
    seen.add(manifest.id);
    discovered.push(entry);

    if (disabledIds.has(manifest.id)) {
      log.info(`extension disabled, skipping: ${manifest.id}`);
      continue;
    }

    try {
      await loadExtension(manifest, app, authMw);
    } catch (err) {
      log.error(`failed to load extension: ${manifest.id}`, log.errorData(err));
    }
  }

  // Discovery endpoint for CLI dynamic dispatch
  app.get("/api/extensions/commands", (c) => {
    const result: Record<string, { commands: Record<string, ExtensionCommandInfo> }> = {};
    for (const { manifest } of loaded) {
      if (!manifest.commands) continue;
      const cmds: Record<string, ExtensionCommandInfo> = {};
      for (const [name, cmd] of Object.entries(manifest.commands)) {
        cmds[name] = toCommandInfo(cmd);
      }
      result[manifest.id] = { commands: cmds };
    }
    return c.json(result);
  });
}

export function getLoadedExtensions(): ExtensionInfo[] {
  return loaded.map(({ manifest }) => {
    let commands: Record<string, ExtensionCommandInfo> | undefined;
    if (manifest.commands) {
      commands = {};
      for (const [name, cmd] of Object.entries(manifest.commands)) {
        commands[name] = toCommandInfo(cmd);
      }
    }
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      icon: manifest.icon,
      systemSection: manifest.ui?.systemSection,
      mindSections: manifest.ui?.mindSections,
      feedSource: manifest.ui?.feedSource,
      commands,
    };
  });
}

export function getAllDiscoveredExtensions(): DiscoveredExtensionInfo[] {
  const disabledIds = new Set(readGlobalConfig().disabledExtensions ?? []);
  return discovered.map((d) => ({
    id: d.manifest.id,
    name: d.manifest.name,
    version: d.manifest.version,
    description: d.manifest.description,
    icon: d.manifest.icon,
    source: d.source,
    enabled: !disabledIds.has(d.manifest.id),
    package: d.package,
  }));
}

export type DetailedExtensionInfo = DiscoveredExtensionInfo & {
  skills?: string[];
  commands?: Record<string, ExtensionCommandInfo>;
  mindSections?: MindSection[];
  systemSection?: SystemSection;
  standardSkill?: boolean;
};

export function getAllDiscoveredExtensionsDetailed(): DetailedExtensionInfo[] {
  const basic = getAllDiscoveredExtensions();
  const loadedMap = new Map(loaded.map((l) => [l.manifest.id, l.manifest]));

  return basic.map((ext) => {
    const manifest = loadedMap.get(ext.id);
    if (!manifest) return ext;

    const detail: DetailedExtensionInfo = { ...ext };

    // Get skill names from skillsDir
    const skillsDir = resolveSkillsDir(manifest);
    if (skillsDir) {
      try {
        detail.skills = readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`failed to read skills dir for ${ext.id}`, log.errorData(err));
        }
      }
    }

    // Commands
    if (manifest.commands) {
      detail.commands = {};
      for (const [name, cmd] of Object.entries(manifest.commands)) {
        detail.commands[name] = toCommandInfo(cmd);
      }
    }

    // UI sections
    if (manifest.ui?.mindSections) detail.mindSections = manifest.ui.mindSections;
    if (manifest.ui?.systemSection) detail.systemSection = manifest.ui.systemSection;
    if (manifest.standardSkill) detail.standardSkill = true;

    return detail;
  });
}

export function setExtensionEnabled(id: string, enabled: boolean): void {
  if (!discovered.find((d) => d.manifest.id === id)) {
    throw new Error(`Extension "${id}" not found`);
  }
  const config = readGlobalConfig();
  const disabled = new Set(config.disabledExtensions ?? []);
  if (enabled) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  config.disabledExtensions = disabled.size > 0 ? [...disabled] : undefined;
  writeGlobalConfig(config);
}

// --- npm extension install/uninstall helpers ---

function extensionsNpmDir(): string {
  return resolve(voluteHome(), "extensions", "_npm");
}

function ensureExtensionsNpmDir(): string {
  const dir = extensionsNpmDir();
  mkdirSync(dir, { recursive: true });
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, '{"private":true,"dependencies":{}}\n');
  }
  return dir;
}

function writeExtensionsConfig(packages: string[]): void {
  const configPath = extensionsConfigPath();
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(packages, null, 2)}\n`);
}

const VALID_NPM_PACKAGE = /^(@[a-z0-9-~][a-z0-9._-~]*\/)?[a-z0-9-~][a-z0-9._-~]*(@[^\s]+)?$/;

export async function installNpmExtension(pkg: string): Promise<void> {
  if (!VALID_NPM_PACKAGE.test(pkg)) {
    throw new Error(`Invalid package name: "${pkg}"`);
  }
  const packages = readExtensionsConfig();
  if (packages.includes(pkg)) {
    throw new Error(`Extension "${pkg}" is already installed`);
  }

  const dir = ensureExtensionsNpmDir();
  const { exec } = await import("./util/exec.js");
  try {
    await exec("npm", ["install", pkg], { cwd: dir });
  } catch (err) {
    log.error(`npm install failed for "${pkg}"`, log.errorData(err));
    throw new Error(`Failed to install "${pkg}". Check daemon logs for details.`);
  }

  packages.push(pkg);
  writeExtensionsConfig(packages);
  log.info(`installed extension package: ${pkg}`);
}

export async function uninstallNpmExtension(pkg: string): Promise<void> {
  const packages = readExtensionsConfig();
  const idx = packages.indexOf(pkg);
  if (idx === -1) {
    throw new Error(`Extension "${pkg}" is not installed`);
  }

  // Try to clean up contributed skills before removing the package
  await cleanupExtensionSkills(pkg);

  packages.splice(idx, 1);
  writeExtensionsConfig(packages);

  try {
    const { exec } = await import("./util/exec.js");
    await exec("npm", ["uninstall", pkg], { cwd: extensionsNpmDir() });
  } catch (err) {
    log.warn(
      `npm uninstall failed for "${pkg}" (may have been manually removed)`,
      log.errorData(err),
    );
  }

  log.info(`uninstalled extension package: ${pkg}`);
}

async function cleanupExtensionSkills(pkg: string): Promise<void> {
  try {
    const pkgDir = resolve(extensionsNpmDir(), "node_modules", pkg);
    if (!existsSync(pkgDir)) return;

    const { createRequire } = await import("node:module");
    const require = createRequire(resolve(extensionsNpmDir(), "noop.js"));
    const mod = require(pkg);
    const manifest = mod.default ?? mod.extension ?? mod;
    if (!manifest?.skillsDir || !existsSync(manifest.skillsDir)) return;

    const skillDirs = readdirSync(manifest.skillsDir, { withFileTypes: true })
      .filter((d: import("node:fs").Dirent) => d.isDirectory())
      .map((d: import("node:fs").Dirent) => d.name);

    for (const skillId of skillDirs) {
      try {
        await removeSharedSkill(skillId);
        log.info(`removed skill "${skillId}" from extension ${pkg}`);
      } catch (err) {
        log.warn(`failed to remove skill "${skillId}" for extension ${pkg}`, log.errorData(err));
      }
    }
  } catch (err) {
    log.warn(`could not clean up skills for "${pkg}"`, log.errorData(err));
  }
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
  for (const { manifest, context } of loaded) {
    try {
      manifest.onDaemonStart?.(context);
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
  discovered.length = 0;
  skillsDirCache.clear();
}

export function notifyExtensionsMindStart(mindName: string): void {
  for (const { manifest, context } of loaded) {
    try {
      manifest.onMindStart?.(mindName, context);
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
