import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { deleteMindUser, getDisplayNames, withSenderDisplayNames } from "../../lib/auth.js";
import { announceSprout, joinCommonsChannelForMind } from "../../lib/chat/commons-channel.js";
import {
  drainEvents,
  eventLabel,
  formatEvents,
  latestEvent,
  latestFailureEvent,
  listEvents,
  MIND_LEVEL_THREAD,
  parseMeta,
  recordNotice,
} from "../../lib/chat/system-events.js";
import { getSpiritName } from "../../lib/config/setup.js";
import { getUpgradeBlocked } from "../../lib/daemon/auto-upgrade.js";
import {
  forgetCredentialDegraded,
  getCredentialDegraded,
} from "../../lib/daemon/credential-recovery.js";
import { getMindManager, MindStartupError } from "../../lib/daemon/mind-manager.js";
// Lifecycle functions from mind-service.ts
import {
  startMindFull as startMindFullService,
  stopMindFull as stopMindFullService,
} from "../../lib/daemon/mind-service.js";
import { DEFAULT_SPEND_PERIOD_MINUTES, getSpendBudget } from "../../lib/daemon/spend-budget.js";
import { supersedeTurnSummary } from "../../lib/daemon/summarizer.js";
import { handleMindEvent, setNoticeDrainWatermark } from "../../lib/daemon/turn-lifecycle.js";
import { getActiveTurnId } from "../../lib/daemon/turn-tracker.js";
import { readWindow, usageReport } from "../../lib/daemon/usage-report.js";
import { getDb } from "../../lib/db.js";
import { getDeliveryManager, UnknownChannelError } from "../../lib/delivery/delivery-manager.js";
import { broadcast } from "../../lib/events/activity-events.js";
import {
  getConversation,
  getMessages,
  getMessagesPaginated,
  isConversationForMind,
  isParticipant,
  listConversationsForMind,
} from "../../lib/events/conversations.js";
import { subscribe as subscribeMindEvent } from "../../lib/events/mind-events.js";
import type { ExportManifest } from "../../lib/mind/archive.js";
import { setupDefaultDreaming } from "../../lib/mind/default-autonomy.js";
import { deleteMindUser as deleteIsolationUser } from "../../lib/mind/isolation.js";
import {
  acquireJoinLock,
  describeJoinAge,
  JoinInProgressError,
  joinInProgress,
} from "../../lib/mind/join-lock.js";
import { commitSrcChanges, rollbackSrcChanges } from "../../lib/mind/last-known-good.js";
import {
  createMind,
  importMindFromArchive,
  importOpenClawWorkspace,
  mergeVariant,
} from "../../lib/mind/lifecycle.js";
import { getMemoryStatus } from "../../lib/mind/memory-size.js";
import {
  findMind,
  findVariants,
  getBaseName,
  type MindEntry,
  mindDir,
  readRegistry,
  removeMind,
  setMindStage,
  stateDir,
} from "../../lib/mind/registry.js";
import { evaluateSeedChecklist } from "../../lib/mind/seed-readiness.js";
import { isTemplateStale } from "../../lib/mind/template-staleness.js";
import { applyThinkingLevel, deriveThinkingLevel } from "../../lib/mind/thinking-config.js";
import {
  abortUpgrade,
  continueUpgrade,
  runUpgrade,
  UpgradeInProgressError,
  upgradeDiff,
  upgradeInProgress,
} from "../../lib/mind/upgrade.js";
import { cleanupVariant } from "../../lib/mind/variant-cleanup.js";
import { validateBranchName } from "../../lib/mind/variants.js";
import { readVoluteConfig, writeVoluteConfig } from "../../lib/mind/volute-config.js";
import { PLATFORMS } from "../../lib/platforms.js";
import { deliveryQueue, mindHistory, summaries, turns } from "../../lib/schema.js";
import {
  createImagegenJob,
  getImagegenJob,
  waitForImagegenJob,
} from "../../lib/services/imagegen-jobs.js";
import { isKnownTemplate } from "../../lib/template/template.js";
import { collectTurnContext } from "../../lib/turn-context.js";
import { checkHealth } from "../../lib/util/health.js";
import log from "../../lib/util/logger.js";
import { safeResolveWithinBase } from "../../lib/util/paths.js";
import {
  boundedIntParam,
  cursorParamsSchema,
  cursorResponse,
  intParamError,
  parseIntParam,
} from "../../lib/util/query-params.js";
import { normalizeDbBound, parseDbTimestamp } from "../../lib/util/time.js";
import { fireWebhook } from "../../lib/webhook.js";
import {
  type AuthEnv,
  invalidateMindUserCache,
  isSpiritActingOnAnother,
  requireAdmin,
  requireSelf,
  requireSelfOrSpirit,
} from "../middleware/auth.js";
import { hasAdminAuthority } from "../middleware/effective-principal.js";

const _lastActiveCache: { map: Map<string, string>; ts: number } = { map: new Map(), ts: 0 };
const _LAST_ACTIVE_TTL = 60_000;

/**
 * mind_history row types the daemon authors to represent someone *other than the mind* —
 * a human's message ("inbound") or the environment itself ("event"). Minds are untrusted
 * principals (they run arbitrary code), and POST /:name/events is how a mind writes its own
 * history, so it must not be able to write these: doing so forges a message from a human, or
 * a system event that the UI renders as an authoritative environment notice. Everything else
 * on this endpoint is mind-authored by definition and is rendered as such.
 */
const DAEMON_AUTHORED_TYPES = new Set(["inbound", "event"]);

/**
 * How far out the spirit may set another mind's wake time.
 *
 * A day is a tending cycle: long enough for the rest to mean something, short enough
 * that a mind rested by mistake — or by a spirit talked into it — comes back on its own
 * rather than waiting for a host to notice. See the sleep route for why the bound exists.
 */
const SPIRIT_MAX_SLEEP_HOURS = 24;
const SPIRIT_MAX_SLEEP_MS = SPIRIT_MAX_SLEEP_HOURS * 60 * 60 * 1000;

/** How many of a mind's messages are currently waiting on a spend cap. */
async function countHeldDeliveries(baseName: string): Promise<number> {
  try {
    const db = await getDb();
    const row = await db
      .select({ n: sql<number>`count(*)` })
      .from(deliveryQueue)
      .where(and(eq(deliveryQueue.mind, baseName), eq(deliveryQueue.status, "held")))
      .get();
    return row?.n ?? 0;
  } catch (err) {
    log.warn(`failed to count held deliveries for ${baseName}`, log.errorData(err));
    return 0;
  }
}

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
};

async function getMindStatus(
  name: string,
  port: number,
  registryRunning?: boolean,
  seed?: { stage?: string | null; dir?: string | null },
) {
  const manager = getMindManager();
  let status: "running" | "stopped" | "starting" | "sleeping" = "stopped";
  let wakeAt: string | null = null;

  // Check sleep state first
  try {
    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const sleepManager = getSleepManagerIfReady();
    if (sleepManager?.isSleeping(name)) {
      status = "sleeping";
      const sleepState = sleepManager.getState(name);
      // A voluntary wake-at is authoritative for the night (initiateSleep nulls
      // the cron wake when one is set), so prefer it.
      wakeAt = sleepState.voluntaryWakeAt ?? sleepState.scheduledWakeAt;
    }
  } catch (err) {
    // A swallowed failure here misreports a sleeping mind as stopped (and chat
    // would offer Start for a mind that is asleep) — leave a trace.
    log.warn(`failed to check sleep state for ${name}`, log.errorData(err));
  }

  if (status !== "sleeping" && registryRunning !== false && manager.isRunning(name)) {
    const health = await checkHealth(port);
    status = health.ok ? "running" : "starting";
  }

  const config = readVoluteConfig(mindDir(name));
  const channels: ChannelStatus[] = [];

  // Built-in channels (e.g. volute)
  for (const [, provider] of Object.entries(PLATFORMS)) {
    if (!provider.builtIn) continue;
    channels.push({
      name: provider.name,
      displayName: provider.displayName,
      status: status === "running" ? "connected" : "disconnected",
    });
  }

  // Undelivered failure notice = the mind failed and hasn't completed a clean
  // turn since. Chat surfaces this as "last turn failed" (#574); it clears
  // automatically once the notice drains on the next clean turn.
  const lastError = await latestFailureEvent(name);

  // Seed minds surface their sprout checklist so the host watching the seed's
  // chat can see how close it is (#664). Derived from the same predicates as the
  // sprout gate and the spirit's nurture check — nothing secret, so it rides in
  // the public status payload alongside displayName/avatar.
  const seedChecklist =
    seed?.stage === "seed" ? evaluateSeedChecklist(seed.dir ?? mindDir(name)) : undefined;

  // MEMORY.md size — read from disk so it's accurate for stopped minds and minds
  // on stale templates that don't yet report their own memory cost (#569).
  const memory = getMemoryStatus(seed?.dir ?? mindDir(name));

  return {
    status,
    wakeAt,
    lastError,
    memory,
    channels,
    displayName: config?.profile?.displayName,
    description: config?.profile?.description,
    avatar: config?.profile?.avatar,
    seedChecklist,
  };
}

type MindStatus = Awaited<ReturnType<typeof getMindStatus>>;

/**
 * True for admin *authority* only: a real admin, or the spirit on a turn a verified
 * admin triggered. The spirit's own tiers are deliberately excluded (#433).
 *
 * Verified rather than assumed: what this gates is the *extra* registry fields — port,
 * dir, branch, template, hash, parent, createdBy, running. `toPublicMind` already
 * returns name, `created` (age), stage, status, displayName, description, avatar and
 * seedChecklist, which is everything the tending skill reads out of `volute mind list`
 * (who is around, who is new, who is a seed and how ready). So denying this costs
 * tending nothing and withholds only host-operational internals.
 */
function isPrivileged(c: Context<AuthEnv>): boolean {
  return hasAdminAuthority(c.get("effective"));
}

/**
 * Reduce a registry entry to the profile-level fields safe to hand a
 * non-privileged caller (a mind token or a non-admin user). Registry internals —
 * port, dir, branch, template, hash, parent, createdBy, running — are withheld:
 * minds are untrusted principals, and a mind's own port/dir aids lateral movement
 * (direct connections to sibling mind servers that bypass the daemon, targeted
 * filesystem probing). Only admin/system callers get the full entry. See #503.
 */
