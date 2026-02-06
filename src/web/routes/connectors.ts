import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { getConnectorManager } from "../../lib/connector-manager.js";
import { agentDir, findAgent } from "../../lib/registry.js";

const app = new Hono()
  // List connectors + status
  .get("/:name/connectors", (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const connectorsDir = resolve(dir, ".volute", "connectors");
    const manager = getConnectorManager();
    const runningStatus = manager.getConnectorStatus(name);

    // List configured connectors from disk
    const configured: string[] = [];
    if (existsSync(connectorsDir)) {
      for (const entry of readdirSync(connectorsDir)) {
        const typeDir = resolve(connectorsDir, entry);
        if (statSync(typeDir).isDirectory() && existsSync(resolve(typeDir, "config.json"))) {
          configured.push(entry);
        }
      }
    }

    const connectors = configured.map((type) => {
      const status = runningStatus.find((s) => s.type === type);
      return { type, running: status?.running ?? false };
    });

    return c.json(connectors);
  })
  // Enable connector
  .post("/:name/connectors/:type", async (c) => {
    const name = c.req.param("name");
    const type = c.req.param("type");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const connectorDir = resolve(dir, ".volute", "connectors", type);
    mkdirSync(connectorDir, { recursive: true });

    const config = await c.req.json();
    writeFileSync(resolve(connectorDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

    const manager = getConnectorManager();
    try {
      await manager.startConnector(name, dir, entry.port, type);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to start connector" },
        500,
      );
    }
  })
  // Disable connector
  .delete("/:name/connectors/:type", async (c) => {
    const name = c.req.param("name");
    const type = c.req.param("type");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const connectorDir = resolve(dir, ".volute", "connectors", type);

    const manager = getConnectorManager();
    await manager.stopConnector(name, type);

    if (existsSync(connectorDir)) {
      rmSync(connectorDir, { recursive: true, force: true });
    }

    return c.json({ ok: true });
  });

export default app;
