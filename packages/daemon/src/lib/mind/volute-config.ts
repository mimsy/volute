import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Schedule = {
  id: string;
  cron?: string;
  fireAt?: string; // ISO date for one-time timers
  message?: string;
  script?: string;
  enabled: boolean;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
  channel?: string; // deprecated — use session instead
  session?: string; // target session name (e.g. "$new" for isolated session)
};

export type WakeTriggerConfig = {
  mentions?: boolean;
  dms?: boolean;
  channels?: string[];
  senders?: string[];
};

export type SleepConfig = {
  enabled?: boolean;
  schedule?: { sleep: string; wake: string };
  wakeTriggers?: WakeTriggerConfig;
};

export type MindProfile = {
  displayName?: string;
  description?: string;
  avatar?: string; // relative path from home/, e.g. "avatar.png"
};

export type CognitionConfig = {
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxThinkingTokens?: number;
  tokenBudget?: number;
  tokenBudgetPeriodMinutes?: number;
};

export type VoluteConfig = CognitionConfig & {
  schedules?: Schedule[];
  identity?: { privateKey: string; publicKey: string };
  profile?: MindProfile;
  sleep?: SleepConfig;
  echoText?: boolean;
  unescapeNewlines?: boolean;
  [key: string]: unknown;
};

function readJson(path: string): VoluteConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`[volute-config] failed to parse ${path}: ${err}`);
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
