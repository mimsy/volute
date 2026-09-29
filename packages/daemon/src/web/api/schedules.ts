import { zValidator } from "@hono/zod-validator";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { z } from "zod";
import { getScheduler } from "../../lib/daemon/scheduler.js";
import { getSleepManagerIfReady } from "../../lib/daemon/sleep-manager.js";
import { upsertEventRule } from "../../lib/mind/event-routes.js";
import { mindFileOwner } from "../../lib/mind/isolation.js";
import { findMind, getBaseName, mindDir } from "../../lib/mind/registry.js";
import {
  readVoluteConfig,
  type Schedule,
  updateMindVoluteConfig,
} from "../../lib/mind/volute-config.js";
import log from "../../lib/util/logger.js";
import { fireWebhook } from "../../lib/webhook.js";
import { type AuthEnv, requireSelf, requireSelfOrSpirit } from "../middleware/auth.js";

const slog = log.child("schedules");

// Validates the body shape only (types + the whileSleeping enum). Every cross-field
// rule (cron/fireAt mutual exclusion, cron parse, fireAt date, action-required,
// non-empty messages) stays in the handler, so the accepted set is unchanged for
// valid input — malformed *types* now 400 structurally instead of flowing through.
const scheduleBodySchema = z.object({
  id: z.string().optional(),
  cron: z.string().optional(),
  fireAt: z.string().optional(),
  message: z.string().optional(),
  messages: z.array(z.string()).optional(),
  script: z.string().optional(),
  enabled: z.boolean().optional(),
  whileSleeping: z.enum(["skip", "queue", "trigger-wake"]).optional(),
  thread: z.string().optional(),
});

const sleepConfigSchema = z.object({
  enabled: z.boolean().optional(),
  schedule: z.object({ sleep: z.string(), wake: z.string() }).optional(),
  wakeTriggers: z
    .object({
      mentions: z.boolean().optional(),
      dms: z.boolean().optional(),
      channels: z.array(z.string()).optional(),
      senders: z.array(z.string()).optional(),
    })
    .optional(),
});

function readSchedules(dir: string): Schedule[] {
  return readVoluteConfig(dir)?.schedules ?? [];
}

/** Validate a rotating-messages pool: must be an array of non-empty strings. */
function validateMessages(messages: unknown): string | null {
  if (messages === undefined) return null;
  if (!Array.isArray(messages) || messages.some((m) => typeof m !== "string" || !m.trim())) {
    return "messages must be an array of non-empty strings";
  }
  return null;
}

export type ClockEvent = {
  id: string;
  at: string;
  type: "cron" | "timer";
  /** Sleeping mind: this fire lands before wake and its whileSleeping is "skip". */
  willSkip?: boolean;
  /** Sleeping mind: this fire lands before wake and will be queued until wake. */
  willQueue?: boolean;
};
export type ClockPrevious = { id: string; at: string };

