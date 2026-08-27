import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { format } from "node:util";
import { setProviderRefreshHook } from "./lib/ai-service.js";
import { backfillCommonsChannelMembers, ensureCommonsChannel } from "./lib/chat/commons-channel.js";
import { initBackupManager } from "./lib/daemon/backup-manager.js";
import { initBridgeManager } from "./lib/daemon/bridge-manager.js";
import { getCredentialRecovery } from "./lib/daemon/credential-recovery.js";
import { syncProviderToMinds } from "./lib/daemon/credential-sync.js";
import { initMailPoller } from "./lib/daemon/mail-poller.js";
import { startMaintenanceInterval } from "./lib/daemon/maintenance.js";
import { getMindManager, initMindManager } from "./lib/daemon/mind-manager.js";
import { restoreMindRuntimeState, startMindFull } from "./lib/daemon/mind-service.js";
import { initScheduler } from "./lib/daemon/scheduler.js";
import { initSleepManager } from "./lib/daemon/sleep-manager.js";
import { initSpendBudget } from "./lib/daemon/spend-budget.js";
import { initSummarizer } from "./lib/daemon/summarizer.js";
import { completeOrphanedTurns, summarizeOrphanedTurns } from "./lib/daemon/turn-tracker.js";
import { initDeliveryManager } from "./lib/delivery/delivery-manager.js";
import { stopAll as stopAllActivityTrackers } from "./lib/events/mind-activity-tracker.js";
import {
  loadAllExtensions,
  notifyExtensionsDaemonStart,
  notifyExtensionsDaemonStop,
  notifyExtensionsSpiritReady,
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

/** The registry fields the boot filter needs. */
type BootCandidate = {
  name: string;
  running: boolean;
  parent?: string | null;
  mindType?: string | null;
};

/**
 * Should this registry row enter the daemon's boot loop?
 *
 * Two distinct populations: minds whose *process* must come back (`running`),
 * and minds whose *clock* must come back. The second is why sleeping minds are
 * here at all — sleep persists `running = 0`, so filtering on `running` alone
 * made the loop's sleeping branch dead code and a mind asleep across a restart
 * came back with no schedules while `clock list` reported them all armed (#865).
 *
 * A mind is only in sleep state because it or its host asked for sleep: the
 * sleep-onset path requires a running mind, `POST /:name/stop` refuses a mind
 * that isn't running, and a mind stopped mid-trigger-wake reads `wokenByTrigger`
 * and so is not `isSleeping`. So "sleeping" always means a deliberate sleep, and
 * restoring its clock is honouring that request — including a `trigger-wake`
 * schedule, which the sleep manager would in any case wake it for at its wake
 * time. A mind stopped with `mind stop` and never slept has no sleep state and
 * stays out, its schedules unloaded by `stopMindFull` as intended.
 *
 * Exported for tests: the claim in the paragraph above is the kind that rots.
 */
export function shouldBootEntry(
  entry: BootCandidate,
  isSleeping: (name: string) => boolean,
): boolean {
  if (entry.mindType === "spirit") return false;
  if (entry.running) return true;
  // Variants have no independent clock and never sleep on their own.
  return !entry.parent && isSleeping(entry.name);
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

  // Initialize database (runs drizzle migrations + creates raw connection)
  await (await import("./lib/db.js")).getDb();

  // Migrate the spirit user's role to "spirit". Fresh installs still carry the
  // default "user" role; installs from the earlier wave carry "system". Both
  // updates are guarded and idempotent — no-ops once the row already reads "spirit".
  try {
    const { eq, and } = await import("drizzle-orm");
    const { users } = await import("./lib/schema.js");
    const db = await (await import("./lib/db.js")).getDb();
    await db
      .update(users)
      .set({ role: "spirit" })
      .where(and(eq(users.user_type, "spirit"), eq(users.role, "user")));
    // Existing installs (e.g. bardo) already carry the earlier "system" value.
    await db
      .update(users)
      .set({ role: "spirit" })
      .where(and(eq(users.user_type, "spirit"), eq(users.role, "system")));
  } catch (err) {
    log.warn("failed to migrate spirit user role", log.errorData(err));
  }

  // Downscale oversized avatars uploaded before resize-on-upload existed (non-fatal)
  try {
    const { migrateAvatarSizes } = await import("./lib/util/avatar-image.js");
    await migrateAvatarSizes();
  } catch (err) {
    log.warn("avatar size migration failed", log.errorData(err));
  }

  // Move legacy schedule `thread` fields into routes.json event rules (idempotent, #736)
  try {
    const { readAllMinds, mindDir } = await import("./lib/mind/registry.js");
    const { migrateScheduleThreadsToRoutes } = await import("./lib/mind/event-routes.js");
    for (const m of await readAllMinds()) {
      try {
        migrateScheduleThreadsToRoutes(m.dir ?? mindDir(m.name), m.name);
      } catch (err) {
        log.warn(`schedule-thread route migration failed for ${m.name}`, log.errorData(err));
      }
    }
  } catch (err) {
    log.warn("schedule-thread route migration failed", log.errorData(err));
  }

  // Initialize sandbox runtime for mind process isolation
  const { initSandbox } = await import("./lib/mind/sandbox.js");
  await initSandbox();

  // Load extensions (non-fatal). This must run BEFORE the HTTP server binds:
  // extensions mount routes on `app`, and Hono freezes its route matcher on the
  // first request, so a route added after the first health poll would throw. The
  // skill sync / auto-update housekeeping below touches only the shared pool and
  // mind dirs (not `app`), so it's deferred until after the server is listening.
  try {
    await loadAllExtensions(app, authMiddleware);
    notifyExtensionsDaemonStart();
  } catch (err) {
    log.error("failed to load extensions", log.errorData(err));
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

  // Start the web server EARLY — before the slow skill sync / auto-update pass
  // below — so `/api/health` means "daemon alive" and answers within seconds.
  // Previously the server only bound after ~2.5min of per-mind skill git work,
  // which blew past `volute update`'s health poll on multi-mind system installs
  // and made a healthy restart report as failed (#510). Must succeed before
  // writing PID/config files, otherwise a failed startup (e.g. EADDRINUSE) would
  // overwrite files belonging to a running daemon.
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

  // --- Post-bind housekeeping ---
  // The HTTP server is already listening and answering /api/health, so the slow
  // steps below no longer gate daemon health (#510). They stay in their original
  // order (sync before defaults) and are awaited before mind startup, so minds
  // still boot against a fully-synced skill pool exactly as before — only the
  // server bind moved earlier.

  // Sync built-in skills into the shared pool (non-fatal)
  try {
    await syncBuiltinSkills();
  } catch (err) {
    log.error("failed to sync built-in skills", log.errorData(err));
  }

  // Initialize default skills config if not set (after extensions load + builtin
  // sync so their skills are present in the pool)
  await initDefaultSkills();

  // Auto-update skills for all minds (non-fatal)
  if (isAutoUpdateSkillsEnabled()) {
    try {
      await autoUpdateMindSkills();
    } catch (err) {
      log.error("failed to auto-update mind skills", log.errorData(err));
    }
  }

  // Ensure the commons (default) channel exists (non-fatal)
  try {
    await ensureCommonsChannel();
  } catch (err) {
    log.warn("failed to ensure commons channel", log.errorData(err));
  }

  // Backfill registered minds into the commons (non-fatal)
  try {
    await backfillCommonsChannelMembers();
  } catch (err) {
    log.warn("failed to backfill minds into the commons", log.errorData(err));
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

  // Start delivery manager, mind manager, bridge manager, and scheduler
  const delivery = initDeliveryManager();
  const manager = initMindManager();
  manager.loadCrashAttempts();

  // Register the xAI (Grok) OAuth provider before any minds start, so a running
  // xai-model mind can resolve its subscription OAuth credentials at boot. (Also
  // powers Grok Imagine image generation via the provider OAuth UI.)
  const { registerXaiOAuthProvider } = await import("./lib/oauth/xai.js");
  registerXaiOAuthProvider();

  const bridgeManager = initBridgeManager();
  const scheduler = initScheduler();
  scheduler.start();
  const mailPoller = initMailPoller();
  mailPoller.start();
  const spendBudget = initSpendBudget();
  const gcfg = readGlobalConfig();
  spendBudget.setSystemCap(gcfg.limits?.systemSpendCapPerDay);
  // The per-mind warning in restoreMindRuntimeState only sees a mind's own
  // volute.json; a stale default sitting in config.json would otherwise be dropped
  // in silence, and every mind created from it would come out uncapped.
  if (gcfg.mindDefaults?.cognition?.tokenBudget != null) {
    log.warn(
      "config.json still sets `mindDefaults.cognition.tokenBudget`, which no longer " +
        "does anything. Budgets are dollars now — replace it with `spendCap` (USD) and " +
        "`spendCapPeriodMinutes`. Until then new minds are created with no spend cap.",
    );
  }
  spendBudget.start();
  // Make the cap a limit rather than a meter: a mind over either bucket has its inbound
  // deliveries held (rows stay `pending`) until the period resets. Wired before any mind
  // boots — the first redrive sweep happens after mind startup has restored each mind's
  // bucket, so an over-cap mind is never handed a burst of held messages at boot.
  delivery.setHoldCheck((baseName) => {
    const hold = spendBudget.holdFor(baseName);
    return hold ? { reason: "spend_cap", scope: hold.scope, until: hold.resetAt } : null;
  });
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

  // Start all minds + variants that were previously running (parallel, concurrency limit of 5).
  // Sleeping minds enter the loop too, but only to have their clock restored —
  // see shouldBootEntry.
  const allMinds = await readAllMinds();
  const bootEntries = allMinds.filter((e) =>
    shouldBootEntry(e, (name) => sleepManager.isSleeping(name)),
  );
  {
    const queue = [...bootEntries];
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (!entry.parent && sleepManager.isSleeping(entry.name)) {
          // Sleeping mind: restore the clock but not the process
          await restoreMindRuntimeState(entry.name);
          continue;
        }
        // The sleep manager's tick is already running, so a mind can wake between
        // the filter above and this dequeue (up to 5 workers, seconds apart). It is
        // then already running: starting it again throws, and the catch below would
        // record a *live* mind as stopped — a mind running while the registry says
        // otherwise, which is #865's own failure mode.
        if (manager.isRunning(entry.name)) continue;
        try {
          await startMindFull(entry.name);
        } catch (err) {
          log.error(`failed to start mind ${entry.name}`, log.errorData(err));
          // Never mark a mind stopped that is in fact running (see above).
          if (!manager.isRunning(entry.name)) await setMindRunning(entry.name, false);
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

      // Let extensions run spirit-dependent bootstrap now that the spirit project
      // exists — after the template sync so nothing they write gets clobbered, and
      // before startSpiritFull so any schedule they provision is loaded this boot
      // rather than the next one.
      if (spiritEntry) await notifyExtensionsSpiritReady();

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
    // Notify first — a mind opted into auto-upgrade is told "it will be applied
    // automatically in a few minutes", so that notice must go out before the pass
    // below actually runs it, not after. Then backfill on-disk hashes, warn about
    // stale minds, then run the serialized auto-upgrade pass over eligible ones.
    notifyVersionUpdate()
      .catch((err) => {
        log.warn("failed to send version update notifications", log.errorData(err));
      })
      .then(() => backfillTemplateHashes())
      .then(() => warnStaleTemplates())
      .then(async () => {
        const { runAutoUpgrades } = await import("./lib/daemon/auto-upgrade.js");
        await runAutoUpgrades();
      })
      .catch((err) => {
        log.warn("template staleness/auto-upgrade pass failed", log.errorData(err));
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

  // Re-evaluate held (gated) messages against current routing (non-blocking). routes.json
  // edits made while the daemon was down are otherwise only noticed on the next inbound
  // message for that channel — which on a quiet channel may never come. Touches only
  // `gated` rows, so it's independent of the `pending` restore above.
  // A spend hold can lift while the daemon is down — a period rolls over, or a host edits
  // a cap — and held rows are out of the sweep, so nothing else would ever notice them.
  delivery.releaseAllHeld().catch((err) => {
    log.warn("startup held-release sweep failed", log.errorData(err));
  });
  delivery.releaseGatedSweep().catch((err) => {
    log.warn("failed to sweep gated messages", log.errorData(err));
  });

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
      safe("credentialRecovery.stop", () => getCredentialRecovery().stop());
      safe("sleepManager.stop", () => sleepManager.stop());
      safe("sleepManager.saveState", () => sleepManager.saveState());
      safe("scheduler.stop", () => scheduler.stop());
      safe("scheduler.saveState", () => scheduler.saveState());
      safe("mailPoller.stop", () => mailPoller.stop());
      safe("spendBudget.stop", () => spendBudget.stop());
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
