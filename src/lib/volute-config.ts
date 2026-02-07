import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
};

export function readVoluteConfig(agentDir: string): VoluteConfig {
  const path = resolve(agentDir, "volute.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function writeVoluteConfig(agentDir: string, config: VoluteConfig) {
  const path = resolve(agentDir, "volute.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
