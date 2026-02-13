import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getAgentManager } from "../../lib/agent-manager.js";
import { deleteAgentUser } from "../../lib/auth.js";
import { CHANNELS } from "../../lib/channels.js";
import { getConnectorManager } from "../../lib/connector-manager.js";
import { getDb } from "../../lib/db.js";
import { collectPart } from "../../lib/format-tool.js";
import { readNdjson } from "../../lib/ndjson.js";
import { agentDir, findAgent, readRegistry, removeAgent, voluteHome } from "../../lib/registry.js";
import { getScheduler } from "../../lib/scheduler.js";
import { agentMessages } from "../../lib/schema.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "../../lib/token-budget.js";
import { getTypingMap } from "../../lib/typing.js";
import { checkHealth, findVariant, readVariants, removeAllVariants } from "../../lib/variants.js";
import { readVoluteConfig } from "../../lib/volute-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

function getDaemonPort(): number | undefined {
  try {
    const data = JSON.parse(readFileSync(resolve(voluteHome(), "daemon.json"), "utf-8"));
    return data.port;
  } catch {
    return undefined;
  }
}

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
};

async function getAgentStatus(name: string, port: number) {
  const manager = getAgentManager();
  let status: "running" | "stopped" | "starting" = "stopped";

  if (manager.isRunning(name)) {
    const health = await checkHealth(port);
    status = health.ok ? "running" : "starting";
  }

  const channelConfig = readVoluteConfig(agentDir(name))?.channels;
  const channels: ChannelStatus[] = [];

  // Built-in channels (e.g. volute)
  for (const [, provider] of Object.entries(CHANNELS)) {
    if (!provider.builtIn) continue;
    channels.push({
      name: provider.name,
      displayName: provider.displayName,
      status: status === "running" ? "connected" : "disconnected",
      showToolCalls: channelConfig?.[provider.name]?.showToolCalls ?? provider.showToolCalls,
    });
  }

  // External connectors
  const connectorStatuses = getConnectorManager().getConnectorStatus(name);
  for (const cs of connectorStatuses) {
    const provider = CHANNELS[cs.type];
    channels.push({
      name: provider?.name ?? cs.type,
      displayName: provider?.displayName ?? cs.type,
      status: cs.running ? "connected" : "disconnected",
      showToolCalls: channelConfig?.[cs.type]?.showToolCalls ?? provider?.showToolCalls ?? false,
    });
  }

  return { status, channels };
}

