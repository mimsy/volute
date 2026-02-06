import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initAgentManager } from "./lib/agent-manager.js";
import { initConnectorManager } from "./lib/connector-manager.js";
import { agentDir, readRegistry, VOLUTE_HOME } from "./lib/registry.js";
import { getScheduler } from "./lib/scheduler.js";
import { startServer } from "./web/server.js";

const DAEMON_PID_PATH = resolve(VOLUTE_HOME, "daemon.pid");
const DAEMON_JSON_PATH = resolve(VOLUTE_HOME, "daemon.json");

export async function startDaemon(opts: { port: number; foreground: boolean }): Promise<void> {
  const { port } = opts;
  const myPid = String(process.pid);

  mkdirSync(VOLUTE_HOME, { recursive: true });

  // Use existing token if set (for testing), otherwise generate one
  const token = process.env.VOLUTE_DAEMON_TOKEN || randomBytes(32).toString("hex");

  // Set token in environment so auth middleware can check it
  process.env.VOLUTE_DAEMON_TOKEN = token;

  // Start web server — must succeed before writing PID/config files,
  // otherwise a failed startup (e.g. EADDRINUSE) would overwrite files
  // belonging to a running daemon.
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ port });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`[daemon] port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  }

  // Server is listening — safe to write PID and config
  writeFileSync(DAEMON_PID_PATH, myPid);
  writeFileSync(DAEMON_JSON_PATH, `${JSON.stringify({ port, token }, null, 2)}\n`);

  // Start agent manager, connector manager, and scheduler
  const manager = initAgentManager();
  const connectors = initConnectorManager();
  const scheduler = getScheduler();
  scheduler.start();

  // Start all agents that were previously running, then their connectors and schedules
  const registry = readRegistry();
  for (const entry of registry) {
    if (!entry.running) continue;
    try {
      await manager.startAgent(entry.name);
      const dir = agentDir(entry.name);
      await connectors.startConnectors(entry.name, dir, entry.port);
      scheduler.loadSchedules(entry.name);
    } catch (err) {
      console.error(`[daemon] failed to start agent ${entry.name}:`, err);
    }
  }

  console.error(`[daemon] running on port ${port}, pid ${myPid}`);

  // Only delete PID/config files if they still belong to this process
  function cleanup() {
    try {
      if (readFileSync(DAEMON_PID_PATH, "utf-8").trim() === myPid) {
        unlinkSync(DAEMON_PID_PATH);
      }
    } catch {}
    try {
      unlinkSync(DAEMON_JSON_PATH);
    } catch {}
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[daemon] shutting down...");
    scheduler.stop();
    await connectors.stopAll();
    await manager.stopAll();
    server.close();
    cleanup();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", cleanup);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.ts")) {
  let port = 4200;
  let foreground = false;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === "--foreground") {
      foreground = true;
    }
  }

  startDaemon({ port, foreground });
}
