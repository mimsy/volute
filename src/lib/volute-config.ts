import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  const newPath = resolve(agentDir, "home/.config/volute.json");
  const oldPath = resolve(agentDir, "volute.json");
  const config = readJson(newPath);
  if (config) {
    // Migrate: if old config has fields missing from new config, merge them
    const old = readJson(oldPath);
    if (old) {
      let migrated = false;
      if (old.schedules?.length && !config.schedules?.length) {
        config.schedules = old.schedules;
        migrated = true;
      }
      if (old.connectors?.length && !config.connectors?.length) {
        config.connectors = old.connectors;
        migrated = true;
      }
      if (migrated) {
        writeVoluteConfig(agentDir, config);
        unlinkSync(oldPath);
      }
    }
    return config;
  }
  // Fall back to legacy location
  return readJson(oldPath) ?? {};
}

export function writeVoluteConfig(agentDir: string, config: VoluteConfig) {
  const path = resolve(agentDir, "home/.config/volute.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
