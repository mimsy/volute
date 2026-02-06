import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { VOLUTE_HOME } from "./registry.js";

export function sharedEnvPath(): string {
  return resolve(VOLUTE_HOME, "env.json");
}

export function agentEnvPath(agentDir: string): string {
  return resolve(agentDir, ".volute", "env.json");
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
  writeFileSync(path, `${JSON.stringify(env, null, 2)}\n`);
}

export function loadMergedEnv(agentDir: string): Record<string, string> {
  const shared = readEnv(sharedEnvPath());
  const agent = readEnv(agentEnvPath(agentDir));
  return { ...shared, ...agent };
}
