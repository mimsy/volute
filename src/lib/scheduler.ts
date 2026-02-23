import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { exec } from "./exec.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "./json-state.js";
import log from "./logger.js";
import { deliverMessage } from "./message-delivery.js";
import { mindDir, voluteHome } from "./registry.js";
import { readVoluteConfig, type Schedule } from "./volute-config.js";

const slog = log.child("scheduler");

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "mind:scheduleId" → epoch minute

  private get statePath(): string {
    return resolve(voluteHome(), "scheduler-state.json");
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
    for (const [mind, schedules] of this.schedules) {
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (this.shouldFire(schedule, now, mind)) {
          this.fire(mind, schedule);
        }
      }
    }
  }

  private shouldFire(schedule: Schedule, now: Date, mind: string): boolean {
    try {
      const interval = CronExpressionParser.parse(schedule.cron);
      const prev = interval.prev().toDate();
      const epochMinute = Math.floor(now.getTime() / 60000);
      const key = `${mind}:${schedule.id}`;
      if (this.lastFired.get(key) === epochMinute) return false;
      const prevMinute = Math.floor(prev.getTime() / 60000);
      if (prevMinute === epochMinute) {
        this.lastFired.set(key, epochMinute);
        this.saveState();
        return true;
      }
      return false;
    } catch (err) {
      slog.warn(`invalid cron "${schedule.cron}" for ${mind}:${schedule.id}`, log.errorData(err));
      return false;
    }
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
        }
      } else {
        text = schedule.message!;
      }
      await this.deliver(mindName, {
        content: [{ type: "text", text }],
        channel: "system:scheduler",
        sender: schedule.id,
      });
      slog.info(`fired "${schedule.id}" for ${mindName}`);
    } catch (err) {
      slog.warn(`failed to fire "${schedule.id}" for ${mindName}`, log.errorData(err));
    }
  }

  protected runScript(script: string, cwd: string, mindName: string): Promise<string> {
    return exec("bash", ["-c", script], { cwd, mindName });
  }

  protected deliver(
    mindName: string,
    payload: { content: { type: string; text: string }[]; channel: string; sender: string },
  ): Promise<void> {
    return deliverMessage(mindName, payload);
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
