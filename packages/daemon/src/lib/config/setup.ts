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

export type ImagegenConfig = {
  enabled?: boolean;
  providers?: Record<string, ServiceProviderConfig>;
  models?: string[];
  defaultModel?: string;
};

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
 * install the daemon runs as root while operators run CLI commands as their own
 * (non-root) user; a single file mode cannot both hide secrets from untrusted
 * minds and stay readable to the operator. So `config.json` keeps only
 * non-secret operational state (0644, operator-readable) and this file holds the
 * provider API keys / OAuth tokens (0600, root-only), mirroring env.json/volute.db.
 */
export function secretsPath(): string {
  return resolve(voluteSystemDir(), "secrets.json");
}

/** The provider-credential subset of GlobalConfig persisted to secrets.json. */
type ConfigSecrets = {
  ai?: { providers: Record<string, AiProviderConfig> };
  imagegen?: { providers: Record<string, ServiceProviderConfig> };
};

function hasEntries(obj: Record<string, unknown> | undefined): boolean {
  return !!obj && Object.keys(obj).length > 0;
}

/** Split a full config into its operator-readable part and its secret part. */
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
  return merged;
}

/** Read secrets.json; returns {} when the file is missing or unreadable (e.g. a non-root operator). */
function readSecrets(): ConfigSecrets {
  const path = secretsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // EACCES for a non-root operator, or a corrupt file — proceed without secrets.
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
  // 0644 — non-secret operational state; must stay readable by the operator's
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
 * v0.41.1 locked to 0600 root-only, breaking non-root operator CLI commands)
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
  const embedsSecrets = hasEntries(parsed.ai?.providers) || hasEntries(parsed.imagegen?.providers);
  const mode = statSync(path).mode & 0o777;
  if (!embedsSecrets && mode === 0o644) return; // already migrated
  _resetConfigCache();
  writeGlobalConfig(readGlobalConfig()); // re-split with correct perms
}

/** Check if setup has been completed. Returns true once the full setup flow has finished. */
export function isSetupComplete(): boolean {
  const config = readGlobalConfig();
  return config.setupCompleted === true;
}

export function isImagegenEnabled(): boolean {
  const config = readGlobalConfig();
  const ig = config.imagegen;
  if (!ig) return false;
  // Legacy: explicit toggle
  if (ig.enabled === true) return true;
  // New: enabled if any provider is configured
  if (ig.providers && Object.keys(ig.providers).length > 0) return true;
  return false;
}

/** Migrate pre-existing installations that have setup but not setupCompleted. */
export function migrateSetupCompleted(): void {
  const config = readGlobalConfig();
  if (config.setup != null && config.setupCompleted == null) {
    config.setupCompleted = true;
    writeGlobalConfig(config);
  }
}
