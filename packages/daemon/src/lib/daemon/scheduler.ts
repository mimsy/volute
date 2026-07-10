import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { sendSystemMessage } from "../chat/system-chat.js";
import { loadMergedEnv } from "../config/env.js";
import { findMind, mindDir, mindTmpDir, stateDir, voluteSystemDir } from "../mind/registry.js";
import { isSandboxEnabled, wrapForSandbox } from "../mind/sandbox.js";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "../mind/volute-config.js";
import { exec } from "../util/exec.js";
import { clearJsonMap, loadJsonMap, saveJsonMapAsync } from "../util/json-state.js";
import log from "../util/logger.js";
import { buildMindBaseEnv } from "./mind-manager.js";
import { generateMindToken, getMindToken } from "./mind-tokens.js";

const slog = log.child("scheduler");

/**
 * Cap on how late a caught-up cron fire may be delivered. A schedule whose most
 * recent cron minute is older than this (e.g. after long daemon downtime) is
 * skipped rather than delivered stale — a 3am dream prompt at 5pm is worse than
 * none — but `lastFired` still advances so it fires normally next time.
 */
const CATCHUP_STALE_MINUTES = 10;

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private mindDirs = new Map<string, string>(); // mindName → dir override
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastFired = new Map<string, number>(); // "mind:scheduleId" → epoch minute

  private get statePath(): string {
    return resolve(voluteSystemDir(), "scheduler-state.json");
  }

  start(): void {
    this.loadState();
    this.interval = setInterval(() => {
      this.tick().catch((err) => slog.error("scheduler tick failed", log.errorData(err)));
    }, 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private loadState(): void {
    this.lastFired = loadJsonMap(this.statePath);
  }

  async saveState(): Promise<void> {
    await saveJsonMapAsync(this.statePath, this.lastFired);
  }

  clearState(): void {
    clearJsonMap(this.statePath, this.lastFired);
  }

  loadSchedules(mindName: string, dir?: string): void {
    if (dir) this.mindDirs.set(mindName, dir);
    const resolvedDir = this.mindDirs.get(mindName) ?? mindDir(mindName);
    const config = readVoluteConfig(resolvedDir);
    if (!config) return; // Config read failed — keep existing schedules
    const schedules = config.schedules ?? [];
    if (schedules.length > 0) {
      this.schedules.set(mindName, schedules);
    } else {
      this.schedules.delete(mindName);
    }

    // Reconcile lastFired bookkeeping for this mind against its authoritative
    // schedule list. Only touch this mind's keys — other minds may not be loaded
    // yet, so a global sweep would drop live state.
    const epochMinute = Math.floor(Date.now() / 60000);
    const validKeys = new Set(schedules.map((s) => `${mindName}:${s.id}`));
    let changed = false;
    // Prune stale entries for removed schedules (#428).
    for (const key of this.lastFired.keys()) {
      if (key.startsWith(`${mindName}:`) && !validKeys.has(key)) {
        this.lastFired.delete(key);
        changed = true;
      }
    }
    // Baseline-init newly-seen schedules so catch-up never replays history (#453).
    for (const key of validKeys) {
      if (!this.lastFired.has(key)) {
        this.lastFired.set(key, epochMinute);
        changed = true;
      }
    }
    if (changed) {
      this.saveState().catch((err) =>
        slog.warn(`failed to persist scheduler state for ${mindName}`, log.errorData(err)),
      );
    }
  }

  unloadSchedules(mindName: string): void {
    this.schedules.delete(mindName);
    this.mindDirs.delete(mindName);
  }

  private async tick(): Promise<void> {
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

    if (anyFired) await this.saveState();
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

    // Level-triggered catch-up: fire when the cron's most recent scheduled minute
    // is newer than the last one we acted on — recovering fires missed while the
    // daemon was down or a tick straddled the minute boundary. Unknown keys are
    // baselined in loadSchedules, so this never replays history on first sight.
    const lastFired = this.lastFired.get(key) ?? epochMinute;
    if (prevMinute <= lastFired) return false;

    // Advance regardless of whether we deliver, so a stale fire isn't retried.
    this.lastFired.set(key, prevMinute);

    // Staleness cap: skip (but don't re-attempt) a catch-up fire that's too old.
    if (epochMinute - prevMinute > CATCHUP_STALE_MINUTES) {
      slog.info(`skipping stale catch-up fire for ${key} (${epochMinute - prevMinute}min late)`);
      return false;
    }
    return true;
  }

  private async fire(mindName: string, schedule: Schedule): Promise<void> {
    try {
      let text: string;
      if (schedule.script) {
        const homeDir = resolve(this.mindDirs.get(mindName) ?? mindDir(mindName), "home");
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
      } else if (Array.isArray(schedule.messages) && schedule.messages.length > 0) {
        // Rotating pool — pick one at random so repeated fires stay varied.
        // Minds hand-edit volute.json, so guard the pool's shape.
        const pick = schedule.messages[Math.floor(Math.random() * schedule.messages.length)];
        if (typeof pick !== "string" || !pick.trim()) {
          slog.warn(`schedule "${schedule.id}" for ${mindName} has a malformed messages pool`);
          return;
        }
        text = pick;
      } else if (schedule.message) {
        text = schedule.message;
      } else {
        slog.warn(`schedule "${schedule.id}" for ${mindName} has no message, messages, or script`);
        return;
      }

      await this.deliverSystem(mindName, `[${schedule.id}] ${text}`, {
        // Default schedule fires to "queue" while asleep so an unadorned cron
        // schedule doesn't inherit the DM wake-trigger fallback and wake the mind.
        whileSleeping: schedule.whileSleeping ?? "queue",
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
      const dir = this.mindDirs.get(mindName) ?? mindDir(mindName);
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

  protected async runScript(script: string, cwd: string, mindName: string): Promise<string> {
    // Scheduled scripts run with the same environment a mind process gets —
    // scoped to the mind's own non-admin token — so that a script invoking the
    // `volute` CLI authenticates as the mind instead of getting 401s.
    const env = await this.buildScriptEnv(mindName);

    // Mind-authored scripts must never run in the daemon's trust domain. Under
    // sandbox mode, wrap with the mind's sandbox (exec only applies user
    // isolation, never the sandbox). Isolation and sandbox modes are mutually
    // exclusive, so we pass mindName to exec only in the non-sandbox case.
    if (isSandboxEnabled()) {
      const dir = this.mindDirs.get(mindName) ?? mindDir(mindName);
      const [cmd, args] = await wrapForSandbox("bash", ["-c", script], dir, mindName, [
        dir,
        mindTmpDir(dir),
      ]);
      return exec(cmd, args, { cwd, env });
    }
    return exec("bash", ["-c", script], { cwd, mindName, env });
  }

  /**
   * Build the environment for a scheduled script — mirrors the mind process env
   * (allowlisted base + merged mind env + VOLUTE_* runtime vars), authenticated
   * with the mind's own per-mind, non-admin token. Reuses the running mind's
   * token when present; otherwise mints one (stable across fires, regenerated on
   * next mind start). The daemon admin token is never included.
   */
  private async buildScriptEnv(mindName: string): Promise<Record<string, string | undefined>> {
    const dir = this.mindDirs.get(mindName) ?? mindDir(mindName);
    const entry = await findMind(mindName);
    const token = getMindToken(mindName) ?? generateMindToken(mindName);
    const mindLocalBin = resolve(dir, "home", ".local", "bin");
    const currentPath = process.env.PATH ?? "";
    return {
      ...buildMindBaseEnv(),
      ...loadMergedEnv(mindName),
      VOLUTE_MIND: mindName,
      VOLUTE_STATE_DIR: stateDir(mindName),
      VOLUTE_MIND_DIR: dir,
      VOLUTE_MIND_PORT: entry ? String(entry.port) : undefined,
      VOLUTE_MIND_TOKEN: token,
      TMPDIR: mindTmpDir(dir),
      PATH: `${mindLocalBin}:${currentPath}`,
    };
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
