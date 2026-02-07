import { CronExpressionParser } from "cron-parser";
import { agentDir, findAgent } from "./registry.js";
import { readVoluteConfig, type Schedule } from "./volute-config.js";

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "agent:scheduleId" → epoch minute

  start(): void {
    this.interval = setInterval(() => this.tick(), 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  loadSchedules(agentName: string): void {
    const dir = agentDir(agentName);
    const config = readVoluteConfig(dir);
    const schedules = config.schedules ?? [];
    if (schedules.length > 0) {
      this.schedules.set(agentName, schedules);
    } else {
      this.schedules.delete(agentName);
    }
  }

  unloadSchedules(agentName: string): void {
    this.schedules.delete(agentName);
  }

  private tick(): void {
    const now = new Date();
    for (const [agent, schedules] of this.schedules) {
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (this.shouldFire(schedule, now, agent)) {
          this.fire(agent, schedule);
        }
      }
    }
  }

  private shouldFire(schedule: Schedule, now: Date, agent: string): boolean {
    try {
      const interval = CronExpressionParser.parse(schedule.cron);
      const prev = interval.prev().toDate();
      const epochMinute = Math.floor(now.getTime() / 60000);
      const key = `${agent}:${schedule.id}`;
      if (this.lastFired.get(key) === epochMinute) return false;
      const prevMinute = Math.floor(prev.getTime() / 60000);
      if (prevMinute === epochMinute) {
        this.lastFired.set(key, epochMinute);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async fire(agentName: string, schedule: Schedule): Promise<void> {
    const entry = findAgent(agentName);
    if (!entry) return;

    try {
      await fetch(`http://localhost:${entry.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: schedule.message }],
          channel: "system:scheduler",
          sender: "scheduler",
        }),
      });
      console.error(`[scheduler] fired "${schedule.id}" for ${agentName}`);
    } catch (err) {
      console.error(`[scheduler] failed to fire "${schedule.id}" for ${agentName}:`, err);
    }
  }
}

let instance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!instance) instance = new Scheduler();
  return instance;
}
