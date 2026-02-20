import { Hono } from "hono";
import { getConnectorManager } from "../../lib/connector-manager.js";
import { getMailPoller } from "../../lib/mail-poller.js";
import { findMind, mindDir } from "../../lib/registry.js";
import { readSystemsConfig } from "../../lib/systems-config.js";
import { readVoluteConfig, writeVoluteConfig } from "../../lib/volute-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

const CONNECTOR_TYPE_RE = /^[a-z][a-z0-9-]*$/;

const app = new Hono<AuthEnv>()
  // List connectors + status
  .get("/:name/connectors", (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const config = readVoluteConfig(dir) ?? {};
    const configured = config.connectors ?? [];

    const manager = getConnectorManager();
    const runningStatus = manager.getConnectorStatus(name);

    const connectors: { type: string; running: boolean; auto?: boolean }[] = configured.map(
      (type) => {
        const status = runningStatus.find((s) => s.type === type);
        return { type, running: status?.running ?? false };
      },
    );

    // Include mail status if system account is configured
    const systemsConfig = readSystemsConfig();
    if (systemsConfig && getMailPoller().isRunning()) {
      connectors.push({ type: "mail", running: true, auto: true });
    }

    return c.json(connectors);
  })
  // Enable connector — admin only
  .post("/:name/connectors/:type", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const type = c.req.param("type");
    if (!CONNECTOR_TYPE_RE.test(type)) {
      return c.json({ error: "Invalid connector type" }, 400);
    }
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage === "seed")
      return c.json({ error: "Seed minds cannot use connectors — sprout first" }, 403);

    const dir = mindDir(name);

    // Check for missing required env vars
    const manager = getConnectorManager();
    const envCheck = manager.checkConnectorEnv(type, name, dir);
    if (envCheck) {
      return c.json(
        {
          error: "missing_env",
          missing: envCheck.missing,
          connectorName: envCheck.connectorName,
        },
        400,
      );
    }

    const config = readVoluteConfig(dir) ?? {};
    const connectors = config.connectors ?? [];

    if (!connectors.includes(type)) {
      config.connectors = [...connectors, type];
      writeVoluteConfig(dir, config);
    }

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
  // Disable connector — admin only
  .delete("/:name/connectors/:type", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const type = c.req.param("type");
    if (!CONNECTOR_TYPE_RE.test(type)) {
      return c.json({ error: "Invalid connector type" }, 400);
    }
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const manager = getConnectorManager();
    await manager.stopConnector(name, type);

    const config = readVoluteConfig(dir) ?? {};
    config.connectors = (config.connectors ?? []).filter((t) => t !== type);
    writeVoluteConfig(dir, config);

    return c.json({ ok: true });
  });

export default app;
