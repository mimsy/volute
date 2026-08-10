import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { deliverEvent, MIND_LEVEL_THREAD, recordNotice } from "../chat/system-events.js";
import { mindDir, voluteSystemDir } from "../mind/registry.js";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "../mind/volute-config.js";
import { getPrompt } from "../prompts.js";
import log from "../util/logger.js";
import { runMindScript } from "./mind-script.js";

const slog = log.child("scheduler");

/**
 * Cap on how late a caught-up cron fire may be delivered. A recurring schedule
 * whose most recent cron minute is older than this (e.g. after long daemon
 * downtime) is skipped rather than delivered stale — a 3am dream prompt at 5pm
 * is worse than none — but its slot cursor still advances so it fires normally
 * next time. One-time (`fireAt`) schedules are deliberately exempt: see
 * {@link Scheduler.shouldFire}.
 */
const CATCHUP_STALE_MINUTES = 10;

/**
 * What the scheduler knows about one schedule, persisted per `"mind:scheduleId"`
 * key in `scheduler-state.json`.
 *
 * **This file is a read surface, not internal scratch.** No code reads it back
 * except the scheduler itself, but hosts — and minds with host access — open it
 * over a shell to answer "did this actually run?". #867 exists because it
 * answered that question wrongly: two minds read a slot cursor as a delivery
 * receipt and concluded a dream had fired when it had not. Keep these fields
 * even though nothing in the codebase consumes them; recording what happened is
 * the fix. (Note `voluteSystemDir()` is sandbox-blocked, so a mind cannot read
 * this from its own seat — the mind-facing half of #867 is the skip notice.)
 *
 * `slot` is the retry cursor and nothing else: the most recent cron minute (or
 * one-time tick) the scheduler *acted on*, whether or not anything was
 * delivered. It is what the file used to hold as a bare integer, and it is what
 * stops a skipped fire from being retried forever.
 *
 * `firedAt` and `skippedAt` are wall-clock minutes recording when the scheduler
 * *acted*, so they are directly comparable to each other and to `dueAt`.
 * `firedAt` means the system event row was recorded — dispatched, not
 * acknowledged. Nothing here proves the mind received anything.
 */
export type ScheduleState = {
  /** Epoch minute of the last cron slot / one-time tick acted on (retry cursor). */
  slot: number;
  /** Epoch minute at which a fire was last dispatched (event row recorded). */
  firedAt?: number;
  /** Epoch minute at which a fire was last skipped without delivering. */
  skippedAt?: number;
  /** Why the last skip happened (currently only `"stale_catchup"`). */
  skipReason?: string;
  /**
   * Epoch minute the fire was actually *due*. Set for one-time (`fireAt`)
   * schedules, which are delivered however late rather than dropped — without
   * this the file could not tell a punctual one-timer from a six-hour-late one.
   */
  dueAt?: number;
};

/** Read `scheduler-state.json`. Entries that aren't well-formed are skipped. */
function loadScheduleStates(path: string): Map<string, ScheduleState> {
  const map = new Map<string, ScheduleState>();
  try {
    if (!existsSync(path)) return map;
    const raw = readFileSync(path, "utf-8").trim();
    // An empty/zero-length file is an expected condition (fresh install), not corruption.
    if (!raw) return map;
    for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as ScheduleState;
      if (typeof v.slot !== "number") continue;
      map.set(key, {
        slot: v.slot,
        ...(typeof v.firedAt === "number" ? { firedAt: v.firedAt } : {}),
        ...(typeof v.skippedAt === "number" ? { skippedAt: v.skippedAt } : {}),
        ...(typeof v.skipReason === "string" ? { skipReason: v.skipReason } : {}),
        ...(typeof v.dueAt === "number" ? { dueAt: v.dueAt } : {}),
      });
    }
  } catch (err) {
    slog.warn(`failed to load ${path}`, log.errorData(err));
  }
  return map;
}

export class Scheduler {
  private schedules = new Map<string, Schedule[]>();
  private mindDirs = new Map<string, string>(); // mindName → dir override
  private interval: ReturnType<typeof setInterval> | null = null;
  private state = new Map<string, ScheduleState>(); // "mind:scheduleId" → bookkeeping
  /** Set by every state mutation; `tick()` persists on it. */
  private stateDirty = false;
  /** Serialises writes so two callers can't interleave on the same file. */
  private writeChain: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  /** Protected so tests can point each instance at its own file — in production
   * there is one Scheduler and one path. */
  protected get statePath(): string {
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
    this.state = loadScheduleStates(this.statePath);
  }