export function toPublicMind(
  entry: MindEntry,
  status: MindStatus,
  extras: { hasPages: boolean; lastActiveAt?: string | null },
) {
  return {
    name: entry.name,
    created: entry.created,
    stage: entry.stage,
    mindType: entry.mindType,
    status: status.status,
    wakeAt: status.wakeAt,
    // Kind/reason/at only — `detail` can embed the raw error string (unknown
    // classifications), which is mind-private (served behind requireSelf).
    lastError: status.lastError
      ? { kind: status.lastError.kind, reason: status.lastError.reason, at: status.lastError.at }
      : null,
    memory: status.memory,
    channels: status.channels,
    displayName: status.displayName,
    description: status.description,
    avatar: status.avatar,
    seedChecklist: status.seedChecklist,
    hasPages: extras.hasPages,
    lastActiveAt: extras.lastActiveAt ?? null,
  };
}

const createMindSchema = z.object({
  name: z.string(),
  template: z.string().optional(),
  stage: z.enum(["seed", "sprouted"]).optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  seedSoul: z.string().optional(),
  skills: z.array(z.string()).optional(),
  createdBy: z.string().optional(),
});

// Create mind — admin only
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function proxyToMind(c: Context<AuthEnv>, path: string) {
  const name = c.req.param("name")!;
  const entry = await findMind(name);
  if (!entry) return c.json({ error: "Mind not found" }, 404);
  if (!getMindManager().isRunning(name)) {
    return c.json({ error: "Mind is not running" }, 503);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const status = res.status >= 500 ? 502 : 404;
      return c.json(
        {
          error:
            res.status >= 500 ? `Mind ${path} handler errored` : `${path} endpoint not available`,
        },
        status,
      );
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return c.json({ error: "Mind returned invalid response" }, 502);
    }
    return c.json(data);
  } catch (err) {
    console.error(`${path} proxy for ${name}:`, err);
    return c.json({ error: "Failed to reach mind" }, 503);
  }
}

/**
 * Host-visible degraded-credentials state: the mind is up but running without model
 * credentials because its provider's OAuth refresh is failing. Undefined (and so
 * absent from the JSON) when the mind is healthy. Privileged callers only — it names
 * a provider and a fault window.
 */
function credentialDegradedField(name: string): { provider: string; since: string } | undefined {
  const state = getCredentialDegraded(name);
  return state ? { provider: state.provider, since: state.since.toISOString() } : undefined;
}

// Page bounds, hoisted so each refusal message names the same numbers the parse used.
const CONTACTS_HOURS = { fallback: 48, min: 1, max: 168 };
const EVENTS_LIMIT = { fallback: 100, min: 1, max: 200 };
const HISTORY_LIMIT = { fallback: 50, min: 1, max: 200 };
const OFFSET = { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER };

