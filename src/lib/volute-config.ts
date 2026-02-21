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
  maxThinkingTokens?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  connectors?: string[];
  schedules?: Schedule[];
  channels?: Record<string, { showToolCalls?: boolean }>;
  tokenBudget?: number;
  tokenBudgetPeriodMinutes?: number;
  identity?: { privateKey?: string; publicKey?: string };
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

export function readVoluteConfig(mindDir: string): VoluteConfig | null {
  const path = resolve(mindDir, "home/.config/volute.json");
  return readJson(path);
}

export function writeVoluteConfig(mindDir: string, config: VoluteConfig) {
  const path = resolve(mindDir, "home/.config/volute.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
