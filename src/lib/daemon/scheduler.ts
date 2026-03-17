import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { exec } from "../exec.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "../json-state.js";
import log from "../logger.js";
import { mindDir, voluteSystemDir } from "../registry.js";
import { sendSystemMessage } from "../system-chat.js";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "../volute-config.js";

const slog = log.child("scheduler");

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "mind:scheduleId" → epoch minute

  private get statePath(): string {
    return resolve(voluteSystemDir(), "scheduler-state.json");
  }

  start(): void {
    this.loadState();
    this.interval = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private loadState(): void {
    this.lastFired = loadJsonMap(this.statePath);
  }

  saveState(): void {
    saveJsonMap(this.statePath, this.lastFired);
  }

  clearState(): void {
    clearJsonMap(this.statePath, this.lastFired);
  }

  loadSchedules(mindName: string): void {
    const dir = mindDir(mindName);
    const config = readVoluteConfig(dir);
    if (!config) return; // Config read failed — keep existing schedules
    const schedules = config.schedules ?? [];
    if (schedules.length > 0) {
      this.schedules.set(mindName, schedules);
    } else {
      this.schedules.delete(mindName);
    }
  }

  unloadSchedules(mindName: string): void {
    this.schedules.delete(mindName);
  }

  private tick(): void {
    const now = new Date();
    const epochMinute = Math.floor(now.getTime() / 60000);
    // Cache cron parse results within this tick — same cron string only parsed once
    const cronCache = new Map<string, number>();
    let anyFired = false;

    for (const [mind, schedules] of this.schedules) {
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (this.shouldFire(schedule, epochMinute, mind, cronCache)) {
          anyFired = true;
          this.fire(mind, schedule);
        }
      }
    }

    if (anyFired) this.saveState();
  }

  private shouldFire(
    schedule: Schedule,
    epochMinute: number,
    mind: string,
    cronCache: Map<string, number>,
  ): boolean {
    const key = `${mind}:${schedule.id}`;
    if (this.lastFired.get(key) === epochMinute) return false;

    // One-time timer: fireAt
    if (schedule.fireAt) {
      const fireTime = Math.floor(new Date(schedule.fireAt).getTime() / 60000);
      if (epochMinute >= fireTime) {
        this.lastFired.set(key, epochMinute);
        return true;
      }
      return false;
    }

    // Recurring: cron
    if (!schedule.cron) return false;

    let prevMinute = cronCache.get(schedule.cron);
    if (prevMinute === undefined) {
      try {
        const interval = CronExpressionParser.parse(schedule.cron);
        const prev = interval.prev().toDate();
        prevMinute = Math.floor(prev.getTime() / 60000);
        cronCache.set(schedule.cron, prevMinute);
      } catch (err) {
        slog.warn(`invalid cron "${schedule.cron}" for ${mind}:${schedule.id}`, log.errorData(err));
        return false;
      }
    }

    if (prevMinute === epochMinute) {
      this.lastFired.set(key, epochMinute);
      return true;
    }
    return false;
  }

  private async fire(mindName: string, schedule: Schedule): Promise<void> {
    try {
      let text: string;
      if (schedule.script) {
        const homeDir = resolve(mindDir(mindName), "home");
        try {
          const output = await this.runScript(schedule.script, homeDir, mindName);
          if (!output.trim()) {
            slog.info(`fired script "${schedule.id}" for ${mindName} (no output)`);
            return;
          }
          text = output;
        } catch (err) {
          const stderr = (err as Error & { stderr?: string }).stderr ?? "";
          text = `[script error] ${(err as Error).message}${stderr ? `\n${stderr}` : ""}`;
          slog.warn(`script "${schedule.id}" failed for ${mindName}`, log.errorData(err));
        }
      } else if (schedule.message) {
        text = schedule.message;
      } else {
        slog.warn(`schedule "${schedule.id}" for ${mindName} has no message or script`);
        return;
      }

      await this.deliverSystem(mindName, `[${schedule.id}] ${text}`, {
        whileSleeping: schedule.whileSleeping,
        session: schedule.session,
      });
      slog.info(`fired "${schedule.id}" for ${mindName}`);

      // Self-delete one-time timers after successful delivery
      if (schedule.fireAt) {
        this.removeSchedule(mindName, schedule.id);
      }
    } catch (err) {
      slog.warn(`failed to fire "${schedule.id}" for ${mindName}`, log.errorData(err));
    }
  }

  private removeSchedule(mindName: string, scheduleId: string): void {
    // Remove from in-memory schedules immediately to prevent re-firing on config write failure
    const memSchedules = this.schedules.get(mindName);
    if (memSchedules) {
      const filtered = memSchedules.filter((s) => s.id !== scheduleId);
      if (filtered.length > 0) {
        this.schedules.set(mindName, filtered);
      } else {
        this.schedules.delete(mindName);
      }
    }

    try {
      const dir = mindDir(mindName);
      const config = readVoluteConfig(dir);
      if (!config?.schedules) return;
      config.schedules = config.schedules.filter((s) => s.id !== scheduleId);
      if (config.schedules.length === 0) config.schedules = undefined;
      writeVoluteConfig(dir, config);
      slog.info(`removed one-time schedule "${scheduleId}" for ${mindName}`);
    } catch (err) {
      slog.error(
        `failed to persist removal of schedule "${scheduleId}" for ${mindName} (removed from memory)`,
        log.errorData(err),
      );
    }
  }

  protected runScript(script: string, cwd: string, mindName: string): Promise<string> {
    return exec("bash", ["-c", script], { cwd, mindName });
  }

  protected deliverSystem(
    mindName: string,
    text: string,
    opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; session?: string },
  ): Promise<void> {
    return sendSystemMessage(mindName, text, opts);
  }
}

let instance: Scheduler | null = null;

export function initScheduler(): Scheduler {
  if (instance) throw new Error("Scheduler already initialized");
  instance = new Scheduler();
  return instance;
}

export function getScheduler(): Scheduler {
  if (!instance) throw new Error("Scheduler not initialized — call initScheduler() first");
  return instance;
}
