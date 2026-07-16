import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteSystemDir } from "../mind/registry.js";
import type { CognitionConfig, Schedule, SleepConfig } from "../mind/volute-config.js";

export type SetupType = "local" | "system";
export type IsolationMode = "sandbox" | "user" | "none";

export type SetupConfig = {
  type: SetupType;
  mindsDir: string;
  isolation: IsolationMode;
  service: boolean;
  /** Name the host gave the system spirit during setup; absent = "volute" */
  spiritName?: string;
  /** Optional temperament line the host wrote for the spirit, rendered into its SOUL.md */
  spiritTemperament?: string;
};

export type AiProviderConfig = {
  apiKey?: string;
  oauth?: {
    refresh: string;
    access: string;
    expires: number;
    [key: string]: unknown;
  };
};

/**
 * An admin-defined model on an already-configured provider, for models not yet
 * in pi-ai's built-in catalog. Only identity (provider + id, plus an optional
 * display name) is stored; the heavy metadata (api/baseUrl/caps/cost) is cloned
 * from a sibling built-in model of the same provider at resolution time so it
 * never goes stale as the catalog evolves.
 */
export type CustomModel = { provider: string; id: string; name?: string };

export type AiConfig = {
  providers: Record<string, AiProviderConfig>;
  models?: string[];
  customModels?: CustomModel[];
  utilityModel?: string;
};

/** Shared across daemon services (imagegen, future TTS, etc.) */
export type ServiceProviderConfig = { apiKey?: string };

/**
 * Whether a provider's credential is actually allowed to generate images.
 * Distinct from "configured": a plan can be authenticated yet not entitled
 * (ChatGPT plan without the hosted image tool; xAI tier not allowlisted).
 * Non-secret — lives in config.json, keyed by provider id.
 */
export type ImagegenEntitlement =
  | { state: "entitled"; checkedAt: number }
  | { state: "not_entitled"; reason: string; checkedAt: number };

export type ImagegenConfig = {
  enabled?: boolean;
  providers?: Record<string, ServiceProviderConfig>;
  models?: string[];
  defaultModel?: string;
  /** Per-provider entitlement cache (sibling of providers → stays in config.json). */
  entitlements?: Record<string, ImagegenEntitlement>;
};

export type BackupSettings = {
  /** Restic repository string: a local path, `s3:...`, `b2:...`, `sftp:...`, etc. */
  repository?: string;
  /** Cron expression for scheduled backups (default "0 3 * * *") */
  schedule?: string;
  /** Whether scheduled backups run */
  enabled?: boolean;
  /** Retention policy passed to `restic forget` (default 7/4/12) */
  keep?: { daily?: number; weekly?: number; monthly?: number };
  /** Include session transcripts (claude/codex/pi) in backups (default false) */
  includeSessions?: boolean;
};

/**
 * Never written to config.json (0644) or returned by the API. A new secret
 * field belongs here AND in splitConfig + redactedConfig (web/api/backup.ts).
 */
export type BackupSecrets = {
  /** Restic repository passphrase */
  password?: string;
  /** Extra env vars for restic, e.g. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY */
  env?: Record<string, string>;
};

export type BackupConfig = BackupSettings & BackupSecrets;

export type GlobalConfig = {
  name?: string;
  description?: string;
  hostname?: string;
  port?: number;
  tailscale?: boolean;
  setup?: SetupConfig;
  /** Skill IDs installed by default when a mind is created/sprouted */
  defaultSkills?: string[];
  /** Skills explicitly removed from defaults by an admin (not re-added on restart) */
  removedDefaultSkills?: string[];
  ai?: AiConfig;
  /** Model ID for the system spirit */
  spiritModel?: string;
  /** True once the full setup flow (account + provider + models + complete) has finished */
  setupCompleted?: boolean;
  /** Image generation configuration */
  imagegen?: ImagegenConfig;
  /** Auto-update skills installed on minds when shared pool versions change (default: true) */
  autoUpdateSkills?: boolean;
  /** Extension IDs that are installed but should not load on daemon start */
  disabledExtensions?: string[];
  /** Default settings applied when creating new minds */
  mindDefaults?: MindDefaults;
  /**
   * Cap on the total number of base minds (excludes variants and the spirit).
   * Every mind is a full process (plus SDK subprocesses, npm install, per-mind OS
   * user under isolation), so unbounded creation can exhaust the host. Unset =
   * unlimited (the default; preserves existing installs). Not a secret — stays in
   * the host-readable config.json.
   */
  maxMinds?: number;
  /**
   * Who may register an external mind account (a `user_type:"mind"` users row
   * with no `minds` registry row). Unset = "admin-only". The enum leaves room
   * for a future "invite" policy. Not a secret — stays in the host-readable
   * config.json.
   */
  externalRegistration?: "closed" | "admin-only" | "open";
  /** Restic-based system backup configuration */
  backup?: BackupConfig;
};

export type MindDefaultsCognition = CognitionConfig & {
  compaction?: { maxContextTokens?: number };
};

