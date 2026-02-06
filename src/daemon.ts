import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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

  mkdirSync(VOLUTE_HOME, { recursive: true });

  // Generate internal auth token for CLI-to-daemon communication
  const token = randomBytes(32).toString("hex");

  // Write PID and config (including internal token)
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
  writeFileSync(DAEMON_JSON_PATH, `${JSON.stringify({ port, token }, null, 2)}\n`);

  // Set token in environment so auth middleware can check it
  process.env.VOLUTE_DAEMON_TOKEN = token;

  // Start web server
  const server = startServer({ port });

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

  console.error(`[daemon] running on port ${port}, pid ${process.pid}`);

  // Graceful shutdown
  function cleanup() {
    try {
      unlinkSync(DAEMON_PID_PATH);
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