// List all agents
const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const entries = readRegistry();
    const agents = await Promise.all(
      entries.map(async (entry) => {
        const { status, channels } = await getAgentStatus(entry.name, entry.port);
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

    if (!existsSync(agentDir(name))) return c.json({ error: "Agent directory missing" }, 404);

    const { status, channels } = await getAgentStatus(name, entry.port);

    // Include variant info
    const variants = readVariants(name);
    const manager = getAgentManager();
    const variantStatuses = await Promise.all(
      variants.map(async (v) => {
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
  // Start agent (supports name@variant) — admin only
  .post("/:name/start", requireAdmin, async (c) => {
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
        const dir = agentDir(baseName);
        await getConnectorManager().startConnectors(baseName, dir, entry.port, getDaemonPort());
        getScheduler().loadSchedules(baseName);
        const config = readVoluteConfig(dir);
        if (config?.tokenBudget) {
          getTokenBudget().setBudget(
            baseName,
            config.tokenBudget,
            config.tokenBudgetPeriodMinutes ?? DEFAULT_BUDGET_PERIOD_MINUTES,
          );
        }
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to start agent" }, 500);
    }
  })
  // Restart agent (supports name@variant) — admin only
  .post("/:name/restart", requireAdmin, async (c) => {
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
        if (!variantName) {
          await connectorManager.stopConnectors(baseName);
          getTokenBudget().removeBudget(baseName);
        }
        await manager.stopAgent(name);
      }

      await manager.startAgent(name);
      if (!variantName) {
        const dir = agentDir(baseName);
        await connectorManager.startConnectors(baseName, dir, entry.port, getDaemonPort());
        getScheduler().loadSchedules(baseName);
        const config = readVoluteConfig(dir);
        if (config?.tokenBudget) {
          getTokenBudget().setBudget(
            baseName,
            config.tokenBudget,
            config.tokenBudgetPeriodMinutes ?? DEFAULT_BUDGET_PERIOD_MINUTES,
          );
        }
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to restart agent" }, 500);
    }
  })
  // Stop agent (supports name@variant) — admin only
  .post("/:name/stop", requireAdmin, async (c) => {
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
      if (!variantName) {
        await getConnectorManager().stopConnectors(baseName);
        getScheduler().unloadSchedules(baseName);
        getTokenBudget().removeBudget(baseName);
      }
      await manager.stopAgent(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to stop agent" }, 500);
    }
  })
  // Delete agent — admin only
  .delete("/:name", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const force = c.req.query("force") === "true";

    // Stop connectors and agent if running
    const manager = getAgentManager();
    if (manager.isRunning(name)) {
      await getConnectorManager().stopConnectors(name);
      getTokenBudget().removeBudget(name);
      await manager.stopAgent(name);
    }

    removeAllVariants(name);
    removeAgent(name);
    await deleteAgentUser(name);

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
    }

    if (!getAgentManager().isRunning(name)) {
      return c.json({ error: "Agent is not running" }, 409);
    }

    const body = await c.req.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      console.error(`[daemon] failed to parse message body for ${baseName}:`, err);
    }

    const channel = (parsed?.channel as string) ?? "unknown";

    // Record inbound message
    const db = await getDb();
    if (parsed) {
      try {
        const sender = (parsed.sender as string) ?? null;
        let content: string;
        if (typeof parsed.content === "string") {
          content = parsed.content;
        } else if (Array.isArray(parsed.content)) {
          content = (parsed.content as { type: string; text?: string }[])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        } else {
          content = JSON.stringify(parsed.content);
        }
        await db.insert(agentMessages).values({
          agent: baseName,
          channel,
          role: "user",
          sender,
          content,
        });
      } catch (err) {
        console.error(`[daemon] failed to persist inbound message for ${baseName}:`, err);
      }
    }

    // Check token budget before forwarding
    const budget = getTokenBudget();
    const budgetStatus = budget.checkBudget(baseName);

    if (budgetStatus === "exceeded") {
      // Extract text content for the queued summary
      let textContent = "";
      if (parsed) {
        if (typeof parsed.content === "string") {
          textContent = parsed.content;
        } else if (Array.isArray(parsed.content)) {
          textContent = (parsed.content as { type: string; text?: string }[])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        }
      }

      budget.enqueue(baseName, {
        channel,
        sender: (parsed?.sender as string) ?? null,
        textContent,
      });

      c.header("Content-Type", "application/x-ndjson");
      const encoder = new TextEncoder();
      return stream(c, async (s) => {
        await s.write(
          encoder.encode(
            `${JSON.stringify({ type: "text", content: "[Token budget exceeded — message queued for next period]" })}\n`,
          ),
        );
        await s.write(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
      });
    }

    // Enrich payload with currently-typing senders (exclude the receiving agent
    // and the message sender — they just sent a message, so they're not typing)
    const typingMap = getTypingMap();
    const sender = (parsed?.sender as string) ?? "";
    if (sender) typingMap.delete(channel, sender);
    const currentlyTyping = typingMap.get(channel).filter((s) => s !== baseName);
    let forwardBody = body;
    if (parsed && currentlyTyping.length > 0) {
      parsed.typing = currentlyTyping;
      forwardBody = JSON.stringify(parsed);
    }

    // Inject one-time budget warning (triggers once at >=80% per period)
    if (budgetStatus === "warning" && parsed) {
      const usage = budget.getUsage(baseName);
      const pct = usage?.percentUsed ?? 80;
      const warningText = `\n[System: Token budget is at ${pct}% — conserve tokens to avoid message queuing]`;
      if (typeof parsed.content === "string") {
        parsed.content = parsed.content + warningText;
      } else if (Array.isArray(parsed.content)) {
        parsed.content = [...parsed.content, { type: "text", text: warningText }];
      }
      budget.acknowledgeWarning(baseName);
      forwardBody = JSON.stringify(parsed);
    }

    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: forwardBody,
      });
    } catch (err) {
      console.error(`[daemon] agent ${name} unreachable on port ${port}:`, err);
      return c.json({ error: "Agent is not reachable" }, 502);
    }

    if (!res.ok) {
      return c.json({ error: `Agent responded with ${res.status}` }, res.status as 500);
    }

    if (!res.body) {
      return c.json({ error: "No response body from agent" }, 502);
    }

    // Stream NDJSON response back, accumulating text for persistence
    c.header("Content-Type", "application/x-ndjson");
    const encoder = new TextEncoder();
    typingMap.set(channel, baseName, { persistent: true });
    return stream(c, async (s) => {
      try {
        const textParts: string[] = [];
        const toolParts: string[] = [];

        for await (const event of readNdjson(res.body!)) {
          // Intercept usage events — record against budget (no-op if unconfigured) and strip from stream
          if (event.type === "usage") {
            const input = typeof event.input_tokens === "number" ? event.input_tokens : 0;
            const output = typeof event.output_tokens === "number" ? event.output_tokens : 0;
            budget.recordUsage(baseName, input, output);
            continue;
          }
          await s.write(encoder.encode(`${JSON.stringify(event)}\n`));
          const part = collectPart(event);
          if (part != null) {
            if (event.type === "tool_use") toolParts.push(part);
            else textParts.push(part);
          }
        }

        const content = [textParts.join(""), ...toolParts].filter(Boolean).join("\n");
        if (content) {
          try {
            await db.insert(agentMessages).values({
              agent: baseName,
              channel,
              role: "assistant",
              sender: baseName,
              content,
            });
          } catch (err) {
            console.error(`[daemon] failed to persist assistant response for ${baseName}:`, err);
          }
        }
      } finally {
        typingMap.delete(channel, baseName);
      }
    });
  })
  // Budget status
  .get("/:name/budget", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);
    const usage = getTokenBudget().getUsage(baseName);
    if (!usage) return c.json({ error: "No budget configured" }, 404);
    return c.json(usage);
  })
  // Persist external channel send to agent_messages
  .post("/:name/history", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);

    let body: { channel: string; content: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.channel || !body.content) {
      return c.json({ error: "channel and content required" }, 400);
    }

    const db = await getDb();
    try {
      await db.insert(agentMessages).values({
        agent: baseName,
        channel: body.channel,
        role: "assistant",
        sender: baseName,
        content: body.content,
      });
    } catch (err) {
      console.error(`[daemon] failed to persist external send for ${baseName}:`, err);
      return c.json({ error: "Failed to persist" }, 500);
    }

    return c.json({ ok: true });
  })
  // Get message history
  .get("/:name/history/channels", async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .selectDistinct({ channel: agentMessages.channel })
      .from(agentMessages)
      .where(eq(agentMessages.agent, name));
    return c.json(rows.map((r) => r.channel));
  })
  .get("/:name/history", async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

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