export type MindDefaults = {
  cognition?: MindDefaultsCognition;
  sleep?: SleepConfig;
  schedules?: Schedule[];
};

export function configPath(): string {
  return resolve(voluteSystemDir(), "config.json");
}

/**
 * Provider credentials live in a separate owner-only file. On a `--system`
 * install the daemon runs as root while hosts run CLI commands as their own
 * (non-root) user; a single file mode cannot both hide secrets from untrusted
 * minds and stay readable to the host. So `config.json` keeps only
 * non-secret operational state (0644, host-readable) and this file holds the
 * provider API keys / OAuth tokens (0600, root-only), mirroring env.json/volute.db.
 */
export function secretsPath(): string {
  return resolve(voluteSystemDir(), "secrets.json");
}

/** The provider-credential subset of GlobalConfig persisted to secrets.json. */
type ConfigSecrets = {
  ai?: { providers: Record<string, AiProviderConfig> };
  imagegen?: { providers: Record<string, ServiceProviderConfig> };
  backup?: BackupSecrets;
};

function hasEntries(obj: Record<string, unknown> | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0;
}

/** Split a full config into its host-readable part and its secret part. */
function splitConfig(config: GlobalConfig): { publicConfig: GlobalConfig; secrets: ConfigSecrets } {
  const publicConfig: GlobalConfig = { ...config };
  const secrets: ConfigSecrets = {};
  if (config.ai) {
    const { providers, ...rest } = config.ai;
    publicConfig.ai = { ...rest, providers: {} };
    if (hasEntries(providers)) secrets.ai = { providers };
  }
  if (config.imagegen) {
    const { providers, ...rest } = config.imagegen;
    publicConfig.imagegen = { ...rest };
    if (providers && Object.keys(providers).length > 0) secrets.imagegen = { providers };
  }
  if (config.backup) {
    const { password, env, ...rest } = config.backup;
    publicConfig.backup = { ...rest };
    if (password || hasEntries(env)) {
      secrets.backup = {};
      if (password) secrets.backup.password = password;
      if (hasEntries(env)) secrets.backup.env = env;
    }
  }
  return { publicConfig, secrets };
}

/** Merge secrets.json provider credentials back onto the public config. */
function mergeSecrets(publicConfig: GlobalConfig, secrets: ConfigSecrets): GlobalConfig {
  const merged: GlobalConfig = { ...publicConfig };
  if (secrets.ai?.providers) {
    merged.ai = { ...(merged.ai ?? { providers: {} }), providers: secrets.ai.providers };
  }
  if (secrets.imagegen?.providers) {
    merged.imagegen = { ...(merged.imagegen ?? {}), providers: secrets.imagegen.providers };
  }
  if (secrets.backup) {
    merged.backup = { ...(merged.backup ?? {}), ...secrets.backup };
  }
  return merged;
}

/** Read secrets.json; returns {} when the file is missing or unreadable (e.g. a non-root host). */
function readSecrets(): ConfigSecrets {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // EACCES for a non-root host, or a corrupt file — proceed without secrets.
    return {};
  }
}

let _cachedConfig: { config: GlobalConfig; ts: number } | null = null;
const CONFIG_CACHE_TTL = 2000;

export function _resetConfigCache(): void {
  _cachedConfig = null;
}

export function readGlobalConfig(): GlobalConfig {
  if (_cachedConfig && Date.now() - _cachedConfig.ts < CONFIG_CACHE_TTL) {
    return { ..._cachedConfig.config };
  }
  const path = configPath();
  if (!existsSync(path)) {
    _cachedConfig = null;
    return {};
  }
  let publicConfig: GlobalConfig;
  try {
    publicConfig = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return {};
  }
  // Overlay provider credentials from secrets.json. A legacy (unsplit) config.json
  // may still carry providers inline; those survive when secrets.json is absent.
  const config = mergeSecrets(publicConfig, readSecrets());
  _cachedConfig = { config, ts: Date.now() };
  return config;
}

export function writeGlobalConfig(config: GlobalConfig): void {
  mkdirSync(voluteSystemDir(), { recursive: true });
  const { publicConfig, secrets } = splitConfig(config);
  // 0644 — non-secret operational state; must stay readable by the host's
  // (possibly non-root) CLI on a system install.
  const cfgPath = configPath();
  writeFileSync(cfgPath, `${JSON.stringify(publicConfig, null, 2)}\n`, { mode: 0o644 });
  chmodSync(cfgPath, 0o644); // relax even if the file pre-existed at 0600
  // 0600 — provider API keys and OAuth refresh tokens; owner-only.
  const secPath = secretsPath();
  writeFileSync(secPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secPath, 0o600); // enforce even if the file pre-existed with looser perms
  _cachedConfig = { config, ts: Date.now() };
}

/**
 * Move provider credentials out of a legacy single-file config.json (which
 * v0.41.1 locked to 0600 root-only, breaking non-root host CLI commands)
 * into secrets.json, and relax config.json back to 0644. Idempotent; must run as
 * the config owner (root on a system install), so it lives on the daemon startup
 * path. A no-op once config.json is already split and 0644.
 */
