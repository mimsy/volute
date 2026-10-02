import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import log from "../util/logger.js";
import { notifyMindOfVersion } from "../version-notify.js";

/** The MindManager surface {@link restartOntoMerge} uses — narrowed so tests can stub it. */
export type MergeRestartTarget = {
  isUpOrRecovering(name: string): boolean;
  stopMind(name: string): Promise<void>;
  startMind(name: string, opts?: { healthTimeoutMs?: number }): Promise<void>;
  setPendingContext(name: string, context: Record<string, unknown>): void;
};

/**
 * `isSleeping`, not `getState().sleeping`: a trigger-woken mind is recorded as sleeping
 * but has a live process taking inbound, so leaving it down would deliver to nothing.
 */
function defaultIsAsleep(name: string): boolean {
  return getSleepManagerIfReady()?.isSleeping(name) ?? false;
}

/**
 * Restart a mind onto merged source (an upgrade, or a variant join into its parent),
 * handing it `context` once the new process is healthy.
 *
 * A mind the sleep manager put to sleep while the merge and install ran is left down
 * (#1309): its wake starts it, and that start delivers the context, which is persisted
 * on disk either way. Booting it here would leave a live process the sleep state says
 * is asleep, with its inbound queued until a wake that never runs its ritual.
 *
 * Returns `"asleep"` when the start was skipped for that reason. Throws whatever the
 * stop or start throws; the callers own their failure handling. A start sends the
 * version notice, as every start does.
 */
export async function restartOntoMerge(
  manager: MergeRestartTarget,
  name: string,
  context: Record<string, unknown>,
  opts: { healthTimeoutMs?: number; isAsleep?: (name: string) => boolean } = {},
): Promise<"started" | "asleep"> {
  // A mind waiting out a crash backoff is stopped too: that cancels its pending
  // restart, which would otherwise race the start below (#1114).
  if (manager.isUpOrRecovering(name)) {
    await manager.stopMind(name);
  }
  manager.setPendingContext(name, context);
  // Checked last, right before the start: the install before it is the long window
  // in which the sleep manager can put the mind to sleep. Only a *finished* bedtime is
  // seen: `isSleeping` turns true at the end of the ritual, after the stop and the
  // session archive. Accepted gap: a bedtime still under way at this check, or one
  // that begins between it and the spawn, overlaps the start.
  if ((opts.isAsleep ?? defaultIsAsleep)(name)) return "asleep";
  await manager.startMind(name, { healthTimeoutMs: opts.healthTimeoutMs });
  // Like every other start: a mind stopped through a Volute update and started by its
  // own upgrade hears what changed now, not at some later start (once — #1365).
  notifyMindOfVersion(name).catch((err: unknown) =>
    log.error(`failed to send the version notice to ${name}`, log.errorData(err)),
  );
  return "started";
}
