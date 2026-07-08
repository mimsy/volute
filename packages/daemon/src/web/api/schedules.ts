import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { getScheduler } from "../../lib/daemon/scheduler.js";
import { getSleepManagerIfReady } from "../../lib/daemon/sleep-manager.js";
import { findMind, mindDir } from "../../lib/mind/registry.js";
import {
  readVoluteConfig,
  type Schedule,
  writeVoluteConfig,
} from "../../lib/mind/volute-config.js";
import log from "../../lib/util/logger.js";
import { fireWebhook } from "../../lib/webhook.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const slog = log.child("schedules");

function readSchedules(dir: string): Schedule[] {
  return readVoluteConfig(dir)?.schedules ?? [];
}

export type ClockEvent = { id: string; at: string; type: "cron" | "timer" };
export type ClockPrevious = { id: string; at: string };

/** Minimal shape of the sleep state the clock/status view needs. */
type ClockSleepState = {
  sleeping: boolean;
  scheduledWakeAt: string | null;
  voluntaryWakeAt: string | null;
  sleepingSince: string | null;
};

/**
 * Compute the `upcoming` / `previous` clock events shown in the dashboard and
 * `volute clock status`. Sleep/wake are surfaced with honest labels: a sleeping
 * mind's next event is its `wake` (at the effective wake time — a voluntary
 * `--wake-at` is authoritative), and an awake mind's most recent sleep event is
 * the `wake` that ended the last night. The next sleep onset stays `sleep`.
 */
export function computeClockEvents(
  schedules: Schedule[],
  sleepState: ClockSleepState | null,
  sleepConfig: { enabled?: boolean; schedule?: { sleep: string; wake: string } } | null,
  now: Date,
): { upcoming: ClockEvent[]; previous: ClockPrevious[] } {
  const upcoming: ClockEvent[] = [];
  const previous: ClockPrevious[] = [];

  for (const s of schedules) {
    if (!s.enabled) continue;
    if (s.fireAt) {
      const fireDate = new Date(s.fireAt);
      if (fireDate >= now) {
        upcoming.push({ id: s.id, at: fireDate.toISOString(), type: "timer" });
      }
    } else if (s.cron) {
      try {
        const next = CronExpressionParser.parse(s.cron, { currentDate: now }).next().toDate();
        upcoming.push({ id: s.id, at: next.toISOString(), type: "cron" });
      } catch {
        slog.warn(`invalid cron "${s.cron}" for schedule "${s.id}"`);
      }
      try {
        const prev = CronExpressionParser.parse(s.cron, { currentDate: now }).prev().toDate();
        previous.push({ id: s.id, at: prev.toISOString() });
      } catch {
        // ignore — prev() can fail for some expressions
      }
    }
  }

  if (sleepState?.sleeping) {
    // Next event is the wake, not "sleep". Effective wake favors the authoritative
    // voluntary time (scheduledWakeAt is nulled when a --wake-at is pinned).
    const effectiveWake = sleepState.scheduledWakeAt ?? sleepState.voluntaryWakeAt;
    if (effectiveWake) {
      upcoming.push({ id: "wake", at: effectiveWake, type: "cron" });
    }
    if (sleepState.sleepingSince) {
      previous.push({ id: "sleep", at: sleepState.sleepingSince });
    }
  } else if (sleepConfig?.enabled && sleepConfig.schedule) {
    try {
      const nextSleep = CronExpressionParser.parse(sleepConfig.schedule.sleep, { currentDate: now })
        .next()
        .toDate();
      upcoming.push({ id: "sleep", at: nextSleep.toISOString(), type: "cron" });
    } catch {
      /* ignore */
    }
    // Previous sleep-related event is the wake that ended the last night.
    try {
      const prevWake = CronExpressionParser.parse(sleepConfig.schedule.wake, { currentDate: now })
        .prev()
        .toDate();
      previous.push({ id: "wake", at: prevWake.toISOString() });
    } catch {
      /* ignore */
    }
  }

  upcoming.sort((a, b) => a.at.localeCompare(b.at));
  previous.sort((a, b) => b.at.localeCompare(a.at)); // most recent first
  return { upcoming, previous };
}

