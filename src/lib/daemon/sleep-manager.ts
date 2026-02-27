import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CronExpressionParser } from "cron-parser";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { type ActivityEvent, subscribe } from "../events/activity-events.js";
import log from "../logger.js";
import { getPrompt } from "../prompts.js";
import { findMind, mindDir, readRegistry, voluteHome } from "../registry.js";
import { deliveryQueue } from "../schema.js";
import { readVoluteConfig, type SleepConfig } from "../volute-config.js";
import { getMindManager } from "./mind-manager.js";
import { sleepMind, wakeMind } from "./mind-service.js";

const slog = log.child("sleep");

export type SleepState = {
  sleeping: boolean;
  sleepingSince: string | null;
  scheduledWakeAt: string | null;
  wokenByTrigger: boolean;
  voluntaryWakeAt: string | null;
  queuedMessageCount: number;
};

type SleepStatePersisted = Record<string, SleepState>;

function defaultState(): SleepState {
  return {
    sleeping: false,
    sleepingSince: null,
    scheduledWakeAt: null,
    wokenByTrigger: false,
    voluntaryWakeAt: null,
    queuedMessageCount: 0,
  };
}

function formatCurrentDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatDuration(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function matchesGlob(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(value);
}

export class SleepManager {
  private states = new Map<string, SleepState>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsubActivity: (() => void) | null = null;
  private returnToSleepTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private get statePath(): string {
    return resolve(voluteHome(), "sleep-state.json");
  }

  start(): void {
    this.loadState();
    this.interval = setInterval(() => this.tick(), 60_000);
    // Listen for mind_idle/mind_done events for return-to-sleep
    this.unsubActivity = subscribe((event) => this.onActivityEvent(event));
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.unsubActivity) this.unsubActivity();
    this.unsubActivity = null;
    for (const timer of this.returnToSleepTimers.values()) clearTimeout(timer);
    this.returnToSleepTimers.clear();
  }

  // --- State persistence ---

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const data: SleepStatePersisted = JSON.parse(readFileSync(this.statePath, "utf-8"));
        for (const [name, state] of Object.entries(data)) {
          this.states.set(name, state);
        }
      }
    } catch (err) {
      slog.warn("failed to load sleep state", log.errorData(err));
    }
  }

  saveState(): void {
    const data: SleepStatePersisted = {};
    for (const [name, state] of this.states) {
      if (state.sleeping) data[name] = state;
    }
    try {
      writeFileSync(this.statePath, `${JSON.stringify(data, null, 2)}\n`);
    } catch (err) {
      slog.warn("failed to save sleep state", log.errorData(err));
    }
  }

  // --- Public API ---

  isSleeping(name: string): boolean {
    return this.states.get(name)?.sleeping ?? false;
  }

  getState(name: string): SleepState {
    return this.states.get(name) ?? defaultState();
  }

  getSleepConfig(name: string): SleepConfig | null {
    const dir = mindDir(name);
    const config = readVoluteConfig(dir);
    return config?.sleep ?? null;
  }

  /**
   * Put a mind to sleep. Sends pre-sleep message, waits for completion,
   * archives session, then stops the mind process.
   */
  async initiateSleep(name: string, opts?: { voluntaryWakeAt?: string }): Promise<void> {
    if (this.isSleeping(name)) return;

    const manager = getMindManager();
    if (!manager.isRunning(name)) {
      // Mind not running — just mark as sleeping
      this.markSleeping(name, opts);
      return;
    }

    const entry = findMind(name);
    if (!entry) return;

    // Send pre-sleep message
    const sleepConfig = this.getSleepConfig(name);
    const wakeTime = opts?.voluntaryWakeAt ?? this.getNextWakeTime(sleepConfig) ?? "scheduled time";
    const queuedInfo = "";
    const preSleepMsg = await getPrompt("pre_sleep", { wakeTime, queuedInfo });

    try {
      await fetch(`http://127.0.0.1:${entry.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: preSleepMsg }],
          channel: "system:sleep",
        }),
      });
    } catch (err) {
      slog.warn(`failed to send pre-sleep message to ${name}`, log.errorData(err));
    }

    // Wait for mind to finish processing (timeout 120s)
    await this.waitForIdle(name, 120_000);

    // Wait a beat for hooks (identity-reload, auto-commit) to settle
    await new Promise((r) => setTimeout(r, 3000));

    // Archive sessions
    await this.archiveSessions(name);

    // Stop the mind process (not connectors)
    await sleepMind(name);

    // Kill any orphan process still on the port (e.g. from identity-reload hook restart)
    await this.killOrphanOnPort(entry.port);

    this.markSleeping(name, opts);
    slog.info(`${name} is now sleeping`);
  }

  /**
   * Wake a sleeping mind. Starts the process, delivers wake summary.
   */
  async initiateWake(name: string, opts?: { trigger?: { channel: string } }): Promise<void> {
    const state = this.states.get(name);
    if (!state?.sleeping) return;

    const sleepingSince = state.sleepingSince ? new Date(state.sleepingSince) : new Date();
    const now = new Date();
    const duration = formatDuration(sleepingSince, now);
    const currentDate = formatCurrentDate();
    const sleepTime = sleepingSince.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

    // Build queued summary
    const queuedSummary = await this.buildQueuedSummary(name);

    // Start the mind process
    try {
      await wakeMind(name);
    } catch (err) {
      slog.error(`failed to wake ${name}`, log.errorData(err));
      return;
    }

    // Wait for health check
    const entry = findMind(name);
    if (!entry) return;

    // Deliver wake summary
    let summaryText: string;
    if (opts?.trigger) {
      state.wokenByTrigger = true;
      summaryText = await getPrompt("wake_trigger_summary", {
        currentDate,
        triggerChannel: opts.trigger.channel,
        sleepTime,
        duration,
        queuedSummary,
      });
    } else {
      summaryText = await getPrompt("wake_summary", {
        currentDate,
        sleepTime,
        duration,
        queuedSummary,
      });
    }

    try {
      await fetch(`http://127.0.0.1:${entry.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: summaryText }],
          channel: "system:sleep",
        }),
      });
    } catch (err) {
      slog.warn(`failed to deliver wake summary to ${name}`, log.errorData(err));
    }

    // Flush queued messages
    const flushed = await this.flushQueuedMessages(name);
    if (flushed > 0) {
      slog.info(`flushed ${flushed} queued message(s) for ${name}`);
    }

    // If trigger wake, set up return-to-sleep on idle
    if (opts?.trigger) {
      this.setupReturnToSleep(name);
    }

    // Mark as awake
    if (!opts?.trigger) {
      this.markAwake(name);
    }

    slog.info(`${name} is now awake${opts?.trigger ? " (trigger wake)" : ""}`);
  }

  /**
   * Check if a message payload should trigger a wake.
   */
  checkWakeTrigger(
    name: string,
    payload: { channel: string; sender?: string | null; isDM?: boolean; content?: unknown },
  ): boolean {
    const config = this.getSleepConfig(name);
    const triggers = config?.wakeTriggers;

    // Default: mentions and DMs wake the mind
    const mentionsEnabled = triggers?.mentions !== false;
    const dmsEnabled = triggers?.dms !== false;

    // Check DM trigger
    if (dmsEnabled && payload.isDM) return true;

    // Check mention trigger (look for @name in content)
    if (mentionsEnabled && payload.content) {
      const text =
        typeof payload.content === "string"
          ? payload.content
          : Array.isArray(payload.content)
            ? (payload.content as { type: string; text?: string }[])
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join(" ")
            : "";
      if (text.includes(`@${name}`)) return true;
    }

    // Check channel globs
    if (triggers?.channels) {
      for (const pattern of triggers.channels) {
        if (matchesGlob(pattern, payload.channel)) return true;
      }
    }

    // Check sender globs
    if (triggers?.senders && payload.sender) {
      for (const pattern of triggers.senders) {
        if (matchesGlob(pattern, payload.sender)) return true;
      }
    }

    return false;
  }

  /**
   * Queue a message for a sleeping mind in the delivery_queue table.
   */
  async queueSleepMessage(
    name: string,
    payload: { channel: string; sender?: string | null; content: unknown },
  ): Promise<void> {
    try {
      const db = await getDb();
      await db.insert(deliveryQueue).values({
        mind: name,
        session: "sleep",
        channel: payload.channel,
        sender: payload.sender ?? null,
        status: "sleep-queued",
        payload: JSON.stringify(payload),
      });

      const state = this.states.get(name);
      if (state) {
        state.queuedMessageCount++;
        this.saveState();
      }
    } catch (err) {
      slog.warn(`failed to queue sleep message for ${name}`, log.errorData(err));
    }
  }

  /**
   * Flush all queued sleep messages for a mind through the delivery manager.
   */
  async flushQueuedMessages(name: string): Promise<number> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, name), eq(deliveryQueue.status, "sleep-queued")))
        .all();

      if (rows.length === 0) return 0;

      // Import deliverMessage lazily to avoid circular deps
      const { deliverMessage } = await import("../delivery/message-delivery.js");

      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          await deliverMessage(name, payload);
        } catch (err) {
          slog.warn(`failed to flush queued message ${row.id} for ${name}`, log.errorData(err));
        }
      }

      // Delete flushed messages
      await db
        .delete(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, name), eq(deliveryQueue.status, "sleep-queued")));

      const state = this.states.get(name);
      if (state) state.queuedMessageCount = 0;

      return rows.length;
    } catch (err) {
      slog.warn(`failed to flush queued messages for ${name}`, log.errorData(err));
      return 0;
    }
  }

  // --- Internal methods ---

  private markSleeping(name: string, opts?: { voluntaryWakeAt?: string }): void {
    const sleepConfig = this.getSleepConfig(name);
    const state: SleepState = {
      sleeping: true,
      sleepingSince: new Date().toISOString(),
      scheduledWakeAt: this.getNextWakeTime(sleepConfig),
      wokenByTrigger: false,
      voluntaryWakeAt: opts?.voluntaryWakeAt ?? null,
      queuedMessageCount: this.states.get(name)?.queuedMessageCount ?? 0,
    };
    this.states.set(name, state);
    this.saveState();
  }

  private markAwake(name: string): void {
    this.states.delete(name);
    this.saveState();
    // Cancel any return-to-sleep timer
    const timer = this.returnToSleepTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.returnToSleepTimers.delete(name);
    }
  }

  private getNextWakeTime(config: SleepConfig | null): string | null {
    if (!config?.schedule?.wake) return null;
    try {
      const interval = CronExpressionParser.parse(config.schedule.wake);
      return interval.next().toDate().toISOString();
    } catch {
      return null;
    }
  }

  private tick(): void {
    const now = new Date();
    const epochMinute = Math.floor(now.getTime() / 60_000);

    // Check each mind's sleep config
    const registry = readRegistry();

    for (const entry of registry) {
      if (!entry.running && !this.isSleeping(entry.name)) continue;

      const config = this.getSleepConfig(entry.name);
      if (!config?.enabled || !config.schedule) continue;

      const state = this.states.get(entry.name);

      // Check voluntary wake time
      if (state?.sleeping && state.voluntaryWakeAt) {
        const wakeAt = new Date(state.voluntaryWakeAt);
        if (now >= wakeAt) {
          this.initiateWake(entry.name).catch((err) =>
            slog.error(`failed voluntary wake for ${entry.name}`, log.errorData(err)),
          );
          continue;
        }
      }

      // Check scheduled wake time
      if (state?.sleeping && state.scheduledWakeAt) {
        const wakeAt = new Date(state.scheduledWakeAt);
        if (now >= wakeAt) {
          this.initiateWake(entry.name).catch((err) =>
            slog.error(`failed scheduled wake for ${entry.name}`, log.errorData(err)),
          );
          continue;
        }
      }

      // Check if it's time to sleep
      if (!state?.sleeping && entry.running) {
        if (this.shouldSleep(config.schedule.sleep, epochMinute)) {
          this.initiateSleep(entry.name).catch((err) =>
            slog.error(`failed to initiate sleep for ${entry.name}`, log.errorData(err)),
          );
        }
      }
    }
  }

  private shouldSleep(cronExpr: string, epochMinute: number): boolean {
    try {
      const interval = CronExpressionParser.parse(cronExpr);
      const prev = interval.prev().toDate();
      const prevMinute = Math.floor(prev.getTime() / 60_000);
      return prevMinute === epochMinute;
    } catch {
      return false;
    }
  }

  private async waitForIdle(name: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);

      const unsub = subscribe((event) => {
        if (event.mind !== name) return;
        if (event.type === "mind_done" || event.type === "mind_idle") {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      });
    });
  }

  private async archiveSessions(name: string): Promise<void> {
    const dir = mindDir(name);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

    // Claude template: .mind/sessions/
    const sessionsDir = resolve(dir, ".mind", "sessions");
    if (existsSync(sessionsDir)) {
      const archiveDir = resolve(sessionsDir, "archive");
      mkdirSync(archiveDir, { recursive: true });

      for (const file of readdirSync(sessionsDir)) {
        if (file === "archive") continue;
        const src = resolve(sessionsDir, file);
        const base = file.replace(/\.json$/, "");
        const dest = resolve(archiveDir, `${base}-${timestamp}.json`);
        try {
          renameSync(src, dest);
        } catch (err) {
          slog.warn(`failed to archive session ${file} for ${name}`, log.errorData(err));
        }
      }
    }

    // Pi template: .mind/pi-sessions/
    const piSessionsDir = resolve(dir, ".mind", "pi-sessions");
    if (existsSync(piSessionsDir)) {
      const archiveDir = resolve(piSessionsDir, "archive");
      mkdirSync(archiveDir, { recursive: true });

      for (const entry of readdirSync(piSessionsDir, { withFileTypes: true })) {
        if (entry.name === "archive" || !entry.isDirectory()) continue;
        const src = resolve(piSessionsDir, entry.name);
        const dest = resolve(archiveDir, `${entry.name}-${timestamp}`);
        try {
          renameSync(src, dest);
        } catch (err) {
          slog.warn(`failed to archive pi-session ${entry.name} for ${name}`, log.errorData(err));
        }
      }
    }
  }

  private async buildQueuedSummary(name: string): Promise<string> {
    try {
      const db = await getDb();
      const rows = await db
        .select({ channel: deliveryQueue.channel })
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, name), eq(deliveryQueue.status, "sleep-queued")))
        .all();

      if (rows.length === 0) return "No messages while you slept.";

      // Count per channel
      const channelCounts = new Map<string, number>();
      for (const row of rows) {
        const ch = row.channel ?? "unknown";
        channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
      }

      const parts = [...channelCounts.entries()].map(([ch, count]) => `${count} on ${ch}`);
      return `${rows.length} message${rows.length === 1 ? "" : "s"} while you slept (${parts.join(", ")}). Ask if you want them delivered.`;
    } catch (err) {
      slog.warn(`failed to build queued summary for ${name}`, log.errorData(err));
      return "";
    }
  }

  /**
   * Kill any process still listening on a port after stopMind.
   * Handles the case where a hook (e.g. identity-reload) restarted the server.
   */
  private async killOrphanOnPort(port: number): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (!res.ok) return;
    } catch {
      return; // Port not in use — good
    }

    // Something is still listening — try lsof, fall back to /proc
    slog.warn(`orphan process found on port ${port} after sleep, killing`);
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const pid = parseInt(line, 10);
        if (pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        }
      }
    } catch {
      // lsof not available (e.g. Docker slim) — try /proc/net/tcp6
      try {
        const portHex = port.toString(16).toUpperCase().padStart(4, "0");
        const tcp6 = readFileSync("/proc/net/tcp6", "utf-8");
        for (const line of tcp6.split("\n")) {
          if (!line.includes(`:${portHex} `)) continue;
          const fields = line.trim().split(/\s+/);
          if (fields[3] !== "0A") continue; // 0A = LISTEN
          const inode = parseInt(fields[9], 10);
          if (!inode) continue;
          // Find PID owning this inode
          for (const pidDir of readdirSync("/proc").filter((f) => /^\d+$/.test(f))) {
            try {
              const fds = readdirSync(`/proc/${pidDir}/fd`);
              for (const fd of fds) {
                try {
                  const link = readlinkSync(`/proc/${pidDir}/fd/${fd}`);
                  if (link.includes(`socket:[${inode}]`)) {
                    process.kill(parseInt(pidDir, 10), "SIGTERM");
                  }
                } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    }

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 1000));
  }

  private setupReturnToSleep(name: string): void {
    // Cancel any existing timer
    const existing = this.returnToSleepTimers.get(name);
    if (existing) clearTimeout(existing);

    // We'll monitor activity events; on mind_idle after trigger wake, go back to sleep
    // The idle timeout in mind-activity-tracker.ts is 2 minutes, so we wait for that
  }

  private onActivityEvent(event: ActivityEvent & { id: number; created_at: string }): void {
    const state = this.states.get(event.mind);
    if (!state?.sleeping || !state.wokenByTrigger) return;

    if (event.type === "mind_idle") {
      // Mind went idle after trigger wake — return to sleep
      slog.info(`${event.mind} going back to sleep after trigger wake`);
      state.wokenByTrigger = false;

      // Archive session and stop (no pre-sleep ritual — session is fresh)
      this.archiveSessions(event.mind)
        .then(() => sleepMind(event.mind))
        .then(() => {
          state.sleeping = true;
          state.sleepingSince = new Date().toISOString();
          const sleepConfig = this.getSleepConfig(event.mind);
          state.scheduledWakeAt = this.getNextWakeTime(sleepConfig);
          this.saveState();
          slog.info(`${event.mind} returned to sleep`);
        })
        .catch((err) => {
          slog.error(`failed to return ${event.mind} to sleep`, log.errorData(err));
        });
    }
  }
}

let instance: SleepManager | null = null;

export function initSleepManager(): SleepManager {
  if (instance) throw new Error("SleepManager already initialized");
  instance = new SleepManager();
  return instance;
}

export function getSleepManager(): SleepManager {
  if (!instance) throw new Error("SleepManager not initialized — call initSleepManager() first");
  return instance;
}

/** Get SleepManager if initialized, or null. Safe to call before init. */
export function getSleepManagerIfReady(): SleepManager | null {
  return instance;
}
