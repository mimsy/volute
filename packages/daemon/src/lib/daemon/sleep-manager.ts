import { execFile, spawn as spawnChild } from "node:child_process";
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
import { and, eq, inArray } from "drizzle-orm";
import {
  deliverEvent,
  flushQueuedEvents,
  MIND_LEVEL_THREAD,
  pendingEventCount,
  pendingEventsLine,
  recordNotice,
} from "../chat/system-events.js";
import { getDb } from "../db.js";
import type { DeliveryPayload } from "../delivery/delivery-router.js";
import {
  type ActivityEvent,
  publish as publishActivity,
  subscribe,
} from "../events/activity-events.js";
import { findMind, mindDir, voluteSystemDir } from "../mind/registry.js";
import { readVoluteConfig, resolveWakeTriggers, type SleepConfig } from "../mind/volute-config.js";
import { getPrompt } from "../prompts.js";
import { deliveryQueue } from "../schema.js";
import log from "../util/logger.js";
import { getMindManager } from "./mind-manager.js";
import { sleepMind, wakeMind } from "./mind-service.js";

const slog = log.child("sleep");

/** Give up waking a mind after this many consecutive failures and mark it errored (#419). */
const MAX_WAKE_ATTEMPTS = 5;
/** Backoff before the next retry, indexed by (failures - 1) and capped at the last entry. */
const WAKE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type SleepState = {
  sleeping: boolean;
  sleepingSince: string | null;
  scheduledWakeAt: string | null;
  wokenByTrigger: boolean;
  voluntaryWakeAt: string | null;
  queuedMessageCount: number;
  triggerWakeHistory: { channel: string; at: string }[];
  /** Consecutive failed wake attempts; reset on a successful wake (#419). */
  wakeFailures: number;
  /** Earliest time the next wake retry may run, while backing off after failures. */
  nextWakeAttemptAt: string | null;
  /**
   * Timestamp of the last full wake (manual `clock wake` or scheduled wake).
   * Level-triggered sleep onset (#453) uses it to exempt a mind woken inside the
   * current sleep window from being immediately re-slept. Persisted for awake
   * minds so the exemption survives a daemon restart.
   */
  lastWakeAt: string | null;
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
    triggerWakeHistory: [],
    wakeFailures: 0,
    nextWakeAttemptAt: null,
    lastWakeAt: null,
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

/** "at 7:00 AM on Tuesday, July 7" for a parseable wake time; a gentle phrase when none is set. */
function formatWakeTime(wakeAt: string | null | undefined): string {
  if (wakeAt) {
    const date = new Date(wakeAt);
    if (!Number.isNaN(date.getTime())) {
      const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const day = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      return `at ${time} on ${day}`;
    }
    return `at ${wakeAt}`;
  }
  return "when something needs you — a message, a mention, or someone waking you";
}

function formatDuration(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const globRegexCache = new Map<string, RegExp>();
export function matchesGlob(pattern: string, value: string): boolean {
  let re = globRegexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    globRegexCache.set(pattern, re);
  }
  return re.test(value);
}

export class SleepManager {
  private states = new Map<string, SleepState>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsubActivity: (() => void) | null = null;
  private transitioning = new Set<string>();
  private sleepConfigs = new Map<string, SleepConfig | null>();

  private get statePath(): string {
    return resolve(voluteSystemDir(), "sleep-state.json");
  }

  start(): void {
    this.loadState();
    this.interval = setInterval(() => this.tick(), 60_000);
    // Listen for mind_idle events for return-to-sleep after trigger wake
    this.unsubActivity = subscribe((event) => this.onActivityEvent(event));
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.unsubActivity) this.unsubActivity();
    this.unsubActivity = null;
  }

  // --- State persistence ---

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const data: SleepStatePersisted = JSON.parse(readFileSync(this.statePath, "utf-8"));
        for (const [name, state] of Object.entries(data)) {
          state.triggerWakeHistory ??= [];
          state.wakeFailures ??= 0;
          state.nextWakeAttemptAt ??= null;
          state.lastWakeAt ??= null;
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
      // Persist sleeping states, plus awake minds that carry a lastWakeAt so the
      // manual-wake exemption for level-triggered sleep onset survives a restart.
      if (state.sleeping || state.lastWakeAt) data[name] = state;
    }
    try {
      writeFileSync(this.statePath, `${JSON.stringify(data, null, 2)}\n`);
    } catch (err) {
      slog.error("failed to save sleep state", log.errorData(err));
    }
  }

  // --- Public API ---

  isSleeping(name: string): boolean {
    const state = this.states.get(name);
    if (!state?.sleeping) return false;
    if (state.wokenByTrigger) return false;
    return true;
  }

  getState(name: string): SleepState {
    return this.states.get(name) ?? defaultState();
  }

  /**
   * Convert a trigger-wake into a full wake. The mind is already running;
   * this just clears the sleep state so onActivityEvent won't return it to sleep.
   */
  convertTriggerToFullWake(name: string): void {
    const state = this.states.get(name);
    if (!state?.sleeping || !state.wokenByTrigger) return;
    this.markAwake(name);
    slog.info(`${name} trigger-wake converted to full wake`);
  }

  /**
   * A trigger-woken mind's process crashed while still in the brief trigger-wake
   * window. The mind-manager crash handler calls this to return it to sleep —
   * archive the (now-dead) session and restore sleeping state — rather than
   * leaving it in sleeping+wokenByTrigger limbo. Mirrors the idle-driven
   * return-to-sleep in onActivityEvent, minus stopping an already-dead process.
   */
  async returnToSleepAfterCrash(name: string): Promise<void> {
    const state = this.states.get(name);
    if (!state?.sleeping || !state.wokenByTrigger) return;
    if (this.transitioning.has(name)) return;
    this.transitioning.add(name);
    state.wokenByTrigger = false;
    try {
      // The mid-wake work is discarded with the crashed process — leave a notice so
      // the next real wake explains the gap instead of silent amnesia (#367). Recorded
      // first so a failure archiving/re-sleeping below can't also swallow the notice,
      // but inside the try so an unexpected throw can't leak the transitioning lock.
      await recordNotice({
        mind: name,
        thread: MIND_LEVEL_THREAD,
        kind: "crash",
        reason: "trigger_wake_crash",
        detail: await getPrompt("trigger_wake_crash_notice"),
      });
      // Process already crashed; sleepMind's stopMind is a no-op here, but it
      // also marks idle and publishes the sleeping event for consistency.
      try {
        await sleepMind(name);
      } catch (err) {
        slog.warn(`sleepMind during crash-return failed for ${name}`, log.errorData(err));
      }
      await this.archiveSessions(name);
      state.sleeping = true;
      // Keep the original bedtime (sleepingSince) — sleep never actually ended
      // during a trigger-wake. Only recompute the cron wake when no voluntary
      // wake-at is pinned for the night (it stays authoritative).
      if (!state.voluntaryWakeAt) {
        state.scheduledWakeAt = this.getNextWakeTime(this.getSleepConfig(name));
      }
      this.saveState();
      slog.info(`${name} returned to sleep after crashing during trigger wake`);
    } catch (err) {
      slog.error(`failed to return ${name} to sleep after crash`, log.errorData(err));
    } finally {
      this.transitioning.delete(name);
    }
  }

  getSleepConfig(name: string): SleepConfig | null {
    if (this.sleepConfigs.has(name)) {
      return this.sleepConfigs.get(name) ?? null;
    }
    const config = this.loadSleepConfig(name);
    return config;
  }

  loadSleepConfig(name: string): SleepConfig | null {
    const dir = mindDir(name);
    const config = readVoluteConfig(dir);
    const sleepConfig = config?.sleep ?? null;
    this.sleepConfigs.set(name, sleepConfig);
    return sleepConfig;
  }

  invalidateSleepConfig(name: string): void {
    this.sleepConfigs.delete(name);
  }

  /**
   * Put a mind to sleep. Sends pre-sleep message, waits for completion,
   * archives session, then stops the mind process.
   */
  async initiateSleep(name: string, opts?: { voluntaryWakeAt?: string }): Promise<void> {
    if (this.isSleeping(name)) return;
    if (this.transitioning.has(name)) return;
    this.transitioning.add(name);

    try {
      const manager = getMindManager();
      if (!manager.isRunning(name)) {
        // Mind not running — just mark as sleeping
        this.markSleeping(name, opts);
        return;
      }

      const entry = await findMind(name);
      if (!entry) return;

      // Send pre-sleep message. wakeTime fills "You'll wake ${wakeTime}." — either a
      // concrete "at <time>" or a phrase describing what will rouse the mind.
      const sleepConfig = this.getSleepConfig(name);
      const wakeAt = opts?.voluntaryWakeAt ?? this.getNextWakeTime(sleepConfig);
      const wakeTime = formatWakeTime(wakeAt);
      const preSleepMsg = await getPrompt("pre_sleep", { wakeTime });

      // Deliver the pre-sleep event (the mind is still awake here). If it never reached
      // the mind there is no wind-down turn to wait for — skip the idle wait rather than
      // burning the full timeout. (Undelivered sleep events are never replayed: they are
      // only meaningful at bedtime, so the wake flush expires them.)
      const { delivered } = await deliverEvent(name, { type: "sleep", body: preSleepMsg });

      // An undelivered sleep event is never replayed (expired at the wake flush), so
      // the wind-down turn is genuinely lost — tell the mind on its next wake (#366).
      if (!delivered) {
        await recordNotice({
          mind: name,
          thread: MIND_LEVEL_THREAD,
          kind: "delivery_failed",
          reason: "pre_sleep_failed",
          detail: await getPrompt("pre_sleep_failure_notice"),
        });
      }

      // Wait for mind to finish processing (timeout 120s)
      if (delivered) await this.waitForIdle(name, 120_000);

      // Wait a beat for hooks (identity-reload, auto-commit) to settle
      await new Promise((r) => setTimeout(r, 3000));

      // Stop the mind process (not connectors) before archiving
      await sleepMind(name);

      // Kill any orphan process still on the port (e.g. from identity-reload hook restart)
      await this.killOrphanOnPort(entry.port);

      // Archive sessions after process is stopped
      await this.archiveSessions(name);

      this.markSleeping(name, opts);
      slog.info(`${name} is now sleeping`);
    } finally {
      this.transitioning.delete(name);
    }
  }

  /**
   * Wake a sleeping mind. Starts the process, delivers wake summary.
   */
  async initiateWake(name: string, opts?: { trigger?: { channel: string } }): Promise<void> {
    const state = this.states.get(name);
    if (!state?.sleeping) return;
    if (this.transitioning.has(name)) return;
    this.transitioning.add(name);

    try {
      // Start the mind process (skip if already running — e.g. process wasn't stopped during sleep)
      const manager = getMindManager();
      if (!manager.isRunning(name)) {
        try {
          await wakeMind(name);
        } catch (err) {
          await this.handleWakeFailure(name, err);
          return;
        }
      }

      // Wait for health check
      const entry = await findMind(name);
      if (!entry) return;

      // Wake succeeded — clear any prior failure backoff so future failures start fresh.
      this.resetWakeBackoff(name);

      if (opts?.trigger) {
        // Trigger-wakes are brief interruptions — the trigger message itself
        // provides context, so skip the wake summary. The mind returns to sleep
        // after going idle via onActivityEvent.
        state.wokenByTrigger = true;
        state.triggerWakeHistory.push({
          channel: opts.trigger.channel,
          at: new Date().toISOString(),
        });
        this.saveState();
      } else {
        const sleepingSince = state.sleepingSince ? new Date(state.sleepingSince) : new Date();
        const now = new Date();
        const duration = formatDuration(sleepingSince, now);
        const currentDate = formatCurrentDate();
        const sleepTime = sleepingSince.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });

        // Build wake context sections
        const triggerWakeSummary = this.buildTriggerWakeSummary(state);
        const wakeContext = await this.runWakeContextScript(
          name,
          state.sleepingSince ?? sleepingSince.toISOString(),
          duration,
        );
        const queuedSummary = await this.buildQueuedSummary(name);
        const eventsSummary = pendingEventsLine(await pendingEventCount(name));
        const sleepActivity = [triggerWakeSummary, wakeContext, queuedSummary, eventsSummary]
          .filter(Boolean)
          .join("\n\n");

        const summaryText = await getPrompt("wake_summary", {
          currentDate,
          sleepTime,
          duration,
          sleepActivity,
        });

        // Deliver the wake event directly (the mind is running but still flagged sleeping).
        await deliverEvent(name, { type: "wake", body: summaryText, force: true });

        // Let the wake-summary turn finish before flushing the backlog (#382), so the
        // summary and the per-channel batches arrive as separate, ordered turns rather
        // than interleaving. Bounded so a stuck turn can't wedge the flush.
        await this.waitForIdle(name, 120_000);
      }

      // Flush queued messages (grouped into one pre-batched turn per channel)
      const flushed = await this.flushQueuedMessages(name);
      if (flushed > 0) {
        slog.info(`flushed ${flushed} queued message(s) for ${name}`);
      }

      // Flush queued system events (delivered oldest-first after the wake event).
      const flushedEvents = await flushQueuedEvents(name);
      if (flushedEvents > 0) {
        slog.info(`flushed ${flushedEvents} queued event(s) for ${name}`);
      }

      // Mark as awake
      if (!opts?.trigger) {
        this.markAwake(name);
      }

      slog.info(`${name} is now awake${opts?.trigger ? " (trigger wake)" : ""}`);
    } finally {
      this.transitioning.delete(name);
    }
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
    const { mentions: mentionsEnabled, dms: dmsEnabled } = resolveWakeTriggers(triggers);

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
    const db = await getDb();
    await db.insert(deliveryQueue).values({
      mind: name,
      thread: "sleep",
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
  }

  /**
   * Flush all queued sleep messages for a mind on wake. Rows are grouped by channel
   * and each channel group is delivered as ONE pre-batched turn (#382) — a night's
   * backlog becomes one stack per channel, not N cold-start doorbells. Delivery is
   * all-or-nothing per channel: a failed group's rows stay queued for the next wake,
   * while other channels still flush.
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

      // Parse payloads, dropping any that can never be delivered so they don't wedge
      // the flush (or replay forever on every wake). Group survivors by channel,
      // preserving arrival order within each channel.
      const groups = new Map<string, { id: number; payload: DeliveryPayload }[]>();
      for (const row of rows) {
        let payload: DeliveryPayload;
        try {
          payload = JSON.parse(row.payload);
        } catch (err) {
          slog.warn(
            `dropping unparseable queued message ${row.id} for ${name}`,
            log.errorData(err),
          );
          await db.delete(deliveryQueue).where(eq(deliveryQueue.id, row.id));
          continue;
        }
        const channel = payload.channel ?? "unknown";
        if (!groups.has(channel)) groups.set(channel, []);
        groups.get(channel)?.push({ id: row.id, payload });
      }

      let deliveredCount = 0;
      for (const [channel, items] of groups) {
        const delivered = await this.deliverQueuedBatch(
          name,
          items.map((i) => i.payload),
        );
        if (!delivered) {
          // Whole-group failure: leave this channel's rows queued so they retry on the
          // next wake, but keep flushing the other (independent) channels.
          slog.warn(
            `failed to flush ${items.length} queued message(s) on ${channel} for ${name}; leaving them queued`,
          );
          continue;
        }
        // Delete the group's rows only after a successful batch ack.
        await db.delete(deliveryQueue).where(
          inArray(
            deliveryQueue.id,
            items.map((i) => i.id),
          ),
        );
        deliveredCount += items.length;
      }

      const state = this.states.get(name);
      if (state) {
        state.queuedMessageCount = Math.max(0, state.queuedMessageCount - deliveredCount);
      }

      return deliveredCount;
    } catch (err) {
      slog.warn(`failed to flush queued messages for ${name}`, log.errorData(err));
      return 0;
    }
  }

  /**
   * Deliver one channel's worth of queued messages as a single pre-batched turn on
   * the wake path. Extracted as a seam so the flush loop can be unit-tested without
   * the real delivery stack. Returns whether the batch was handed off to the mind.
   */
  protected async deliverQueuedBatch(name: string, payloads: DeliveryPayload[]): Promise<boolean> {
    // Import lazily to avoid a circular dependency with message-delivery.
    const { deliverBatch } = await import("../delivery/message-delivery.js");
    return deliverBatch(name, payloads);
  }

  // --- Wake failure handling (#419) ---

  /**
   * Record a failed wake attempt. Applies exponential backoff between retries and,
   * after MAX_WAKE_ATTEMPTS consecutive failures, gives up and marks the mind errored
   * rather than retrying every tick forever.
   */
  protected async handleWakeFailure(name: string, err: unknown): Promise<void> {
    const state = this.states.get(name);
    if (!state?.sleeping) return;

    state.wakeFailures = (state.wakeFailures ?? 0) + 1;

    if (state.wakeFailures >= MAX_WAKE_ATTEMPTS) {
      await this.markWakeErrored(name, err);
      return;
    }

    const backoff = WAKE_BACKOFF_MS[Math.min(state.wakeFailures - 1, WAKE_BACKOFF_MS.length - 1)];
    state.nextWakeAttemptAt = new Date(Date.now() + backoff).toISOString();
    this.saveState();
    slog.warn(
      `failed to wake ${name} (attempt ${state.wakeFailures}/${MAX_WAKE_ATTEMPTS}); retrying in ${Math.round(backoff / 60_000)}m`,
      log.errorData(err),
    );
  }

  /** Clear wake-failure backoff after a successful wake. */
  private resetWakeBackoff(name: string): void {
    const state = this.states.get(name);
    if (!state) return;
    if (state.wakeFailures === 0 && state.nextWakeAttemptAt === null) return;
    state.wakeFailures = 0;
    state.nextWakeAttemptAt = null;
    this.saveState();
  }

  /**
   * A mind has failed to wake too many times — it isn't asleep, it's broken.
   * Clear the sleep state (so the tick stops retrying) and surface the failure
   * loudly: error log, activity event for the web UI, and a mind notice so the
   * mind learns what happened on its next successful session. A manual
   * `volute clock wake` / `volute mind start` is the recovery path.
   */
  protected async markWakeErrored(name: string, err: unknown): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    // The mind never woke — clear its sleep state entirely (no lastWakeAt, unlike
    // a successful markAwake) so the tick stops retrying and nothing lingers.
    this.states.delete(name);
    this.saveState();

    slog.error(
      `${name} failed to wake ${MAX_WAKE_ATTEMPTS} times in a row; giving up and marking errored`,
      log.errorData(err),
    );

    try {
      await publishActivity({
        type: "mind_stopped",
        mind: name,
        summary: `${name} failed to wake after ${MAX_WAKE_ATTEMPTS} attempts`,
        metadata: { error: "wake_failed", detail },
      });
    } catch (e) {
      slog.error(`failed to publish wake-failure activity for ${name}`, log.errorData(e));
    }

    await recordNotice({
      mind: name,
      thread: MIND_LEVEL_THREAD,
      kind: "startup",
      reason: "startup_failed",
      detail: `Wake failed ${MAX_WAKE_ATTEMPTS} times in a row and was given up. Last error: ${detail}`,
    });
  }

  // --- Internal methods ---

  private markSleeping(name: string, opts?: { voluntaryWakeAt?: string }): void {
    const sleepConfig = this.getSleepConfig(name);
    const state: SleepState = {
      sleeping: true,
      sleepingSince: new Date().toISOString(),
      // An explicit voluntary wake-at is authoritative for the night — null out
      // the cron wake so an earlier scheduled wake can't silently override it.
      scheduledWakeAt: opts?.voluntaryWakeAt ? null : this.getNextWakeTime(sleepConfig),
      wokenByTrigger: false,
      voluntaryWakeAt: opts?.voluntaryWakeAt ?? null,
      queuedMessageCount: this.states.get(name)?.queuedMessageCount ?? 0,
      triggerWakeHistory: [],
      wakeFailures: 0,
      nextWakeAttemptAt: null,
      lastWakeAt: this.states.get(name)?.lastWakeAt ?? null,
    };
    this.states.set(name, state);
    this.saveState();
  }

  private markAwake(name: string): void {
    // Keep a minimal awake entry recording when the mind last fully woke, so
    // level-triggered sleep onset (#453) won't immediately re-sleep a mind woken
    // inside its own sleep window (manual `clock wake` or a scheduled wake).
    this.states.set(name, { ...defaultState(), lastWakeAt: new Date().toISOString() });
    this.saveState();
  }

  private getNextWakeTime(config: SleepConfig | null): string | null {
    if (!config?.schedule?.wake) return null;
    try {
      const interval = CronExpressionParser.parse(config.schedule.wake);
      return interval.next().toDate().toISOString();
    } catch (err) {
      slog.warn(`invalid wake cron "${config.schedule.wake}"`, log.errorData(err));
      return null;
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();

    // Iterate minds that have sleep configs or sleep state, avoiding a full registry query
    const mindNames = new Set([...this.sleepConfigs.keys(), ...this.states.keys()]);

    for (const name of mindNames) {
      await this.evaluateMind(name, now);
    }
  }

  /**
   * Per-mind tick evaluation. The wake checks depend only on the persisted sleep
   * state — never on a currently-enabled sleep config — so a mind that was put to
   * sleep with a wake time still wakes even if the schedule is later disabled or
   * removed (or never existed, e.g. a bare `clock sleep --wake-at`). Only the
   * sleep-onset check requires a running mind with an enabled schedule.
   */
  private async evaluateMind(name: string, now: Date): Promise<void> {
    const state = this.states.get(name);

    if (state?.sleeping) {
      // In wake-failure backoff — wait before retrying rather than hammering
      // wakeMind every tick (#419).
      if (state.nextWakeAttemptAt && now < new Date(state.nextWakeAttemptAt)) return;

      // Voluntary wake time
      if (state.voluntaryWakeAt && now >= new Date(state.voluntaryWakeAt)) {
        this.initiateWake(name).catch((err) =>
          slog.error(`failed voluntary wake for ${name}`, log.errorData(err)),
        );
        return;
      }

      // Scheduled wake time
      if (state.scheduledWakeAt && now >= new Date(state.scheduledWakeAt)) {
        this.initiateWake(name).catch((err) =>
          slog.error(`failed scheduled wake for ${name}`, log.errorData(err)),
        );
        return;
      }

      // Sleeping but not yet time to wake (or intentionally indefinite) — done.
      return;
    }

    // Sleep-onset — requires a running mind and an enabled schedule.
    const mind = await findMind(name);
    if (!mind?.running) return;
    const config = this.getSleepConfig(name);
    if (!config?.enabled || !config.schedule) return;

    if (this.shouldSleepNow(config.schedule, state?.lastWakeAt ?? null, now)) {
      this.initiateSleep(name).catch((err) =>
        slog.error(`failed to initiate sleep for ${name}`, log.errorData(err)),
      );
    }
  }

  /**
   * Level-triggered sleep-onset decision: sleep whenever we're inside the nightly
   * window, not only on the exact sleep minute — so a daemon restart or a stalled
   * tick across the sleep minute still puts the mind to bed on the next tick.
   *
   * Manual-wake exemption: a full wake inside the current window (human
   * `clock wake`, or a scheduled wake) suppresses re-sleep until the next window
   * begins, so `volute clock wake` at 3am sticks instead of being undone a minute
   * later.
   */
  shouldSleepNow(
    schedule: { sleep: string; wake: string },
    lastWakeAt: string | null,
    now: Date,
  ): boolean {
    const { inWindow, windowStart } = this.inSleepWindow(schedule, now);
    if (!inWindow || !windowStart) return false;
    if (lastWakeAt && new Date(lastWakeAt) >= windowStart) return false;
    return true;
  }

  /**
   * Whether `now` falls inside the mind's nightly sleep window: the most recent
   * sleep-cron fire is more recent than the most recent wake-cron fire. Returns
   * the window start (last sleep fire) for the manual-wake exemption check.
   */
  inSleepWindow(
    schedule: { sleep: string; wake: string },
    now: Date,
  ): { inWindow: boolean; windowStart: Date | null } {
    try {
      const prevSleep = CronExpressionParser.parse(schedule.sleep, { currentDate: now })
        .prev()
        .toDate();
      const prevWake = CronExpressionParser.parse(schedule.wake, { currentDate: now })
        .prev()
        .toDate();
      return { inWindow: prevSleep > prevWake, windowStart: prevSleep };
    } catch (err) {
      slog.warn(
        `invalid sleep/wake cron "${schedule.sleep}"/"${schedule.wake}"`,
        log.errorData(err),
      );
      return { inWindow: false, windowStart: null };
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
        if (file === "archive" || !file.endsWith(".json")) continue;
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

    // Codex template: .mind/codex-sessions/ (pointer files holding { threadId }).
    // Archive them like the claude branch so codex minds get a fresh session on
    // wake and the old threadId is preserved for session seeding.
    const codexSessionsDir = resolve(dir, ".mind", "codex-sessions");
    if (existsSync(codexSessionsDir)) {
      const archiveDir = resolve(codexSessionsDir, "archive");
      mkdirSync(archiveDir, { recursive: true });

      for (const file of readdirSync(codexSessionsDir)) {
        if (file === "archive" || !file.endsWith(".json")) continue;
        const src = resolve(codexSessionsDir, file);
        const base = file.replace(/\.json$/, "");
        const dest = resolve(archiveDir, `${base}-${timestamp}.json`);
        try {
          renameSync(src, dest);
        } catch (err) {
          slog.warn(`failed to archive codex-session ${file} for ${name}`, log.errorData(err));
        }
      }
    }
  }

  private async runWakeContextScript(
    name: string,
    sleepingSince: string,
    duration: string,
  ): Promise<string> {
    const scriptPath = resolve(mindDir(name), "home", ".local", "hooks", "wake-context.sh");
    if (!existsSync(scriptPath)) return "";

    const input = JSON.stringify({
      sleepingSince,
      duration,
      wakeTime: new Date().toISOString(),
    });

    try {
      const result = await new Promise<string>((resolvePromise, reject) => {
        const child = spawnChild("bash", [scriptPath], {
          cwd: mindDir(name),
          timeout: 5000,
          env: { ...process.env, VOLUTE_MIND: name },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        child.on("close", (code) => {
          if (code === 0) resolvePromise(stdout);
          else
            reject(
              new Error(
                `wake-context script exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
              ),
            );
        });
        child.on("error", reject);
        child.stdin.end(input);
      });
      return result.trim();
    } catch (err) {
      slog.warn(`wake-context script failed for ${name}`, log.errorData(err));
      return "";
    }
  }

  private buildTriggerWakeSummary(state: SleepState): string {
    const history = state.triggerWakeHistory;
    if (!history || history.length === 0) return "";

    const channels = [...new Set(history.map((h) => h.channel))];
    const times = history.length === 1 ? "once" : `${history.length} times`;
    return `You were briefly woken ${times} during sleep to handle messages on ${channels.join(", ")} (sessions were archived after each).`;
  }

  private async buildQueuedSummary(name: string): Promise<string> {
    try {
      const db = await getDb();
      const rows = await db
        .select({ channel: deliveryQueue.channel, sender: deliveryQueue.sender })
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, name), eq(deliveryQueue.status, "sleep-queued")))
        .all();

      if (rows.length === 0) return "No messages arrived while you slept.";

      // Count per channel and collect unique senders
      const channelCounts = new Map<string, number>();
      const senders = new Set<string>();
      for (const row of rows) {
        const ch = row.channel ?? "unknown";
        channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
        if (row.sender) senders.add(row.sender);
      }

      const parts = [...channelCounts.entries()].map(([ch, count]) => `${count} on ${ch}`);
      const senderNote = senders.size > 0 ? ` from ${[...senders].join(", ")}` : "";
      return `${rows.length} message${rows.length === 1 ? "" : "s"} arrived while you slept${senderNote} (${parts.join(", ")}). They'll be delivered to your normal channels now.`;
    } catch (err) {
      slog.error(`failed to build queued summary for ${name}`, log.errorData(err));
      return "Unable to check for queued messages — there may be messages waiting.";
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
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
              slog.warn(`failed to kill orphan pid ${pid}`, log.errorData(err));
            }
          }
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
      } catch (err) {
        slog.warn(`failed to kill orphan on port ${port} via /proc`, log.errorData(err));
      }
    }

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 1000));
  }

  private onActivityEvent(event: ActivityEvent & { id: number; created_at: string }): void {
    const state = this.states.get(event.mind);
    if (!state?.sleeping || !state.wokenByTrigger) return;
    if (this.transitioning.has(event.mind)) return;

    if (event.type === "mind_idle") {
      // Mind went idle after trigger wake — return to sleep
      slog.info(`${event.mind} going back to sleep after trigger wake`);
      state.wokenByTrigger = false;
      this.transitioning.add(event.mind);

      // Stop first, then archive (no pre-sleep ritual — session is fresh)
      sleepMind(event.mind)
        .then(() => this.archiveSessions(event.mind))
        .then(() => {
          state.sleeping = true;
          // Keep the original bedtime (sleepingSince) — sleep never actually
          // ended during a trigger-wake. Only recompute the cron wake when no
          // voluntary wake-at is pinned for the night (it stays authoritative).
          if (!state.voluntaryWakeAt) {
            const sleepConfig = this.getSleepConfig(event.mind);
            state.scheduledWakeAt = this.getNextWakeTime(sleepConfig);
          }
          this.saveState();
          slog.info(`${event.mind} returned to sleep`);
        })
        .catch((err) => {
          slog.error(`failed to return ${event.mind} to sleep`, log.errorData(err));
        })
        .finally(() => {
          this.transitioning.delete(event.mind);
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
