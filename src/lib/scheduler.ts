import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "./json-state.js";
import log from "./logger.js";
import { daemonLoopback, findMind, mindDir, voluteHome } from "./registry.js";
import { readVoluteConfig, type Schedule } from "./volute-config.js";

const slog = log.child("scheduler");

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "mind:scheduleId" → epoch minute
  private daemonPort: number | null = null;
  private daemonToken: string | null = null;

  private get statePath(): string {
    return resolve(voluteHome(), "scheduler-state.json");
  }

  start(daemonPort?: number, daemonToken?: string): void {
    this.daemonPort = daemonPort ?? null;
    this.daemonToken = daemonToken ?? null;
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
    // Hot-reload schedules from config on every tick
    for (const mind of this.schedules.keys()) {
      this.loadSchedules(mind);
    }

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
      slog.warn(`invalid cron "${schedule.cron}" for ${mind}:${schedule.id}`, {
        error: String(err),
      });
      return false;
    }
  }

  private async fire(mindName: string, schedule: Schedule): Promise<void> {
    const entry = findMind(mindName);
    if (!entry) return;

    const body = JSON.stringify({
      content: [{ type: "text", text: schedule.message }],
      channel: "system:scheduler",
      sender: schedule.id,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      let res: Response;
      if (this.daemonPort && this.daemonToken) {
        // Route through daemon so messages are recorded in mind_messages
        const daemonUrl = `http://${daemonLoopback()}:${this.daemonPort}`;
        res = await fetch(`${daemonUrl}/api/minds/${encodeURIComponent(mindName)}/message`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.daemonToken}`,
            Origin: daemonUrl,
          },
          body,
          signal: controller.signal,
        });
      } else {
        // Fallback to direct mind fetch
        res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
      }
      if (!res.ok) {
        slog.warn(`"${schedule.id}" for ${mindName} got HTTP ${res.status}`);
      } else {
        slog.info(`fired "${schedule.id}" for ${mindName}`);
      }
      // Consume response body
      await res.text().catch(() => {});
    } catch (err) {
      slog.warn(`failed to fire "${schedule.id}" for ${mindName}`, { error: String(err) });
    } finally {
      clearTimeout(timeout);
    }
  }
}

let instance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!instance) instance = new Scheduler();
  return instance;
}
