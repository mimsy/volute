import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Schedule = {
  id: string;
  cron?: string;
  fireAt?: string; // ISO timestamp for one-time schedules
  message?: string;
  messages?: string[]; // rotating pool — one is picked at random per fire
  script?: string;
  enabled: boolean;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
  channel?: string; // deprecated — use thread instead
  thread?: string; // target thread name (e.g. "$new" for isolated thread)
};

export type WakeTriggerConfig = {
  mentions?: boolean;
  dms?: boolean;
  channels?: string[];
  senders?: string[];
};

/**
 * Effective defaults for wake triggers when a mind hasn't configured them.
 * Mentions and DMs wake a sleeping mind by default. This is the single source
 * of truth for the runtime default; the web UI mirrors these values so the
 * settings form reflects actual behavior.
 */
export const WAKE_TRIGGER_DEFAULTS = { mentions: true, dms: true } as const;

/** Resolve the effective mentions/dms wake-trigger settings, applying defaults. */
export function resolveWakeTriggers(triggers?: WakeTriggerConfig): {
  mentions: boolean;
  dms: boolean;
} {
  return {
    mentions: triggers?.mentions ?? WAKE_TRIGGER_DEFAULTS.mentions,
    dms: triggers?.dms ?? WAKE_TRIGGER_DEFAULTS.dms,
  };
}

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
