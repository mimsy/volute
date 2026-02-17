import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { format } from "node:util";
import { initAgentManager } from "./lib/agent-manager.js";
import { initConnectorManager } from "./lib/connector-manager.js";
import { migrateAgentState } from "./lib/migrate-state.js";
import { agentDir, readRegistry, setAgentRunning, voluteHome } from "./lib/registry.js";
import { RotatingLog } from "./lib/rotating-log.js";
import { getScheduler } from "./lib/scheduler.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "./lib/token-budget.js";
import { getAllRunningVariants, setVariantRunning } from "./lib/variants.js";
import { readVoluteConfig } from "./lib/volute-config.js";
import { cleanExpiredSessions } from "./web/middleware/auth.js";
import { startServer } from "./web/server.js";

if (!process.env.VOLUTE_HOME) {
  process.env.VOLUTE_HOME = resolve(homedir(), ".volute");
}

export async function startDaemon(opts: {
  port: number;
  hostname: string;
  foreground: boolean;
}): Promise<void> {
  const { port, hostname } = opts;
  const myPid = String(process.pid);

  const home = voluteHome();

  // In background mode, redirect console to a rotating log file
  if (!opts.foreground) {
    const log = new RotatingLog(resolve(home, "daemon.log"));
    const write = (...args: any[]) => log.write(`${format(...args)}\n`);
    console.log = write;
    console.error = write;
    console.warn = write;
    console.info = write;
  }
  const DAEMON_PID_PATH = resolve(home, "daemon.pid");
  const DAEMON_JSON_PATH = resolve(home, "daemon.json");

  mkdirSync(home, { recursive: true });

  // Use existing token if set (for testing), otherwise generate one
  const token = process.env.VOLUTE_DAEMON_TOKEN || randomBytes(32).toString("hex");

  // Set token, port, and hostname in environment so internal code can build correct URLs
  process.env.VOLUTE_DAEMON_TOKEN = token;
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_DAEMON_HOSTNAME = hostname;

  // Start web server — must succeed before writing PID/config files,
  // otherwise a failed startup (e.g. EADDRINUSE) would overwrite files
  // belonging to a running daemon.
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ port, hostname });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`[daemon] port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  }

  // Server is listening — safe to write PID and config
  writeFileSync(DAEMON_PID_PATH, myPid, { mode: 0o644 });
  writeFileSync(DAEMON_JSON_PATH, `${JSON.stringify({ port, hostname, token }, null, 2)}\n`, {
    mode: 0o644,
  });

  // Start agent manager, connector manager, and scheduler
  const manager = initAgentManager();
  manager.loadCrashAttempts();
  const connectors = initConnectorManager();
  const scheduler = getScheduler();
  scheduler.start(port, token);
  const tokenBudget = getTokenBudget();
  tokenBudget.start(port, token);

  // Migrate system state for all registered agents
  const registry = readRegistry();
  for (const entry of registry) {
    try {
      migrateAgentState(entry.name);
    } catch (err) {
      console.error(`[daemon] failed to migrate state for ${entry.name}:`, err);
    }
  }

  // Start all agents that were previously running, then their connectors and schedules
  for (const entry of registry) {
    if (!entry.running) continue;
    try {
      await manager.startAgent(entry.name);
      // Seed agents only get the server — no connectors, schedules, or budget
      if (entry.stage === "seed") continue;
      const dir = agentDir(entry.name);
      await connectors.startConnectors(entry.name, dir, entry.port, port);
      scheduler.loadSchedules(entry.name);
      const config = readVoluteConfig(dir);
      if (config?.tokenBudget) {
        tokenBudget.setBudget(
          entry.name,
          config.tokenBudget,
          config.tokenBudgetPeriodMinutes ?? DEFAULT_BUDGET_PERIOD_MINUTES,
        );
      }
    } catch (err) {
      console.error(`[daemon] failed to start agent ${entry.name}:`, err);
      setAgentRunning(entry.name, false);
    }
  }

  // Restore running variants
  const runningVariants = getAllRunningVariants();
  for (const { agentName, variant } of runningVariants) {
    const compositeKey = `${agentName}@${variant.name}`;
    try {
      await manager.startAgent(compositeKey);
    } catch (err) {
      console.error(`[daemon] failed to start variant ${compositeKey}:`, err);
      setVariantRunning(agentName, variant.name, false);
    }
  }

  // Clean up expired sessions (non-blocking)
  cleanExpiredSessions().catch(() => {});

  console.error(`[daemon] running on ${hostname}:${port}, pid ${myPid}`);

  // Only delete PID/config files if they still belong to this process
  function cleanup() {
    try {
      if (readFileSync(DAEMON_PID_PATH, "utf-8").trim() === myPid) {
        unlinkSync(DAEMON_PID_PATH);
      }
    } catch {
      // PID file may not exist or belong to another process — ignore
    }
    try {
      // Only delete daemon.json if it belongs to this process
      const data = JSON.parse(readFileSync(DAEMON_JSON_PATH, "utf-8"));
      if (data.token === token) {
        unlinkSync(DAEMON_JSON_PATH);
      }
    } catch {
      // Config file may not exist — ignore
    }
  }

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[daemon] shutting down...");
    scheduler.stop();
    scheduler.saveState();
    tokenBudget.stop();
    await connectors.stopAll();
    await manager.stopAll();
    manager.clearCrashAttempts();
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
  let hostname = "127.0.0.1";
  let foreground = false;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === "--host" && process.argv[i + 1]) {
      hostname = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === "--foreground") {
      foreground = true;
    }
  }

  startDaemon({ port, hostname, foreground });
}
