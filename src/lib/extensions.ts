import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import extNotes from "@volute/ext-notes";
import extPages from "@volute/ext-pages";
import type {
  ExtensionContext,
  ExtensionManifest,
  FeedSource,
  MindSection,
  SystemSection,
} from "@volute/extension-sdk";
import type { Hono } from "hono";
import { getUser, getUserByUsername } from "./auth.js";
import { publish } from "./events/activity-events.js";
import log from "./logger.js";
import { mindDir, voluteHome } from "./registry.js";
import { importSkillFromDir } from "./skills.js";

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

function extensionsConfigPath(): string {
  return resolve(voluteHome(), "system", "extensions.json");
}

function readExtensionsConfig(): string[] {
  const configPath = extensionsConfigPath();
  if (!existsSync(configPath)) return [];
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let _LibsqlDatabase: (new (path: string) => ExtensionContext["db"]) | null = null;

async function getLibsqlDatabase(): Promise<new (path: string) => ExtensionContext["db"]> {
  if (_LibsqlDatabase) return _LibsqlDatabase;
  const mod = await import("libsql");
  _LibsqlDatabase = (mod.default ?? mod) as new (path: string) => ExtensionContext["db"];
  return _LibsqlDatabase;
}

async function openExtensionDb(_id: string, dataDir: string): Promise<ExtensionContext["db"]> {
  const dbPath = resolve(dataDir, "data.db");
  const Database = await getLibsqlDatabase();
  return new Database(dbPath);
}

async function buildContext(
  manifest: ExtensionManifest,
  dataDir: string,
): Promise<ExtensionContext> {
  // Only open DB if the extension declares initDb (otherwise it doesn't need one)
  let db: ExtensionContext["db"] | null = null;
  if (manifest.initDb) {
    db = await openExtensionDb(manifest.id, dataDir);
    manifest.initDb(db);
  }

  return {
    db:
      db ??
      ({
        exec() {
          throw new Error("No database configured for this extension");
        },
        prepare() {
          throw new Error("No database configured for this extension");
        },
        close() {},
      } as ExtensionContext["db"]),
    authMiddleware: null, // Set by mountExtensions
    resolveUser: (c: unknown) => {
      const ctx = c as { get: (key: string) => unknown };
      const user = ctx.get("user");
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
      } catch {
        return null;
      }
    },
    dataDir,
  };
}

async function loadExtension(
  manifest: ExtensionManifest,
  app: Hono,
  authMw: unknown,
): Promise<void> {
  const dataDir = resolve(extensionsBaseDir(), manifest.id);
  mkdirSync(dataDir, { recursive: true });

  const context = await buildContext(manifest, dataDir);
  context.authMiddleware = authMw;

  // Mount authenticated API routes
  const routesApp = manifest.routes(context);
  app.use(`/api/ext/${manifest.id}/*`, authMw as any);
  app.route(`/api/ext/${manifest.id}`, routesApp);

  // Mount public routes (no auth)
  if (manifest.publicRoutes) {
    const publicApp = manifest.publicRoutes(context);
    app.route(`/ext/${manifest.id}/public`, publicApp);
  }

  // Serve static UI assets
  if (manifest.ui?.assetsDir && existsSync(manifest.ui.assetsDir)) {
    const { serveStatic } = await import("@hono/node-server/serve-static");
    app.use(
      `/ext/${manifest.id}/*`,
      serveStatic({
        root: manifest.ui.assetsDir,
        rewriteRequestPath: (path) => path.replace(`/ext/${manifest.id}`, ""),
      }),
    );
  }

  // Sync skill if declared
  if (manifest.skillDir && existsSync(manifest.skillDir)) {
    try {
      await importSkillFromDir(manifest.skillDir, `ext:${manifest.id}`);
      log.info(`synced skill for extension: ${manifest.id}`);
    } catch (err) {
      log.error(`failed to sync skill for extension ${manifest.id}`, log.errorData(err));
    }
  }

  loaded.push({ manifest, context });
  log.info(`loaded extension: ${manifest.id} v${manifest.version}`);
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
      if (manifest?.id && manifest?.routes) {
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

export async function loadAllExtensions(app: Hono, authMw: unknown): Promise<void> {
  const builtins = discoverBuiltinExtensions();
  const installed = await discoverInstalledExtensions();
  const all = [...builtins, ...installed];

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
  return loaded.filter((e) => e.manifest.standardSkill).map((e) => e.manifest.id);
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
  for (const { manifest } of loaded) {
    try {
      manifest.onDaemonStop?.();
    } catch (err) {
      log.error(`extension ${manifest.id}: onDaemonStop failed`, log.errorData(err));
    }
  }
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
