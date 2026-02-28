import { findMind, mindDir } from "@volute/shared/registry";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "@volute/shared/volute-config";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";
import { getScheduler } from "../../lib/daemon/scheduler.js";
import log from "../../lib/logger.js";
import { fireWebhook } from "../../lib/webhook.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

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
  fireWebhook({
    event: "schedule_changed",
    mind: name,
    data: { schedules },
  });
}

const app = new Hono<AuthEnv>()
  // List schedules
  .get("/:name/schedules", (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);
    return c.json(readSchedules(name));
  })
  // Add schedule — admin only
  .post("/:name/schedules", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot use schedules — sprout first" }, 403);

    const body = (await c.req.json()) as Partial<Schedule>;
    if (!body.cron) {
      return c.json({ error: "cron is required" }, 400);
    }
    if (!body.message && !body.script) {
      return c.json({ error: "message or script is required" }, 400);
    }
    if (body.message && body.script) {
      return c.json({ error: "message and script are mutually exclusive" }, 400);
    }

    try {
      CronExpressionParser.parse(body.cron);
    } catch {
      return c.json({ error: `Invalid cron expression: ${body.cron}` }, 400);
    }

    const schedules = readSchedules(name);
    const id = body.id || `schedule-${Date.now()}`;

    if (schedules.some((s) => s.id === id)) {
      return c.json({ error: `Schedule "${id}" already exists` }, 409);
    }

    const schedule: Schedule = { id, cron: body.cron, enabled: body.enabled ?? true };
    if (body.message) schedule.message = body.message;
    if (body.script) schedule.script = body.script;
    schedules.push(schedule);
    writeSchedules(name, schedules);
    return c.json({ ok: true, id }, 201);
  })
  // Update schedule — admin only
  .put("/:name/schedules/:id", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

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
    }
    if (body.message !== undefined) {
      schedules[idx].message = body.message;
      delete schedules[idx].script;
    }
    if (body.script !== undefined) {
      schedules[idx].script = body.script;
      delete schedules[idx].message;
    }
    if (body.enabled !== undefined) schedules[idx].enabled = body.enabled;

    writeSchedules(name, schedules);
    return c.json({ ok: true });
  })
  // Delete schedule — admin only
  .delete("/:name/schedules/:id", requireAdmin, (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

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
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = await c.req.text();
    const message = `[webhook: ${event}] ${body}`;

    try {
      const res = await fetch(`http://127.0.0.1:${entry.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [{ type: "text", text: message }],
          channel: "system:webhook",
          sender: "webhook",
        }),
      });

      if (!res.ok) {
        return c.json({ error: `Mind responded with ${res.status}` }, 502);
      }
      return c.json({ ok: true });
    } catch (err) {
      slog.warn(`webhook delivery failed for ${name}`, log.errorData(err));
      return c.json({ error: "Failed to reach mind" }, 502);
    }
  });

export default app;
