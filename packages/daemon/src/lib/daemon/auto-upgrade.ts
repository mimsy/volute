import { alertHost } from "../chat/system-events.js";
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

/** The alert kind {@link alertHost} fans out when an auto-upgrade can't complete. */
export const UPGRADE_ALERT_KIND = "upgrade_failed";

/** In-memory only — cleared per-mind at the start of each attempt and on success. */
const blocked = new Map<string, AutoUpgradeBlocked>();

/**
 * Minds whose auto-upgrade already failed in this daemon run, mapped to the reason.
 * The hourly pass skips them: a failure here needs the mind or a host to act (a
 * refusing pre-commit hook, a merge conflict), and re-running the whole template
 * merge every hour for two weeks only burns I/O and re-creates worktrees — which is
 * exactly what bardo did through August 2026. Cleared on success and by
 * {@link pruneBlocked} when the mind leaves the eligible set, so a resolved mind is
 * picked up again without waiting for a daemon restart.
 */
const failedThisRun = new Map<string, string>();

/**
 * The reason each mind was last alerted about. A cheap guard against telling a mind
 * the same thing twice for one unresolved failure — it is not the primary quieting
 * mechanism (the attempt gate above is; a mind that isn't retried can't re-alert).
 *
 * Pruned with the rest: leaving the eligible set means the mind was upgraded, by hand
 * or otherwise, or opted out — the failure is over. A failure after that is a new
 * failure and gets said out loud again, the same way a failure after a clean auto
 * upgrade does.
 */
const alertedReason = new Map<string, string>();

/** In-memory record of minds whose last auto-upgrade backed off (conflicts/errors). */
export function getUpgradeBlocked(name: string): AutoUpgradeBlocked | undefined {
  return blocked.get(name);
}

/** Test seam: forget every in-memory auto-upgrade failure/alert record. */
export function resetAutoUpgradeState(): void {
  blocked.clear();
  failedThisRun.clear();
  alertedReason.clear();
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
  alertHost: (name: string, kind: string, text: string) => Promise<void>;
  delay: (ms: number) => Promise<void>;
};

const defaultAutoUpgradeOneDeps: AutoUpgradeOneDeps = {
  isRunning: (name) => getMindManager().isRunning(name),
  runUpgrade,
  abortUpgrade,
  alertHost,
  delay: sleep,
};

/**
 * The text a mind gets when its auto-upgrade fails. `detail` is the failing command's
 * own output — a mind that can read why its framework stopped updating (a hook of its
 * own refusing the pre-upgrade commit, say) can usually fix it in a minute, which is
 * the entire point of alerting it rather than journald.
 */
export function upgradeFailureText(mindName: string, detail: string): string {
  return (
    `Your framework auto-upgrade failed, so you are still running the older template.\n\n` +
    `${detail.trim()}\n\n` +
    `Automatic attempts are paused until this upgrade succeeds or the daemon restarts ` +
    `— retrying the same doomed merge every hour helps nobody. Nothing is waiting on ` +
    `that, though: once whatever is blocking it is resolved, run ` +
    `\`volute mind upgrade ${mindName}\` yourself and it runs immediately, or ask your ` +
    `host to. To stop automatic attempts entirely, set "upgrades": "manual" in ` +
    `home/.config/volute.json.`
  );
}

