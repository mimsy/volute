import { CronExpressionParser } from "cron-parser";
import { runBackup } from "../backup/backup.js";
import { readGlobalConfig } from "../config/setup.js";
import log from "../util/logger.js";

const blog = log.child("backup");

export const DEFAULT_BACKUP_SCHEDULE = "0 3 * * *";

/**
 * Runs scheduled backups. Config is re-read each tick so enabling/changing the
 * schedule via the API takes effect without a daemon restart.
 */
export class BackupManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFiredMinute = -1;
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
   * True at most once per scheduled fire minute (records the minute it
   * consumed), and only when backups are enabled and runnable. Not a pure
   * predicate — a second call in the same minute returns false.
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
    if (epochMinute === this.lastFiredMinute) return false;
    let prevMinute: number;
    try {
      const interval = CronExpressionParser.parse(cron, { currentDate: now });
      prevMinute = Math.floor(interval.prev().toDate().getTime() / 60000);
    } catch (err) {
      blog.warn(`invalid backup cron "${cron}"`, log.errorData(err));
      return false;
    }
    if (prevMinute !== epochMinute) return false;
    this.lastFiredMinute = epochMinute;
    return true;
  }

  private async tick(): Promise<void> {
    if (!this.isDue()) return;
    blog.info("scheduled backup starting");
    try {
      await runBackup();
    } catch (err) {
      blog.error("scheduled backup failed", log.errorData(err));
    }
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
