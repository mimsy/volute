import { Hono } from "hono";
import { findAgent } from "../../lib/registry.js";
import { checkHealth, readVariants } from "../../lib/variants.js";

const app = new Hono().get("/:name/variants", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const variants = readVariants(name);
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
