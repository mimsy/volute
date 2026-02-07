import { existsSync, rmSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getAgentManager } from "../../lib/agent-manager.js";
import { CHANNELS } from "../../lib/channels.js";
import { getConnectorManager } from "../../lib/connector-manager.js";
import { getDb } from "../../lib/db.js";
import {
  agentDir,
  findAgent,
  readRegistry,
  removeAgent,
  setAgentRunning,
} from "../../lib/registry.js";
import { agentMessages } from "../../lib/schema.js";
import { checkHealth, findVariant, readVariants, removeAllVariants } from "../../lib/variants.js";

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
};

async function getAgentStatus(name: string, _dir: string, port: number) {
  const manager = getAgentManager();
  let status: "running" | "stopped" | "starting" = "stopped";

  if (manager.isRunning(name)) {
    const health = await checkHealth(port);
    status = health.ok ? "running" : "starting";
  }

  const channels: ChannelStatus[] = [];

  // Web channel is always available when agent is running
  channels.push({
    name: CHANNELS.web.name,
    displayName: CHANNELS.web.displayName,
    status: status === "running" ? "connected" : "disconnected",
    showToolCalls: CHANNELS.web.showToolCalls,
  });

  // Check connector status via ConnectorManager
  const connectorManager = getConnectorManager();
  const connectorStatuses = connectorManager.getConnectorStatus(name);
  for (const cs of connectorStatuses) {
    const channelConfig = CHANNELS[cs.type];
    if (channelConfig) {
      channels.push({
        name: channelConfig.name,
        displayName: channelConfig.displayName,
        status: cs.running ? "connected" : "disconnected",
        showToolCalls: channelConfig.showToolCalls,
      });
    } else {
      channels.push({
        name: cs.type,
        displayName: cs.type,
        status: cs.running ? "connected" : "disconnected",
        showToolCalls: false,
      });
    }
  }

  return { status, channels };
}

// List all agents
const app = new Hono()
  .get("/", async (c) => {
    const entries = readRegistry();
    const agents = await Promise.all(
      entries.map(async (entry) => {
        const dir = agentDir(entry.name);
        const { status, channels } = await getAgentStatus(entry.name, dir, entry.port);
        return { ...entry, status, channels };
      }),
    );
    return c.json(agents);
  })
  // Get single agent
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    if (!existsSync(dir)) return c.json({ error: "Agent directory missing" }, 404);

    const { status, channels } = await getAgentStatus(name, dir, entry.port);

    // Include variant info
    const variants = readVariants(name);
    const variantStatuses = await Promise.all(
      variants.map(async (v) => {
        const manager = getAgentManager();
        const compositeKey = `${name}@${v.name}`;
        let variantStatus: "running" | "stopped" | "starting" = "stopped";
        if (manager.isRunning(compositeKey)) {
          const health = await checkHealth(v.port);
          variantStatus = health.ok ? "running" : "starting";
        }
        return { name: v.name, port: v.port, status: variantStatus };
      }),
    );

    return c.json({ ...entry, status, channels, variants: variantStatuses });
  })
  // Start agent (supports name@variant)
  .post("/:name/start", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findAgent(baseName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    } else {
      const dir = agentDir(baseName);
      if (!existsSync(dir)) return c.json({ error: "Agent directory missing" }, 404);
    }

    const manager = getAgentManager();
    if (manager.isRunning(name)) {
      return c.json({ error: "Agent already running" }, 409);
    }

    try {
      await manager.startAgent(name);
      // Only start connectors/schedules for base agents, not variants
      if (!variantName) {
        setAgentRunning(baseName, true);
        const dir = agentDir(baseName);
        await getConnectorManager().startConnectors(baseName, dir, entry.port);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to start agent" }, 500);
    }
  })
  // Restart agent (supports name@variant)
  .post("/:name/restart", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findAgent(baseName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    } else {
      const dir = agentDir(baseName);
      if (!existsSync(dir)) return c.json({ error: "Agent directory missing" }, 404);
    }

    const manager = getAgentManager();
    const connectorManager = getConnectorManager();

    try {
      if (manager.isRunning(name)) {
        if (!variantName) await connectorManager.stopConnectors(baseName);
        await manager.stopAgent(name);
      }

      await manager.startAgent(name);
      if (!variantName) {
        setAgentRunning(baseName, true);
        const dir = agentDir(baseName);
        await connectorManager.startConnectors(baseName, dir, entry.port);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to restart agent" }, 500);
    }
  })
  // Stop agent (supports name@variant)
  .post("/:name/stop", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findAgent(baseName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    }

    const manager = getAgentManager();
    if (!manager.isRunning(name)) {
      return c.json({ error: "Agent is not running" }, 409);
    }

    try {
      if (!variantName) await getConnectorManager().stopConnectors(baseName);
      await manager.stopAgent(name);
      if (!variantName) setAgentRunning(baseName, false);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to stop agent" }, 500);
    }
  })
  // Delete agent
  .delete("/:name", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const force = c.req.query("force") === "true";

    // Stop connectors and agent if running
    const manager = getAgentManager();
    if (manager.isRunning(name)) {
      await getConnectorManager().stopConnectors(name);
      await manager.stopAgent(name);
    }

    removeAllVariants(name);
    removeAgent(name);

    if (force && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }

    return c.json({ ok: true });
  })
  // Proxy message to agent
  .post("/:name/message", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findAgent(baseName);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
      port = variant.port;
    } else {
      const manager = getAgentManager();
      if (!manager.isRunning(baseName)) {
        return c.json({ error: "Agent is not running" }, 409);
      }
    }

    const body = await c.req.text();

    // Record inbound message
    const db = await getDb();
    try {
      const parsed = JSON.parse(body);
      const channel = parsed.channel ?? "unknown";
      const sender = parsed.sender ?? null;
      const content =
        typeof parsed.content === "string" ? parsed.content : JSON.stringify(parsed.content);
      await db.insert(agentMessages).values({
        agent: baseName,
        channel,
        role: "user",
        sender,
        content,
      });
    } catch {
      // Don't block the request if persistence fails
    }

    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      return c.json({ error: `Agent responded with ${res.status}` }, res.status as 500);
    }

    if (!res.body) {
      return c.json({ error: "No response body from agent" }, 502);
    }

    // Stream NDJSON response back, accumulating text for persistence
    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const textParts: string[] = [];
      let channel = "unknown";

      try {
        // Extract channel from the original request
        try {
          channel = JSON.parse(body).channel ?? "unknown";
        } catch {}

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await s.write(value);

          // Parse NDJSON lines to accumulate text events
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === "text") {
                textParts.push(event.content);
              }
            } catch {}
          }
        }

        // Handle remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "text") {
              textParts.push(event.content);
            }
          } catch {}
        }

        // Record assistant response
        if (textParts.length > 0) {
          const db = await getDb();
          await db.insert(agentMessages).values({
            agent: baseName,
            channel,
            role: "assistant",
            content: textParts.join(""),
          });
        }
      } finally {
        reader.releaseLock();
      }
    });
  })
  // Get message history
  .get("/:name/history", async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const db = await getDb();
    const conditions = [eq(agentMessages.agent, name)];
    if (channel) {
      conditions.push(eq(agentMessages.channel, channel));
    }

    const rows = await db
      .select()
      .from(agentMessages)
      .where(and(...conditions))
      .orderBy(desc(agentMessages.created_at))
      .limit(limit)
      .offset(offset);

    return c.json(rows);
  });

export default app;
