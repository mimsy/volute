import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { chownMindFile } from "./isolation.js";
import { getBaseName } from "./registry.js";

export type Schedule = {
  id: string;
  cron?: string;
  fireAt?: string; // ISO timestamp for one-time schedules
  message?: string;
  messages?: string[]; // rotating pool — one is picked at random per fire
  script?: string;
  enabled: boolean;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
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
  /** Spend cap in USD per `spendCapPeriodMinutes`. Replaces the old `tokenBudget`. */
  spendCap?: number;
  /** Length of the spend period in minutes. Default 1440 (a day). */
  spendCapPeriodMinutes?: number;
  /**
   * Pre-0.59 token budget. Read only to warn the host that it no longer does
   * anything (`restoreMindRuntimeState`) — never enforced.
   */
  tokenBudget?: number;
};

export type VoluteConfig = CognitionConfig & {
  schedules?: Schedule[];
  identity?: { privateKey: string; publicKey: string };
  profile?: MindProfile;
  sleep?: SleepConfig;
  echoText?: boolean;
  unescapeNewlines?: boolean;
  /** Opt out of the post-startup auto-upgrade pass. Absent/"auto" → eligible. */
  upgrades?: "auto" | "manual";
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

/**
 * Write volute.json in place. Returns the paths this write created (the config
 * dir and/or the file) — a created path is born owned by the daemon, so a caller
 * writing into a live mind's home must hand it over; see writeMindVoluteConfig.
 */
export function writeVoluteConfig(mindDir: string, config: VoluteConfig): string[] {
  const path = resolve(mindDir, "home/.config/volute.json");
  const created: string[] = [];
  const firstDir = mkdirSync(dirname(path), { recursive: true });
  // mkdirSync names only the topmost dir it made; chown each one below it too.
  if (firstDir) {
    for (let d = dirname(path); d.length >= firstDir.length; d = dirname(d)) created.unshift(d);
  }
  // The daemon writes here with its own privileges (root under user isolation), and
  // the mind owns this tree: refuse a .config/ that a symlink leads out of it, and
  // never follow a symlink planted at volute.json itself.
  const realBase = realpathSync(mindDir);
  if (!realpathSync(dirname(path)).startsWith(realBase + sep)) {
    throw new Error(`${dirname(path)} resolves outside ${mindDir}`);
  }
  const data = `${JSON.stringify(config, null, 2)}\n`;
  const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC, O_NOFOLLOW } = constants;
  let fd: number;
  try {
    // Exclusive create: tells us the file is new without a check-then-write race.
    fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    created.push(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Truncate in place, which keeps the mind's ownership of the existing file.
    fd = openSync(path, O_WRONLY | O_TRUNC | O_NOFOLLOW);
  }
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return created;
}

/**
 * writeVoluteConfig for a mind that already exists: whatever the write created is
 * handed to the mind's user, or under user isolation the mind could not edit or
 * delete its own config (#1072). No-op chown when isolation is off.
 */
export async function writeMindVoluteConfig(
  name: string,
  mindDir: string,
  config: VoluteConfig,
): Promise<void> {
  await chownVoluteConfigPaths(name, writeVoluteConfig(mindDir, config));
}

/** Hand paths writeVoluteConfig created to the mind (its parent, for a variant). */
export async function chownVoluteConfigPaths(
  name: string,
  created: string[],
  chown: (path: string, name: string) => Promise<void> = chownMindFile,
): Promise<void> {
  if (created.length === 0) return;
  const owner = await getBaseName(name);
  for (const p of created) await chown(p, owner);
}
