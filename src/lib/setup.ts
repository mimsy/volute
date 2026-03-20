import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteSystemDir } from "./registry.js";

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

export type AiConfig = {
  providers: Record<string, AiProviderConfig>;
  models?: string[];
  utilityModel?: string;
};

/** Shared across daemon services (imagegen, future TTS, etc.) */
export type ServiceProviderConfig = { apiKey?: string };

export type ImagegenConfig = {
  enabled?: boolean;
  providers?: Record<string, ServiceProviderConfig>;
  models?: string[];
};

export type GlobalConfig = {
  name?: string;
  description?: string;
  hostname?: string;
  port?: number;
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
};

export function configPath(): string {
  return resolve(voluteSystemDir(), "config.json");
}

export function readGlobalConfig(): GlobalConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const path = configPath();
  mkdirSync(voluteSystemDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
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