export function migrateConfigSecrets(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8"); // skip silently if we're not the owner
  } catch {
    return;
  }
  let parsed: GlobalConfig;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const embedsSecrets =
    hasEntries(parsed.ai?.providers) ||
    hasEntries(parsed.imagegen?.providers) ||
    !!parsed.backup?.password ||
    hasEntries(parsed.backup?.env);
  const mode = statSync(path).mode & 0o777;
  if (!embedsSecrets && mode === 0o644) return; // already migrated
  _resetConfigCache();
  writeGlobalConfig(readGlobalConfig()); // re-split with correct perms
}

/**
 * Setup lifecycle state:
 * - `complete` — the full flow finished (or a legacy install predating the flag).
 * - `in-progress` — a setup entry point ran (`volute setup` CLI or a wizard step)
 *   but the browser wizard hasn't been completed. Re-running `volute setup` won't
 *   advance this; the user must finish in the browser.
 * - `none` — setup has never been started.
 */
export type SetupStatus = "complete" | "in-progress" | "none";

/** Pure setup-status rules, usable against any (possibly strictly-read) config. */
export function computeSetupStatus(config: GlobalConfig): SetupStatus {
  if (config.setupCompleted === true) return "complete";
  // Legacy install: has a setup block but predates the `setupCompleted` flag.
  // migrateSetupCompleted() persists these as complete on daemon start; the CLI
  // gate must agree even before the daemon has run that migration.
  if (config.setup != null && config.setupCompleted == null) return "complete";
  // A setup entry point ran but the browser wizard hasn't finished.
  if (config.setup != null) return "in-progress";
  return "none";
}

export function setupStatus(): SetupStatus {
  return computeSetupStatus(readGlobalConfig());
}

/**
 * Strict config read for callers that must not act on a broken read: a missing file
 * reads as `{}` (a genuinely fresh install), but unparseable JSON (e.g. a torn read of
 * the non-atomic writeGlobalConfig) THROWS instead of silently returning `{}` the way
 * readGlobalConfig does. Skips the secrets merge — strict callers only need setup fields.
 */
export function readGlobalConfigStrict(): GlobalConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as GlobalConfig;
}

/** Check if setup has been completed. Returns true once the full setup flow has finished. */
export function isSetupComplete(): boolean {
  return setupStatus() === "complete";
}

/**
 * Best-effort URL for finishing setup in the browser wizard, derived from the
 * saved config (no dependency on the daemon running). Falls back to localhost:1618.
 */
export function setupUrl(): string {
  const config = readGlobalConfig();
  const port = config.port || 1618;
  let host = config.hostname || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") host = "localhost";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`; // bracket bare IPv6
  return `http://${host}:${port}`;
}

/**
 * Name of the system spirit — the single source of truth for spirit identity.
 * Keyed off config rather than the minds table's mind_type so future ephemeral
 * spirits (#464) can't be mistaken for the system spirit. Absent config (every
 * pre-naming install) resolves to "volute", which is the entire migration story.
 */
export function getSpiritName(): string {
  return readGlobalConfig().setup?.spiritName ?? "volute";
}

/** The host-given name of this system (from `volute setup --name`), or a neutral fallback. */
export function getSystemName(): string {
  return readGlobalConfig().name ?? "this system";
}

/**
 * AI providers that double as image providers (chat/image unification): a
 * subscription configured for chat also enables image generation. Kept in sync
 * with the `aiProviderId` links in services/imagegen.ts — duplicated here only
 * to avoid a setup.ts → imagegen.ts import cycle.
 */
const IMAGEGEN_AI_PROVIDERS = ["openai-codex", "xai"];

export function isImagegenEnabled(): boolean {
  const config = readGlobalConfig();
  const ig = config.imagegen;
  // Legacy: explicit toggle
  if (ig?.enabled === true) return true;
  // Enabled if any imagegen provider has a key configured
  if (ig?.providers && Object.keys(ig.providers).length > 0) return true;
  // Or if a subscription AI provider (codex/xai) is configured for chat, since
  // it is auto-added as an image provider.
  const aiProviders = config.ai?.providers;
  for (const id of IMAGEGEN_AI_PROVIDERS) {
    const p = aiProviders?.[id];
    if (p?.oauth || p?.apiKey) return true;
  }
  return false;
}

/**
 * Enforce the `maxMinds` cap. Returns a human-friendly error message when
 * creating another mind would meet or exceed the cap — the spirit relays this
 * verbatim to whoever asked, so keep it actionable — or null when creation is
 * allowed. `limit` unset (undefined) = unlimited.
 */
export function mindLimitError(count: number, limit: number | undefined): string | null {
  if (limit == null) return null;
  if (count >= limit) {
    return `Mind limit reached (${count}/${limit}). An admin can raise maxMinds in Settings.`;
  }
  return null;
}

/** Migrate pre-existing installations that have setup but not setupCompleted. */
export function migrateSetupCompleted(): void {
  const config = readGlobalConfig();
  if (config.setup != null && config.setupCompleted == null) {
    config.setupCompleted = true;
    writeGlobalConfig(config);
  }
}
