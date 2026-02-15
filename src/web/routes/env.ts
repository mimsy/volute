import { Hono } from "hono";
import { agentEnvPath, loadMergedEnv, readEnv, sharedEnvPath, writeEnv } from "../../lib/env.js";
import { findAgent } from "../../lib/registry.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

// Agent-scoped env routes (mounted at /api/agents)
const app = new Hono<AuthEnv>()
  .get("/:name/env", (c) => {
    const name = c.req.param("name");
    if (!findAgent(name)) return c.json({ error: "Agent not found" }, 404);
    const shared = readEnv(sharedEnvPath());
    const agent = readEnv(agentEnvPath(name));
    return c.json({ shared, agent });
  })
  .get("/:name/env/:key", (c) => {
    const name = c.req.param("name");
    if (!findAgent(name)) return c.json({ error: "Agent not found" }, 404);
    const key = c.req.param("key");
    const merged = loadMergedEnv(name);
    const value = merged[key];
    if (value === undefined) return c.json({ error: "Key not found" }, 404);
    return c.json({ value });
  })
  .put("/:name/env/:key", requireAdmin, async (c) => {
    const name = c.req.param("name");
    if (!findAgent(name)) return c.json({ error: "Agent not found" }, 404);
    const key = c.req.param("key");
    const body = await c.req.json<{ value: string }>();
    const path = agentEnvPath(name);
    const env = readEnv(path);
    env[key] = body.value;
    writeEnv(path, env);
    return c.json({ ok: true });
  })
  .delete("/:name/env/:key", requireAdmin, (c) => {
    const name = c.req.param("name");
    if (!findAgent(name)) return c.json({ error: "Agent not found" }, 404);
    const key = c.req.param("key");
    const path = agentEnvPath(name);
    const env = readEnv(path);
    delete env[key];
    writeEnv(path, env);
    return c.json({ ok: true });
  });

// Shared env routes (mounted at /api/env)
export const sharedEnvApp = new Hono<AuthEnv>()
  .get("/", (c) => {
    return c.json(readEnv(sharedEnvPath()));
  })
  .put("/:key", requireAdmin, async (c) => {
    const key = c.req.param("key");
    const body = await c.req.json<{ value: string }>();
    const path = sharedEnvPath();
    const env = readEnv(path);
    env[key] = body.value;
    writeEnv(path, env);
    return c.json({ ok: true });
  })
  .delete("/:key", requireAdmin, (c) => {
    const key = c.req.param("key");
    const path = sharedEnvPath();
    const env = readEnv(path);
    delete env[key];
    writeEnv(path, env);
    return c.json({ ok: true });
  });

export default app;
