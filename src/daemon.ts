import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { format } from "node:util";
import { initBridgeManager } from "./lib/daemon/bridge-manager.js";
import { initMailPoller } from "./lib/daemon/mail-poller.js";
import { initMindManager } from "./lib/daemon/mind-manager.js";
import { startMindFull } from "./lib/daemon/mind-service.js";
import { initScheduler } from "./lib/daemon/scheduler.js";
import { initSleepManager } from "./lib/daemon/sleep-manager.js";
import { initTokenBudget } from "./lib/daemon/token-budget.js";
import { completeOrphanedTurns } from "./lib/daemon/turn-tracker.js";
import { initDeliveryManager } from "./lib/delivery/delivery-manager.js";
import { stopAll as stopAllActivityTrackers } from "./lib/events/mind-activity-tracker.js";
import {
  loadAllExtensions,
  notifyExtensionsDaemonStart,
  notifyExtensionsDaemonStop,
} from "./lib/extensions.js";
import { cleanExpiredLogs } from "./lib/history-cleanup.js";
import log from "./lib/logger.js";
import {
  ensureSystemDir,
  findMind,
  readAllMinds,
  setMindRunning,
  voluteHome,
  voluteSystemDir,
} from "./lib/registry.js";
import { RotatingLog } from "./lib/rotating-log.js";
import { ensureSharedRepo } from "./lib/shared.js";
import {
  autoUpdateMindSkills,
  initDefaultSkills,
  isAutoUpdateSkillsEnabled,
  syncBuiltinSkills,
} from "./lib/skills.js";
import { ensureSystemChannel } from "./lib/system-channel.js";
import { initWebhook } from "./lib/webhook.js";
import { startApiKeyRefresh, stopApiKeyRefresh } from "./web/api/system.js";
import app from "./web/app.js";
import { authMiddleware, cleanExpiredSessions } from "./web/middleware/auth.js";
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
  tailscale?: boolean;
}): Promise<void> {
  const { port, hostname } = opts;
  const myPid = String(process.pid);

  const home = voluteHome();

  const systemDir = voluteSystemDir();

  // In background mode, redirect structured logs and console to a rotating log file
  if (!opts.foreground) {
    const rotatingLog = new RotatingLog(resolve(systemDir, "daemon.log"));
    log.setOutput((line) => rotatingLog.write(`${line}\n`));
    // Keep console redirect as safety net for uncaught/third-party output
    const write = (...args: any[]) => rotatingLog.write(`${format(...args)}\n`);
    console.log = write;
    console.error = write;
    console.warn = write;
    console.info = write;
  }
  const DAEMON_PID_PATH = resolve(systemDir, "daemon.pid");
  const DAEMON_JSON_PATH = resolve(systemDir, "daemon.json");

  mkdirSync(home, { recursive: true });
  ensureSystemDir();

  // Initialize shared repo for inter-mind collaboration (non-fatal)
  try {
    await ensureSharedRepo();
  } catch (err) {
    log.warn("failed to initialize shared repo", log.errorData(err));
  }

  // Migrate pre-existing installations (setup field without setupCompleted)
  const { migrateSetupCompleted } = await import("./lib/setup.js");
  migrateSetupCompleted();

  // Initialize database (runs drizzle migrations + creates raw connection)
  await (await import("./lib/db.js")).getDb();

  // Migrate system user role to "system" (existing installs have "user")
  try {
    const { eq, and } = await import("drizzle-orm");
    const { users } = await import("./lib/schema.js");
    const db = await (await import("./lib/db.js")).getDb();
    await db
      .update(users)
      .set({ role: "system" })
      .where(and(eq(users.user_type, "system"), eq(users.role, "user")));
  } catch (err) {
    log.warn("failed to migrate system user role", log.errorData(err));
  }

  // Initialize sandbox runtime for mind process isolation
  const { initSandbox } = await import("./lib/sandbox.js");
  await initSandbox();

  // Sync built-in skills into the shared pool (non-fatal)
  try {
    await syncBuiltinSkills();
  } catch (err) {
    log.error("failed to sync built-in skills", log.errorData(err));
  }

  // Load extensions (non-fatal)
  try {
    await loadAllExtensions(app, authMiddleware);
    notifyExtensionsDaemonStart();
  } catch (err) {
    log.error("failed to load extensions", log.errorData(err));
  }

  // Initialize default skills config if not set (after extensions load so their skills are included)
  await initDefaultSkills();

  // Auto-update skills for all minds (non-fatal)
  if (isAutoUpdateSkillsEnabled()) {
    try {
      await autoUpdateMindSkills();
    } catch (err) {
      log.error("failed to auto-update mind skills", log.errorData(err));
    }
  }

  // Ensure #system channel exists (non-fatal)
  try {
    await ensureSystemChannel();
  } catch (err) {
    log.warn("failed to ensure #system channel", log.errorData(err));
  }

  // Ensure system user exists (non-fatal)
  try {
    const { getOrCreateSystemUser } = await import("./lib/auth.js");
    await getOrCreateSystemUser();
  } catch (err) {
    log.warn(
      "failed to ensure system user — system chat features will be unavailable",
      log.errorData(err),
    );
  }

  // Use existing token if set (for testing), otherwise generate one
  const token = process.env.VOLUTE_DAEMON_TOKEN || randomBytes(32).toString("hex");

  // Tailscale HTTPS setup
  let tls: { key: Buffer; cert: Buffer } | undefined;
  if (opts.tailscale) {
    const { getTailscaleTls } = await import("./lib/tailscale.js");
    const tlsConfig = await getTailscaleTls();
    tls = { key: tlsConfig.key, cert: tlsConfig.cert };
    log.info("Tailscale HTTPS enabled", { hostname: tlsConfig.hostname });
  }

  // Start web server — must succeed before writing PID/config files,
  // otherwise a failed startup (e.g. EADDRINUSE) would overwrite files
  // belonging to a running daemon.
  let result: Awaited<ReturnType<typeof startServer>>;
  try {
    result = await startServer({ port, hostname: "0.0.0.0", tls });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      log.error(`port ${port} is already in use`);
      process.exit(1);
    }
    throw err;
  }
  const { server, internalPort } = result;

  // Internal communication always uses HTTP on localhost
  // When TLS is enabled, minds/CLI talk to the secondary HTTP port
  const daemonPort = internalPort ?? port;
  process.env.VOLUTE_DAEMON_TOKEN = token;
  process.env.VOLUTE_DAEMON_PORT = String(daemonPort);
  process.env.VOLUTE_DAEMON_HOSTNAME = hostname;

  // Server is listening — safe to write PID and config
  writeFileSync(DAEMON_PID_PATH, myPid, { mode: 0o644 });
  const daemonConfig: Record<string, unknown> = { port, hostname, token };
  if (internalPort) daemonConfig.internalPort = internalPort;
  if (tls) daemonConfig.tls = true;
  writeFileSync(DAEMON_JSON_PATH, `${JSON.stringify(daemonConfig, null, 2)}\n`, { mode: 0o644 });

  // Start delivery manager, mind manager, bridge manager, and scheduler
  const delivery = initDeliveryManager();
  const manager = initMindManager();
  manager.loadCrashAttempts();
  const bridgeManager = initBridgeManager();
  const scheduler = initScheduler();
  scheduler.start();
  const mailPoller = initMailPoller();
  mailPoller.start();
  const tokenBudget = initTokenBudget();
  tokenBudget.start();
  const sleepManager = initSleepManager();
  sleepManager.start();
  const unsubscribeWebhook = initWebhook();

  // Clean up any turns left active from a previous daemon session
  await completeOrphanedTurns();

  // Start all minds + variants that were previously running (parallel, concurrency limit of 5)
  // Skip sleeping minds — they only need connectors, not the mind process
  const allMinds = await readAllMinds();
  const runningEntries = allMinds.filter((e) => e.running && e.mindType !== "spirit");
  {
    const queue = [...runningEntries];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (!entry.parent && sleepManager.isSleeping(entry.name)) {
          // Sleeping mind: start schedules but not the process
          try {
            scheduler.loadSchedules(entry.name);
          } catch (err) {
            log.error(
              `failed to start schedules for sleeping mind ${entry.name}`,
              log.errorData(err),
            );
          }
          continue;
        }
        try {
          await startMindFull(entry.name);
        } catch (err) {
          log.error(`failed to start mind ${entry.name}`, log.errorData(err));
          await setMindRunning(entry.name, false);
        }
      }
    });
    await Promise.all(workers);
  }

  // Start system spirit (non-fatal — system works without it)
  // Only create/start the spirit if setup is complete (provider + model configured)
  try {
    const { isSetupComplete } = await import("./lib/setup.js");
    if (isSetupComplete()) {
      const { ensureSpiritProject, syncSpiritTemplate } = await import("./lib/spirit.js");
      const { startSpiritFull } = await import("./lib/daemon/mind-service.js");
      await ensureSpiritProject();
      await syncSpiritTemplate();
      const spiritEntry = await findMind("volute");
      if (spiritEntry && !manager.isRunning("volute")) {
        await startSpiritFull("volute");
      }
    }
  } catch (err) {
    log.warn(
      "failed to start system spirit — system replies will use aiComplete fallback",
      log.errorData(err),
    );
  }

  // Start system-level bridges (non-blocking)
  bridgeManager.startBridges(daemonPort).catch((err) => {
    log.warn("failed to start bridges", log.errorData(err));
  });

  // Consume messages queued in the cloud while the machine was off (non-blocking)
  import("./lib/cloud-sync.js")
    .then(({ consumeQueuedMessages }) =>
      consumeQueuedMessages().catch((err) => {
        log.warn("failed to consume queued cloud messages", log.errorData(err));
      }),
    )
    .catch((err) => {
      log.warn("failed to load cloud-sync module", log.errorData(err));
    });

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

  // Clean up expired sessions and old log entries (non-blocking)
  cleanExpiredSessions().catch((err) => {
    log.warn("failed to clean expired sessions", log.errorData(err));
  });
  cleanExpiredLogs().catch((err) => {
    log.warn("failed to clean expired logs", log.errorData(err));
  });

  // Start periodic API key cache refresh for mind provider keys
  startApiKeyRefresh();

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
      safe("notifyExtensionsDaemonStop", notifyExtensionsDaemonStop);
      safe("stopAllActivityTrackers", stopAllActivityTrackers);
      safe("unsubscribeWebhook", unsubscribeWebhook);
      safe("sleepManager.stop", () => sleepManager.stop());
      safe("sleepManager.saveState", () => sleepManager.saveState());
      safe("scheduler.stop", () => scheduler.stop());
      safe("scheduler.saveState", () => scheduler.saveState());
      safe("mailPoller.stop", () => mailPoller.stop());
      safe("tokenBudget.stop", () => tokenBudget.stop());
      safe("stopApiKeyRefresh", stopApiKeyRefresh);
      safe("delivery.dispose", () => delivery.dispose());
      await safe("bridgeManager.stopAll", () => bridgeManager.stopAll());
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
  let port = 1618;
  let hostname = "127.0.0.1";
  let foreground = false;
  let tailscale = false;
  let noSandbox = false;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--port" && process.argv[i + 1]) {
      port = parseInt(process.argv[i + 1], 10);
      i++;
    } else if (process.argv[i] === "--host" && process.argv[i + 1]) {
      hostname = process.argv[i + 1];
      i++;
    } else if (process.argv[i] === "--foreground") {
      foreground = true;
    } else if (process.argv[i] === "--tailscale") {
      tailscale = true;
    } else if (process.argv[i] === "--no-sandbox") {
      noSandbox = true;
    }
  }

  if (noSandbox) {
    process.env.VOLUTE_SANDBOX = "0";
  }

  startDaemon({ port, hostname, foreground, tailscale });
}
