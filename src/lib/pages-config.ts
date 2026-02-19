import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

export type PagesConfig = {
  apiKey: string;
  system: string;
  apiUrl: string;
};

const DEFAULT_API_URL = "https://pages.volute.dev";

function configPath(): string {
  return resolve(voluteHome(), "pages.json");
}

export function readPagesConfig(): PagesConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!data.apiKey || !data.system) return null;
    return {
      apiKey: data.apiKey,
      system: data.system,
      apiUrl: data.apiUrl || DEFAULT_API_URL,
    };
  } catch {
    return null;
  }
}

export function writePagesConfig(config: PagesConfig): void {
  mkdirSync(voluteHome(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function deletePagesConfig(): boolean {
  const path = configPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
