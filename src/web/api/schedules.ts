import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { getScheduler } from "../../lib/daemon/scheduler.js";
import { getSleepManagerIfReady } from "../../lib/daemon/sleep-manager.js";
import log from "../../lib/logger.js";
import { findMind, mindDir } from "../../lib/registry.js";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "../../lib/volute-config.js";
import { fireWebhook } from "../../lib/webhook.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

const slog = log.child("schedules");

function readSchedules(name: string): Schedule[] {
  return readVoluteConfig(mindDir(name))?.schedules ?? [];
}

function writeSchedules(name: string, schedules: Schedule[]): void {
  const dir = mindDir(name);
  const config = readVoluteConfig(dir) ?? {};
  config.schedules = schedules.length > 0 ? schedules : undefined;
  writeVoluteConfig(dir, config);
  getScheduler().loadSchedules(name);
  getSleepManagerIfReady()?.invalidateSleepConfig(name);
  fireWebhook({
    event: "schedule_changed",
    mind: name,
    data: { schedules },
  });
}

const app = new Hono<AuthEnv>()
  // Clock status — combined sleep state + upcoming schedules
  .get("/:name/clock/status", async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const sleepManager = getSleepManagerIfReady();
    const sleepState = sleepManager?.getState(name) ?? null;
    const sleepConfig = sleepManager?.getSleepConfig(name) ?? null;
    const schedules = readSchedules(name);

    // Compute upcoming schedule fires (next 24h)
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60_000);
    const upcoming: { id: string; at: string; type: "cron" | "timer" }[] = [];

    for (const s of schedules) {
      if (!s.enabled) continue;
      if (s.fireAt) {
        const fireDate = new Date(s.fireAt);
        if (fireDate >= now && fireDate <= in24h) {
          upcoming.push({ id: s.id, at: fireDate.toISOString(), type: "timer" });
        }
      } else if (s.cron) {
        try {
          const interval = CronExpressionParser.parse(s.cron);
          const next = interval.next().toDate();
          if (next <= in24h) {
            upcoming.push({ id: s.id, at: next.toISOString(), type: "cron" });
          }
        } catch {
          slog.warn(`invalid cron "${s.cron}" for schedule "${s.id}" of ${name}`);
        }
      }
    }
    upcoming.sort((a, b) => a.at.localeCompare(b.at));

    return c.json({ sleep: sleepState, sleepConfig, schedules, upcoming });
  })
  // List schedules
  .get("/:name/schedules", async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    return c.json(readSchedules(name));
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

    const schedules = readSchedules(name);
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
    writeSchedules(name, schedules);
    return c.json({ ok: true, id }, 201);
  })
  // Update schedule
  .put("/:name/schedules/:id", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const schedules = readSchedules(name);
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

    writeSchedules(name, schedules);
    return c.json({ ok: true });
  })
  // Delete schedule
  .delete("/:name/schedules/:id", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const schedules = readSchedules(name);
    const filtered = schedules.filter((s) => s.id !== id);
    if (filtered.length === schedules.length) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    writeSchedules(name, filtered);
    return c.json({ ok: true });
  })
  // Webhook endpoint
  .post("/:name/webhook/:event", async (c) => {
    const name = c.req.param("name");
    const event = c.req.param("event");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = await c.req.text();
    const message = `[webhook: ${event}] ${body}`;

    try {
      const { sendSystemMessage } = await import("../../lib/system-chat.js");
      await sendSystemMessage(name, message);
      return c.json({ ok: true });
    } catch (err) {
      slog.warn(`webhook delivery failed for ${name}`, log.errorData(err));
      return c.json({ error: "Failed to reach mind" }, 502);
    }
  });

export default app;
