import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { voluteHome, voluteSystemDir, voluteUserHome } from "./registry.js";

export type SystemsConfig = {
  apiKey: string;
  system: string;
  apiUrl: string;
};

const DEFAULT_API_URL = "https://volute.systems";

function configPath(): string {
  return resolve(voluteSystemDir(), "systems.json");
}

/** Migrate systems.json from old locations to the system directory. */
function migrateIfNeeded(): void {
  const target = configPath();
  if (existsSync(target)) return;

  // Check old locations: ~/.volute/systems.json and VOLUTE_HOME/systems.json
  const oldPaths = [
    resolve(voluteUserHome(), "systems.json"),
    resolve(voluteHome(), "systems.json"),
  ];
  for (const old of oldPaths) {
    if (old !== target && existsSync(old)) {
      try {
        mkdirSync(voluteSystemDir(), { recursive: true });
        renameSync(old, target);
      } catch {
        // Migration failed (e.g. cross-device rename) — read from old location
      }
      return;
    }
  }
}

export function readSystemsConfig(): SystemsConfig | null {
  migrateIfNeeded();
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(
      `Warning: ${path} contains invalid JSON. Run "volute systems logout" and re-login.`,
    );
    return null;
  }
  if (!data.apiKey || !data.system) return null;
  return {
    apiKey: data.apiKey as string,
    system: data.system as string,
    apiUrl: (data.apiUrl as string) || DEFAULT_API_URL,
  };
}

export function writeSystemsConfig(config: SystemsConfig): void {
  mkdirSync(voluteSystemDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function deleteSystemsConfig(): boolean {
  try {
    unlinkSync(configPath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
