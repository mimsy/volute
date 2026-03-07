import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stateDir, voluteHome } from "./registry.js";

export function sharedEnvPath(): string {
  return resolve(voluteHome(), "env.json");
}

export function mindEnvPath(mindName: string): string {
  return resolve(stateDir(mindName), "env.json");
}

export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function writeEnv(path: string, env: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
}

export function loadMergedEnv(mindName: string): Record<string, string> {
  const shared = readEnv(sharedEnvPath());
  const mind = readEnv(mindEnvPath(mindName));
  return { ...shared, ...mind };
}
