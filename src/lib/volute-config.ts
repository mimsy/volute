import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Schedule = {
  id: string;
  cron: string;
  message: string;
  enabled: boolean;
};

export type VoluteConfig = {
  model?: string;
  connectors?: string[];
  schedules?: Schedule[];
  channels?: Record<string, { showToolCalls?: boolean }>;
  [key: string]: unknown;
};

function readJson(path: string): VoluteConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function readVoluteConfig(agentDir: string): VoluteConfig | null {
  const path = resolve(agentDir, "home/.config/volute.json");
  return readJson(path);
}

export function writeVoluteConfig(agentDir: string, config: VoluteConfig) {
  const path = resolve(agentDir, "home/.config/volute.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