  /**
   * Persist the state map. Writes are serialised through a promise chain and
   * land via write-temp-then-rename, because `fire()` runs un-awaited from
   * `tick()` and both save: two overlapping non-atomic writes to the same path
   * can leave a truncated file, which loads as empty and silently re-baselines
   * every schedule — costing exactly the catch-up fire this file exists to
   * protect. The snapshot is taken synchronously before any await so a
   * concurrent mutation can't tear a single write's view of the map.
   */
  async saveState(): Promise<void> {
    const data: Record<string, ScheduleState> = {};
    for (const [key, value] of this.state) data[key] = { ...value };
    this.stateDirty = false;
    const body = `${JSON.stringify(data)}\n`;
    // Unique temp name per write: a shared `.tmp` would be clobbered by any
    // other writer of the same file (a second Scheduler on one VOLUTE_HOME),
    // whose rename then lands on a file this one already moved away.
    const tmp = `${this.statePath}.${process.pid}.${++this.writeSeq}.tmp`;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeFile(tmp, body);
        await rename(tmp, this.statePath);
      } catch (err) {
        slog.warn(`failed to save ${this.statePath}`, log.errorData(err));
        await rm(tmp, { force: true }).catch(() => {});
      }
    });
    return this.writeChain;
  }

  clearState(): void {
    this.state.clear();
    try {
      if (existsSync(this.statePath)) unlinkSync(this.statePath);
    } catch (err) {
      slog.warn(`failed to clear ${this.statePath}`, log.errorData(err));
    }
  }

  /**
   * Mutate one schedule's bookkeeping and flag the map for persistence. Every
   * write goes through here: a skip-only tick mutates state without firing
   * anything, and if that never reached disk the cursor would rewind on restart
   * and re-skip — re-notifying the mind about the same missed fire on every
   * restart, which is the double-delivery half of the bug this fixes.
   */
  private mark(key: string, patch: Partial<ScheduleState> & { slot?: number }): void {
    const entry = this.state.get(key);
    if (entry) Object.assign(entry, patch);
    else this.state.set(key, { slot: patch.slot ?? Math.floor(Date.now() / 60000), ...patch });
    this.stateDirty = true;
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

    // Reconcile slot bookkeeping for this mind against its authoritative
    // schedule list. Only touch this mind's keys — other minds may not be loaded
    // yet, so a global sweep would drop live state.
    const epochMinute = Math.floor(Date.now() / 60000);
    const validKeys = new Set(schedules.map((s) => `${mindName}:${s.id}`));
    // Prune stale entries for removed schedules (#428).
    for (const key of this.state.keys()) {
      if (key.startsWith(`${mindName}:`) && !validKeys.has(key)) {
        this.state.delete(key);
        this.stateDirty = true;
      }
    }
    // Baseline-init newly-seen schedules so catch-up never replays history (#453).
    for (const key of validKeys) {
      if (!this.state.has(key)) this.mark(key, { slot: epochMinute });
    }
    if (this.stateDirty) {
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

    for (const [mind, schedules] of this.schedules) {
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        if (this.shouldFire(schedule, epochMinute, mind, cronCache)) {
          this.fire(mind, schedule);
        }
      }
    }

    // Persist on any state change, not just on a fire. A tick containing only
    // skips still advances cursors and records skip reasons; saving only when
    // something fired left those on the floor, so a sparse cron would re-skip
    // and re-notify after every restart (#867).
    if (this.stateDirty) await this.saveState();
  }

  private shouldFire(
    schedule: Schedule,
    epochMinute: number,
    mind: string,
    cronCache: Map<string, number>,
  ): boolean {
    const key = `${mind}:${schedule.id}`;
    if (this.state.get(key)?.slot === epochMinute) return false;

    // One-time timer: fireAt
    if (schedule.fireAt) {
      const fireTime = Math.floor(new Date(schedule.fireAt).getTime() / 60000);
      if (epochMinute < fireTime) return false;
      // Deliberate policy: one-timers have no staleness cap. A reminder armed for
      // a moment that has passed is still the only copy of that intention, so it
      // is delivered late rather than dropped. Late is fine; *silently* late is
      // not — the lateness is logged and recorded so the state file never reads
      // as if the fire landed on time (#867).
      const lateBy = epochMinute - fireTime;
      this.mark(key, { slot: epochMinute, dueAt: fireTime });
      if (lateBy > CATCHUP_STALE_MINUTES) {
        slog.info(`firing one-time "${key}" ${lateBy}min late (one-timers are never dropped)`);
      }
      return true;
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
    const lastSlot = this.state.get(key)?.slot ?? epochMinute;
    if (prevMinute <= lastSlot) return false;

    // Advance regardless of whether we deliver, so a stale fire isn't retried
    // and a delivered one doesn't re-fire on the next tick.
    this.mark(key, { slot: prevMinute });

    // Staleness cap: skip (but don't re-attempt) a catch-up fire that's too old.
    const lateBy = epochMinute - prevMinute;
    if (lateBy > CATCHUP_STALE_MINUTES) {
      slog.info(`skipping stale catch-up fire for ${key} (${lateBy}min late)`);
      this.mark(key, { skippedAt: epochMinute, skipReason: "stale_catchup" });
      // A daemon log line is UNREACH from a mind's sandbox, so a skipped fire
      // would otherwise be indistinguishable from an ordinary quiet hour. Tell
      // the mind whose schedule it was (#867). One notice per skipped slot —
      // the cursor has already advanced and `tick()` persists it, so a restart
      // does not re-skip and re-notify the same missed fire.
      this.noticeSkippedFire(mind, schedule, lateBy).catch((err) =>
        slog.warn(`failed to record skip notice for ${key}`, log.errorData(err)),
      );
      return false;
    }
    return true;
  }

  /**
   * Tell the mind that one of its fires was dropped for being too late.
   *
   * Always mind-level, never `schedule.thread`. A next-turn event on a named
   * thread is only drained by *that* thread's turns, and the thread a schedule
   * targets is frequently a thread only that schedule ever starts (a dream
   * prompt opens the dream thread). Addressing the notice there would strand it
   * in exactly the case it exists for — the fire that didn't happen. Mind-level
   * events are drained by any thread's next turn, and next-turn events survive
   * sleep untouched (the wake flush only replays `immediate` ones), so this
   * reaches the mind whenever it next thinks about anything.
   */
  protected async noticeSkippedFire(
    mindName: string,
    schedule: Schedule,
    lateBy: number,
  ): Promise<void> {
    await recordNotice({
      mind: mindName,
      thread: MIND_LEVEL_THREAD,
      kind: "delivery_failed",
      reason: "schedule_skipped_stale",
      detail: await getPrompt("schedule_skipped_notice", {
        id: schedule.id,
        late: String(lateBy),
      }),
    });
  }

  /**
   * Tell the mind its schedule is malformed and could not send anything.
   *
   * These states are only reachable by hand-editing `volute.json` (the API
   * validates), and a one-time entry in this shape is consumed below — so
   * without this the mind's reminder would vanish over a typo, leaving nothing
   * but a `slog.warn` its sandbox cannot read. That daemon-log-only silence is
   * the thing #867 exists to remove; reproducing it inside the same commit
   * would be an odd way to fix it.
   */
  protected async noticeInvalidSchedule(
    mindName: string,
    schedule: Schedule,
    reason: string,
  ): Promise<void> {
    slog.warn(`schedule "${schedule.id}" for ${mindName} is malformed: ${reason}`);
    await recordNotice({
      mind: mindName,
      thread: MIND_LEVEL_THREAD,
      kind: "delivery_failed",
      reason: "schedule_invalid",
      detail: await getPrompt("schedule_invalid_notice", {
        id: schedule.id,
        reason,
        fate: schedule.fireAt ? " It was a one-time schedule, so it has been removed." : "",
      }),
    });
  }

  private async fire(mindName: string, schedule: Schedule): Promise<void> {
    // A one-time timer is consumed as soon as its fire *resolves* — delivered, or
    // resolved with nothing to deliver. A side-effect-only script (append to a
    // log, touch a file, run a backup) prints nothing by design, and skipping
    // delivery used to skip consumption too, so it re-fired on every tick
    // forever (#866). The only outcome that keeps a one-timer armed is a failure
    // to record the event at all, so the next tick retries the insert.
    let consumeOneTimer = true;
    try {
      let text: string;
      if (schedule.script) {
        const homeDir = resolve(this.mindDirs.get(mindName) ?? mindDir(mindName), "home");
        try {
          const output = await this.runScript(schedule.script, homeDir, mindName);
          if (!output.trim()) {
            slog.info(`fired script "${schedule.id}" for ${mindName} (no output)`);
            // A silent side-effect script DID run. Recording it keeps the state
            // file honest: a nightly script that has worked for months must not
            // read as "never ran" just because it prints nothing (#867).
            this.markFired(mindName, schedule.id);
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
          await this.noticeInvalidSchedule(
            mindName,
            schedule,
            "its messages pool is not a list of non-empty strings",
          );
          return;
        }
        text = pick;
      } else if (schedule.message) {
        text = schedule.message;
      } else {
        await this.noticeInvalidSchedule(
          mindName,
          schedule,
          "it has no message, messages, or script to send",
        );
        return;
      }

      const { id, delivered } = await this.deliverSystem(mindName, schedule.id, text, {
        // Default schedule fires to "queue" while asleep so an unadorned cron
        // schedule doesn't inherit the DM wake-trigger fallback and wake the mind.
        whileSleeping: schedule.whileSleeping ?? "queue",
        thread: schedule.thread,
      });
      slog.info(`fired "${schedule.id}" for ${mindName}${delivered ? "" : " (event pending)"}`);

      // An undelivered event row stays pending and is redelivered on the mind's next
      // start or wake, so the reminder is not lost — only a failed insert (no id)
      // keeps a one-timer armed so the next tick retries (a retained fireAt refires
      // every minute, so retaining it after a successful insert would pile up
      // duplicate pending events).
      if (id == null) consumeOneTimer = false;
      else this.markFired(mindName, schedule.id);
    } catch (err) {
      // Nothing was recorded, so the one-timer stays armed for the next tick.
      consumeOneTimer = false;
      slog.warn(`failed to fire "${schedule.id}" for ${mindName}`, log.errorData(err));
      // The schedule fired but the mind never heard it — leave a notice rather than
      // only a daemon log the mind can't see (#366). recordNotice never throws.
      // A literal ephemeral thread would strand the notice in a session that never
      // runs another turn, so those fall back to mind-level ("$new" is collapsed by
      // deliverEvent itself).
      const detail = await getPrompt("schedule_failure_notice", {
        id: schedule.id,
        reason: err instanceof Error && err.message ? err.message : String(err),
      });
      const thread =
        schedule.thread && !schedule.thread.startsWith("new-")
          ? schedule.thread
          : MIND_LEVEL_THREAD;
      await recordNotice({
        mind: mindName,
        thread,
        kind: "delivery_failed",
        reason: "schedule_failed",
        detail,
      });
    } finally {
      if (schedule.fireAt && consumeOneTimer) this.removeSchedule(mindName, schedule.id);
    }
  }

  /**
   * Record that a fire was actually dispatched — the system event row exists.
   * Persisted immediately because `fire()` runs un-awaited from `tick()`, whose
   * own `saveState()` may already have run by the time this lands. `mark()`
   * creates the entry if it is missing, so a fire for a schedule whose key was
   * pruned still records rather than quietly going unrecorded.
   */
  private markFired(mindName: string, scheduleId: string): void {
    this.mark(`${mindName}:${scheduleId}`, { firedAt: Math.floor(Date.now() / 60000) });
    this.saveState().catch((err) =>
      slog.warn(`failed to persist fire for ${mindName}:${scheduleId}`, log.errorData(err)),
    );
  }

  private removeSchedule(mindName: string, scheduleId: string): void {
    // Drop the bookkeeping with the schedule. Ids get reused — `clock add --id
    // reminder --in 5m` is the natural repeat — and loadSchedules only baselines
    // keys it has never seen, so a surviving key would hand a brand-new schedule
    // a dead one's slot and firedAt: the state file would answer "did this run?"
    // with another schedule's fire, and a reused cron id could immediately land
    // in the stale-skip branch and tell the mind something created seconds ago
    // failed to run.
    if (this.state.delete(`${mindName}:${scheduleId}`)) {
      this.stateDirty = true;
      this.saveState().catch((err) =>
        slog.warn(`failed to persist removal of ${mindName}:${scheduleId}`, log.errorData(err)),
      );
    }

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
    // `volute` CLI authenticates as the mind instead of getting 401s, and they
    // never run in the daemon's trust domain. runMindScript owns both halves.
    return runMindScript("bash", ["-c", script], {
      mindName,
      dir: this.mindDirs.get(mindName),
      cwd,
    });
  }

  protected async deliverSystem(
    mindName: string,
    scheduleId: string,
    text: string,
    opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; thread?: string },
  ): Promise<{ id?: number; delivered: boolean }> {
    return deliverEvent(mindName, {
      type: "schedule",
      body: text,
      meta: { scheduleId },
      thread: opts?.thread,
      whileSleeping: opts?.whileSleeping,
    });
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
