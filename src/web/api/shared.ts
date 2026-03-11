import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";
import { sharedMerge } from "../../lib/shared.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const app = new Hono<AuthEnv>().post("/:name/shared/merge", requireAdmin, async (c) => {
  const name = c.req.param("name");
  const entry = await findMind(name);
  if (!entry) return c.json({ error: "Mind not found" }, 404);

  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  const message = body.message || `shared: merge from ${name}`;

  try {
    const result = await sharedMerge(name, mindDir(name), message);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Merge failed" }, 500);
  }
});

export default app;