/** stderr if the failing command produced any, else the error message. */
export function failureDetail(err: unknown): string {
  const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
  if (stderr) return stderr;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Removes per-mind records for minds that are not in this pass's eligible set
 * (resolved manually, opted out, or removed from the registry) — otherwise a
 * conflict a host resolves by hand keeps a stale "upgrade blocked" badge
 * forever, and a mind that was fixed would never be attempted again this run.
 * Entries for minds that ARE eligible are left untouched here; the per-mind
 * attempt below clears or replaces them once the outcome is known.
 *
 * Applied to all three per-mind maps, `alertedReason` included: a mind that left the
 * set was fixed (or opted out), so the next failure it hits is news again.
 */
export function pruneBlocked<T>(blockedMap: Map<string, T>, eligibleNames: Set<string>): void {
  for (const name of blockedMap.keys()) {
    if (!eligibleNames.has(name)) blockedMap.delete(name);
  }
}

/** Apply {@link pruneBlocked} to this module's per-run state. */
export function pruneAutoUpgradeState(eligibleNames: Set<string>): void {
  pruneBlocked(blocked, eligibleNames);
  pruneBlocked(failedThisRun, eligibleNames);
  pruneBlocked(alertedReason, eligibleNames);
}

/**
 * Record a failed auto-upgrade and, unless the mind has already been told about this
 * exact failure in this daemon run, alert it (plus the spirit and the dashboard).
 * `reason` is the short form that backs the UI badge and the alert dedupe; `detail`
 * is what the mind reads.
 */
async function recordFailure(
  name: string,
  reason: string,
  detail: string,
  deps: AutoUpgradeOneDeps,
): Promise<void> {
  blocked.set(name, { reason, at: new Date() });
  failedThisRun.set(name, reason);
  if (alertedReason.get(name) === reason) return;
  alertedReason.set(name, reason);
  try {
    await deps.alertHost(name, UPGRADE_ALERT_KIND, upgradeFailureText(name, detail));
  } catch (err) {
    // alertHost swallows its own failures; this is a backstop so a broken alert
    // path can never turn a recorded failure into an unhandled rejection.
    alog.error(`failed to alert ${name} about its upgrade failure`, log.errorData(err));
  }
}

/**
 * Auto-upgrade a single mind. Never throws — every failure path records a
 * blocked reason and returns, so the caller's per-mind try/catch is a backstop
 * rather than the primary handling. Collaborators are injectable (defaulting to
 * the real daemon-wide singletons) so each branch is unit-testable without a
 * running daemon.
 *
 * A mind that already failed in this daemon run is skipped entirely — see
 * {@link failedThisRun}.
 */
export async function autoUpgradeOne(
  entry: MindEntry,
  sleeping: boolean,
  deps: AutoUpgradeOneDeps = defaultAutoUpgradeOneDeps,
): Promise<void> {
  if (failedThisRun.has(entry.name)) return;
  // Clear the previous outcome only once we're actually going to attempt again,
  // so a skipped mind keeps the reason its badge and alert dedupe are built on.
  blocked.delete(entry.name);

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
      // Someone is mid-resolution by hand — not a failure, and not something to
      // alert about or gate on; the next pass should look again.
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
      await recordFailure(entry.name, message, failureDetail(err2), deps);
      return;
    }
  }

  if (outcome.status === "conflicts") {
    await deps.abortUpgrade(entry.name).catch((err) => {
      alog.warn(`failed to abort conflicted auto-upgrade for ${entry.name}`, log.errorData(err));
    });
    const fileList = outcome.files.join(", ");
    await recordFailure(
      entry.name,
      `merge conflicts: ${fileList}`,
      `The template merge conflicted in: ${fileList}.` +
        (outcome.message ? ` ${outcome.message}` : ""),
      deps,
    );
    return;
  }

  // Upgraded. A success resolves whatever was wrong, so drop both the attempt gate
  // and the alert record — if this mind breaks again later, even in the same way,
  // that is news and gets its own alert. (pruneAutoUpgradeState does the same for a
  // mind fixed by hand, which leaves the eligible set instead of passing through here.)
  failedThisRun.delete(entry.name);
  alertedReason.delete(entry.name);
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

  pruneAutoUpgradeState(new Set(eligible.map((e) => e.name)));

  if (eligible.length === 0) return;

  const attempting = eligible.filter((e) => !failedThisRun.has(e.name));
  if (attempting.length === 0) return;

  alog.info(`auto-upgrade pass starting for ${attempting.length} mind(s)`, {
    minds: attempting.map((e) => e.name),
    skippedAfterFailure: eligible.length - attempting.length,
  });

  for (const entry of attempting) {
    try {
      await autoUpgradeOne(entry, isSleeping(entry.name));
    } catch (err) {
      // Backstop: autoUpgradeOne shouldn't throw, but one mind's failure must
      // never stop the walk.
      alog.error(`unexpected error auto-upgrading ${entry.name}`, log.errorData(err));
      await recordFailure(
        entry.name,
        err instanceof Error ? err.message : String(err),
        failureDetail(err),
        defaultAutoUpgradeOneDeps,
      );
    }
  }
}
