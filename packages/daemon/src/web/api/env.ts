import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  loadMergedEnv,
  mindEnvPath,
  readEnv,
  sharedEnvPath,
  writeEnv,
} from "../../lib/config/env.js";
import { findMind } from "../../lib/mind/registry.js";
import { type AuthEnv, requireAdmin, requireSelf } from "../middleware/auth.js";

const envValueSchema = z.object({ value: z.string() });

// Mind-scoped env routes (mounted at /api/v1/minds)
const app = new Hono<AuthEnv>()
  .get("/:name/env", requireSelf(), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    const shared = readEnv(sharedEnvPath());
    const mind = readEnv(mindEnvPath(name));
    return c.json({ shared, mind });
  })
  .get("/:name/env/:key", requireSelf(), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    const key = c.req.param("key");
    const merged = loadMergedEnv(name);
    const value = merged[key];
    if (value === undefined) return c.json({ error: "Key not found" }, 404);
    return c.json({ value });
  })
  .put("/:name/env/:key", requireSelf(), zValidator("json", envValueSchema), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    const key = c.req.param("key");
    const { value } = c.req.valid("json");
    const path = mindEnvPath(name);
    const env = readEnv(path);
    env[key] = value;
    writeEnv(path, env);
    return c.json({ ok: true });
  })
  .delete("/:name/env/:key", requireSelf(), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    const key = c.req.param("key");
    const path = mindEnvPath(name);
    const env = readEnv(path);
    if (!(key in env)) return c.json({ error: "Key not found" }, 404);
    delete env[key];
    writeEnv(path, env);
    return c.json({ ok: true });
  });

// Shared env routes (mounted at /api/v1/env)
export const sharedEnvApp = new Hono<AuthEnv>()
  .get("/", requireAdmin, (c) => {
    return c.json(readEnv(sharedEnvPath()));
  })
  .put("/:key", requireAdmin, zValidator("json", envValueSchema), async (c) => {
    const key = c.req.param("key");
    const { value } = c.req.valid("json");
    const path = sharedEnvPath();
    const env = readEnv(path);
    env[key] = value;
    writeEnv(path, env);
    return c.json({ ok: true });
  })
  .delete("/:key", requireAdmin, (c) => {
    const key = c.req.param("key");
    const path = sharedEnvPath();
    const env = readEnv(path);
    if (!(key in env)) return c.json({ error: "Key not found" }, 404);
    delete env[key];
    writeEnv(path, env);
    return c.json({ ok: true });
  });

export default app;