const app = new Hono<AuthEnv>()
  .post("/", requireAdmin, zValidator("json", createMindSchema), async (c) => {
    const result = await createMind(c.req.valid("json"), { username: c.get("user")?.username });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.body);
  })
  // Import mind from OpenClaw workspace or .volute archive — admin only
  .post(
    "/import",
    requireAdmin,
    zValidator(
      "json",
      z.object({
        workspacePath: z.string().optional(),
        name: z.string().optional(),
        template: z.string().optional(),
        sessionPath: z.string().optional(),
        archivePath: z.string().optional(),
        // The archive manifest is validated downstream by importMindFromArchive.
        manifest: z.custom<ExportManifest>().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid("json");

      const result =
        body.archivePath && body.manifest
          ? await importMindFromArchive(body.archivePath, body.name, body.manifest)
          : await importOpenClawWorkspace(body);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(result.body);
    },
  )
  // List all minds
  .get("/", async (c) => {
    const entries = await readRegistry();
    let lastActiveMap: Map<string, string>;
    if (_lastActiveCache.ts > 0 && Date.now() - _lastActiveCache.ts < _LAST_ACTIVE_TTL) {
      lastActiveMap = _lastActiveCache.map;
    } else {
      lastActiveMap = new Map<string, string>();
      try {
        const db = await getDb();
        const lastActiveRows = await db
          .select({
            mind: mindHistory.mind,
            lastActiveAt: sql<string>`MAX(${mindHistory.created_at})`,
          })
          .from(mindHistory)
          .groupBy(mindHistory.mind);
        lastActiveMap = new Map(lastActiveRows.map((r) => [r.mind, r.lastActiveAt]));
        _lastActiveCache.map = lastActiveMap;
        _lastActiveCache.ts = Date.now();
      } catch {
        // Non-essential: degrade gracefully without activity data
      }
    }

    const privileged = isPrivileged(c);
    const minds = await Promise.all(
      entries.map(async (entry) => {
        const mindStatus = await getMindStatus(entry.name, entry.port, entry.running, {
          stage: entry.stage,
          dir: entry.dir,
        });
        const hasPages = existsSync(resolve(mindDir(entry.name), "home", "pages"));
        const lastActiveAt = lastActiveMap.get(entry.name) ?? null;
        if (!privileged) return toPublicMind(entry, mindStatus, { hasPages, lastActiveAt });
        return {
          ...entry,
          ...mindStatus,
          hasPages,
          templateStale: isTemplateStale(entry),
          upgradeBlocked: getUpgradeBlocked(entry.name)?.reason,
          credentialDegraded: credentialDegradedField(entry.name),
          lastActiveAt,
        };
      }),
    );
    return c.json(minds);
  })
  // Get single mind
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(entry.parent ?? name);
    if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);

    const mindStatus = await getMindStatus(name, entry.port, undefined, {
      stage: entry.stage,
      dir: entry.dir,
    });
    const hasPages = existsSync(resolve(mindDir(name), "home", "pages"));

    // Non-privileged callers (minds, non-admin users) get profile-level fields
    // only — no port/dir/branch/variants that would aid lateral movement (#503).
    if (!isPrivileged(c)) {
      return c.json(toPublicMind(entry, mindStatus, { hasPages }));
    }

    // Include variant info (admin/system only — variant ports/names are internal)
    const variants = await findVariants(name);
    const manager = getMindManager();
    const variantStatuses = await Promise.all(
      variants.map(async (s) => {
        let variantStatus: "running" | "stopped" | "starting" = "stopped";
        if (manager.isRunning(s.name)) {
          const health = await checkHealth(s.port);
          variantStatus = health.ok ? "running" : "starting";
        }
        return { name: s.name, port: s.port, status: variantStatus };
      }),
    );

    // Surface the newest un-drained notice (turn error, crash, missing credentials)
    // so `mind status` can show why a mind is silent (#573). Admin/system only.
    const notice = await latestEvent(name);

    return c.json({
      ...entry,
      ...mindStatus,
      variants: variantStatuses,
      hasPages,
      templateStale: isTemplateStale(entry),
      upgradeBlocked: getUpgradeBlocked(name)?.reason,
      credentialDegraded: credentialDegradedField(name),
      ...(notice && {
        lastNotice: {
          kind: notice.kind,
          reason: notice.reason,
          detail: notice.detail,
          created_at: notice.created_at,
        },
      }),
    });
  })
  // Context info — proxy to mind's /context endpoint
  .get("/:name/context", requireSelf(), async (c) => proxyToMind(c, "context"))
  // Context messages — proxy to mind's /context/messages endpoint
  .get("/:name/context/messages", requireSelf(), async (c) => proxyToMind(c, "context/messages"))
  // Start mind (supports variants) — admin only
  .post("/:name/start", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");

    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const targetPort = entry.port;
    // Variants and spirits store their project dir in the DB (worktree /
    // ~/.volute/system/spirit); only plain minds live at mindDir(name).
    const projectDir = entry.dir ?? mindDir(name);
    if (entry.parent) {
      if (!entry.dir) return c.json({ error: `Variant ${name} has no directory` }, 404);
    } else if (!existsSync(projectDir)) {
      return c.json({ error: "Mind directory missing" }, 404);
    }

    if (getMindManager().isRunning(name)) {
      return c.json({ error: "Mind already running" }, 409);
    }

    try {
      await startMindFullService(name);
      return c.json({ ok: true, port: targetPort });
    } catch (err) {
      log.error(`failed to start mind ${name}`, log.errorData(err));
      return c.json({ error: "Failed to start mind" }, 500);
    }
  })
  // Restart mind (supports variants) — admin or self
  // Accepts optional JSON body: { context?: { type: string, name?: string, summary?: string, ... } }
  .post("/:name/restart", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");

    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const baseName = entry.parent ?? name;
    const targetPort = entry.port;
    // Variants and spirits store their project dir in the DB (worktree /
    // ~/.volute/system/spirit); only plain minds live at mindDir(name).
    const projectDir = entry.dir ?? mindDir(name);
    if (entry.parent) {
      if (!entry.dir) return c.json({ error: `Variant ${name} has no directory` }, 404);
    } else if (!existsSync(projectDir)) {
      return c.json({ error: "Mind directory missing" }, 404);
    }

    // Parse optional context from request body
    let context: Record<string, unknown> | undefined;
    const contentType = c.req.header("content-type");
    if (contentType?.includes("application/json")) {
      try {
        const body = await c.req.json();
        if (body?.context) context = body.context as Record<string, unknown>;
      } catch (err) {
        log.error(`failed to parse restart context for ${name}`, log.errorData(err));
      }
    }

    const manager = getMindManager();

    // The other entry point into a variant merge (#655): a mind calling daemonRestart()
    // with a merge context. Same lock, same key — `baseName` is exactly what this path
    // passes to mergeVariant as `parentName` — so a mind-initiated join and a merge-route
    // join exclude each other. Taken *before* the stop below: a refused join must leave
    // the mind running, not stopped by a restart it never got to finish.
    const joinVariant =
      context?.type === "merge" && context.name && !entry.parent ? String(context.name) : undefined;
    let releaseJoin: (() => void) | undefined;
    if (joinVariant) {
      try {
        releaseJoin = acquireJoinLock(baseName, joinVariant);
      } catch (err) {
        if (err instanceof JoinInProgressError) return c.json({ error: err.message }, 409);
        throw err;
      }
    }

    try {
      // During sleep (including trigger-wakes), skip identity reloads.
      // The mind process restarts on wake, picking up changes then.
      if (context?.type === "reload") {
        const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
        const sleepState = getSleepManagerIfReady()?.getState(name);
        if (sleepState?.sleeping) {
          log.info(`skipping reload for ${name} during sleep — will apply on next wake`);
          return c.json({ ok: true, deferred: true, port: targetPort });
        }
      }

      // Stop running mind
      if (manager.isRunning(name)) {
        await stopMindFullService(name);
      }

      // Handle mind-initiated merge: perform merge operations directly
      if (context?.type === "merge" && context.name && !entry.parent) {
        const mergeVariantName = String(context.name);
        const branchErr = validateBranchName(mergeVariantName);
        if (branchErr) {
          return c.json({ error: `Invalid variant name: ${branchErr}` }, 400);
        }
        log.error(`merging variant for ${baseName}: ${mergeVariantName}`);
        const variantEntry = await findMind(mergeVariantName);
        if (
          variantEntry &&
          variantEntry.parent === baseName &&
          variantEntry.dir &&
          variantEntry.branch
        ) {
          const projectRoot = mindDir(baseName);

          // Delegate to the one shared merge implementation (#330). The parent isn't
          // restarted here — that happens below, through the last-known-good recovery
          // path — so mergeVariant only does the merge + cleanup + reinstall and hands
          // back the result to fold into the pending context.
          const merge = await mergeVariant({
            parentName: baseName,
            variantName: mergeVariantName,
            projectRoot,
            variantDir: variantEntry.dir,
            variantBranch: variantEntry.branch,
            verify: false,
            discardUnresolved: context.discardUnresolvedHomeFiles === true,
            parentTemplate: entry.template ?? undefined,
          });

          if (merge.status === "merged") {
            if (merge.memoryDelta && context) context.memoryDelta = merge.memoryDelta;
          } else {
            // Merge blocked (unresolved home/ files, a merge conflict, or a failed
            // pre-merge commit): the variant is left fully intact. Tell the parent why
            // via a notice, and downgrade to a plain restart so buildPendingContextMessage
            // doesn't fire the "your variant has returned, merged into you" prompt for a
            // join that didn't finish (#656). The join_blocked notice is the real story.
            log.warn(
              `variant join blocked for ${baseName}: ${mergeVariantName} — ${merge.message}`,
            );
            await recordNotice({
              mind: baseName,
              thread: "main",
              kind: "join_blocked",
              reason:
                merge.status === "unresolved" || merge.status === "check_failed"
                  ? "unresolved_variant_files"
                  : "merge_conflict",
              detail: merge.message,
            });
            if (context) {
              context.type = "restart";
              context.name = undefined;
            }
          }
        }
      }

      // Store context for delivery after restart (skip "reload" — identity file
      // edits and compaction are self-initiated, so the mind doesn't need a notification)
      if (context && context.type !== "reload") {
        manager.setPendingContext(name, context);
      }

      // The mind itself learns it sprouted via the "sprouted" lifecycle event delivered on
      // restart (setPendingContext above); no separate conversation marker is injected.

      // Resolve the mind's git repo dir (variant worktree, spirit dir, or the base
      // mind dir) so last-known-good recovery can operate on the right working tree.
      const repoDir = projectDir;

      try {
        await startMindFullService(name);
      } catch (startErr) {
        // A mind can break its own startup by editing src/ (e.g. src/server.ts) then
        // calling daemonRestart(). The auto-commit hook only tracks home/, so the bad
        // src/ change is usually uncommitted. Park it on a broken/<ts> branch, revert
        // src/ to the last known-good HEAD, and retry — turning a fatal self-edit into
        // a recoverable one. If nothing was under src/, there's nothing to roll back.
        const stderr = startErr instanceof MindStartupError ? startErr.stderr : undefined;
        let rollback: { parked: boolean; branch?: string } = { parked: false };
        try {
          rollback = await rollbackSrcChanges(repoDir, name);
        } catch (rbErr) {
          log.error(`failed to roll back src changes for ${name}`, log.errorData(rbErr));
        }

        if (!rollback.parked) throw startErr;

        // Retry on the restored (known-good) src/. If this also fails, give up.
        await startMindFullService(name);

        const startMsg = startErr instanceof Error ? startErr.message : String(startErr);
        const errLine = (stderr ?? startMsg).trim().split("\n").filter(Boolean).pop() ?? "";
        // Attribute the notice to the mind that was actually restarted so the parent
        // isn't notified about variant code it didn't touch. Caveat: the drain endpoint
        // resolves getBaseName first, so a notice recorded under a VARIANT name is not
        // drained into the variant's turns — it surfaces via `mind status` (latestEvent
        // also queries by the raw name) and the events UI instead.
        await recordNotice({
          mind: name,
          thread: "main",
          kind: "startup",
          reason: "startup_failed",
          detail:
            `Your last change to src/ broke startup, so it was rolled back and your previous ` +
            `working code was restored. The broken change is preserved on branch ` +
            `\`${rollback.branch}\` — check it out to inspect and fix it. Error: ${errLine}`,
          raw: stderr ?? null,
        });

        return c.json({
          ok: true,
          recovered: true,
          brokenBranch: rollback.branch,
          port: targetPort,
        });
      }

      // Startup succeeded — commit any src/ changes as the new known-good baseline so a
      // future bad edit has a clean point to roll back to.
      await commitSrcChanges(repoDir, name).catch((e) =>
        log.error(`failed to commit known-good src for ${name}`, log.errorData(e)),
      );
      return c.json({ ok: true, port: targetPort });
    } catch (err) {
      log.error(`failed to restart mind ${name}`, log.errorData(err));
      return c.json({ error: "Failed to restart mind" }, 500);
    } finally {
      releaseJoin?.();
    }
  })
  // Stop mind (supports variants) — admin only
  .post("/:name/stop", requireSelf(), async (c) => {
    const name = c.req.param("name");

    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const manager = getMindManager();
    if (!manager.isRunning(name)) {
      return c.json({ error: "Mind is not running" }, 409);
    }

    try {
      await stopMindFullService(name);
      return c.json({ ok: true });
    } catch (err) {
      log.error(`failed to stop mind ${name}`, log.errorData(err));
      return c.json({ error: "Failed to stop mind" }, 500);
    }
  })
  // Get sleep state
  .get("/:name/sleep", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (!sm) return c.json({ error: "Sleep manager not initialized" }, 503);

    return c.json(sm.getState(name));
  })
  /**
   * Initiate sleep — the mind itself, an admin, or the spirit.
   *
   * The spirit's form is bounded: it must name a `wakeAt`, and no further out than
   * {@link SPIRIT_MAX_SLEEP_MS}. `sleep` is on the spirit's allowlist *because* it is the
   * humane pause — the mind rests and comes back continuous — while `stop` is not. An
   * open-ended or year-long sleep collapses that distinction: it is `stop` by another
   * name, and it would hand back through this route exactly the power the allowlist
   * withholds. A mind sleeping itself, or an admin, is unbounded as before; the bound is
   * on the party that has the capability only conditionally (#433).
   */
  .post("/:name/sleep", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (!sm) return c.json({ error: "Sleep manager not initialized" }, 503);

    if (sm.isSleeping(name)) return c.json({ error: "Mind is already sleeping" }, 409);

    const body = await c.req.json().catch(() => ({}));
    const wakeAt = (body as { wakeAt?: string }).wakeAt;

    if (wakeAt) {
      const wakeDate = new Date(wakeAt);
      if (Number.isNaN(wakeDate.getTime()) || wakeDate <= new Date()) {
        return c.json({ error: "wakeAt must be a valid future ISO date" }, 400);
      }
    }

    // The spirit resting another mind must say when it wakes, and not far off.
    if (await isSpiritActingOnAnother(c.get("user"), name)) {
      if (!wakeAt) {
        return c.json(
          { error: "wakeAt is required when the spirit puts another mind to sleep" },
          400,
        );
      }
      if (new Date(wakeAt).getTime() - Date.now() > SPIRIT_MAX_SLEEP_MS) {
        return c.json(
          {
            error: `wakeAt may be at most ${SPIRIT_MAX_SLEEP_HOURS}h out when the spirit puts another mind to sleep`,
          },
          400,
        );
      }
    }

    sm.initiateSleep(name, wakeAt ? { voluntaryWakeAt: wakeAt } : undefined).catch((err) =>
      log.error(`failed to initiate sleep for ${name}`, log.errorData(err)),
    );

    return c.json({ ok: true });
  })
  // Wake a sleeping mind — mind-or-admin (requireSelf: the mind itself or an admin/system user)
  .post("/:name/wake", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (!sm) return c.json({ error: "Sleep manager not initialized" }, 503);

    const sleepState = sm.getState(name);
    if (!sleepState.sleeping) return c.json({ error: "Mind is not sleeping" }, 409);

    if (sleepState.wokenByTrigger) {
      // Convert trigger-wake to full wake (mind is already running)
      sm.convertTriggerToFullWake(name);
    } else {
      sm.initiateWake(name).catch((err) => log.error(`failed to wake ${name}`, log.errorData(err)));
    }

    return c.json({ ok: true });
  })
  // Flush queued sleep messages — mind-or-admin (requireSelf: the mind itself or an admin/system user)
  .post("/:name/sleep/messages", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (!sm) return c.json({ error: "Sleep manager not initialized" }, 503);

    const flushed = await sm.flushQueuedMessages(name);
    return c.json({ ok: true, flushed });
  })
  // Update mind profile — admin or self
  .patch(
    "/:name/profile",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        displayName: z.string().optional(),
        description: z.string().optional(),
        avatar: z.string().optional(),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const body = c.req.valid("json");

      const dir = entry.dir ?? mindDir(name);
      const config = readVoluteConfig(dir) ?? {};
      const profile = config.profile ?? {};

      if (body.displayName !== undefined) profile.displayName = body.displayName;
      if (body.description !== undefined) profile.description = body.description;
      // Store a home-relative path — never persist a value that escapes home/,
      // since it's later used in filesystem operations (avatar serving/deletion).
      if (body.avatar !== undefined) {
        const homeDir = resolve(dir, "home");
        const avatarPath = safeResolveWithinBase(homeDir, body.avatar);
        if (!avatarPath) {
          return c.json({ error: "Avatar path must be inside the mind's home directory" }, 400);
        }
        if (!existsSync(avatarPath)) {
          return c.json({ error: `Avatar file not found: ${relative(homeDir, avatarPath)}` }, 400);
        }
        profile.avatar = relative(homeDir, avatarPath);
      }

      config.profile = profile;
      writeVoluteConfig(dir, config);

      // Sync to users table
      const { syncMindProfile } = await import("../../lib/auth.js");
      await syncMindProfile(name, profile);

      // Broadcast profile update
      broadcast({ type: "profile_updated", mind: name, summary: `${name} profile updated` });

      return c.json({ ok: true });
    },
  )
  // Start a background image-generation job. Returns a job id immediately; the
  // daemon generates, writes home/images/<filename>.png, and wakes the mind on
  // completion. requireSelf: a mind may only run jobs for itself.
  .post(
    "/:name/imagegen/jobs",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        model: z.string().min(1),
        prompt: z.string().min(1),
        filename: z.string().min(1),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const { model, prompt, filename } = c.req.valid("json");
      try {
        const jobId = createImagegenJob(name, model, prompt, filename);
        return c.json({ jobId }, 202);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Failed to start job" }, 429);
      }
    },
  )
  // Poll a job. `?wait=<sec>` long-polls: the daemon returns as soon as the job
  // finishes, or after the timeout (still "running"). 404 = unknown/lost job
  // (e.g. after a daemon restart) — the skill tells the mind to re-run.
  .get("/:name/imagegen/jobs/:jobId", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const jobId = c.req.param("jobId");
    // Absent means "don't long-poll"; malformed is a different thing and must not read as
    // the same. `?wait=30s` used to return instantly reporting "running", with nothing to
    // say the wait had been dropped.
    const waitSec = parseIntParam(c.req.query("wait"));
    if (waitSec === null) return c.json({ error: "wait must be a non-negative integer" }, 400);
    const waitMs = Math.min(waitSec ?? 0, 60) * 1000;
    const job =
      waitMs > 0 ? await waitForImagegenJob(name, jobId, waitMs) : getImagegenJob(name, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  })
  // Seed readiness check — used by spirit nurture schedule
  .get("/:name/seed-check", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");
    // Without ?force=1 this check is gated on recency — output is empty when the
    // seed was recently attended to, which is what the spirit's `--nurture`
    // schedule relies on. The CLI passes ?force=1 for bare host invocations so a
    // manual check always reports, even for a mind that is no longer a seed (#666).
    const force = c.req.query("force") === "1" || c.req.query("force") === "true";
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage !== "seed") {
      return c.json({
        output: force ? `${name} is no longer a seed (stage: ${entry.stage}).` : "",
      });
    }

    // A sleeping seed needs no encouragement; stay quiet until it wakes.
    if (!force) {
      const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
      if (getSleepManagerIfReady()?.isSleeping(name)) {
        return c.json({ output: "" });
      }
    }

    const db = await getDb();
    const rawCreator = Number(process.env.VOLUTE_NURTURE_CREATOR_MINUTES);
    const creatorThreshold = Number.isNaN(rawCreator) ? 5 : rawCreator;
    const rawSpirit = Number(process.env.VOLUTE_NURTURE_SPIRIT_MINUTES);
    const spiritThreshold = Number.isNaN(rawSpirit) ? 15 : rawSpirit;
    const rawNudge = Number(process.env.VOLUTE_NURTURE_NUDGE_MINUTES);
    const nudgeThreshold = Number.isNaN(rawNudge) ? 30 : rawNudge;

    // Last message anyone other than the spirit (or the seed itself) sent the
    // seed — creator or neighbor mind alike, engagement is engagement.
    const spiritName = getSpiritName();
    const lastActivityMsg = await db
      .select({ created_at: mindHistory.created_at, sender: mindHistory.sender })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          eq(mindHistory.type, "inbound"),
          sql`${mindHistory.sender} != ${spiritName}`,
          sql`${mindHistory.sender} != ${name}`,
          sql`${mindHistory.sender} IS NOT NULL`,
        ),
      )
      .orderBy(desc(mindHistory.created_at))
      .limit(1);

    // Last spirit message
    const lastSpiritMsg = await db
      .select({ created_at: mindHistory.created_at })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          eq(mindHistory.type, "inbound"),
          eq(mindHistory.sender, spiritName),
        ),
      )
      .orderBy(desc(mindHistory.created_at))
      .limit(1);

    const now = Date.now();
    const activityTime = lastActivityMsg[0]
      ? parseDbTimestamp(lastActivityMsg[0].created_at).getTime()
      : 0;
    const spiritTime = lastSpiritMsg[0]
      ? parseDbTimestamp(lastSpiritMsg[0].created_at).getTime()
      : 0;
    const minutesSinceActivity = activityTime ? (now - activityTime) / 60_000 : Infinity;
    const minutesSinceSpirit = spiritTime ? (now - spiritTime) / 60_000 : Infinity;

    // No nudge needed while anyone is engaging the seed — a recent message from
    // the creator/another mind OR the spirit's own recent DM each suffice.
    // (A forced manual check reports anyway.)
    if (
      !force &&
      (minutesSinceActivity < creatorThreshold || minutesSinceSpirit < spiritThreshold)
    ) {
      return c.json({ output: "" });
    }

    // Backoff: repeated identical nudges cost the spirit a full turn each, so
    // don't re-nudge about the same seed more than once per nudgeThreshold
    // minutes. The last nudge is the spirit's most recent "Seed: <name>" event.
    if (!force) {
      // Match the nudge's leading "Seed: <name>\n" line. Mind names may contain
      // `_`, a LIKE wildcard, so escape it (and `%`/`\`) to avoid matching a
      // different seed's nudge.
      const nudgePattern = `Seed: ${name.replace(/[\\%_]/g, "\\$&")}\n%`;
      const lastNudge = await db
        .select({ created_at: mindHistory.created_at })
        .from(mindHistory)
        .where(
          and(
            eq(mindHistory.mind, spiritName),
            eq(mindHistory.type, "event"),
            sql`${mindHistory.content} LIKE ${nudgePattern} ESCAPE '\\'`,
          ),
        )
        .orderBy(desc(mindHistory.created_at))
        .limit(1);
      if (lastNudge[0]) {
        const minutesSinceNudge =
          (now - parseDbTimestamp(lastNudge[0].created_at).getTime()) / 60_000;
        if (minutesSinceNudge < nudgeThreshold) {
          return c.json({ output: "" });
        }
      }
    }

    // Collect state — shared with the sprout gate so the two always agree.
    const dir = entry.dir ?? mindDir(name);
    const { evaluateSeedChecklist } = await import("../../lib/mind/seed-readiness.js");
    const checklist = evaluateSeedChecklist(dir);

    const done: string[] = [];
    const remaining: string[] = [];
    if (checklist.soulWritten) done.push("SOUL.md written");
    else remaining.push("Write SOUL.md");
    if (checklist.memoryWritten) done.push("MEMORY.md written");
    else remaining.push("Write MEMORY.md");
    if (checklist.displayNameSet) done.push("Display name set");
    else remaining.push("Set display name");
    if (checklist.imagegenEnabled) {
      if (checklist.avatarSet) done.push("Avatar set");
      else remaining.push("Generate and set avatar");
    }

    const activityStatus =
      minutesSinceActivity === Infinity
        ? `No one has messaged ${name} yet`
        : `Last message to ${name}: ${Math.round(minutesSinceActivity)} minutes ago (from ${lastActivityMsg[0].sender})`;

    const lines = [`Seed: ${name}`, activityStatus];
    if (done.length > 0) lines.push(`Done: ${done.join(", ")}`);
    if (remaining.length > 0) lines.push(`Remaining: ${remaining.join(", ")}`);
    if (remaining.length > 0) {
      lines.push("", `DM the seed to encourage them: echo "message" | volute chat send @${name}`);
    } else {
      lines.push(
        "",
        `All checklist items complete — the seed can run \`volute seed sprout\` when ready.`,
      );
    }

    return c.json({ output: lines.join("\n") });
  })
  // Sprout a seed mind — admin or self
  .post("/:name/sprout", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage !== "seed") {
      return c.json({ error: `Mind is not a seed (stage: ${entry.stage})` }, 409);
    }
    await setMindStage(name, "sprouted");

    // Join the commons now. Seeds are deliberately kept out until they
    // sprout (backfill and the spawn path both exclude stage="seed"), so sprouting
    // is the moment a mind enters the commons. Joining here — rather than relying on
    // the incidental restart that follows — makes membership a direct consequence of
    // sprouting for every caller. Idempotent; fail-soft so a join hiccup can't block
    // the sprout itself.
    await joinCommonsChannelForMind(name).catch((err) =>
      log.warn(`failed to join the commons on sprout for ${name}`, log.errorData(err)),
    );

    // Make sprouting a visible event (#665): prompt the spirit to hand-write a
    // welcome in the commons, plus a persisted `mind_sprouted` activity event
    // (home-feed card + immediate stage-badge refresh). Fail-soft — see
    // announceSprout.
    await announceSprout(name);

    // Default autonomy: working dreaming out of the box (#581). The seed-sprout
    // CLI installs the standard skills — including dreaming — before calling
    // this endpoint, so the skill dir is present here on the normal path. The
    // mind is already running, so reload its schedules when the dream schedule
    // lands. Fail soft: sprouting must not break over dreaming wiring.
    try {
      const sproutedDir = entry.dir ?? mindDir(name);
      if (setupDefaultDreaming(sproutedDir).schedulesChanged) {
        const { getScheduler } = await import("../../lib/daemon/scheduler.js");
        getScheduler().loadSchedules(name, sproutedDir);
      }
    } catch (err) {
      log.warn(`failed to set up default dreaming for ${name}`, log.errorData(err));
    }

    // Swap the spirit's nurture schedule for the first-week arc (#582): remove
    // nurture-<name>, add one-time cues prompting the spirit to check in over
    // the mind's first days. The one-time schedules self-delete after firing.
    // A null spirit config (missing or unparseable) is left alone — writing a
    // fresh one back could destroy the spirit's profile and other schedules.
    try {
      const spiritName = getSpiritName();
      const spiritEntry = await findMind(spiritName);
      if (spiritEntry) {
        const { firstWeekSchedules, spiritDir } = await import("../../lib/mind/spirit.js");
        const sDir = spiritEntry.dir ?? spiritDir();
        const spiritConfig = readVoluteConfig(sDir);
        if (spiritConfig) {
          const schedules = (spiritConfig.schedules ?? []).filter(
            (s) => s.id !== `nurture-${name}`,
          );
          const existing = new Set(schedules.map((s) => s.id));
          schedules.push(
            ...firstWeekSchedules(name, new Date()).filter((s) => !existing.has(s.id)),
          );
          spiritConfig.schedules = schedules;
          writeVoluteConfig(sDir, spiritConfig);
          // Reload separately: if the write succeeded but the reload throws, the
          // change is on disk and takes effect on the spirit's next restart —
          // that's a different situation from the write itself failing.
          try {
            const { getScheduler } = await import("../../lib/daemon/scheduler.js");
            getScheduler().loadSchedules(spiritName, sDir);
          } catch (err) {
            log.warn(
              `spirit schedules for sprout of ${name} written to disk but not reloaded into the running scheduler (effective on next spirit restart)`,
              log.errorData(err),
            );
          }
        } else {
          log.warn(
            `spirit config at ${sDir} missing or unparseable — first-week arc for ${name} not scheduled, nurture-${name} not removed`,
          );
        }
      }
    } catch (err) {
      log.warn(`failed to update spirit schedules for sprout of ${name}`, log.errorData(err));
    }

    return c.json({ ok: true });
  })
  // Delete mind — admin only
  .delete("/:name", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const manager = getMindManager();

    // The other way to destroy a variant: `volute mind delete <variant>` lands here,
    // not on the variant-specific endpoint. Both branches below reach cleanupVariant,
    // which removes the worktree and branch a running join is still merging from — so
    // both take the same join-in-progress guard (#655). Keyed on the parent either way:
    // deleting a variant, or deleting a parent (which cleans up all of its variants).
    const joinParent = entry.parent ?? name;
    const joining = joinInProgress(joinParent);
    if (joining) {
      return c.json(
        {
          error:
            `Cannot delete ${name} while a join of ${joining.variant} into ${joinParent} is ` +
            `running (${describeJoinAge(joining)}) — deleting now would pull the worktree out ` +
            `from under the merge. Wait for the join to finish. If that age keeps growing and ` +
            `nothing lands, the join is wedged and only a daemon restart clears it.`,
        },
        409,
      );
    }

    // Variants live in a git worktree under the parent's `.variants/`, not
    // mindDir(name) — route to the same cleanup the variant-specific endpoint
    // uses so the worktree and branch aren't stranded (#650).
    if (entry.parent) {
      if (!entry.dir) return c.json({ error: `Variant ${name} has no directory` }, 500);
      const parentEntry = await findMind(entry.parent);
      if (!parentEntry) return c.json({ error: `Parent mind ${entry.parent} not found` }, 404);

      if (manager.isRunning(name)) {
        await stopMindFullService(name);
      }
      await cleanupVariant(name, entry.parent, parentEntry.dir ?? mindDir(entry.parent), entry.dir);
      invalidateMindUserCache(name);

      fireWebhook({
        event: "mind_deleted",
        mind: name,
        data: { port: entry.port, stage: entry.stage, template: entry.template },
      });

      return c.json({ ok: true, variant: true });
    }

    const dir = mindDir(name);
    const force = c.req.query("force") === "true";

    // Stop mind if running
    if (manager.isRunning(name)) {
      await stopMindFullService(name);
    }

    // Stop and clean up any running variants before deleting parent
    const variants = await findVariants(name);
    for (const s of variants) {
      if (s.dir) {
        await cleanupVariant(s.name, name, dir, s.dir, { stop: true });
      }
    }

    forgetCredentialDegraded(name);
    await removeMind(name);
    await deleteMindUser(name);
    invalidateMindUserCache(name);

    // Clean up centralized state directory (logs, env, channels)
    const state = stateDir(name);
    if (existsSync(state)) {
      rmSync(state, { recursive: true, force: true });
    }

    if (force && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      deleteIsolationUser(name);
    }

    fireWebhook({
      event: "mind_deleted",
      mind: name,
      data: { port: entry.port, stage: entry.stage, template: entry.template },
    });

    return c.json({ ok: true });
  })
  // Upgrade mind — admin only
  .post("/:name/upgrade", requireSelf(), async (c) => {
    const mindName = c.req.param("name");
    const entry = await findMind(mindName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(mindName);
    if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);

    let body: {
      template?: string;
      continue?: boolean;
      abort?: boolean;
      diff?: boolean;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine
    }

    const oldTemplate = entry.template ?? "claude";
    const template = body.template ?? oldTemplate;
    // `template` is request-controllable and flows into fs paths, composeTemplate
    // (which throws on an unknown template), and the registry — validate against
    // the known set before any of that.
    if (!isKnownTemplate(template)) {
      return c.json({ error: `Unknown template: ${template}` }, 400);
    }

    if (body.abort) {
      if (!upgradeInProgress(mindName)) {
        return c.json({ error: "No upgrade in progress" }, 400);
      }
      try {
        await abortUpgrade(mindName);
        return c.json({ ok: true });
      } catch (err) {
        log.error(`failed to abort upgrade for ${mindName}`, log.errorData(err));
        return c.json({ error: "Failed to abort upgrade" }, 500);
      }
    }

    if (body.continue) {
      if (!upgradeInProgress(mindName)) {
        return c.json({ error: "No upgrade in progress" }, 400);
      }
      try {
        const result = await continueUpgrade(mindName, { template });
        if (result.status === "conflicts") {
          return c.json({
            ok: false,
            conflicts: true,
            worktreeDir: result.worktreeDir,
            files: result.files,
            message:
              result.message ?? "Merge conflicts detected. Resolve them, then run with continue.",
          });
        }
        return c.json({ ok: true, warning: result.warning });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to merge upgrade";
        if (msg === "Unresolved conflicts remain") {
          return c.json({ error: msg }, 409);
        }
        return c.json({ error: msg }, 500);
      }
    }

    if (body.diff) {
      // Initialize git repo if missing
      if (!existsSync(resolve(dir, ".git"))) {
        return c.json({ error: "Mind has no git history — nothing to diff against" }, 400);
      }
      try {
        const diff = await upgradeDiff(mindName, template);
        return c.json({ ok: true, diff: diff || "(no changes)" });
      } catch (err) {
        log.error(`failed to generate upgrade diff for ${mindName}`, log.errorData(err));
        return c.json({ error: "Failed to generate diff" }, 500);
      }
    }

    // Fresh upgrade. A stale worktree from an orphaned prior run self-heals inside
    // runUpgrade; only a worktree that's genuinely mid-conflict-resolution 409s.
    try {
      const result = await runUpgrade(mindName, { template });
      if (result.status === "conflicts") {
        return c.json({
          ok: false,
          conflicts: true,
          worktreeDir: result.worktreeDir,
          files: result.files,
          message:
            result.message ?? "Merge conflicts detected. Resolve them, then run with continue.",
        });
      }
      return c.json({ ok: true, warning: result.warning });
    } catch (err) {
      if (err instanceof UpgradeInProgressError) {
        return c.json({ error: err.message }, 409);
      }
      log.error(`failed to merge upgrade for ${mindName}`, log.errorData(err));
      return c.json({ error: "Failed to merge upgrade" }, 500);
    }
  })
  // All conversations for a mind (across all channels)
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const user = c.get("user");
    const convs = await listConversationsForMind(name);
    // Strip lastMessage from private conversations for non-participants/non-admins.
    // Admin *authority*, like every privileged read here: the spirit qualifies only
    // on a verified admin's turn, never on its own (#433).
    const privileged = hasAdminAuthority(c.get("effective"));
    const filtered = convs.map((conv) => {
      if (conv.private !== 1) return conv;
      if (privileged) return conv;
      const userIsParticipant = conv.participants.some((p) => p.userId === user.id);
      if (userIsParticipant) return conv;
      const { lastMessage: _, ...rest } = conv;
      return rest;
    });
    return c.json(filtered);
  })
  // Read messages from a mind's conversation (privacy-enforced)
  .get(
    "/:name/conversations/:convId/messages",
    zValidator("query", cursorParamsSchema),
    async (c) => {
      const name = c.req.param("name");
      const convId = c.req.param("convId");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);
      // Verify conversation belongs to this mind
      const belongs = await isConversationForMind(name, convId);
      if (!belongs) {
        return c.json({ error: "Conversation not found" }, 404);
      }
      // Enforce privacy: if conversation is private, require participant or admin
      const conv = await getConversation(convId);
      if (!conv) {
        return c.json({ error: "Conversation not found" }, 404);
      }
      if (conv.private === 1) {
        const user = c.get("user");
        // Admin authority, like the private-conversation reads above: the spirit
        // qualifies only on a verified admin's turn, never on its own (#433).
        if (!hasAdminAuthority(c.get("effective"))) {
          const participant = await isParticipant(convId, user.id);
          if (!participant) {
            return c.json({ error: "This is a private conversation" }, 403);
          }
        }
      }
      const { before, limit } = c.req.valid("query");
      if (before === undefined && limit === undefined) {
        const msgs = await getMessages(convId);
        return c.json(cursorResponse(await withSenderDisplayNames(msgs), false));
      }
      const result = await getMessagesPaginated(convId, { before, limit });
      return c.json(cursorResponse(await withSenderDisplayNames(result.messages), result.hasMore));
    },
  )
  // Budget status
  .get("/:name/budget", requireSelf(), async (c) => {
    const name = c.req.param("name");
    // A name nobody holds must not answer as if it were an uncapped mind: every
    // lookup below returns empty for an unknown name, so without this a typo'd
    // `volute usage dizy` reports "nothing is limiting you" about no one.
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    const baseName = await getBaseName(name);
    const sb = getSpendBudget();
    const usage = sb.getUsage(baseName);
    // The install-wide cap holds minds that have no bucket of their own, so a mind with no
    // per-mind cap can still be held — report that rather than 404ing, or a host watching a
    // mind go quiet has nowhere at all to learn why.
    const hold = sb.holdFor(baseName);
    const held = await countHeldDeliveries(baseName);
    // An install-wide cap counts even before it trips: a mind under one is told about
    // it at 80% by `system_spend_warning_notice`, so answering "no budget configured"
    // here would have `volute usage` contradict a notice the mind has already read.
    const system = sb.getSystemUsage();
    if (!usage && !hold && !system && held === 0)
      return c.json({ error: "No budget configured" }, 404);
    return c.json({
      ...(usage ?? {}),
      system,
      // What a host needs to tell "this mind is broken" apart from "this mind is capped".
      held: { count: held, scope: hold?.scope ?? null, releasesAt: hold?.resetAt ?? null },
    });
  })
  // Token/cost usage over a wall-clock window. Distinct from /budget, which reports the
  // cap period — the two windows rarely line up and must not be read as one number.
  // The name is used as logged: a variant's turns are its own, not its parent's.
  .get("/:name/usage", requireSelf(), async (c) => {
    const window = readWindow(c.req.query("window"));
    if (!window) return c.json({ error: "Invalid window" }, 400);
    return c.json(await usageReport({ window, mind: c.req.param("name") }));
  })
  // Get mind config (registry + volute.json + env)
  .get("/:name/config", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(name);
    if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);

    // Read volute config (handles both claude and pi templates)
    let config = readVoluteConfig(dir);

    // For pi template, also try config.json
    if (!config && entry.template === "pi") {
      const piConfigPath = resolve(dir, "home/.config/config.json");
      if (existsSync(piConfigPath)) {
        try {
          config = JSON.parse(readFileSync(piConfigPath, "utf-8"));
        } catch {
          // ignore parse errors
        }
      }
    }

    // Read config.json for template-level settings (model fallback, compaction)
    let templateConfig: { model?: string; compaction?: { maxContextTokens?: number } } = {};
    const configJsonPath = resolve(dir, "home/.config/config.json");
    if (existsSync(configJsonPath)) {
      try {
        templateConfig = JSON.parse(readFileSync(configJsonPath, "utf-8"));
      } catch {
        // ignore parse errors
      }
    }

    return c.json({
      registry: {
        name: entry.name,
        port: entry.port,
        created: entry.created,
        stage: entry.stage,
        template: entry.template,
      },
      config: {
        model: config?.model ?? templateConfig.model ?? null,
        thinkingLevel:
          config?.thinkingLevel ?? deriveThinkingLevel(templateConfig as Record<string, unknown>),
        spendCap: config?.spendCap ?? null,
        spendCapPeriodMinutes: config?.spendCapPeriodMinutes ?? null,
        compaction: templateConfig.compaction ?? null,
        unescapeNewlines: config?.unescapeNewlines === true,
      },
    });
  })
  // Update mind config
  .put(
    "/:name/config",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        model: z.string().optional(),
        thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
        spendCap: z.number().positive().nullable().optional(),
        spendCapPeriodMinutes: z.number().int().positive().nullable().optional(),
        compaction: z
          .object({ maxContextTokens: z.number().int().positive().nullable().optional() })
          .nullable()
          .optional(),
        unescapeNewlines: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const dir = entry.dir ?? mindDir(name);
      if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);

      const body = c.req.valid("json");

      const existing = readVoluteConfig(dir) ?? {};

      if (body.model !== undefined) existing.model = body.model;
      if (body.thinkingLevel !== undefined) {
        existing.thinkingLevel = body.thinkingLevel;
      }
      if (body.spendCap !== undefined) {
        if (body.spendCap === null) {
          delete existing.spendCap;
        } else {
          existing.spendCap = body.spendCap;
        }
      }
      if (body.spendCapPeriodMinutes !== undefined) {
        if (body.spendCapPeriodMinutes === null) {
          delete existing.spendCapPeriodMinutes;
        } else {
          existing.spendCapPeriodMinutes = body.spendCapPeriodMinutes;
        }
      }
      if (body.unescapeNewlines !== undefined) {
        existing.unescapeNewlines = body.unescapeNewlines;
      }

      writeVoluteConfig(dir, existing);

      // Apply the cap to the live budget, so a host who sets one doesn't have to
      // restart the mind before it means anything.
      // Budgets are tracked per base mind. A variant writes its own volute.json but
      // has no bucket of its own, so live-applying its cap would bound the parent
      // instead — leave variants to their config file alone.
      const isBaseMind = !entry.parent;
      if (isBaseMind && (body.spendCap !== undefined || body.spendCapPeriodMinutes !== undefined)) {
        try {
          const baseName = await getBaseName(name);
          const sb = getSpendBudget();
          if (existing.spendCap)
            sb.setBudget(
              baseName,
              existing.spendCap,
              existing.spendCapPeriodMinutes ?? DEFAULT_SPEND_PERIOD_MINUTES,
            );
          else await sb.removeBudget(baseName);
        } catch (err) {
          // The config is already written; the cap takes effect at the next restart.
          log.warn(`spend cap for ${name} saved but not applied live`, log.errorData(err));
        }
      }

      if (body.unescapeNewlines !== undefined) {
        const { clearEchoTextCache } = await import("../../lib/delivery/echo-text.js");
        clearEchoTextCache(name);
      }

      // Write template-level settings to config.json
      // Templates read thinking/model/compaction from config.json, not volute.json
      const needsConfigJson =
        body.model !== undefined ||
        body.thinkingLevel !== undefined ||
        body.compaction !== undefined;

      if (needsConfigJson) {
        const configJsonPath = resolve(dir, "home/.config/config.json");
        let templateConfig: Record<string, unknown> = {};
        if (existsSync(configJsonPath)) {
          try {
            templateConfig = JSON.parse(readFileSync(configJsonPath, "utf-8"));
          } catch {
            // start fresh
          }
        }

        if (body.model !== undefined) {
          templateConfig.model = body.model;
        }

        // Thinking level maps onto each template's own config shape.
        if (body.thinkingLevel !== undefined) {
          applyThinkingLevel(templateConfig, entry.template ?? "claude", body.thinkingLevel);
        }

        if (body.compaction !== undefined) {
          if (body.compaction === null) {
            delete templateConfig.compaction;
          } else {
            const comp = (templateConfig.compaction ?? {}) as Record<string, unknown>;
            if (body.compaction.maxContextTokens === null) {
              delete comp.maxContextTokens;
            } else if (body.compaction.maxContextTokens !== undefined) {
              comp.maxContextTokens = body.compaction.maxContextTokens;
            }
            templateConfig.compaction = comp;
          }
        }

        writeFileSync(configJsonPath, `${JSON.stringify(templateConfig, null, 2)}\n`);
      }

      // Sync spirit model to global config so syncSpiritTemplate() stays consistent
      if (entry.mindType === "spirit" && body.model !== undefined) {
        try {
          const { readGlobalConfig, writeGlobalConfig } = await import("../../lib/config/setup.js");
          const globalConfig = readGlobalConfig();
          globalConfig.spiritModel = body.model;
          writeGlobalConfig(globalConfig);
        } catch (err) {
          log.warn("failed to sync spirit model to global config", log.errorData(err));
        }
      }

      return c.json({ ok: true });
    },
  )
  // Get pending/gated delivery messages
  .get("/:name/delivery/pending", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    try {
      const pending = await getDeliveryManager().getPending(baseName);
      return c.json(pending);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not initialized")) {
        return c.json([]);
      }
      log.error(`failed to get pending deliveries for ${baseName}`, log.errorData(err));
      return c.json({ error: "Failed to retrieve pending messages" }, 500);
    }
  })
  // Decline an unrouted (gated) channel: stops invites and archives the held backlog.
  // The channel is passed in the body (not the path) since channel slugs can contain
  // slashes (e.g. "discord:server/general") that a path param can't carry.
  .post(
    "/:name/gates/decline",
    requireSelf(),
    zValidator("json", z.object({ channel: z.string() })),
    async (c) => {
      const name = c.req.param("name");
      const channel = c.req.valid("json").channel.trim();
      if (!channel) return c.json({ error: "channel required" }, 400);
      try {
        const archived = await getDeliveryManager().declineChannel(name, channel);
        return c.json({ ok: true, channel, archived });
      } catch (err) {
        if (err instanceof Error && err.message.includes("not initialized")) {
          return c.json({ error: "Delivery manager not available" }, 503);
        }
        // A name that matches no real channel is caller error, not a server fault.
        if (err instanceof UnknownChannelError) return c.json({ error: err.message }, 400);
        log.error(`failed to decline channel ${channel} for ${name}`, log.errorData(err));
        return c.json({ error: "Failed to decline channel" }, 500);
      }
    },
  )
  // Accept an unrouted (gated) channel: adds a routing rule and releases the held backlog
  // immediately. Channel is in the body for the same reason as decline (slugs contain slashes).
  .post(
    "/:name/gates/accept",
    requireSelf(),
    zValidator("json", z.object({ channel: z.string(), thread: z.string().optional() })),
    async (c) => {
      const name = c.req.param("name");
      const body = c.req.valid("json");
      const channel = body.channel.trim();
      if (!channel) return c.json({ error: "channel required" }, 400);
      // Accept writes to the mind's home directory — refuse rather than fabricate a path.
      if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
      try {
        const result = await getDeliveryManager().acceptChannel(name, channel, body.thread?.trim());
        return c.json({ ok: true, channel, ...result });
      } catch (err) {
        if (err instanceof Error && err.message.includes("not initialized")) {
          return c.json({ error: "Delivery manager not available" }, 503);
        }
        if (err instanceof Error && err.message.includes("malformed")) {
          return c.json({ error: err.message }, 409);
        }
        // A name that matches no real channel is caller error, not a server fault.
        if (err instanceof UnknownChannelError) return c.json({ error: err.message }, 400);
        log.error(`failed to accept channel ${channel} for ${name}`, log.errorData(err));
        return c.json({ error: "Failed to accept channel" }, 500);
      }
    },
  )
  // Read the messages held on a gated channel, without changing anything. Gated rows have no
  // conversation, so `volute chat read` can't reach them.
  .get("/:name/gates/peek", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel")?.trim();
    if (!channel) return c.json({ error: "channel required" }, 400);
    try {
      return c.json(await getDeliveryManager().peekChannel(name, channel));
    } catch (err) {
      // Never answer "nothing is held" for a subsystem that simply isn't up — a mind
      // checking whether messages are stranded would read that as a confident no.
      if (err instanceof Error && err.message.includes("not initialized")) {
        return c.json({ error: "Delivery manager not available" }, 503);
      }
      log.error(`failed to peek channel ${channel} for ${name}`, log.errorData(err));
      return c.json({ error: "Failed to read held messages" }, 500);
    }
  })
  // AI completion proxy for minds
  .post(
    "/:name/ai/complete",
    requireSelf(),
    zValidator(
      "json",
      z.object({ systemPrompt: z.string(), message: z.string(), model: z.string().optional() }),
    ),
    async (c) => {
      const body = c.req.valid("json");
      if (!body.systemPrompt || !body.message) {
        return c.json({ error: "systemPrompt and message required" }, 400);
      }
      const { aiComplete: aiCompleteFn, isAiConfigured } = await import("../../lib/ai-service.js");
      if (!isAiConfigured()) {
        return c.json({ error: "AI service not configured" }, 503);
      }
      const text = await aiCompleteFn(body.systemPrompt, body.message, body.model);
      if (text == null) {
        return c.json({ error: "AI completion failed" }, 502);
      }
      return c.json({ text });
    },
  )
  // Receive events from mind, persist to mind_history, publish to pub-sub
  .post(
    "/:name/events",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        type: z.string(),
        session: z.string().optional(),
        channel: z.string().optional(),
        messageId: z.string().optional(),
        content: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const baseName = await getBaseName(name);

      const body = c.req.valid("json");

      if (!body.type) {
        return c.json({ error: "type required" }, 400);
      }
      if (DAEMON_AUTHORED_TYPES.has(body.type)) {
        return c.json({ error: `type "${body.type}" is daemon-authored` }, 400);
      }

      await handleMindEvent(baseName, body);

      return c.json({ ok: true });
    },
  )
  // SSE endpoint for mind events
  .get("/:name/events", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);

    const entry = await findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    // Parse optional filters from query params
    const typeFilter = c.req.query("type")?.split(",").filter(Boolean);
    const sessionFilter = c.req.query("session");
    const channelFilter = c.req.query("channel");

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        // Keep-alive ping every 15s to prevent silent connection drops
        let unsubscribe: (() => void) | undefined;
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(pingInterval);
            unsubscribe?.();
          }
        }, 15000);

        unsubscribe = subscribeMindEvent(baseName, (event) => {
          // Apply filters
          if (typeFilter && !typeFilter.includes(event.type)) return;
          if (sessionFilter && event.session !== sessionFilter) return;
          if (channelFilter && event.channel !== channelFilter) return;

          try {
            send(JSON.stringify(event));
          } catch {
            clearInterval(pingInterval);
            unsubscribe?.();
          }
        });

        // Clean up on close
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  })
  // Persist external channel send to mind_history
  .post(
    "/:name/history",
    requireSelf(),
    zValidator(
      "json",
      z.object({ channel: z.string(), content: z.string(), sender: z.string().optional() }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const baseName = await getBaseName(name);

      const body = c.req.valid("json");

      if (!body.channel || !body.content) {
        return c.json({ error: "channel and content required" }, 400);
      }

      // Best-effort turn lookup for external bridge sends (these don't go through
      // volute chat send, so they won't have tool_result correlation markers).
      const mindSession = c.get("mindSession");
      const outboundTurnId = getActiveTurnId(baseName, mindSession);

      const db = await getDb();
      try {
        await db.insert(mindHistory).values({
          mind: baseName,
          type: "outbound",
          channel: body.channel,
          sender: body.sender ?? baseName,
          content: body.content,
          turn_id: outboundTurnId ?? null,
        });
      } catch (err) {
        log.error(`failed to persist external send for ${baseName}`, log.errorData(err));
        return c.json({ error: "Failed to persist" }, 500);
      }

      return c.json({ ok: true });
    },
  )
  // Get sessions summary
  .get("/:name/history/sessions", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .select({
        thread: mindHistory.thread,
        started_at: sql<string>`MIN(${mindHistory.created_at})`,
        event_count: sql<number>`COUNT(*)`,
        message_count: sql<number>`SUM(CASE WHEN ${mindHistory.type} IN ('inbound','outbound') THEN 1 ELSE 0 END)`,
        tool_count: sql<number>`SUM(CASE WHEN ${mindHistory.type}='tool_use' THEN 1 ELSE 0 END)`,
      })
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, name), sql`${mindHistory.thread} IS NOT NULL`))
      .groupBy(mindHistory.thread)
      .orderBy(sql`MIN(${mindHistory.created_at}) DESC`);
    return c.json(rows);
  })
  // Get message history
  .get("/:name/history/channels", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .selectDistinct({ channel: mindHistory.channel })
      .from(mindHistory)
      .where(eq(mindHistory.mind, name));
    return c.json(rows.map((r) => r.channel));
  })
  // Freshness-independent "who has this mind talked to lately" view. Reads raw
  // mind_history (NOT the rolled-up summaries table), so it never trails the
  // summarizer — the spirit uses it while tending so a first-week cue doesn't
  // suggest a mind greet a neighbor it has been DMing for the last 20 minutes.
  // Aggregates inbound/outbound rows per channel over a recent window.
  .get("/:name/history/contacts", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");
    // A malformed `hours` used to fall back to 48 and report "last 48h" for a window
    // nobody asked for; `?hours=1e9` used to parse as 1. Refuse both (#970 class).
    const hours = boundedIntParam(c.req.query("hours"), CONTACTS_HOURS);
    if (hours === null) return c.json({ error: intParamError("hours", CONTACTS_HOURS) }, 400);
    const cutoff = new Date(Date.now() - hours * 3600_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const db = await getDb();
    const contacts = await db
      .select({
        channel: mindHistory.channel,
        last_at: sql<string>`MAX(${mindHistory.created_at})`,
        last_inbound_at: sql<
          string | null
        >`MAX(CASE WHEN ${mindHistory.type} = 'inbound' THEN ${mindHistory.created_at} END)`,
        last_outbound_at: sql<
          string | null
        >`MAX(CASE WHEN ${mindHistory.type} = 'outbound' THEN ${mindHistory.created_at} END)`,
        message_count: sql<number>`COUNT(*)`,
        // The counterparty: most recent inbound sender on this channel. For a
        // DM the channel name already carries it (e.g. @atlas), but this also
        // covers shared channels (#system) and rows where the channel is opaque.
        last_sender: sql<string | null>`(
          SELECT sender FROM mind_history h2
          WHERE h2.mind = ${name}
            AND h2.channel = ${mindHistory.channel}
            AND h2.type = 'inbound'
            AND h2.sender IS NOT NULL
          ORDER BY h2.created_at DESC, h2.id DESC LIMIT 1
        )`,
      })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          sql`${mindHistory.type} IN ('inbound','outbound')`,
          sql`${mindHistory.channel} IS NOT NULL`,
          sql`${mindHistory.created_at} >= ${cutoff}`,
        ),
      )
      .groupBy(mindHistory.channel)
      .orderBy(sql`MAX(${mindHistory.created_at}) DESC`);

    return c.json({ hours, contacts });
  })
  .get("/:name/history/export", requireSelf(), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
    return c.json(rows);
  })
  .get("/:name/history/turn", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const turnId = c.req.query("turn_id");
    const detail = c.req.query("detail") === "1";

    const db = await getDb();

    const typeFilter = detail
      ? undefined
      : sql`${mindHistory.type} IN ('inbound','event','outbound','tool_use','tool_result','text','thinking','activity')`;

    if (!turnId) {
      return c.json({ error: "turn_id required" }, 400);
    }

    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, name), eq(mindHistory.turn_id, turnId), typeFilter))
      .orderBy(mindHistory.id);

    // These rows render through the same timeline components as GET /:name/history, so they
    // need the same sender annotation — without it an expanded turn drops back to the bare
    // handle while the row above it shows the display name (#1024).
    const displayNames = await getDisplayNames(rows.map((r) => r.sender));
    return c.json(
      rows.map((r) => ({
        ...r,
        sender_display_name: r.sender ? (displayNames.get(r.sender) ?? null) : null,
      })),
    );
  })
  .get("/:name/history/cross-session", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const currentSession = c.req.query("session");

    const db = await getDb();

    // Find the "since" timestamp: the start of the last turn in the current session.
    // This ensures we capture activity that happened during the current turn, not just after it.
    let sinceTimestamp: string | null = null;

    if (currentSession) {
      // Get the first event of the last turn in the current session
      const lastTurn = await db
        .select({ turn_id: mindHistory.turn_id })
        .from(mindHistory)
        .where(
          and(
            eq(mindHistory.mind, name),
            eq(mindHistory.thread, currentSession),
            sql`${mindHistory.turn_id} IS NOT NULL`,
          ),
        )
        .orderBy(desc(mindHistory.created_at))
        .limit(1);

      if (lastTurn.length > 0 && lastTurn[0].turn_id) {
        const firstEvent = await db
          .select({ created_at: mindHistory.created_at })
          .from(mindHistory)
          .where(eq(mindHistory.turn_id, lastTurn[0].turn_id))
          .orderBy(mindHistory.created_at)
          .limit(1);

        if (firstEvent.length > 0) {
          sinceTimestamp = firstEvent[0].created_at;
        }
      }
    }

    // Fall back to last 1h if no prior events (first message in session)
    if (!sinceTimestamp) {
      sinceTimestamp = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    }

    // Query turn summaries from other sessions since the timestamp
    const conditions = [
      eq(summaries.mind, name),
      eq(summaries.period, "turn"),
      sql`${summaries.created_at} > ${sinceTimestamp}`,
    ];
    if (currentSession) {
      conditions.push(sql`${turns.thread} != ${currentSession}`);
    }

    const rows = await db
      .select({
        thread: turns.thread,
        content: summaries.content,
        created_at: summaries.created_at,
      })
      .from(summaries)
      .innerJoin(turns, eq(turns.id, summaries.period_key))
      .where(and(...conditions))
      .orderBy(desc(summaries.created_at))
      .limit(50);

    if (rows.length === 0) {
      return c.json({ context: null });
    }

    // Format as [Session Activity] block
    const lines = rows.map((row) => {
      const ts = parseDbTimestamp(row.created_at);
      const ago = formatTimeAgo(ts);
      return `- ${row.thread ?? "unknown"} (${ago}): ${row.content ?? ""}`;
    });

    return c.json({ context: `[Session Activity]\n${lines.join("\n")}` });
  })
  // Drain undelivered failure notices for a session. The pre-prompt hook calls this to
  // whisper prior failures into the mind's next turn. Does not delete them (the DB rows
  // are only removed once a turn completes cleanly, see TurnLifecycle); it records an
  // in-memory drain watermark (setNoticeDrainWatermark) so that clean turn clears these.
  .get("/:name/history/notices", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const session = c.req.query("session");
    if (!session) return c.json({ context: null, notices: [] });

    const notices = await drainEvents(baseName, session);
    if (notices.length === 0) return c.json({ context: null, notices: [] });

    // Remember the high-water id so a clean turn clears exactly these.
    const maxId = notices.reduce((m, n) => Math.max(m, n.id), 0);
    setNoticeDrainWatermark(baseName, session, maxId);

    return c.json({ context: formatEvents(notices), notices });
  })
  // Ambient turn context contributed by extensions — "here is what's around", as
  // opposed to the directed notices drained above. The pre-prompt hook calls this with
  // reason=turn; the wake path collects reason=wake daemon-side in SleepManager.
  //
  // The daemon owns the budget: collectTurnContext enforces a total cap across all
  // extensions and drops any that throws, hangs, or overruns. `context: null` — nothing
  // is around — is the normal response.
  .get("/:name/turn-context", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const reason = c.req.query("reason") === "wake" ? "wake" : "turn";
    return c.json({ context: await collectTurnContext(baseName, reason) });
  })
  // Record a notice for a mind (mind → daemon). Templates use this to surface
  // context-loss the daemon can't see (missing session file, compaction failure) so
  // it lands in the same next-turn notices drain as daemon-recorded failures (#367).
  // A `thread` scopes the notice to that thread's drain; omitted → mind-level
  // (drained by whichever thread next runs a turn).
  //
  // Deliberately narrower than NOTICE_KINDS: crash/turn_error/startup feed
  // latestFailureEvent (the host's "last turn failed" surface) and budget becomes a
  // budget event — daemon-authored semantics a mind must not be able to forge about
  // itself (mirrors the DAEMON_AUTHORED_TYPES guard on POST /:name/events).
  .post(
    "/:name/notices",
    requireSelf(),
    // Deliberately narrower than NOTICE_KINDS: only these three are mind-postable
    // (see the route comment) — the enum enforces that a mind can't forge a
    // daemon-authored kind about itself. All three are a mind reporting on its own
    // process, so forging one gains it nothing.
    zValidator(
      "json",
      z.object({
        kind: z.enum(["context_lost", "delivery_failed", "identity_reload"]),
        message: z.string(),
        thread: z.string().optional(),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const baseName = await getBaseName(name);

      const body = c.req.valid("json");
      const message = body.message.trim();
      if (!message) return c.json({ error: "message is required" }, 400);

      await recordNotice({
        mind: baseName,
        thread: body.thread ?? MIND_LEVEL_THREAD,
        kind: body.kind,
        reason: body.kind,
        // Bound the size (the body is injected into turn context) without dropping
        // the notice — a truncated explanation beats a silent 400.
        detail: message.length > 4000 ? `${message.slice(0, 4000)}…` : message,
      });
      return c.json({ ok: true });
    },
  )
  // List system events for a mind (schedule fires, wake summaries, lifecycle, notices…)
  // with their reflections. Self-or-admin only. Named /system-events because
  // GET /:name/events is the live SSE stream above.
  .get("/:name/system-events", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const limit = boundedIntParam(c.req.query("limit"), EVENTS_LIMIT);
    if (limit === null) return c.json({ error: intParamError("limit", EVENTS_LIMIT) }, 400);
    // `Number("notanumber")` is NaN, and `id < NaN` matches nothing — a malformed cursor
    // used to return an empty page that reads exactly like "no more events".
    const before = parseIntParam(c.req.query("before"));
    if (before === null) return c.json({ error: "before must be a non-negative integer" }, 400);
    const events = await listEvents(baseName, limit, before);
    return c.json({
      events: events.map((e) => {
        // parseMeta tolerates corrupt rows — one bad row must not 500 the listing.
        const meta = parseMeta(e.meta, `event ${e.id}`);
        return {
          id: e.id,
          type: e.type,
          label: eventLabel(e.type, meta),
          body: e.body,
          meta,
          delivery: e.delivery,
          reflection: e.reflection,
          created_at: e.created_at,
          delivered_at: e.delivered_at,
        };
      }),
    });
  })
  // Supersede provisional turn summaries with the mind's own words. Self-or-admin only.
  .put(
    "/:name/turn-summaries",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        summaries: z
          .array(z.object({ turnId: z.string().min(1), content: z.string() }))
          .min(1, "summaries must be a non-empty array"),
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const baseName = await getBaseName(name);

      const items = c.req.valid("json").summaries;

      let updated = 0;
      let created = 0;
      for (const item of items) {
        const result = await supersedeTurnSummary(baseName, item.turnId, item.content);
        switch (result.status) {
          case "invalid":
            return c.json({ error: result.error }, 400);
          case "not_found":
            return c.json({ error: "Turn not found" }, 404);
          case "forbidden":
            return c.json({ error: "Forbidden" }, 403);
          case "ok":
            if (result.created) created++;
            else updated++;
            break;
        }
      }

      return c.json({ ok: true, updated, created });
    },
  )
  .get("/:name/history", requireSelfOrSpirit(), async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const session = c.req.query("session");
    // `from`/`to` used to be accepted by the CLI and forwarded nowhere, so a mind that
    // asked for one day got its whole history back and had no way to tell (#907 class).
    // A malformed bound is refused rather than dropped, for the same reason.
    let fromBound: string;
    let toBound: string;
    try {
      fromBound = normalizeDbBound(c.req.query("from"), "start");
      toBound = normalizeDbBound(c.req.query("to"), "end");
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const full = c.req.query("full") === "true";
    const preset = c.req.query("preset") as
      | "summary"
      | "conversation"
      | "detailed"
      | "all"
      | undefined;
    const limit = boundedIntParam(c.req.query("limit"), HISTORY_LIMIT);
    if (limit === null) return c.json({ error: intParamError("limit", HISTORY_LIMIT) }, 400);
    const offset = boundedIntParam(c.req.query("offset"), OFFSET);
    if (offset === null) return c.json({ error: intParamError("offset", OFFSET) }, 400);
    // Summary preset only: keep just turn summaries the mind hasn't rewritten yet.
    const provisional = c.req.query("provisional") === "true";

    const db = await getDb();
    const conditions = [eq(mindHistory.mind, name)];
    if (fromBound) conditions.push(gte(mindHistory.created_at, fromBound));
    if (toBound) conditions.push(lte(mindHistory.created_at, toBound));
    if (channel) {
      conditions.push(eq(mindHistory.channel, channel));
    }
    if (session) {
      conditions.push(eq(mindHistory.thread, session));
    }

    // Preset-based type filtering
    const effectivePreset = full ? "all" : preset;

    // Default "summary" preset reads from the unified summaries table
    if (!effectivePreset || effectivePreset === "summary") {
      const sumConditions: SQL[] = [eq(summaries.mind, name), eq(summaries.period, "turn")];
      if (fromBound) sumConditions.push(gte(summaries.created_at, fromBound));
      if (toBound) sumConditions.push(lte(summaries.created_at, toBound));
      if (provisional) {
        // Turn summaries the mind hasn't rewritten: metadata.author absent or not "mind".
        // `IS NOT` is null-safe, so rows with no author (the summarizer's) match; the path
        // literal is constant and the compared value is bound, so no injection surface.
        sumConditions.push(sql`json_extract(${summaries.metadata}, '$.author') is not ${"mind"}`);
      }

      if (session) {
        sumConditions.push(eq(turns.thread, session));
        const sumRows = await db
          .select({
            id: summaries.id,
            mind: summaries.mind,
            period: summaries.period,
            period_key: summaries.period_key,
            content: summaries.content,
            metadata: summaries.metadata,
            created_at: summaries.created_at,
            thread: turns.thread,
          })
          .from(summaries)
          .innerJoin(turns, eq(turns.id, summaries.period_key))
          .where(and(...sumConditions))
          .orderBy(desc(summaries.created_at))
          .limit(limit)
          .offset(offset);
        return c.json(
          sumRows.map((r) => ({
            id: r.id,
            mind: r.mind,
            type: "summary",
            channel: null,
            thread: r.thread,
            sender: null,
            // A summary has no sender, so no display name either — but the key is present
            // on every row shape this endpoint returns, so clients can read it uniformly.
            sender_display_name: null,
            message_id: null,
            content: r.content,
            metadata: r.metadata,
            turn_id: r.period_key,
            created_at: r.created_at,
          })),
        );
      }

      const sumRows = await db
        .select()
        .from(summaries)
        .where(and(...sumConditions))
        .orderBy(desc(summaries.created_at))
        .limit(limit)
        .offset(offset);
      return c.json(
        sumRows.map((r) => ({
          id: r.id,
          mind: r.mind,
          type: "summary",
          channel: null,
          thread: null,
          sender: null,
          sender_display_name: null,
          message_id: null,
          content: r.content,
          metadata: r.metadata,
          turn_id: r.period_key,
          created_at: r.created_at,
        })),
      );
    }

    switch (effectivePreset) {
      case "all":
        // No type filter
        break;
      case "conversation":
        conditions.push(sql`${mindHistory.type} IN ('inbound','event','outbound','tool_use')`);
        break;
      case "detailed":
        conditions.push(
          sql`${mindHistory.type} IN ('inbound','event','outbound','tool_use','tool_result','text','thinking')`,
        );
        break;
    }

    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(...conditions))
      .orderBy(desc(mindHistory.created_at))
      .limit(limit)
      .offset(offset);

    const displayNames = await getDisplayNames(rows.map((r) => r.sender));
    return c.json(
      rows.map((r) => ({
        ...r,
        sender_display_name: r.sender ? (displayNames.get(r.sender) ?? null) : null,
      })),
    );
  });

export default app;
