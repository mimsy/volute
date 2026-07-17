import { cleanExpiredSessions } from "../../web/middleware/auth.js";
import { cleanExpiredEvents } from "../chat/system-events.js";
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
