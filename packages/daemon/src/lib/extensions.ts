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
import { type AuthEnv, requireSelf } from "../web/middleware/auth.js";
import {
  type Effective,
  hasAdminAuthority,
  hasSystemAuthority,
} from "../web/middleware/effective-principal.js";
import { getUser, getUserByUsername } from "./auth.js";
import { announceToCommons } from "./chat/commons-channel.js";
import { MIND_LEVEL_THREAD, recordNotice as recordMindNotice } from "./chat/system-events.js";
import { getSpiritName, readGlobalConfig, writeGlobalConfig } from "./config/setup.js";
import { readSystemsConfig } from "./config/systems-config.js";
import { publish } from "./events/activity-events.js";
import { isIsolationEnabled, mindUserName } from "./mind/isolation.js";
import {
  findMind,
  readRegistry,
  resolveMindDir,
  voluteHome,
  voluteSystemDir,
} from "./mind/registry.js";
import {
  hashSkillDir,
  importSkillFromDir,
  listSharedSkills,
  removeSharedSkill,
  sharedSkillsDir,
} from "./skills.js";
import log from "./util/logger.js";
import { sanitizeSvgIcon } from "./util/sanitize-svg.js";

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

/**
 * Enrich an activity event's metadata with the extension's icon/color branding and
 * sanitize the resulting icon before it reaches the DB. Activity icons round-trip to
 * the host dashboard where they render as raw HTML, so the write-time sanitize is
 * the belt-and-braces layer that keeps a malicious `metadata.icon` from becoming stored
 * XSS even if a render-time sanitizer is ever missed.
 */
export function enrichActivityMetadata(
  manifest: Pick<ExtensionManifest, "icon" | "color">,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = {
    ...metadata,
    ...(manifest.icon && !metadata?.icon ? { icon: manifest.icon } : {}),
    ...(manifest.color && !metadata?.color ? { color: manifest.color } : {}),
  };
  if (typeof enriched.icon === "string") enriched.icon = sanitizeSvgIcon(enriched.icon);
  return enriched;
}

/**
 * The command definition as the CLI sees it over `/api/v1/extensions/commands`:
 * everything except the handler, which cannot cross the wire. Metadata the CLI
 * acts on before dispatch — notably `stdin` (#872) — reaches it only through here.
 */
export function toCommandInfo(cmd: ExtensionCommand): ExtensionCommandInfo {
  const { handler: _, ...info } = cmd;
  return info;
}

/**
 * Resolve the mind an extension command runs as, from the authenticated caller and the
 * requested `--mind` / `VOLUTE_MIND` identity.
 *
 * Minds are untrusted principals, so only privileged callers may act as someone else.
 * `privileged` is the request's *admin-tier effective* authority (`hasAdminAuthority`),
 * never the caller's stored role: the spirit's account reads "spirit" on every call, and
 * `--mind` is an impersonation flag — a spirit privileged on identity would let any mind
 * that talked it into running `--mind <admin>` reach that admin's extension data, and
 * sail through a downstream `actor.role === "admin"` check on the *impersonated*
 * identity (#433). Deliberately NOT `hasSystemAuthority`: the `system` tier is
 * self-reachable (the spirit configures its own schedules), and its one legitimate
 * privileged command — review-due — never names a foreign `--mind`, so system-tier
 * impersonation would be a pure over-grant of exactly the escalation this gate closes.
 * An unprivileged caller that asks to act as another mind is **refused**,
 * never quietly handed itself: `volute pages list --mind gardener` used to return the
 * caller's own pages with exit 0, and three minds on separate seats each read that as a
 * fact about the interface rather than a refused permission (#907). A right answer to a
 * question about yourself, when you asked about someone else, has no artifact — the
 * refusal is the information.
 */
