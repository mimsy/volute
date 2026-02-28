import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

export type SystemsConfig = {
  apiKey: string;
  system: string;
  apiUrl: string;
};

const DEFAULT_API_URL = "https://volute.systems";

function configPath(): string {
  return resolve(voluteHome(), "systems.json");
}

export function readSystemsConfig(): SystemsConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`Warning: ${path} contains invalid JSON. Run "volute auth logout" and re-login.`);
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
  mkdirSync(voluteHome(), { recursive: true });
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
