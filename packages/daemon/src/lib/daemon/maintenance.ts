import { cleanExpiredSessions } from "../../web/middleware/auth.js";
import { cleanExpiredEvents, findStrandedEventMinds } from "../chat/system-events.js";
import { reportStaleApiPaths } from "../template/stale-api-paths.js";
import { cleanExpiredLogs } from "../util/history-cleanup.js";
import log from "../util/logger.js";

/** Hourly maintenance cadence. Retention policies that only run at restart aren't policies. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Run all daemon maintenance cleanups once. Each cleanup is guarded on its own so
 * a transient DB error in one doesn't skip the rest (or kill the recurring interval).
 */
export async function runMaintenance(): Promise<void> {
  try {
    await cleanExpiredSessions();
  } catch (err) {
    log.warn("maintenance: failed to clean expired sessions", log.errorData(err));
  }
  try {
    await cleanExpiredLogs();
  } catch (err) {
    log.warn("maintenance: failed to clean expired logs", log.errorData(err));
  }
  try {
    await cleanExpiredEvents();
  } catch (err) {
    log.warn("maintenance: failed to clean expired events", log.errorData(err));
  }
  try {
    await warnStrandedEvents();
  } catch (err) {
    log.warn("maintenance: failed to check for stranded events", log.errorData(err));
  }
  try {
    await reportStaleApiPaths();
  } catch (err) {
    log.warn("maintenance: failed to check for stale API paths", log.errorData(err));
  }
}

/**
 * Warn about minds whose next-turn system events are accumulating undrained.
 *
 * Re-warns on every sweep rather than once per process: the condition is a live
 * breakage (the mind is not hearing crash notices, delivery failures, or anything
 * else on that channel), and one hourly line per affected mind stops the moment
 * the drain works again. Silence here is the failure mode this exists to prevent.
 */
async function warnStrandedEvents(): Promise<void> {
  for (const s of await findStrandedEventMinds()) {
    log.warn(
      `${s.mind} has ${s.pending} undelivered next-turn system event${s.pending === 1 ? "" : "s"} ` +
        `and has completed ${s.turnsSince} turns without draining them (oldest is ${s.ageHours}h old). ` +
        `Its pre-prompt drain hook is missing or failing — check ` +
        `home/.local/hooks/pre-prompt/notices.ts. If that file is Volute's (unedited), ` +
        `\`volute mind upgrade ${s.mind}\` will restore or refresh it; if the mind has edited ` +
        `it, upgrade leaves it alone on purpose and it has to be repaired by hand. ` +
        `The "stale-api-paths" log category names the specific files when the cause is a removed API path.`,
      { mind: s.mind, pending: s.pending, turnsSince: s.turnsSince, ageHours: s.ageHours },
    );
  }
}

/**
 * Start the recurring maintenance interval. Returns the timer handle so the
 * caller can clear it during shutdown.
 */
export function startMaintenanceInterval(
  intervalMs: number = MAINTENANCE_INTERVAL_MS,
  task: () => Promise<void> = runMaintenance,
): NodeJS.Timeout {
  const handle = setInterval(() => void task(), intervalMs);
  handle.unref?.();
  return handle;
}