export function resolveActingMind(
  user: { username: string } | undefined,
  requested: string | undefined,
  privileged: boolean,
): { mind: string | undefined } | { error: string } {
  if (privileged) return { mind: requested || user?.username };
  if (requested && requested !== user?.username) {
    return {
      error: user?.username
        ? `cannot act as '${requested}': not permitted. You are '${user.username}'; omit --mind/VOLUTE_MIND to run as yourself.`
        : `cannot act as '${requested}': not permitted.`,
    };
  }
  return { mind: user?.username };
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
      // `--flag=value` must be understood here too: the CLI accepts that spelling and
      // forwards the raw argv, so parsing only `--flag value` would drop the value into
      // a daemon log line the caller never sees — the exact silence of #907.
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const def = flagDefs[name];
      if (!def) {
        log.warn(`unknown flag --${name}`);
        continue;
      }
      if (def.type === "boolean") {
        flags[name] = true;
      } else if (inlineValue !== undefined || i + 1 < rawArgs.length) {
        const val = inlineValue ?? rawArgs[++i];
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

/**
 * Extension routes are mounted with `app.route()`, and a mounted sub-app's "/"
 * doesn't match a request path carrying a trailing slash — so every extension
 * route 404s on the slashed form, root and nested alike (#792). This normalizes
 * the path and re-dispatches.
 *
 * Rewrite rather than a 301: a redirect only rescues GET/HEAD, which would leave
 * a POST to a slashed path still silently 404ing. Recursion is impossible because
 * the rewritten path no longer ends in a slash.
 */
export function normalizeTrailingSlash(app: Hono): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
      return app.fetch(new Request(url, c.req.raw), c.env);
    }
    await next();
  };
}

/**
 * Build the context handed to an extension's routes and lifecycle hooks.
 * Exported so tests can exercise the real helpers (spirit dir resolution, notice
 * gating) rather than a hand-rolled fake that can drift from this implementation.
 */
