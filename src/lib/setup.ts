import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome, voluteSystemDir } from "./registry.js";

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
};

export type GlobalConfig = {
  name?: string;
  hostname?: string;
  port?: number;
  setup?: SetupConfig;
  /** Skill IDs installed by default when a mind is created/sprouted */
  defaultSkills?: string[];
  /** Skills explicitly removed from defaults by an admin (not re-added on restart) */
  removedDefaultSkills?: string[];
  ai?: AiConfig;
};

export function configPath(): string {
  return resolve(voluteSystemDir(), "config.json");
}

export function readGlobalConfig(): GlobalConfig {
  const path = configPath();
  const legacyPath = resolve(voluteHome(), "config.json");
  const effectivePath = existsSync(path) ? path : legacyPath;
  if (!existsSync(effectivePath)) return {};
  try {
    return JSON.parse(readFileSync(effectivePath, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse ${effectivePath}: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig): void {
  const path = configPath();
  mkdirSync(voluteSystemDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Check if setup has been completed. Returns true if config.json has a setup field. */
export function isSetupComplete(): boolean {
  const config = readGlobalConfig();
  return config.setup != null;
}

/**
 * For existing users who have ~/.volute/minds.json but no setup config,
 * auto-populate setup state so they're never blocked.
 */
export function migrateSetupConfig(): void {
  const config = readGlobalConfig();
  if (config.setup) return; // already configured

  const home = voluteHome();
  const systemDir = voluteSystemDir();
  const registryPath = resolve(systemDir, "minds.json");
  const legacyRegistryPath = resolve(home, "minds.json");
  if (!existsSync(registryPath) && !existsSync(legacyRegistryPath)) return; // truly fresh install, no migration needed

  // Existing user — infer setup state
  const isSystem = process.env.VOLUTE_ISOLATION === "user";
  const mindsDir = process.env.VOLUTE_MINDS_DIR || resolve(home, "minds");

  // Detect if a service is installed
  let hasService = false;
  try {
    // Check macOS launchd
    if (process.platform === "darwin") {
      const plistPath = resolve(
        process.env.HOME || "",
        "Library",
        "LaunchAgents",
        "com.volute.daemon.plist",
      );
      if (existsSync(plistPath)) hasService = true;
    }
    // Check Linux systemd
    if (process.platform === "linux") {
      if (existsSync("/etc/systemd/system/volute.service")) hasService = true;
      const userUnit = resolve(
        process.env.HOME || "",
        ".config",
        "systemd",
        "user",
        "volute.service",
      );
      if (existsSync(userUnit)) hasService = true;
    }
  } catch {
    // Detection is best-effort
  }

  const setup: SetupConfig = {
    type: isSystem ? "system" : "local",
    isolation: isSystem ? "user" : "none",
    mindsDir,
    service: hasService,
  };

  writeGlobalConfig({ ...config, setup });
}
