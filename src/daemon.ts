import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { format } from "node:util";
import { initConnectorManager } from "./lib/daemon/connector-manager.js";
import { initMailPoller } from "./lib/daemon/mail-poller.js";
import { initMindManager } from "./lib/daemon/mind-manager.js";
import { startMindFull } from "./lib/daemon/mind-service.js";
import { initScheduler } from "./lib/daemon/scheduler.js";
import { initSleepManager } from "./lib/daemon/sleep-manager.js";
import { initTokenBudget } from "./lib/daemon/token-budget.js";
import { initDeliveryManager } from "./lib/delivery/delivery-manager.js";
import { stopAll as stopAllActivityTrackers } from "./lib/events/mind-activity-tracker.js";
import log from "./lib/logger.js";
import { migrateAgentsToMinds } from "./lib/migrate-agents-to-minds.js";
import { migrateDotVoluteDir, migrateMindState } from "./lib/migrate-state.js";
import { stopAllWatchers } from "./lib/pages-watcher.js";
import {
  initRegistryCache,
  mindDir,
  readRegistry,
  setMindRunning,
  voluteHome,
} from "./lib/registry.js";
import { RotatingLog } from "./lib/rotating-log.js";
import { ensureSharedRepo } from "./lib/shared.js";
import { syncBuiltinSkills } from "./lib/skills.js";
import { getAllRunningVariants, setVariantRunning } from "./lib/variants.js";
import { initWebhook } from "./lib/webhook.js";
import { cleanExpiredSessions } from "./web/middleware/auth.js";
import { startServer } from "./web/server.js";

if (!process.env.VOLUTE_HOME) {
  process.env.VOLUTE_HOME = resolve(homedir(), ".volute");
}

// Allow explicit timezone override — propagates to all child processes (minds, connectors)
if (process.env.VOLUTE_TIMEZONE && !process.env.TZ) {
  process.env.TZ = process.env.VOLUTE_TIMEZONE;
}