export async function buildExtensionContext(
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
    // Reuse the daemon's canonical guard so extension routes authorize the same
    // way core routes do (admin/system or the mind whose base name matches the
    // route param). Its type is compatible with the SDK MiddlewareHandler.
    requireSelf: (paramName?: string) => requireSelf(paramName) as unknown as MiddlewareHandler,
    resolveUser: (c) => {
      const user = c.get("user");
      if (!user || typeof user !== "object") return null;
      return user as ReturnType<ExtensionContext["resolveUser"]>;
    },
    isPrivileged: (c) => hasSystemAuthority(c.get("effective") as Effective | undefined),
    getUser: async (id: number) => getUser(id),
    getUserByUsername: async (username: string) => getUserByUsername(username),
    publishActivity: (event) => {
      // Inject extension icon/color branding and sanitize the icon before it reaches
      // the DB (the dashboard renders it raw).
      const metadata = enrichActivityMetadata(manifest, event.metadata);
      const enriched = { ...event, metadata };
      // Insert without turn linkage — when called from skill command handlers, the
      // activity is linked to the correct turn via correlation markers in tool_result.
      // When called from route handlers or lifecycle hooks, the record stays unlinked.
      publish(enriched as Parameters<typeof publish>[0]).catch((err) =>
        log.error(`extension ${manifest.id}: failed to publish activity`, log.errorData(err)),
      );
    },
    // Registry-backed, not path-convention: the spirit lives under the system dir
    // and variants live in worktrees, so mindDir(name) alone resolves neither.
    getMindDir: async (name: string) => {
      try {
        const dir = await resolveMindDir(name);
        return existsSync(dir) ? dir : null;
      } catch (err) {
        log.warn(
          `extension ${manifest.id}: failed to resolve mind dir for ${name}`,
          log.errorData(err),
        );
        return null;
      }
    },
    listMinds: async () => {
      try {
        // readRegistry already excludes variants (parent is null) and non-mind
        // rows, so this is the roster an extension means by "everyone here".
        return (await readRegistry()).map((m) => ({
          name: m.name,
          mindType: m.mindType === "spirit" ? ("spirit" as const) : ("mind" as const),
          stage: m.stage,
        }));
      } catch (err) {
        log.warn(`extension ${manifest.id}: failed to list minds`, log.errorData(err));
        return [];
      }
    },
    getSystemsConfig: () => readSystemsConfig(),
    announceToCommons: (text: string) => announceToCommons(text),
    recordNotice: async (mindName: string, text: string) => {
      try {
        // Gate on the minds registry rather than the users table: the spirit is a
        // mind but shares the system user account (`user_type: "spirit"`), so a
        // user_type check would silently drop every notice addressed to it.
        if (!(await findMind(mindName))) return;
        await recordMindNotice({
          mind: mindName,
          thread: MIND_LEVEL_THREAD,
          kind: "extension",
          reason: manifest.id,
          detail: text.slice(0, 500),
        });
      } catch (err) {
        log.warn(
          `extension ${manifest.id}: failed to record notice for ${mindName}`,
          log.errorData(err),
        );
      }
    },
    isIsolationEnabled,
    getMindUser: mindUserName,
    // Delegate to the daemon's single source of truth, which falls back to "volute"
    // on installs that predate spirit naming. Reading setup.spiritName directly
    // returned null on those systems, so extension spirit paths no-opped forever.
    getSpiritName: () => getSpiritName(),
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

  const context = await buildExtensionContext(manifest, dataDir, authMw);

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
        // Two different questions, deliberately: `--mind` impersonation takes admin
        // authority (a verified admin's turn), while ctx.privileged — the coordinator
        // gate commands like review-due read — also admits the spirit's own
        // daemon-evidenced schedule/script work. Folding them would let a self-added
        // schedule impersonate any mind (see resolveActingMind's docblock).
        const privileged = hasSystemAuthority(c.get("effective"));
        const acting = resolveActingMind(user, body.mind, hasAdminAuthority(c.get("effective")));
        if ("error" in acting) return c.json({ error: acting.error }, 403);
        const mindName = acting.mind;
        const session = c.get("mindSession") as string | undefined;
        try {
          // Collect activity publish promises so we can append correlation markers
          // to the output (linked to the correct turn when the tool_result event
          // arrives at the events endpoint).
          const activityPromises: Promise<number>[] = [];
          const parsed = parseCommandArgs(body.args ?? [], cmd.args ?? [], cmd.flags ?? {});
          const result = await cmd.handler(parsed, {
            ...context,
            privileged,
            publishActivity: (rawEvent) => {
              const metadata = enrichActivityMetadata(manifest, rawEvent.metadata);
              const event = { ...rawEvent, metadata };
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
    { id: "pages", load: async () => (await import("@volute/pages")).default },
    { id: "intentions", load: async () => (await import("@volute/intentions")).default },
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

  await pruneOrphanedExtensionSkills();

  // Discovery endpoint for CLI dynamic dispatch
  app.get("/api/v1/extensions/commands", (c) => {
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

  // Mind-facing digest for session-start orientation: what extensions exist and how a
  // mind reaches them. Reflects only what's actually loaded, so third-party and disabled
  // extensions are handled automatically.
  app.get("/api/v1/extensions/mind-docs", (c) => {
    const result = loaded
      .filter(({ manifest }) => manifest.mindDoc || manifest.commands)
      .map(({ manifest }) => ({
        id: manifest.id,
        name: manifest.name,
        mindDoc: manifest.mindDoc ?? manifest.description ?? "",
        commands: Object.keys(manifest.commands ?? {}),
      }));
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
    // --ignore-scripts: extensions install as the daemon user (root on system
    // installs), so never run untrusted package lifecycle scripts.
    await exec("npm", ["install", "--ignore-scripts", pkg], { cwd: dir });
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
    await exec("npm", ["uninstall", "--ignore-scripts", pkg], { cwd: extensionsNpmDir() });
  } catch (err) {
    log.warn(
      `npm uninstall failed for "${pkg}" (may have been manually removed)`,
      log.errorData(err),
    );
  }

  log.info(`uninstalled extension package: ${pkg}`);
}

/**
 * Remove shared-pool skills belonging to an extension that is no longer present.
 *
 * `uninstallNpmExtension` cleans up after itself, but an extension that simply
 * stops shipping — a built-in dropped from `discoverBuiltinExtensions`, or a local
 * directory deleted by hand — leaves its skills in the pool forever, because the
 * pool is otherwise add-only. The orphan then stays in `defaultSkills` and every
 * new mind tries to install a skill whose extension is gone.
 *
 * The `author` column is what makes this safe to do generically: extension skills
 * are imported as `ext:<id>`, built-ins as `volute`, and a mind's own published
 * skill under its own name. Only the first kind is considered, and only when its
 * extension is neither loaded nor merely disabled — a disabled extension is meant
 * to come back, so its skills stay put.
 */
async function pruneOrphanedExtensionSkills(): Promise<void> {
  try {
    const present = new Set(discovered.map((e) => e.manifest.id));
    const skills = await listSharedSkills();
    for (const skill of skills) {
      if (!skill.author?.startsWith("ext:")) continue;
      const extId = skill.author.slice("ext:".length);
      if (present.has(extId)) continue;
      try {
        await removeSharedSkill(skill.id);
        log.info(`removed orphaned skill "${skill.id}" from absent extension ${extId}`);
      } catch (err) {
        log.warn(`failed to remove orphaned skill "${skill.id}"`, log.errorData(err));
      }
    }
  } catch (err) {
    log.warn("could not prune orphaned extension skills", log.errorData(err));
  }
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
    const spiritSet = new Set(manifest.spiritSkills ?? []);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !spiritSet.has(entry.name)) skills.push(entry.name);
      }
    } catch (err) {
      log.warn(`failed to read skills dir for extension ${manifest.id}`, log.errorData(err));
    }
  }
  return skills;
}

/** Extension-declared skill names to install for the system spirit (spiritSkills manifests). */
export function getExtensionSpiritSkills(): string[] {
  const skills: string[] = [];
  for (const { manifest } of loaded) {
    for (const name of manifest.spiritSkills ?? []) skills.push(name);
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

/**
 * Fire `onSpiritReady` for every loaded extension. Called once per daemon start,
 * after the spirit project exists and is registered — `onDaemonStart` runs long
 * before that on a fresh install, so spirit bootstrap hooks that ran there skipped
 * the very boot that created the spirit and only fired on the next one.
 * Awaited so an extension's bootstrap failure is logged, never unhandled.
 */
export async function notifyExtensionsSpiritReady(): Promise<void> {
  for (const { manifest, context } of loaded) {
    if (!manifest.onSpiritReady) continue;
    try {
      await manifest.onSpiritReady(context);
    } catch (err) {
      log.error(`extension ${manifest.id}: onSpiritReady failed`, log.errorData(err));
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

export type TurnContextProviderEntry = {
  id: string;
  manifest: ExtensionManifest;
  context: ExtensionContext;
};

/**
 * Every loaded extension that declares `turnContext`, in a deterministic order
 * (by extension id). Order is load-order-independent on purpose: which extension
 * gets asked first decides who gets first claim on the shared budget, and that must
 * not depend on discovery order, which varies with npm/local install state.
 */
export function getTurnContextProviders(): TurnContextProviderEntry[] {
  return loaded
    .filter(({ manifest }) => typeof manifest.turnContext === "function")
    .map(({ manifest, context }) => ({ id: manifest.id, manifest, context }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Test-only: register a manifest directly into the loaded-extension list, bypassing file
 * discovery and route mounting. For unit-testing skill-set derivation
 * (getExtensionStandardSkills, getExtensionSpiritSkills) without a full extension load.
 */
export function _registerExtensionForTest(manifest: ExtensionManifest): void {
  loaded.push({ manifest, context: {} as ExtensionContext });
}

/** Test-only: empty the entire loaded-extension list (not just test-registered entries). */
export function _clearLoadedExtensionsForTest(): void {
  loaded.length = 0;
}
