import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "./json-state.js";
import { agentDir, findAgent, voluteHome } from "./registry.js";
import { readVoluteConfig, type Schedule } from "./volute-config.js";

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "agent:scheduleId" → epoch minute
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

  loadSchedules(agentName: string): void {
    const dir = agentDir(agentName);
    const config = readVoluteConfig(dir);
    if (!config) return; // Config read failed — keep existing schedules
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
    // Hot-reload schedules from config on every tick
    for (const agent of this.schedules.keys()) {
      this.loadSchedules(agent);
    }

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
        this.saveState();
        return true;
      }
      return false;
    } catch (err) {
      console.error(
        `[scheduler] invalid cron "${schedule.cron}" for ${agent}:${schedule.id}:`,
        err,
      );
      return false;
    }
  }

  private async fire(agentName: string, schedule: Schedule): Promise<void> {
    const entry = findAgent(agentName);
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
        // Route through daemon so messages are recorded in agent_messages
        const daemonUrl = `http://127.0.0.1:${this.daemonPort}`;
        res = await fetch(`${daemonUrl}/api/agents/${encodeURIComponent(agentName)}/message`, {
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
        // Fallback to direct agent fetch
        res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
      }
      if (!res.ok) {
        console.error(`[scheduler] "${schedule.id}" for ${agentName} got HTTP ${res.status}`);
      } else {
        console.error(`[scheduler] fired "${schedule.id}" for ${agentName}`);
      }
      // Cancel the streaming body to free the connection — the message
      // was already delivered to the agent when response headers arrived
      try {
        await res.body?.cancel();
      } catch {
        // Body already closed or stream errored — safe to ignore
      }
    } catch (err) {
      console.error(`[scheduler] failed to fire "${schedule.id}" for ${agentName}:`, err);
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
