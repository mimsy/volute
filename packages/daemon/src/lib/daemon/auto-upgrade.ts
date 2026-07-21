import { deliverEvent } from "../chat/system-events.js";
import { type MindEntry, mindDir, readRegistry } from "../mind/registry.js";
import { isTemplateStale } from "../mind/template-staleness.js";
import {
  abortUpgrade,
  runUpgrade,
  UpgradeInProgressError,
  type UpgradeOutcome,
} from "../mind/upgrade.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "../util/logger.js";
import { getMindManager } from "./mind-manager.js";
import { getSleepManagerIfReady } from "./sleep-manager.js";

const alog = log.child("auto-upgrade");

/** Delay before the single retry attempt for a transient (thrown) upgrade error. */
const RETRY_DELAY_MS = 5000;

export type AutoUpgradeBlocked = { reason: string; at: Date };

/** In-memory only — cleared per-mind at the start of each pass and on success. */
const blocked = new Map<string, AutoUpgradeBlocked>();

/** In-memory record of minds whose last auto-upgrade backed off (conflicts/errors). */
export function getUpgradeBlocked(name: string): AutoUpgradeBlocked | undefined {
  return blocked.get(name);
}

export type SelectEligibleDeps = {
  isStale: (entry: MindEntry) => boolean;
  isSleeping: (name: string) => boolean;
  readConfig: (name: string) => { upgrades?: "auto" | "manual" } | null;
};

/**
 * Pure eligibility + ordering over registry entries: stale, non-seed/spirit/variant
 * minds that haven't opted out via `"upgrades": "manual"`, sorted sleeping-first
 * (stable — ties keep their original relative order).
 */
export function selectEligible(entries: MindEntry[], deps: SelectEligibleDeps): MindEntry[] {
  const eligible = entries.filter((entry) => {
    if (entry.mindType !== "mind") return false;
    if (entry.stage === "seed") return false;
    if (entry.parent) return false;
    if (!deps.isStale(entry)) return false;
    if (deps.readConfig(entry.name)?.upgrades === "manual") return false;
    return true;
  });

  return eligible.sort((a, b) => {
    const aSleeping = deps.isSleeping(a.name) ? 0 : 1;
    const bSleeping = deps.isSleeping(b.name) ? 0 : 1;
    return aSleeping - bSleeping;
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collaborators of {@link autoUpgradeOne}, injectable so its branches are unit-testable. */
export type AutoUpgradeOneDeps = {
  isRunning: (name: string) => boolean;
  runUpgrade: (name: string, opts: { restart: boolean }) => Promise<UpgradeOutcome>;
  abortUpgrade: (name: string) => Promise<void>;
  deliverEvent: (name: string, input: { type: string; body: string }) => Promise<unknown>;
  delay: (ms: number) => Promise<void>;
};

const defaultAutoUpgradeOneDeps: AutoUpgradeOneDeps = {
  isRunning: (name) => getMindManager().isRunning(name),
  runUpgrade,
  abortUpgrade,
  deliverEvent: (name, input) => deliverEvent(name, input),
  delay: sleep,
};

/**
 * Removes blocked records for minds that are not in this pass's eligible set
 * (resolved manually, opted out, or removed from the registry) — otherwise a
 * conflict a host resolves by hand keeps a stale "upgrade blocked" badge
 * forever. Entries for minds that ARE eligible are left untouched here; the
 * per-mind attempt below clears or replaces them once the outcome is known.
 */
export function pruneBlocked(
  blockedMap: Map<string, AutoUpgradeBlocked>,
  eligibleNames: Set<string>,
): void {
  for (const name of blockedMap.keys()) {
    if (!eligibleNames.has(name)) blockedMap.delete(name);
  }
}

/**
 * Auto-upgrade a single mind. Never throws — every failure path records a
 * blocked reason and returns, so the caller's per-mind try/catch is a backstop
 * rather than the primary handling. Collaborators are injectable (defaulting to
 * the real daemon-wide singletons) so each branch is unit-testable without a
 * running daemon.
 */
export async function autoUpgradeOne(
  entry: MindEntry,
  sleeping: boolean,
  deps: AutoUpgradeOneDeps = defaultAutoUpgradeOneDeps,
): Promise<void> {
  const wasRunning = deps.isRunning(entry.name);
  // Never restart a sleeping mind (it's supposed to stay stopped), and never
  // skip restarting a mind that was actually running — that would leave it
  // executing the old code.
  const restart = wasRunning && !sleeping;

  const attempt = () => deps.runUpgrade(entry.name, { restart });

  let outcome: UpgradeOutcome;
  try {
    outcome = await attempt();
  } catch (err) {
    if (err instanceof UpgradeInProgressError) {
      blocked.set(entry.name, {
        reason: "upgrade already in progress (mid conflict resolution)",
        at: new Date(),
      });
      return;
    }
    // Transient failure — retry once after a short delay before giving up.
    await deps.delay(RETRY_DELAY_MS);
    try {
      outcome = await attempt();
    } catch (err2) {
      const message = err2 instanceof Error ? err2.message : String(err2);
      alog.error(`auto-upgrade failed for ${entry.name} after retry`, log.errorData(err2));
      blocked.set(entry.name, { reason: message, at: new Date() });
      return;
    }
  }

  if (outcome.status === "conflicts") {
    await deps.abortUpgrade(entry.name).catch((err) => {
      alog.warn(`failed to abort conflicted auto-upgrade for ${entry.name}`, log.errorData(err));
    });
    const fileList = outcome.files.join(", ");
    await deps.deliverEvent(entry.name, {
      type: "notice",
      body:
        `Auto-upgrade hit merge conflicts in: ${fileList}. Run \`volute mind upgrade ${entry.name}\` ` +
        `to resolve them manually (or set "upgrades": "manual" in home/.config/volute.json to stop ` +
        `auto attempts).`,
    });
    blocked.set(entry.name, { reason: `merge conflicts: ${fileList}`, at: new Date() });
  }
}

/** Serialized auto-upgrade pass over stale, eligible minds. Never throws. */
export async function runAutoUpgrades(): Promise<void> {
  let entries: MindEntry[];
  try {
    entries = await readRegistry();
  } catch (err) {
    alog.error("failed to read registry for auto-upgrade pass", log.errorData(err));
    return;
  }

  const sleepManager = getSleepManagerIfReady();
  const isSleeping = (name: string) => sleepManager?.isSleeping(name) ?? false;

  const eligible = selectEligible(entries, {
    isStale: (entry) => isTemplateStale(entry),
    isSleeping,
    readConfig: (name) => readVoluteConfig(mindDir(name)),
  });

  pruneBlocked(blocked, new Set(eligible.map((e) => e.name)));

  if (eligible.length === 0) return;

  alog.info(`auto-upgrade pass starting for ${eligible.length} mind(s)`, {
    minds: eligible.map((e) => e.name),
  });

  for (const entry of eligible) {
    blocked.delete(entry.name);
    try {
      await autoUpgradeOne(entry, isSleeping(entry.name));
    } catch (err) {
      // Backstop: autoUpgradeOne shouldn't throw, but one mind's failure must
      // never stop the walk.
      alog.error(`unexpected error auto-upgrading ${entry.name}`, log.errorData(err));
      blocked.set(entry.name, {
        reason: err instanceof Error ? err.message : String(err),
        at: new Date(),
      });
    }
  }
}