export async function startDaemon(opts: {
  port: number;
  hostname: string;
  foreground: boolean;
}): Promise<void> {
  const { port, hostname } = opts;
  const myPid = String(process.pid);

  const home = voluteHome();

  // In background mode, redirect structured logs and console to a rotating log file
  if (!opts.foreground) {
    const rotatingLog = new RotatingLog(resolve(home, "daemon.log"));
    log.setOutput((line) => rotatingLog.write(`${line}\n`));
    // Keep console redirect as safety net for uncaught/third-party output
    const write = (...args: any[]) => rotatingLog.write(`${format(...args)}\n`);
    console.log = write;
    console.error = write;
    console.warn = write;
    console.info = write;
  }
  const DAEMON_PID_PATH = resolve(home, "daemon.pid");
  const DAEMON_JSON_PATH = resolve(home, "daemon.json");

  mkdirSync(home, { recursive: true });

  // One-time migration: agents.json → minds.json, agents/ → minds/
  migrateAgentsToMinds();

  // Initialize shared repo for inter-mind collaboration (non-fatal)
  try {
    await ensureSharedRepo();
  } catch (err) {
    log.warn("failed to initialize shared repo", log.errorData(err));
  }

  // Load registry into memory for fast reads within the daemon
  initRegistryCache();

  // Sync built-in skills into the shared pool (non-fatal)
  try {
    await syncBuiltinSkills();
  } catch (err) {
    log.error("failed to sync built-in skills", log.errorData(err));
  }

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
      log.error(`port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  }

  // Server is listening — safe to write PID and config
  writeFileSync(DAEMON_PID_PATH, myPid, { mode: 0o644 });
  writeFileSync(DAEMON_JSON_PATH, `${JSON.stringify({ port, hostname, token }, null, 2)}\n`, {
    mode: 0o644,
  });

  // Start delivery manager, mind manager, connector manager, and scheduler
  const delivery = initDeliveryManager();
  const manager = initMindManager();
  manager.loadCrashAttempts();
  const connectors = initConnectorManager();
  const scheduler = initScheduler();
  scheduler.start();
  const mailPoller = initMailPoller();
  mailPoller.start();
  const tokenBudget = initTokenBudget();
  tokenBudget.start();
  const sleepManager = initSleepManager();
  sleepManager.start();
  const unsubscribeWebhook = initWebhook();

  // Migrate .volute/ → .mind/ and system state for all registered minds
  const registry = readRegistry();
  for (const entry of registry) {
    try {
      migrateDotVoluteDir(entry.name);
      migrateMindState(entry.name);
    } catch (err) {
      log.warn(`failed to migrate state for ${entry.name}`, log.errorData(err));
    }
  }

  // Start all minds that were previously running (parallel, concurrency limit of 5)
  // Skip sleeping minds — they only need connectors, not the mind process
  const runningEntries = registry.filter((e) => e.running);
  {
    const queue = [...runningEntries];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (sleepManager.isSleeping(entry.name)) {
          // Sleeping mind: start connectors/schedules but not the process
          try {
            // We need connectors running but not the mind process
            const dir = mindDir(entry.name);
            const daemonPort = process.env.VOLUTE_DAEMON_PORT
              ? parseInt(process.env.VOLUTE_DAEMON_PORT, 10)
              : undefined;
            await connectors.startConnectors(entry.name, dir, entry.port, daemonPort);
            scheduler.loadSchedules(entry.name);
          } catch (err) {
            log.error(
              `failed to start connectors for sleeping mind ${entry.name}`,
              log.errorData(err),
            );
          }
          continue;
        }
        try {
          await startMindFull(entry.name);
        } catch (err) {
          log.error(`failed to start mind ${entry.name}`, log.errorData(err));
          setMindRunning(entry.name, false);
        }
      }
    });
    await Promise.all(workers);
  }

  // Restore running variants (in parallel with same pattern)
  const runningVariants = getAllRunningVariants();
  {
    const queue = [...runningVariants];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const { mindName, variant } = queue.shift()!;
        const compositeKey = `${mindName}@${variant.name}`;
        try {
          await startMindFull(compositeKey);
        } catch (err) {
          log.error(`failed to start variant ${compositeKey}`, log.errorData(err));
          setVariantRunning(mindName, variant.name, false);
        }
      }
    });
    await Promise.all(workers);
  }

  // Consume messages queued in the cloud while the machine was off (non-blocking)
  import("./lib/cloud-sync.js").then(({ consumeQueuedMessages }) =>
    consumeQueuedMessages().catch((err) => {
      log.warn("failed to consume queued cloud messages", log.errorData(err));
    }),
  );

  // Backfill template hashes + notify minds about version updates
  try {
    const { backfillTemplateHashes, notifyVersionUpdate } = await import("./lib/version-notify.js");
    backfillTemplateHashes();
    // Fire-and-forget notification (non-blocking)
    notifyVersionUpdate().catch((err) => {
      log.warn("failed to send version update notifications", log.errorData(err));
    });
  } catch (err) {
    log.warn("failed to initialize version notifications", log.errorData(err));
  }

  // Restore delivery queue from DB (non-blocking)
  delivery.restoreFromDb().catch((err) => {
    log.warn("failed to restore delivery queue", log.errorData(err));
  });

  // Clean up expired sessions (non-blocking)
  cleanExpiredSessions().catch((err) => {
    log.warn("failed to clean expired sessions", log.errorData(err));
  });

  log.info(`running on ${hostname}:${port}, pid ${myPid}`);

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
    log.info("shutting down...");
    const safe = (label: string, fn: () => unknown) => {
      try {
        const result = fn();
        if (result instanceof Promise)
          return result.catch((err) => log.error(`shutdown: ${label} failed`, log.errorData(err)));
      } catch (err) {
        log.error(`shutdown: ${label} failed`, log.errorData(err));
      }
    };
    try {
      safe("stopAllWatchers", stopAllWatchers);
      safe("stopAllActivityTrackers", stopAllActivityTrackers);
      safe("unsubscribeWebhook", unsubscribeWebhook);
      safe("sleepManager.stop", () => sleepManager.stop());
      safe("sleepManager.saveState", () => sleepManager.saveState());
      safe("scheduler.stop", () => scheduler.stop());
      safe("scheduler.saveState", () => scheduler.saveState());
      safe("mailPoller.stop", () => mailPoller.stop());
      safe("tokenBudget.stop", () => tokenBudget.stop());
      safe("delivery.dispose", () => delivery.dispose());
      await safe("connectors.stopAll", () => connectors.stopAll());
      await safe("manager.stopAll", () => manager.stopAll());
      safe("clearCrashAttempts", () => manager.clearCrashAttempts());
      safe("server.close", () => server.close());
    } catch (err) {
      log.error("error during shutdown", log.errorData(err));
    } finally {
      cleanup();
      process.exit(0);
    }
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
