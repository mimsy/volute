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
  skipWhenSleeping?: boolean; // legacy — treated as whileSleeping: "skip"
  channel?: string;
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

export type VoluteConfig = {
  model?: string;
  maxThinkingTokens?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  schedules?: Schedule[];
  channels?: Record<string, { showToolCalls?: boolean }>;
  tokenBudget?: number;
  tokenBudgetPeriodMinutes?: number;
  identity?: { privateKey: string; publicKey: string };
  profile?: MindProfile;
  sleep?: SleepConfig;
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
  const config = readJson(path);
  if (!config) return null;
  // Migrate legacy top-level profile fields into profile object
  const legacy = config as Record<string, unknown>;
  if (
    !config.profile &&
    ("displayName" in config || "description" in config || "avatar" in config)
  ) {
    config.profile = {
      displayName: legacy.displayName as string | undefined,
      description: legacy.description as string | undefined,
      avatar: legacy.avatar as string | undefined,
    };
    delete legacy.displayName;
    delete legacy.description;
    delete legacy.avatar;
  }
  return config;
}

export function writeVoluteConfig(mindDir: string, config: VoluteConfig) {
  const path = resolve(mindDir, "home/.config/volute.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