function writeSchedules(name: string, dir: string, schedules: Schedule[]): void {
  const config = readVoluteConfig(dir) ?? {};
  config.schedules = schedules.length > 0 ? schedules : undefined;
  writeVoluteConfig(dir, config);
  getScheduler().loadSchedules(name, dir);
  getSleepManagerIfReady()?.invalidateSleepConfig(name);
  fireWebhook({
    event: "schedule_changed",
    mind: name,
    data: { schedules },
  });
}

const app = new Hono<AuthEnv>()
  // Clock status — combined sleep state + upcoming schedules
  .get("/:name/clock/status", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const dir = entry.dir ?? mindDir(name);

    const sleepManager = getSleepManagerIfReady();
    const sleepState = sleepManager?.getState(name) ?? null;
    const sleepConfig = sleepManager?.getSleepConfig(name) ?? null;
    const schedules = readSchedules(dir);

    // Compute upcoming and previous schedule fires (incl. honest sleep/wake labels)
    const now = new Date();
    const { upcoming, previous } = computeClockEvents(schedules, sleepState, sleepConfig, now);

    return c.json({ sleep: sleepState, sleepConfig, schedules, upcoming, previous });
  })
  // Get sleep config
  .get("/:name/sleep/config", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const config = readVoluteConfig(entry.dir ?? mindDir(name));
    return c.json(config?.sleep ?? { enabled: false });
  })
  // Update sleep config
  .put("/:name/sleep/config", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as {
      enabled?: boolean;
      schedule?: { sleep: string; wake: string };
      wakeTriggers?: {
        mentions?: boolean;
        dms?: boolean;
        channels?: string[];
        senders?: string[];
      };
    };

    // Validate cron expressions if provided
    if (body.schedule) {
      for (const field of ["sleep", "wake"] as const) {
        if (body.schedule[field]) {
          try {
            CronExpressionParser.parse(body.schedule[field]);
          } catch {
            return c.json({ error: `Invalid ${field} cron: ${body.schedule[field]}` }, 400);
          }
        }
      }
    }

    const dir = entry.dir ?? mindDir(name);
    const config = readVoluteConfig(dir) ?? {};
    const sleep = config.sleep ?? {};

    if (body.enabled !== undefined) sleep.enabled = body.enabled;
    if (body.schedule !== undefined) sleep.schedule = body.schedule;
    if (body.wakeTriggers !== undefined) sleep.wakeTriggers = body.wakeTriggers;

    config.sleep = sleep;
    writeVoluteConfig(dir, config);

    getSleepManagerIfReady()?.invalidateSleepConfig(name);

    return c.json({ ok: true });
  })
  // List schedules
  .get("/:name/schedules", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    return c.json(readSchedules(entry.dir ?? mindDir(name)));
  })
  // Add schedule
  .post("/:name/schedules", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot use schedules — sprout first" }, 403);

    const body = (await c.req.json()) as Partial<Schedule>;
    if (!body.id) {
      return c.json({ error: "id is required (a descriptive name for this schedule)" }, 400);
    }
    if (!body.cron && !body.fireAt) {
      return c.json({ error: "cron or fireAt is required" }, 400);
    }
    if (body.cron && body.fireAt) {
      return c.json({ error: "cron and fireAt are mutually exclusive" }, 400);
    }
    if (!body.message && !body.script) {
      return c.json({ error: "message or script is required" }, 400);
    }
    if (body.message && body.script) {
      return c.json({ error: "message and script are mutually exclusive" }, 400);
    }

    if (body.cron) {
      try {
        CronExpressionParser.parse(body.cron);
      } catch {
        return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
      }
    }
    if (body.fireAt && Number.isNaN(new Date(body.fireAt).getTime())) {
      return c.json({ error: `Invalid fireAt date: ${body.fireAt}` }, 400);
    }
    if (body.whileSleeping && !["skip", "queue", "trigger-wake"].includes(body.whileSleeping)) {
      return c.json(
        {
          error: `Invalid whileSleeping value: ${body.whileSleeping} (must be skip, queue, or trigger-wake)`,
        },
        400,
      );
    }

    const dir = entry.dir ?? mindDir(name);
    const schedules = readSchedules(dir);
    const id = body.id;

    if (schedules.some((s) => s.id === id)) {
      return c.json({ error: `Schedule "${id}" already exists` }, 409);
    }

    const schedule: Schedule = { id, enabled: body.enabled ?? true };
    if (body.cron) schedule.cron = body.cron;
    if (body.fireAt) schedule.fireAt = body.fireAt;
    if (body.message) schedule.message = body.message;
    if (body.script) schedule.script = body.script;
    if (body.channel) schedule.channel = body.channel;
    if (body.whileSleeping) schedule.whileSleeping = body.whileSleeping;
    schedules.push(schedule);
    writeSchedules(name, dir, schedules);
    return c.json({ ok: true, id }, 201);
  })
  // Update schedule
  .put("/:name/schedules/:id", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const dir = entry.dir ?? mindDir(name);

    const schedules = readSchedules(dir);
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) return c.json({ error: "Schedule not found" }, 404);

    const body = (await c.req.json()) as Partial<Schedule>;
    if (body.message && body.script) {
      return c.json({ error: "message and script are mutually exclusive" }, 400);
    }
    if (body.cron !== undefined) {
      try {
        CronExpressionParser.parse(body.cron);
      } catch {
        return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
      }
      schedules[idx].cron = body.cron;
      delete schedules[idx].fireAt;
    }
    if (body.fireAt !== undefined) {
      if (Number.isNaN(new Date(body.fireAt).getTime())) {
        return c.json({ error: `Invalid fireAt date: ${body.fireAt}` }, 400);
      }
      schedules[idx].fireAt = body.fireAt;
      delete schedules[idx].cron;
    }
    if (body.message !== undefined) {
      schedules[idx].message = body.message;
      delete schedules[idx].script;
    }
    if (body.script !== undefined) {
      schedules[idx].script = body.script;
      delete schedules[idx].message;
    }
    if (body.whileSleeping && !["skip", "queue", "trigger-wake"].includes(body.whileSleeping)) {
      return c.json(
        {
          error: `Invalid whileSleeping value: ${body.whileSleeping} (must be skip, queue, or trigger-wake)`,
        },
        400,
      );
    }
    if (body.enabled !== undefined) schedules[idx].enabled = body.enabled;
    if (body.channel !== undefined) schedules[idx].channel = body.channel || undefined;
    if (body.whileSleeping !== undefined)
      schedules[idx].whileSleeping = body.whileSleeping || undefined;

    writeSchedules(name, dir, schedules);
    return c.json({ ok: true });
  })
  // Delete schedule
  .delete("/:name/schedules/:id", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const dir = entry.dir ?? mindDir(name);

    const schedules = readSchedules(dir);
    const filtered = schedules.filter((s) => s.id !== id);
    if (filtered.length === schedules.length) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    writeSchedules(name, dir, filtered);
    return c.json({ ok: true });
  })
  // Webhook endpoint
  .post("/:name/webhook/:event", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const event = c.req.param("event");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = await c.req.text();
    const message = `[webhook: ${event}] ${body}`;

    try {
      const { sendSystemMessage } = await import("../../lib/chat/system-chat.js");
      await sendSystemMessage(name, message);
      return c.json({ ok: true });
    } catch (err) {
      slog.warn(`webhook delivery failed for ${name}`, log.errorData(err));
      return c.json({ error: "Failed to reach mind" }, 502);
    }
  });

export default app;
