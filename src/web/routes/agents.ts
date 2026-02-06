import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { CHANNELS } from "../../lib/channels.js";
import { agentDir, findAgent, readRegistry } from "../../lib/registry.js";
import { checkHealth } from "../../lib/variants.js";

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
  username?: string;
  connectedAt?: string;
};

async function getAgentStatus(dir: string, port: number) {
  let status: "running" | "stopped" | "starting" = "stopped";
  const pidPath = resolve(dir, ".molt", "supervisor.pid");
  if (existsSync(pidPath)) {
    const pid = parseInt((await readFile(pidPath, "utf-8")).trim(), 10);
    try {
      process.kill(pid, 0);
      const health = await checkHealth(port);
      status = health.ok ? "running" : "starting";
    } catch {
      status = "stopped";
    }
  }

  const channels: ChannelStatus[] = [];

  // Web channel is always available when agent is running
  channels.push({
    name: CHANNELS.web.name,
    displayName: CHANNELS.web.displayName,
    status: status === "running" ? "connected" : "disconnected",
    showToolCalls: CHANNELS.web.showToolCalls,
  });

  // Check Discord connector status
  const discordChannel: ChannelStatus = {
    name: CHANNELS.discord.name,
    displayName: CHANNELS.discord.displayName,
    status: "disconnected",
    showToolCalls: CHANNELS.discord.showToolCalls,
  };
  const discordPidPath = resolve(dir, ".molt", "discord.pid");
  if (existsSync(discordPidPath)) {
    const dpid = parseInt((await readFile(discordPidPath, "utf-8")).trim(), 10);
    try {
      process.kill(dpid, 0);
      discordChannel.status = "connected";
      // Read connection details if available
      const discordStatePath = resolve(dir, ".molt", "discord.json");
      if (existsSync(discordStatePath)) {
        try {
          const state = JSON.parse(await readFile(discordStatePath, "utf-8"));
          discordChannel.username = state.username;
          discordChannel.connectedAt = state.connectedAt;
        } catch {
          // Invalid JSON, ignore
        }
      }
    } catch {
      // Stale PID
    }
  }
  channels.push(discordChannel);

  return { status, channels };
}

// List all agents
const app = new Hono()
  .get("/", async (c) => {
    const entries = readRegistry();
    const agents = await Promise.all(
      entries.map(async (entry) => {
        const dir = agentDir(entry.name);
        const { status, channels } = await getAgentStatus(dir, entry.port);
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

    const { status, channels } = await getAgentStatus(dir, entry.port);
    return c.json({ ...entry, status, channels });
  })
  // Start agent
  .post("/:name/start", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    if (!existsSync(dir)) return c.json({ error: "Agent directory missing" }, 404);

    // Check if already running
    const pidPath = resolve(dir, ".molt", "supervisor.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt((await readFile(pidPath, "utf-8")).trim(), 10);
      try {
        process.kill(pid, 0);
        return c.json({ error: "Agent already running" }, 409);
      } catch {
        // Stale PID, continue
      }
    }

    // Spawn supervisor in background (same logic as start.ts)
    const { spawn } = await import("node:child_process");
    const { mkdirSync, openSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    let supervisorModule = "";
    let searchDir = dirname(new URL(import.meta.url).pathname);
    for (let i = 0; i < 5; i++) {
      const candidate = resolve(searchDir, "src", "lib", "supervisor.ts");
      if (existsSync(candidate)) {
        supervisorModule = candidate;
        break;
      }
      searchDir = dirname(searchDir);
    }
    if (!supervisorModule) {
      supervisorModule = resolve(
        dirname(new URL(import.meta.url).pathname),
        "..",
        "..",
        "lib",
        "supervisor.ts",
      );
    }

    const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");
    const bootstrapCode = `
    import { runSupervisor } from ${JSON.stringify(supervisorModule)};
    runSupervisor({
      agentName: ${JSON.stringify(name)},
      agentDir: ${JSON.stringify(dir)},
      port: ${entry.port},
      dev: false,
    });
  `;

    const logsDir = resolve(dir, ".molt", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = resolve(logsDir, "supervisor.log");
    const logFd = openSync(logFile, "a");

    const child = spawn(tsxBin, ["--eval", bootstrapCode], {
      cwd: dir,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();

    // Poll for health
    const maxWait = 30_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(`http://localhost:${entry.port}/health`);
        if (res.ok) {
          return c.json({ ok: true, pid: child.pid });
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return c.json({ error: "Server did not become healthy within 30s" }, 504);
  })
  // Stop agent
  .post("/:name/stop", async (c) => {
    const name = c.req.param("name");
    const entry = findAgent(name);
    if (!entry) return c.json({ error: "Agent not found" }, 404);

    const dir = agentDir(name);
    const pidPath = resolve(dir, ".molt", "supervisor.pid");

    if (!existsSync(pidPath)) {
      return c.json({ error: "Agent is not running" }, 409);
    }

    const pid = parseInt((await readFile(pidPath, "utf-8")).trim(), 10);

    try {
      process.kill(pid, 0);
    } catch {
      const { unlinkSync } = await import("node:fs");
      try {
        unlinkSync(pidPath);
      } catch {}
      return c.json({ ok: true, message: "Cleaned up stale PID" });
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    // Wait for PID file to be removed
    const maxWait = 10_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (!existsSync(pidPath)) {
        return c.json({ ok: true });
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Force kill
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    return c.json({ ok: true, message: "Force killed" });
  });

export default app;
