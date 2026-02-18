import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";
import { getScheduler } from "../../lib/scheduler.js";
import { readVoluteConfig, type Schedule, writeVoluteConfig } from "../../lib/volute-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

function readSchedules(name: string): Schedule[] {
  return readVoluteConfig(mindDir(name))?.schedules ?? [];
}

function writeSchedules(name: string, schedules: Schedule[]): void {
  const dir = mindDir(name);
  const config = readVoluteConfig(dir) ?? {};
  config.schedules = schedules.length > 0 ? schedules : undefined;
  writeVoluteConfig(dir, config);
  getScheduler().loadSchedules(name);
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
    if (!body.cron || !body.message) {
      return c.json({ error: "cron and message are required" }, 400);
    }

    const schedules = readSchedules(name);
    const id = body.id || `schedule-${Date.now()}`;

    if (schedules.some((s) => s.id === id)) {
      return c.json({ error: `Schedule "${id}" already exists` }, 409);
    }

    schedules.push({ id, cron: body.cron, message: body.message, enabled: body.enabled ?? true });
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
    if (body.cron !== undefined) schedules[idx].cron = body.cron;
    if (body.message !== undefined) schedules[idx].message = body.message;
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
    } catch {
      return c.json({ error: "Failed to reach mind" }, 502);
    }
  });

export default app;