/** Only surface fires within this window in the "upcoming (next 24h)" view. */
const UPCOMING_HORIZON_MS = 24 * 60 * 60 * 1000;

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

  // Effective wake for a sleeping mind — favors the authoritative voluntary time
  // (scheduledWakeAt is nulled when a --wake-at is pinned). Used to annotate which
  // schedule fires land before wake and will be skipped/queued.
  const effectiveWake = sleepState?.sleeping
    ? (sleepState.scheduledWakeAt ?? sleepState.voluntaryWakeAt)
    : null;
  const effectiveWakeDate = effectiveWake ? new Date(effectiveWake) : null;

  // Annotate a fire that lands during sleep with its while-sleeping fate.
  const sleepFate = (s: Schedule, fireDate: Date): Partial<ClockEvent> => {
    if (!effectiveWakeDate || fireDate >= effectiveWakeDate) return {};
    const ws = s.whileSleeping ?? "queue";
    if (ws === "skip") return { willSkip: true };
    if (ws === "trigger-wake") return {}; // wakes the mind — the fire happens
    return { willQueue: true };
  };

  for (const s of schedules) {
    if (!s.enabled) continue;
    if (s.fireAt) {
      const fireDate = new Date(s.fireAt);
      if (fireDate >= now) {
        upcoming.push({
          id: s.id,
          at: fireDate.toISOString(),
          type: "timer",
          ...sleepFate(s, fireDate),
        });
      }
    } else if (s.cron) {
      try {
        const next = CronExpressionParser.parse(s.cron, { currentDate: now }).next().toDate();
        upcoming.push({ id: s.id, at: next.toISOString(), type: "cron", ...sleepFate(s, next) });
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
    // Next event is the wake, not "sleep".
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

  // "Upcoming (next 24h)" — drop fires beyond the horizon (e.g. a weekly cron
  // days out). Sleeping-mind currentItem shows the wake separately, so filtering
  // the wake entry here is harmless.
  const horizon = now.getTime() + UPCOMING_HORIZON_MS;
  const withinHorizon = upcoming.filter((e) => new Date(e.at).getTime() <= horizon);

  withinHorizon.sort((a, b) => a.at.localeCompare(b.at));
  previous.sort((a, b) => b.at.localeCompare(a.at)); // most recent first
  return { upcoming: withinHorizon, previous };
}

/**
 * Apply `mutate` to the mind's schedules and write them back, under one read-modify-write
 * of volute.json — a mind's parallel `clock add` calls must not drop each other's
 * schedule. `mutate` returns null to write nothing; the result is what was written.
 */
async function writeSchedules(
  name: string,
  dir: string,
  mutate: (schedules: Schedule[]) => Schedule[] | null,
): Promise<Schedule[] | null> {
  let schedules: Schedule[] | null = null;
  await updateMindVoluteConfig(name, dir, (config) => {
    schedules = mutate(config.schedules ?? []);
    if (!schedules) return null;
    config.schedules = schedules.length > 0 ? schedules : undefined;
    return config;
  });
  if (!schedules) return null;
  getScheduler().loadSchedules(name, dir);
  getSleepManagerIfReady()?.invalidateSleepConfig(name);
  fireWebhook({
    event: "schedule_changed",
    mind: name,
    data: { schedules },
  });
  return schedules;
}

/** The owner a routes.json write for this mind hands new files to. */
async function routesOwner(name: string) {
  return mindFileOwner(await getBaseName(name));
}

const app = new Hono<AuthEnv>()
  // Clock status — combined sleep state + upcoming schedules
  .get("/:name/clock/status", requireSelfOrSpirit(), async (c) => {
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

    // Cron expressions are interpreted in the daemon host's local timezone, so a
    // remote viewer needs the daemon IANA TZ to label cron-derived wall times.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return c.json({ sleep: sleepState, sleepConfig, schedules, upcoming, previous, timezone });
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
  .put("/:name/sleep/config", requireSelf(), zValidator("json", sleepConfigSchema), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = c.req.valid("json");

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
    await updateMindVoluteConfig(name, dir, (config) => {
      const sleep = config.sleep ?? {};
      if (body.enabled !== undefined) sleep.enabled = body.enabled;
      if (body.schedule !== undefined) sleep.schedule = body.schedule;
      if (body.wakeTriggers !== undefined) sleep.wakeTriggers = body.wakeTriggers;
      config.sleep = sleep;
      return config;
    });

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
  .post("/:name/schedules", requireSelf(), zValidator("json", scheduleBodySchema), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot use schedules — sprout first" }, 403);

    const body = c.req.valid("json");
    if (!body.id) {
      return c.json({ error: "id is required (a descriptive name for this schedule)" }, 400);
    }
    if (!body.cron && !body.fireAt) {
      return c.json({ error: "cron or fireAt is required" }, 400);
    }
    if (body.cron && body.fireAt) {
      return c.json({ error: "cron and fireAt are mutually exclusive" }, 400);
    }
    const messagesErr = validateMessages(body.messages);
    if (messagesErr) return c.json({ error: messagesErr }, 400);
    if (!body.message && !body.messages?.length && !body.script) {
      return c.json({ error: "message, messages, or script is required" }, 400);
    }
    if ([body.message, body.messages?.length, body.script].filter(Boolean).length > 1) {
      return c.json({ error: "message, messages, and script are mutually exclusive" }, 400);
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

    const dir = entry.dir ?? mindDir(name);
    const id = body.id;

    const schedule: Schedule = { id, enabled: body.enabled ?? true };
    if (body.cron) schedule.cron = body.cron;
    if (body.fireAt) schedule.fireAt = body.fireAt;
    if (body.message) schedule.message = body.message;
    if (body.messages?.length) schedule.messages = body.messages;
    if (body.script) schedule.script = body.script;
    if (body.whileSleeping) schedule.whileSleeping = body.whileSleeping;
    const added = await writeSchedules(name, dir, (schedules) =>
      schedules.some((s) => s.id === id) ? null : [...schedules, schedule],
    );
    if (!added) return c.json({ error: `Schedule "${id}" already exists` }, 409);
    // `--thread` is sugar for a routes.json event rule (#736) — schedule-fire routing
    // lives in routes.json, not on the schedule itself.
    if (body.thread) {
      await upsertEventRule(dir, `schedule:${id}`, body.thread, {
        owner: await routesOwner(name),
        name,
      });
    }
    return c.json({ ok: true, id }, 201);
  })
  // Update schedule
  .put("/:name/schedules/:id", requireSelf(), zValidator("json", scheduleBodySchema), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const dir = entry.dir ?? mindDir(name);

    const body = c.req.valid("json");
    const messagesErr = validateMessages(body.messages);
    if (messagesErr) return c.json({ error: messagesErr }, 400);
    if ([body.message, body.messages?.length, body.script].filter(Boolean).length > 1) {
      return c.json({ error: "message, messages, and script are mutually exclusive" }, 400);
    }
    if (body.cron !== undefined) {
      try {
        CronExpressionParser.parse(body.cron);
      } catch {
        return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
      }
    }
    if (body.fireAt !== undefined && Number.isNaN(new Date(body.fireAt).getTime())) {
      return c.json({ error: `Invalid fireAt date: ${body.fireAt}` }, 400);
    }

    let refusal: { error: string; status: 400 | 404 } | null = null;
    const written = await writeSchedules(name, dir, (schedules) => {
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx === -1) {
        refusal = { error: "Schedule not found", status: 404 };
        return null;
      }
      const result = { ...schedules[idx] };
      if (body.cron !== undefined) {
        result.cron = body.cron;
        delete result.fireAt;
      }
      if (body.fireAt !== undefined) {
        result.fireAt = body.fireAt;
        delete result.cron;
      }
      if (body.message !== undefined) {
        result.message = body.message;
        delete result.script;
        delete result.messages;
      }
      if (body.messages !== undefined) {
        if (body.messages.length > 0) {
          result.messages = body.messages;
          delete result.message;
          delete result.script;
        } else {
          delete result.messages;
        }
      }
      if (body.script !== undefined) {
        result.script = body.script;
        delete result.message;
        delete result.messages;
      }
      if (body.enabled !== undefined) result.enabled = body.enabled;
      if (body.whileSleeping !== undefined) result.whileSleeping = body.whileSleeping || undefined;

      // An action-field edit must not strip the schedule down to nothing — an
      // actionless schedule would silently warn+skip on every fire.
      const touchedAction =
        body.message !== undefined || body.messages !== undefined || body.script !== undefined;
      if (touchedAction && !result.message && !result.messages?.length && !result.script) {
        refusal = { error: "schedule must keep a message, messages, or script", status: 400 };
        return null;
      }
      return schedules.map((s, i) => (i === idx ? result : s));
    });
    if (!written) {
      const r = refusal as { error: string; status: 400 | 404 } | null;
      return c.json({ error: r?.error ?? "Schedule not found" }, r?.status ?? 404);
    }
    // `--thread` writes/updates a routes.json event rule (#736); an empty value clears it.
    if (body.thread !== undefined) {
      await upsertEventRule(dir, `schedule:${id}`, body.thread || null, {
        owner: await routesOwner(name),
        name,
      });
    }
    return c.json({ ok: true });
  })
  // Delete schedule
  .delete("/:name/schedules/:id", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const dir = entry.dir ?? mindDir(name);

    const removed = await writeSchedules(name, dir, (schedules) => {
      const filtered = schedules.filter((s) => s.id !== id);
      return filtered.length === schedules.length ? null : filtered;
    });
    if (!removed) return c.json({ error: "Schedule not found" }, 404);
    // Drop the schedule's routing rule too, so a deleted schedule leaves nothing behind.
    await upsertEventRule(dir, `schedule:${id}`, null, { owner: await routesOwner(name), name });
    return c.json({ ok: true });
  })
  // Webhook endpoint
  .post("/:name/webhook/:event", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const event = c.req.param("event");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = await c.req.text();

    // deliverEvent never throws — answer honestly instead of a blanket ok. A webhook at
    // a stopped/sleeping mind is recorded but pending (202); it is delivered on the
    // mind's next start or wake. Only a failure to record at all is a 502.
    const { deliverEvent } = await import("../../lib/chat/system-events.js");
    const { id, delivered } = await deliverEvent(name, {
      type: "webhook",
      body,
      meta: { source: event },
    });
    if (id == null) {
      slog.warn(`webhook event for ${name} could not be recorded`);
      return c.json({ error: "Failed to record event" }, 502);
    }
    if (!delivered) return c.json({ ok: true, delivered: false, id }, 202);
    return c.json({ ok: true, delivered: true, id });
  });

export default app;
