import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { mindFileOwner } from "./isolation.js";
import { type MindFileOwner, readMindFileSync, replaceMindFile } from "./mind-file-write.js";
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

/**
 * Daemon-side cognition settings. A mind's model and thinking level are not here:
 * they live only in `home/.config/config.json`, the file the template actually runs
 * from — a second copy in volute.json drifted and made the settings page lie.
 */
export type CognitionConfig = {
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
    return JSON.parse(readMindFileSync(path));
  } catch (err) {
    console.error(`[volute-config] failed to parse ${path}: ${err}`);
    return null;
  }
}

export function readVoluteConfig(mindDir: string): VoluteConfig | null {
  const path = resolve(mindDir, "home/.config/volute.json");
  return readJson(path);
}

const VOLUTE_JSON = "home/.config/volute.json";

/** volute.json is there but unparseable: refused rather than overwritten (it is the mind's). */
export class UnparseableConfigError extends Error {}

/**
 * Write volute.json through {@link replaceMindFile}: the daemon is root under user
 * isolation and the mind owns this tree, so nothing it plants redirects the write, and
 * whatever the write creates (the file, `.config/`) is handed to `owner` — or the mind
 * could not edit its own config (#1072). Replaced whole, never truncated in place:
 * `readVoluteConfig` is synchronous, and must never read a half-written file. `owner` is null for a tree not handed over yet
 * (creation, before `chownMindDir`) or when isolation is off.
 */
export async function writeVoluteConfig(
  mindDir: string,
  config: VoluteConfig,
  owner: MindFileOwner | null,
): Promise<void> {
  await replaceMindFile(mindDir, VOLUTE_JSON, `${JSON.stringify(config, null, 2)}\n`, { owner });
}

/**
 * Read-modify-write volute.json under one handle, so concurrent updates can't drop each
 * other's change. `fn` gets the current config (`{}` when there is none) and returns the
 * config to write, or null to leave the file alone. An unparseable file is refused rather
 * than overwritten — it is the mind's, and replacing it would lose its profile and
 * schedules. Returns whether it wrote.
 */
export async function updateVoluteConfig(
  mindDir: string,
  owner: MindFileOwner | null,
  fn: (config: VoluteConfig) => VoluteConfig | null,
): Promise<boolean> {
  return replaceMindFile(
    mindDir,
    VOLUTE_JSON,
    (text) => {
      let current: VoluteConfig = {};
      if (text.trim()) {
        try {
          current = JSON.parse(text);
        } catch {
          throw new UnparseableConfigError(
            `${VOLUTE_JSON} is unparseable — fix or remove it; not modifying it`,
          );
        }
      }
      const next = fn(current);
      return next ? `${JSON.stringify(next, null, 2)}\n` : null;
    },
    { owner },
  );
}

/** {@link updateVoluteConfig} for a mind that already exists (its parent's owner, for a variant). */
export async function updateMindVoluteConfig(
  name: string,
  mindDir: string,
  fn: (config: VoluteConfig) => VoluteConfig | null,
): Promise<boolean> {
  return updateVoluteConfig(mindDir, await mindFileOwner(await getBaseName(name)), fn);
}
