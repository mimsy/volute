import { Hono } from "hono";
import { existsSync } from "fs";
import { findAgent, agentDir } from "../../lib/registry.js";
import { readVariants, checkHealth } from "../../lib/variants.js";

const app = new Hono();

app.get("/:name/variants", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const dir = agentDir(name);
  if (!existsSync(dir)) return c.json({ error: "Agent directory missing" }, 404);

  const variants = readVariants(dir);
  const results = await Promise.all(
    variants.map(async (v) => {
      if (!v.port) return { ...v, status: "no-server" };
      const health = await checkHealth(v.port);
      return { ...v, status: health.ok ? "running" : "dead" };
    }),
  );

  return c.json(results);
});

export default app;
