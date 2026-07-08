import { CronExpressionParser } from "cron-parser";
import { readBackupState, runBackup } from "../backup/backup.js";
import { readGlobalConfig } from "../config/setup.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { SPIRIT_NAME } from "../mind/registry.js";
import log from "../util/logger.js";

const blog = log.child("backup");

export const DEFAULT_BACKUP_SCHEDULE = "0 3 * * *";

/**
 * Notify the operator on the 1st scheduled-backup failure and then every Nth
 * consecutive one. A persistently-broken repo shouldn't spam a message every
 * night, but a silent `lastError` in backup-state.json shouldn't sit unnoticed
 * until restore time either. The counter resets on the next success.
 */
const NOTIFY_EVERY_N_FAILURES = 5;

/**
 * Runs scheduled backups. Config is re-read each tick so enabling/changing the
 * schedule via the API takes effect without a daemon restart.
 */
export class BackupManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** Epoch-ms of the most recent scheduled fire this process has serviced. */
  private lastServicedFireMs = -1;
  private consecutiveFailures = 0;
  private warnedUnconfigured = false;

  start(): void {
    this.interval = setInterval(() => {
      this.tick().catch((err) => blog.error("backup tick failed", log.errorData(err)));
    }, 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * True at most once per scheduled fire (records the fire it consumed), and
   * only when backups are enabled and runnable. Not a pure predicate — a second
   * call for the same fire returns false.
   *
   * Catch-up: if the machine was asleep or the daemon was down across a
   * scheduled fire (a laptop at 3am), the fire is picked up on the next tick so
   * long as it falls after the last successful run (`lastRun` in
   * backup-state.json). Without an anchor (no successful backup yet) only the
   * exact on-time minute fires, so freshly enabling backups doesn't trigger an
   * immediate run.
   */
  isDue(now: Date = new Date()): boolean {
    const config = readGlobalConfig().backup;
    if (!config?.enabled) return false;
    if (!config.repository || !config.password) {
      if (!this.warnedUnconfigured) {
        blog.warn("scheduled backups are enabled but no repository is initialized — not running");
        this.warnedUnconfigured = true;
      }
      return false;
    }
    this.warnedUnconfigured = false;
    const cron = config.schedule || DEFAULT_BACKUP_SCHEDULE;
    const epochMinute = Math.floor(now.getTime() / 60000);
    let prevFireMs: number;
    try {
      const interval = CronExpressionParser.parse(cron, { currentDate: now });
      prevFireMs = interval.prev().toDate().getTime();
    } catch (err) {
      blog.warn(`invalid backup cron "${cron}"`, log.errorData(err));
      return false;
    }

    // Already handled this fire (dedupe within the process, incl. retries).
    if (prevFireMs <= this.lastServicedFireMs) return false;

    const lastRunMs = this.readLastRunMs();
    // Already completed this fire (or a later one) in a prior daemon session.
    if (lastRunMs !== null && prevFireMs <= lastRunMs) return false;

    const onTime = Math.floor(prevFireMs / 60000) === epochMinute;
    if (!onTime) {
      // A missed fire is only a catch-up relative to a known last run; without
      // one there's nothing to be "behind" on.
      if (lastRunMs === null) return false;
      blog.warn(
        `missed scheduled backup fire at ${new Date(prevFireMs).toISOString()}; running catch-up`,
      );
    }

    this.lastServicedFireMs = prevFireMs;
    return true;
  }

  private readLastRunMs(): number | null {
    const lastRun = readBackupState().lastRun;
    if (!lastRun) return null;
    const ms = Date.parse(lastRun);
    return Number.isNaN(ms) ? null : ms;
  }

  private async tick(): Promise<void> {
    if (!this.isDue()) return;
    blog.info("scheduled backup starting");
    try {
      await runBackup();
      this.recordSuccess();
    } catch (err) {
      blog.error("scheduled backup failed", log.errorData(err));
      await this.recordFailure(err);
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Track consecutive scheduled-backup failures and actively notify the operator
   * on the 1st and then every Nth. Returns whether it notified (for tests).
   * Notification failures are swallowed — surfacing a backup failure must never
   * take the daemon's backup loop down with it.
   */
  async recordFailure(err: unknown): Promise<boolean> {
    this.consecutiveFailures += 1;
    const n = this.consecutiveFailures;
    if (n !== 1 && n % NOTIFY_EVERY_N_FAILURES !== 0) return false;

    const reason = err instanceof Error ? err.message : String(err);
    const summary =
      n === 1
        ? `Scheduled backup failed: ${reason}`
        : `Scheduled backup has failed ${n} times in a row: ${reason}`;

    try {
      await publishActivity({
        type: "backup_failed",
        mind: SPIRIT_NAME,
        summary,
        metadata: { consecutiveFailures: n, error: reason },
      });
    } catch (pubErr) {
      blog.error("failed to publish backup-failure activity", log.errorData(pubErr));
    }

    try {
      const { sendSystemMessage } = await import("../chat/system-chat.js");
      await sendSystemMessage(
        SPIRIT_NAME,
        `${summary}\n\nBackups are not being saved. Check \`volute backup status\` and the Backups settings tab.`,
      );
    } catch (msgErr) {
      blog.error("failed to send backup-failure system message", log.errorData(msgErr));
    }

    return true;
  }
}

let backupManager: BackupManager | null = null;

export function initBackupManager(): BackupManager {
  if (!backupManager) backupManager = new BackupManager();
  return backupManager;
}

export function getBackupManager(): BackupManager {
  if (!backupManager) throw new Error("BackupManager not initialized");
  return backupManager;
}
