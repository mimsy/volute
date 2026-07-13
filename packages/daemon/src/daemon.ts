import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { format } from "node:util";
import { setProviderRefreshHook } from "./lib/ai-service.js";
import { backfillSystemChannelMembers, ensureSystemChannel } from "./lib/chat/system-channel.js";
import { initBackupManager } from "./lib/daemon/backup-manager.js";
import { initBridgeManager } from "./lib/daemon/bridge-manager.js";
import { syncProviderToMinds } from "./lib/daemon/credential-sync.js";
import { initMailPoller } from "./lib/daemon/mail-poller.js";
import { startMaintenanceInterval } from "./lib/daemon/maintenance.js";
import { getMindManager, initMindManager } from "./lib/daemon/mind-manager.js";
import { startMindFull } from "./lib/daemon/mind-service.js";
import { initScheduler } from "./lib/daemon/scheduler.js";
import { initSleepManager } from "./lib/daemon/sleep-manager.js";
import { initSummarizer } from "./lib/daemon/summarizer.js";
import { initTokenBudget } from "./lib/daemon/token-budget.js";
import { completeOrphanedTurns, summarizeOrphanedTurns } from "./lib/daemon/turn-tracker.js";
import { initDeliveryManager } from "./lib/delivery/delivery-manager.js";
import { stopAll as stopAllActivityTrackers } from "./lib/events/mind-activity-tracker.js";
import {
  loadAllExtensions,
  notifyExtensionsDaemonStart,
  notifyExtensionsDaemonStop,
} from "./lib/extensions.js";
import {
  ensureSystemDir,
  findMind,
  readAllMinds,
  setMindRunning,
  voluteHome,
  voluteSystemDir,
} from "./lib/mind/registry.js";
import {
  autoUpdateMindSkills,
  initDefaultSkills,
  isAutoUpdateSkillsEnabled,
  syncBuiltinSkills,
} from "./lib/skills.js";
import { cleanExpiredLogs } from "./lib/util/history-cleanup.js";
import log from "./lib/util/logger.js";
import { RotatingLog } from "./lib/util/rotating-log.js";
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

/**
 * Persist daemon connection info, splitting the secret from the non-secret part:
 * daemon.json (port/hostname) stays host-readable at 0644 so a non-root CLI
 * on a system install can find the daemon, while the admin token goes to a
 * separate 0600 owner-only file. chmodSync enforces the mode even when a file
 * pre-existed with looser/tighter perms (writeFileSync's `mode` only applies on
 * creation) — this also relaxes a daemon.json left at 0600 by v0.41.1.
 */
