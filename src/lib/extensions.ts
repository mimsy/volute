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
import { mindDir, voluteHome, voluteSystemDir } from "./registry.js";
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
  } catch (err) {
    log.warn("failed to read extensions config, ignoring installed extensions", {
      path: configPath,
      error: (err as Error).message,
    });
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

/** Migrate notes data from core volute.db to the extension's own DB (one-time). */
async function migrateNotesFromCoreDb(extDb: ExtensionContext["db"]): Promise<void> {
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
  authMw: unknown,
): Promise<ExtensionContext> {
  // Only open DB if the extension declares initDb (otherwise it doesn't need one)
  let db: ExtensionContext["db"] | null = null;
  if (manifest.initDb) {
    db = await openExtensionDb(manifest.id, dataDir);
    try {
      manifest.initDb(db);
    } catch (err) {
      db.close();
      throw new Error(`initDb failed for extension ${manifest.id}: ${(err as Error).message}`);
    }

    // One-time migration for built-in extensions extracted from core
    if (manifest.id === "notes") {
      await migrateNotesFromCoreDb(db);
    }
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
    authMiddleware: authMw,
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
      } catch (err) {
        log.warn(
          `extension ${manifest.id}: failed to resolve mind dir for ${name}`,
          log.errorData(err),
        );
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

  const context = await buildContext(manifest, dataDir, authMw);

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
  for (const { manifest, context } of loaded) {
    try {
      manifest.onDaemonStop?.();
    } catch (err) {
      log.error(`extension ${manifest.id}: onDaemonStop failed`, log.errorData(err));
    }
    try {
      context.db.close();
    } catch {
      // ignore — stub db or already closed
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
