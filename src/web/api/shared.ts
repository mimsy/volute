import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";
import { sharedLog, sharedMerge, sharedPull, sharedStatus } from "../../lib/shared.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .post("/:name/shared/merge", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    let body: { message?: string };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const message = body.message || `shared: merge from ${name}`;

    try {
      const result = await sharedMerge(name, mindDir(name), message);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Merge failed" }, 500);
    }
  })
  .post("/:name/shared/pull", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    try {
      const result = await sharedPull(name, mindDir(name));
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Pull failed" }, 500);
    }
  })
  .get("/:name/shared/log", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const limit = parseInt(c.req.query("limit") ?? "20", 10) || 20;

    try {
      const log = await sharedLog(limit);
      return c.text(log);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to read log" }, 500);
    }
  })
  .get("/:name/shared/status", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    try {
      const status = await sharedStatus(name);
      return c.text(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to get status" }, 500);
    }
  });

export default app;