export function writeDaemonConfig(
  systemDir: string,
  config: Record<string, unknown>,
  token: string,
): void {
  const configPath = resolve(systemDir, "daemon.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  chmodSync(configPath, 0o644);
  const tokenPath = resolve(systemDir, "daemon-token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
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
  const DAEMON_TOKEN_PATH = resolve(systemDir, "daemon-token");

  mkdirSync(home, { recursive: true });
  ensureSystemDir();

  // Split provider credentials into secrets.json and relax config.json to 0644 so
  // non-root host CLI commands can read it (v0.41.1 regression). Runs as root.
  const { migrateConfigSecrets, migrateSetupCompleted } = await import("./lib/config/setup.js");
  migrateConfigSecrets();

  // Migrate pre-existing installations (setup field without setupCompleted)
  migrateSetupCompleted();

  // Migrate bare model ids to provider-qualified form before the spirit starts,
  // so syncSpiritTemplate reads a qualified spiritModel.
  const { migrateAiModelQualification } = await import("./lib/ai-service.js");
  migrateAiModelQualification();

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

  // Downscale oversized avatars uploaded before resize-on-upload existed (non-fatal)
  try {
    const { migrateAvatarSizes } = await import("./lib/util/avatar-image.js");
    await migrateAvatarSizes();
  } catch (err) {
    log.warn("avatar size migration failed", log.errorData(err));
  }

  // Initialize sandbox runtime for mind process isolation
  const { initSandbox } = await import("./lib/mind/sandbox.js");
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

  // Backfill registered minds into #system (non-fatal)
  try {
    await backfillSystemChannelMembers();
  } catch (err) {
    log.warn("failed to backfill minds into #system", log.errorData(err));
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

  // Tailscale HTTPS setup (CLI flag or config)
  const { readGlobalConfig } = await import("./lib/config/setup.js");
  const globalCfg = readGlobalConfig();
  let tls: { key: Buffer; cert: Buffer } | undefined;
  if (opts.tailscale || globalCfg.tailscale) {
    try {
      const { getTailscaleTls } = await import("./lib/tailscale.js");
      const tlsConfig = await getTailscaleTls();
      tls = { key: tlsConfig.key, cert: tlsConfig.cert };
      log.info("Tailscale HTTPS enabled", { hostname: tlsConfig.hostname });
    } catch (err) {
      log.error(
        "Tailscale TLS setup failed — starting without HTTPS. Ensure Tailscale is running, or disable tailscale in config.",
        log.errorData(err),
      );
    }
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
  const daemonConfig: Record<string, unknown> = { port, hostname };
  if (internalPort) daemonConfig.internalPort = internalPort;
  if (tls) daemonConfig.tls = true;
  // daemon.json is host-readable (0644); the admin token is written separately at 0600.
  writeDaemonConfig(systemDir, daemonConfig, token);

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
  const summarizer = initSummarizer();
  summarizer.start();
  const backupManager = initBackupManager();
  backupManager.start();
  const unsubscribeWebhook = initWebhook();

  // Clean up any turns left active from a previous daemon session and generate their summaries
  const orphanedTurns = await completeOrphanedTurns();
  summarizeOrphanedTurns(orphanedTurns);

  // Reconcile variant rows against disk before starting anything: drop stale rows
  // whose worktree is gone (e.g. legacy `name@variant` rows) and report orphaned
  // `.variants/` dirs that have no row (#444).
  try {
    const { reconcileVariants } = await import("./lib/mind/variant-cleanup.js");
    await reconcileVariants();
  } catch (err) {
    log.error("failed to reconcile variants", log.errorData(err));
  }

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
    const { isSetupComplete, getSpiritName } = await import("./lib/config/setup.js");
    if (isSetupComplete()) {
      const { ensureSpiritProject, syncSpiritTemplate } = await import("./lib/mind/spirit.js");
      const { startSpiritFull } = await import("./lib/daemon/mind-service.js");
      await ensureSpiritProject();

      // Register the spirit's custom dir for routing-config resolution now, so any
      // resolution before startSpiritFull (e.g. syncSpiritTemplate, setup welcome)
      // reads the spirit's routes.json rather than the (wrong) minds dir.
      const spiritName = getSpiritName();
      const spiritEntry = await findMind(spiritName);
      if (spiritEntry?.dir) {
        const { registerMindDir } = await import("./lib/delivery/delivery-router.js");
        registerMindDir(spiritName, spiritEntry.dir);
      }

      await syncSpiritTemplate();
      if (spiritEntry && !manager.isRunning(spiritName)) {
        await startSpiritFull(spiritName);
      }
    }
  } catch (err) {
    // No fallback replies exist anymore — a DM to the missing spirit gets an honest
    // unavailable notice, and the next DM retries the start on demand (#434).
    log.warn("failed to start system spirit", log.errorData(err));
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
    const { backfillTemplateHashes, notifyVersionUpdate, warnStaleTemplates } = await import(
      "./lib/version-notify.js"
    );
    // Backfill first (measures on-disk hashes), then warn about stale minds.
    backfillTemplateHashes()
      .then(() => warnStaleTemplates())
      .catch((err) => {
        log.warn("failed to check template staleness", log.errorData(err));
      });
    // Fire-and-forget notification (non-blocking)
    notifyVersionUpdate().catch((err) => {
      log.warn("failed to send version update notifications", log.errorData(err));
    });
  } catch (err) {
    log.warn("failed to initialize version notifications", log.errorData(err));
  }

  // Restore delivery queue from DB (non-blocking) and start the periodic redrive
  // sweep so stranded/failed deliveries are retried at-least-once.
  delivery.restoreFromDb().catch((err) => {
    log.warn("failed to restore delivery queue", log.errorData(err));
  });
  delivery.startRedrive();

  // Clean up expired sessions and old log entries (non-blocking)
  cleanExpiredSessions().catch((err) => {
    log.warn("failed to clean expired sessions", log.errorData(err));
  });
  cleanExpiredLogs().catch((err) => {
    log.warn("failed to clean expired logs", log.errorData(err));
  });

  // ...and re-run that cleanup hourly so retention is actually enforced on a
  // long-lived daemon, not just once at startup.
  const maintenanceInterval = startMaintenanceInterval();

  // When the daemon rotates a provider's OAuth token, push the fresh token into
  // running minds so they don't refresh the rotating grant independently (which
  // invalidated each other and caused recurring 401s).
  setProviderRefreshHook((provider) => {
    void syncProviderToMinds(provider, {
      listRunning: () => getMindManager().getRunningMinds(),
    }).catch((err) => log.warn("credential sync to minds failed", log.errorData(err)));
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
      // Only delete daemon.json/token if they still belong to this process
      // (the token file, 0600, is the ownership marker now that daemon.json is public).
      if (readFileSync(DAEMON_TOKEN_PATH, "utf-8").trim() === token) {
        unlinkSync(DAEMON_TOKEN_PATH);
        try {
          unlinkSync(DAEMON_JSON_PATH);
        } catch {
          // daemon.json may already be gone — ignore
        }
      }
    } catch {
      // Token file may not exist or belong to another process — ignore
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
      safe("summarizer.stop", () => summarizer.stop());
      safe("backupManager.stop", () => backupManager.stop());
      safe("stopApiKeyRefresh", stopApiKeyRefresh);
      safe("maintenanceInterval", () => clearInterval(maintenanceInterval));
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

  startDaemon({ port, hostname, foreground, tailscale }).catch((err) => {
    log.error("daemon failed to start", log.errorData(err));
    process.exit(1);
  });
}
