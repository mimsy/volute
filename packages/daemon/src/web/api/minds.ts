import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  isAiConfigured,
  missingCredentialWarning,
  qualifyModelId,
  resolveTemplate,
  unqualifyModelId,
} from "../../lib/ai-service.js";
import { deleteMindUser, getDisplayNames, withSenderDisplayNames } from "../../lib/auth.js";
import {
  announceSprout,
  announceToSystem,
  joinSystemChannelForMind,
} from "../../lib/chat/system-channel.js";
import {
  drainEvents,
  eventLabel,
  formatEvents,
  latestEvent,
  latestFailureEvent,
  listEvents,
  parseMeta,
  recordNotice,
} from "../../lib/chat/system-events.js";
import { getSpiritName } from "../../lib/config/setup.js";
import { readSystemsConfig } from "../../lib/config/systems-config.js";
import { getMindManager, MindStartupError } from "../../lib/daemon/mind-manager.js";
// Lifecycle functions from mind-service.ts
import {
  startMindFull as startMindFullService,
  stopMindFull as stopMindFullService,
} from "../../lib/daemon/mind-service.js";
import { getTokenBudget } from "../../lib/daemon/token-budget.js";
import { handleMindEvent, setNoticeDrainWatermark } from "../../lib/daemon/turn-lifecycle.js";
import { getActiveTurnId } from "../../lib/daemon/turn-tracker.js";
import { getDb } from "../../lib/db.js";
import { getDeliveryManager } from "../../lib/delivery/delivery-manager.js";
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
import { type ExportManifest, isHomeOnlyArchive } from "../../lib/mind/archive.js";
import { consolidateMemory } from "../../lib/mind/consolidate.js";
import { defaultHeartbeatSchedule, setupDefaultDreaming } from "../../lib/mind/default-autonomy.js";
import { generateIdentity, publishPublicKey } from "../../lib/mind/identity.js";
import {
  chownMindDir,
  createMindUser,
  deleteMindUser as deleteIsolationUser,
  ensureVoluteGroup,
  isIsolationEnabled,
} from "../../lib/mind/isolation.js";
import { commitSrcChanges, rollbackSrcChanges } from "../../lib/mind/last-known-good.js";
import { npmInstallAsMind, npmInstallNeeded } from "../../lib/mind/npm-install.js";
import {
  addMind,
  countCappedMinds,
  ensureVoluteHome,
  findMind,
  findVariants,
  getBaseName,
  type MindEntry,
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  setMindStage,
  setMindTemplate,
  setMindTemplateHash,
  stateDir,
  validateMindName,
} from "../../lib/mind/registry.js";
import { evaluateSeedChecklist } from "../../lib/mind/seed-readiness.js";
import { isTemplateStale } from "../../lib/mind/template-staleness.js";
import { applyThinkingLevel, deriveThinkingLevel } from "../../lib/mind/thinking-config.js";
import { cleanupVariant } from "../../lib/mind/variant-cleanup.js";
import { mergeVariantExcludingMemory, validateBranchName } from "../../lib/mind/variants.js";
import { readVoluteConfig, writeVoluteConfig } from "../../lib/mind/volute-config.js";
import { PLATFORMS } from "../../lib/platforms.js";
import {
  getMindPromptDefaults,
  getPrompt,
  getPromptIfCustom,
  substitute,
} from "../../lib/prompts.js";
import { mindHistory, summaries, turns } from "../../lib/schema.js";
import {
  createImagegenJob,
  getImagegenJob,
  waitForImagegenJob,
} from "../../lib/services/imagegen-jobs.js";
import {
  getStandardSkillsWithExtensions,
  installSkill,
  migrateSkillsToTemplate,
  SEED_SKILLS,
} from "../../lib/skills.js";
import { convertSession } from "../../lib/template/convert-session.js";
import {
  findOpenClawSession,
  importOpenClawConnectors,
  importPiSession,
  parseNameFromIdentity,
} from "../../lib/template/import-utils.js";
import {
  applyInitFiles,
  applyTemplateHomeFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  isKnownTemplate,
  listFiles,
  type TemplateManifest,
} from "../../lib/template/template.js";
import { computeTemplateHash } from "../../lib/template/template-hash.js";
import { gitExec } from "../../lib/util/exec.js";
import { checkHealth } from "../../lib/util/health.js";
import log from "../../lib/util/logger.js";
import { safeResolveWithinBase } from "../../lib/util/paths.js";
import { parseDbTimestamp } from "../../lib/util/time.js";
import { fireWebhook } from "../../lib/webhook.js";
import {
  type AuthEnv,
  invalidateMindUserCache,
  requireAdmin,
  requireAdminOrSystem,
  requireSelf,
} from "../middleware/auth.js";

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

  return {
    status,
    wakeAt,
    lastError,
    channels,
    displayName: config?.profile?.displayName,
    description: config?.profile?.description,
    avatar: config?.profile?.avatar,
    seedChecklist,
  };
}

type MindStatus = Awaited<ReturnType<typeof getMindStatus>>;

/** True for the daemon's own privileged principals: admin users and the system spirit. */
function isPrivileged(c: Context<AuthEnv>): boolean {
  const role = c.get("user").role;
  return role === "admin" || role === "system";
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
    channels: status.channels,
    displayName: status.displayName,
    description: status.description,
    avatar: status.avatar,
    seedChecklist: status.seedChecklist,
    hasPages: extras.hasPages,
    lastActiveAt: extras.lastActiveAt ?? null,
  };
}

const TEMPLATE_BRANCH = "volute/template";

/** Configure per-repo git identity for a mind: name = mind name, email = [mind].[system]@volute.systems. */
async function configureGitIdentity(
  mindName: string,
  opts: { cwd: string; mindName?: string; env?: NodeJS.ProcessEnv },
) {
  const systemsConfig = readSystemsConfig();
  const system = systemsConfig?.system ?? "local";
  await gitExec(["config", "user.name", mindName], opts);
  await gitExec(["config", "user.email", `${mindName}.${system}@volute.systems`], opts);
}

/**
 * Create the volute/template tracking branch and main branch with shared history.
 * Enables clean 3-way merges on the first `volute mind upgrade`.
 */
async function initTemplateBranch(
  projectRoot: string,
  composedDir: string,
  manifest: TemplateManifest,
  mindName?: string,
  env?: NodeJS.ProcessEnv,
) {
  const templateFiles = listFiles(composedDir)
    .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
    .filter((f) => (!f.startsWith("home/") && !f.startsWith("home\\")) || f === "home/VOLUTE.md")
    .map((f) => manifest.rename[f] ?? f);

  const opts = { cwd: projectRoot, mindName, env };

  await gitExec(["checkout", "--orphan", TEMPLATE_BRANCH], opts);
  await gitExec(["add", "--", ...templateFiles], opts);
  await gitExec(["commit", "-m", "template update"], opts);

  await gitExec(["checkout", "-b", "main"], opts);
  await gitExec(["add", "-A"], opts);
  await gitExec(["commit", "-m", "initial commit"], opts);
}

/**
 * Update the volute/template orphan branch with the latest template files.
 * Uses a temporary worktree to avoid touching the main working directory.
 */
async function updateTemplateBranch(projectRoot: string, template: string, mindName: string) {
  const tempWorktree = resolve(projectRoot, ".variants", "_template_update");

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", TEMPLATE_BRANCH], { cwd: projectRoot });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // Clean up any existing temp worktree
  try {
    await gitExec(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
  } catch {
    // doesn't exist
  }
  if (existsSync(tempWorktree)) {
    rmSync(tempWorktree, { recursive: true, force: true });
  }

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    if (branchExists) {
      await gitExec(["worktree", "add", tempWorktree, TEMPLATE_BRANCH], {
        cwd: projectRoot,
      });
    } else {
      await gitExec(["worktree", "add", "--detach", tempWorktree], { cwd: projectRoot });
      await gitExec(["checkout", "--orphan", TEMPLATE_BRANCH], { cwd: tempWorktree });
      await gitExec(["rm", "-rf", "--cached", "."], { cwd: tempWorktree });
      await gitExec(["clean", "-fd"], { cwd: tempWorktree });
    }

    if (branchExists) {
      await gitExec(["rm", "-rf", "."], { cwd: tempWorktree }).catch(() => {});
    }

    copyTemplateToDir(composedDir, tempWorktree, mindName, manifest);

    const initDir = resolve(tempWorktree, ".init");
    if (existsSync(initDir)) {
      rmSync(initDir, { recursive: true, force: true });
    }

    // Remove home files except VOLUTE.md — template branch should only track infrastructure
    const homeDir = resolve(tempWorktree, "home");
    if (existsSync(homeDir)) {
      for (const entry of readdirSync(homeDir)) {
        if (entry !== "VOLUTE.md") {
          rmSync(resolve(homeDir, entry), { recursive: true, force: true });
        }
      }
    }

    await gitExec(["add", "-A"], { cwd: tempWorktree });

    try {
      await gitExec(["diff", "--cached", "--quiet"], { cwd: tempWorktree });
    } catch {
      await gitExec(["commit", "-m", "template update"], { cwd: tempWorktree });
    }
  } finally {
    try {
      await gitExec(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
    } catch {
      // best effort cleanup
    }
    if (existsSync(tempWorktree)) {
      rmSync(tempWorktree, { recursive: true, force: true });
    }
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Merge the template branch into the current worktree.
 * Returns true if there are merge conflicts.
 */
async function mergeTemplateBranch(worktreeDir: string): Promise<boolean> {
  try {
    await gitExec(
      ["merge", TEMPLATE_BRANCH, "--allow-unrelated-histories", "-m", "merge template update"],
      { cwd: worktreeDir },
    );
    return false;
  } catch (e: unknown) {
    try {
      const status = await gitExec(["status", "--porcelain"], { cwd: worktreeDir });
      const hasConflictMarkers = status
        .split("\n")
        .some((line) => line.startsWith("UU") || line.startsWith("AA"));
      if (hasConflictMarkers) return true;
    } catch {
      // fall through to rethrow
    }
    throw e;
  }
}

/**
 * Merge the upgrade branch back into main, clean up, install deps, and restart.
 * Returns { ok, warning? } on success, throws on merge failure.
 */
async function mergeUpgradeAndRestart(
  mindName: string,
  dir: string,
  worktreeDir: string,
  upgradeVariantName: string,
  upgradeBranch: string,
  template: string,
  oldTemplate: string,
): Promise<{ ok: true; warning?: string }> {
  const templateChanged = template !== oldTemplate;
  // Auto-commit any uncommitted changes in main worktree
  const mainStatus = (await gitExec(["status", "--porcelain"], { cwd: dir })).trim();
  if (mainStatus) {
    await gitExec(["add", "-A"], { cwd: dir });
    await gitExec(["commit", "-m", "Auto-commit before upgrade merge"], { cwd: dir });
  }

  const preMergeHead = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();
  await gitExec(["merge", upgradeBranch], { cwd: dir });

  // Merge succeeded — everything below is best-effort cleanup/restart
  try {
    await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir);
  } catch (err) {
    log.warn(`failed to clean up upgrade worktree for ${mindName}`, log.errorData(err));
  }
  try {
    await gitExec(["branch", "-D", upgradeBranch], { cwd: dir });
  } catch {
    // branch may already be deleted by cleanupVariant
  }

  // On an actual template switch, swap the template-owned home/ files (mechanics
  // doc, .claude/settings.json, config.json) which the merge never touches. This
  // must succeed *before* the DB template field is advanced: that field drives
  // credential injection at spawn (mind-manager), so it has to stay consistent
  // with the on-disk config. On failure, leave the field at oldTemplate and
  // surface the failure rather than reporting a clean success.
  let switchWarning: string | undefined;
  if (templateChanged) {
    try {
      applyTemplateHomeFiles(resolve(dir, "home"), template);
      // Move installed skills into the new template's skills dir and regenerate
      // their shims, so they aren't stranded (invisible + shims pointing at the
      // old path) after the switch.
      const migratedSkills = migrateSkillsToTemplate(dir, oldTemplate, template);
      await gitExec(["add", "home/"], { cwd: dir });
      try {
        await gitExec(["diff", "--cached", "--quiet"], { cwd: dir });
      } catch {
        await gitExec(["commit", "-m", `swap template-owned home files for ${template}`], {
          cwd: dir,
        });
      }
      await chownMindDir(dir, mindName);
      const skillNote =
        migratedSkills.length > 0
          ? ` Migrated skills to the ${template} skills dir: ${migratedSkills.join(", ")}.`
          : "";
      switchWarning = `Switched ${oldTemplate}→${template}: config reset to ${template} defaults, mechanics doc replaced, conversation starts fresh (sessions aren't portable across runtimes).${skillNote}`;
    } catch (err) {
      log.warn(`failed to swap template home files for ${mindName}`, log.errorData(err));
      return {
        ok: true,
        warning: `Upgrade merged but template switch ${oldTemplate}→${template} failed: ${err instanceof Error ? err.message : String(err)}. The mind is still registered as ${oldTemplate}; re-run the switch or fix home/ manually.`,
      };
    }
  }

  // Persist the template field only after any switch swap succeeded, so the DB
  // stays consistent with the on-disk template files.
  try {
    await setMindTemplateHash(mindName, computeTemplateHash(template));
    await setMindTemplate(mindName, template);
  } catch (err) {
    log.warn(`failed to update template for ${mindName}`, log.errorData(err));
  }

  // Skip npm install when the merge didn't touch dependencies — even a no-op
  // install writes enough to freeze slow storage for a minute or more.
  if (await npmInstallNeeded(dir, preMergeHead)) {
    try {
      await npmInstallAsMind(dir, mindName);
    } catch (err) {
      log.warn(`npm install failed after upgrade merge for ${mindName}`, log.errorData(err));
      return {
        ok: true,
        warning: `Upgrade merged but npm install failed: ${err instanceof Error ? err.message : String(err)}. You may need to run npm install manually.`,
      };
    }
  } else {
    log.info(`skipping npm install for ${mindName} — dependencies unchanged by upgrade`);
  }

  // Restart mind with upgrade context
  const manager = getMindManager();
  try {
    if (manager.isRunning(mindName)) {
      await manager.stopMind(mindName);
    }
    manager.setPendingContext(mindName, { type: "upgraded" });
    // Generous health budget: right after an npm install the disk cache is
    // cold and I/O may still be saturated, so a tsx cold start can exceed the
    // default 30s — timing out here kills the child and leaves the mind down.
    await manager.startMind(mindName, { healthTimeoutMs: 120_000 });
  } catch (e) {
    return {
      ok: true,
      warning: `Upgrade merged but mind restart failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, warning: switchWarning };
}

/** Import a mind from a .volute archive (extracted to tempDir by CLI). */
async function importFromArchive(
  c: any,
  tempDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
) {
  const extractedMindDir = resolve(tempDir, "mind");
  if (!existsSync(extractedMindDir)) {
    return c.json({ error: "Invalid archive: missing mind/ directory" }, 400);
  }

  if (!manifest?.includes || !manifest.name || !manifest.template) {
    return c.json({ error: "Invalid archive manifest" }, 400);
  }

  // Route home-only archives through the template-composed import path
  if (isHomeOnlyArchive(manifest)) {
    return importFromHomeOnlyArchive(c, tempDir, extractedMindDir, nameOverride, manifest);
  }

  return importFromFullArchive(c, tempDir, extractedMindDir, nameOverride, manifest);
}

/** Import a full archive (contains src/, home/, .mind/) — original behavior. */
async function importFromFullArchive(
  c: any,
  tempDir: string,
  extractedMindDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
) {
  const name = nameOverride ?? manifest.name;

  const nameErr = validateMindName(name);
  if (nameErr) return c.json({ error: nameErr }, 400);

  if (await findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

  ensureVoluteHome();
  const dest = mindDir(name);
  if (existsSync(dest)) return c.json({ error: "Mind directory already exists" }, 409);

  try {
    // Copy extracted mind directory to final location
    cpSync(extractedMindDir, dest, { recursive: true });

    // Generate new identity if not included in archive
    if (!manifest.includes.identity) {
      generateIdentity(dest);
    }

    // Copy state files (env.json) to centralized state dir
    const state = stateDir(name);
    mkdirSync(state, { recursive: true });

    const envJson = resolve(tempDir, "state/env.json");
    if (existsSync(envJson)) {
      cpSync(envJson, resolve(state, "env.json"));
    }

    // Assign port and register
    const port = await nextPort();
    await addMind(name, port, manifest.stage, manifest.template);
    try {
      await setMindTemplateHash(name, computeTemplateHash(manifest.template));
    } catch (err) {
      log.warn(`failed to set template hash for ${name}`, log.errorData(err));
    }

    // Set up per-mind user isolation
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // Install dependencies
    await npmInstallAsMind(dest, name);

    // Import history and sessions
    await importHistoryFromArchive(name, tempDir);
    importSessionsFromArchive(dest, tempDir);

    // git init if .git/ doesn't exist (non-fatal — mind works without git)
    if (!existsSync(resolve(dest, ".git"))) {
      try {
        const env = isIsolationEnabled()
          ? { ...process.env, HOME: resolve(dest, "home") }
          : undefined;
        await gitExec(["init"], { cwd: dest, mindName: name, env });
        await configureGitIdentity(name, { cwd: dest, mindName: name, env });
        await gitExec(["add", "-A"], { cwd: dest, mindName: name, env });
        await gitExec(["commit", "-m", "import from archive"], { cwd: dest, mindName: name, env });
      } catch (err) {
        log.error(`git setup failed for imported mind ${name}`, log.errorData(err));
        rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      }
    }

    // Fix ownership
    await chownMindDir(dest, name);

    // Clean up temp dir
    rmSync(tempDir, { recursive: true, force: true });

    return c.json({ ok: true, name, port, message: `Imported mind: ${name} (port ${port})` });
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      log.error(`Failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    rmSync(tempDir, { recursive: true, force: true });
    return c.json({ error: err instanceof Error ? err.message : "Failed to import mind" }, 500);
  }
}

/** Import a home-only archive by composing a fresh template and overlaying mind-owned files. */
async function importFromHomeOnlyArchive(
  c: any,
  tempDir: string,
  extractedMindDir: string,
  nameOverride: string | undefined,
  manifest: ExportManifest,
) {
  const name = nameOverride ?? manifest.name;

  const nameErr = validateMindName(name);
  if (nameErr) return c.json({ error: nameErr }, 400);

  if (await findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

  ensureVoluteHome();
  const dest = mindDir(name);
  if (existsSync(dest)) return c.json({ error: "Mind directory already exists" }, 409);

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest: templateManifest } = composeTemplate(
    templatesRoot,
    manifest.template,
  );

  try {
    // 1. Compose fresh template
    copyTemplateToDir(composedDir, dest, name, templateManifest);
    applyInitFiles(dest);

    // 2. Overlay home/ from archive (archive files win over template defaults)
    const extractedHome = resolve(extractedMindDir, "home");
    if (existsSync(extractedHome)) {
      cpSync(extractedHome, resolve(dest, "home"), { recursive: true });
    }

    // 3. Overlay .mind/ from archive (preserves schedules, etc.)
    const extractedMindInternal = resolve(extractedMindDir, ".mind");
    if (existsSync(extractedMindInternal)) {
      cpSync(extractedMindInternal, resolve(dest, ".mind"), { recursive: true });
    }

    // 4. Generate new identity if not included in archive
    const identityDir = resolve(dest, ".mind/identity");
    let publicKeyPem: string;
    if (!manifest.includes.identity || !existsSync(resolve(identityDir, "private.pem"))) {
      ({ publicKeyPem } = generateIdentity(dest));
    } else {
      publicKeyPem = readFileSync(resolve(identityDir, "public.pem"), "utf-8");
    }

    // 5. Stamp prompts.json only if archive didn't provide one
    const promptsPath = resolve(dest, "home/.config/prompts.json");
    if (!existsSync(promptsPath)) {
      const mindPrompts = await getMindPromptDefaults();
      writeFileSync(promptsPath, `${JSON.stringify(mindPrompts, null, 2)}\n`);
    }

    // 6. Copy state files (env.json) to centralized state dir
    const state = stateDir(name);
    mkdirSync(state, { recursive: true });

    const envJson = resolve(tempDir, "state/env.json");
    if (existsSync(envJson)) {
      cpSync(envJson, resolve(state, "env.json"));
    }

    // 7. Register with correct stage and template
    const port = await nextPort();
    await addMind(name, port, manifest.stage, manifest.template);

    // 8. User isolation setup
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    await chownMindDir(dest, name);

    // 9. npm install
    await npmInstallAsMind(dest, name);

    // 10. Git init with template branch (enables upgrades)
    let gitWarning: string | undefined;
    try {
      const env = isIsolationEnabled() ? { ...process.env, HOME: homeDir } : undefined;
      await gitExec(["init"], { cwd: dest, mindName: name, env });
      await configureGitIdentity(name, { cwd: dest, mindName: name, env });
      await initTemplateBranch(dest, composedDir, templateManifest, name, env);
    } catch (err) {
      log.error(`git setup failed for imported mind ${name}`, log.errorData(err));
      rmSync(resolve(dest, ".git"), { recursive: true, force: true });
      gitWarning =
        "Git setup failed — variants and upgrades won't be available until git is initialized.";
    }

    // 11. Install skills based on stage
    const skillSet = manifest.stage === "seed" ? SEED_SKILLS : getStandardSkillsWithExtensions();
    const skillWarnings: string[] = [];
    for (const skillId of skillSet) {
      try {
        await installSkill(name, dest, skillId);
      } catch (err) {
        log.error(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
        skillWarnings.push(`Failed to install skill: ${skillId}`);
      }
    }

    // 13. Import history and sessions from archive
    await importHistoryFromArchive(name, tempDir);
    importSessionsFromArchive(dest, tempDir);

    // 14. Fix ownership, publish public key
    await chownMindDir(dest, name);
    publishPublicKey(name, publicKeyPem).catch((err: unknown) =>
      log.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
    );

    // 15. Clean up
    rmSync(tempDir, { recursive: true, force: true });

    return c.json({
      ok: true,
      name,
      port,
      stage: manifest.stage ?? "sprouted",
      message: `Imported mind: ${name} (port ${port})`,
      ...(gitWarning && { warning: gitWarning }),
      ...(skillWarnings.length > 0 && { skillWarnings }),
    });
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      await removeMind(name);
    } catch (cleanupErr) {
      log.error(`Failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    rmSync(tempDir, { recursive: true, force: true });
    return c.json({ error: err instanceof Error ? err.message : "Failed to import mind" }, 500);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Import history rows from archive into the database. */
async function importHistoryFromArchive(name: string, tempDir: string): Promise<void> {
  const historyJsonl = resolve(tempDir, "history.jsonl");
  if (!existsSync(historyJsonl)) return;

  try {
    const db = await getDb();
    const lines = readFileSync(historyJsonl, "utf-8").trim().split("\n");
    let imported = 0;
    let failed = 0;
    for (const line of lines) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (!row.type) {
          failed++;
          continue;
        }
        await db.insert(mindHistory).values({
          mind: name,
          channel: row.channel ?? null,
          // Archives are long-lived files: pre-rename exports carry `session`.
          thread: row.thread ?? row.session ?? null,
          sender: row.sender ?? null,
          message_id: row.message_id ?? null,
          type: row.type,
          content: row.content ?? null,
          metadata: row.metadata ?? null,
          created_at: row.created_at ?? new Date().toISOString(),
        });
        imported++;
      } catch (lineErr) {
        log.warn("Failed to import history line", log.errorData(lineErr));
        failed++;
      }
    }
    if (failed > 0) {
      log.warn(`History import: ${imported} imported, ${failed} failed`);
    }
  } catch (err) {
    log.error("Failed to open database for history import", log.errorData(err));
  }
}

/** Import session files from archive into .mind/sessions/. Non-fatal on failure. */
function importSessionsFromArchive(dest: string, tempDir: string): void {
  const sessionsDir = resolve(tempDir, "sessions");
  if (!existsSync(sessionsDir)) return;

  try {
    const destSessions = resolve(dest, ".mind/sessions");
    mkdirSync(destSessions, { recursive: true });
    for (const file of readdirSync(sessionsDir)) {
      cpSync(resolve(sessionsDir, file), resolve(destSessions, file));
    }
  } catch (err) {
    log.error("Failed to import sessions from archive", log.errorData(err));
  }
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

const app = new Hono<AuthEnv>()
  .post("/", requireAdminOrSystem, zValidator("json", createMindSchema), async (c) => {
    const body = c.req.valid("json");

    const { name } = body;
    const template = body.template ?? (await resolveTemplate(body.model));

    const nameErr = validateMindName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    if (await findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

    // Refuse to create a mind the system can't run. With no AI provider configured
    // every mind spawns mute (no model to think with), so block creation here rather
    // than leave an unusable mind behind (#606). Mirrors the dashboard banner's copy.
    if (!isAiConfigured()) {
      return c.json(
        {
          error:
            "Minds cannot think yet — no AI provider is configured. Add a provider in Settings before creating a mind.",
        },
        409,
      );
    }

    // Cap total minds to protect host resources. Central enforcement here covers
    // `volute mind create`, `volute seed create`, and spirit-driven seeds alike;
    // the error text is relayed verbatim to whoever asked.
    {
      const { mindLimitError, readGlobalConfig } = await import("../../lib/config/setup.js");
      const limitError = mindLimitError(await countCappedMinds(), readGlobalConfig().maxMinds);
      if (limitError) return c.json({ error: limitError }, 409);
    }

    ensureVoluteHome();
    const dest = mindDir(name);

    if (existsSync(dest)) return c.json({ error: "Mind directory already exists" }, 409);

    const templatesRoot = findTemplatesRoot();
    const { composedDir, manifest } = composeTemplate(templatesRoot, template);

    try {
      copyTemplateToDir(composedDir, dest, name, manifest);
      applyInitFiles(dest);

      // Generate Ed25519 keypair for mind identity
      const { publicKeyPem } = generateIdentity(dest);

      // The model the mind will actually run (request, or default cognition model),
      // provider-qualified — feeds the credential warning below so pi minds created
      // from defaults are checked too.
      let effectiveModel: string | undefined = body.model;
      // Merge default settings into volute.json and config.json
      {
        const { readGlobalConfig: readGlobal } = await import("../../lib/config/setup.js");
        const mindDefaults = readGlobal().mindDefaults;
        const config = readVoluteConfig(dest);
        if (!config) throw new Error("Failed to read volute.json after identity generation");
        if (body.description) {
          config.profile = { ...config.profile, description: body.description };
        }
        if (!config.sleep) {
          config.sleep = mindDefaults?.sleep ?? {
            enabled: true,
            schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" },
          };
        }
        if (!config.schedules || config.schedules.length === 0) {
          config.schedules = mindDefaults?.schedules ?? [defaultHeartbeatSchedule()];
        }
        // Apply cognition defaults
        const cog = mindDefaults?.cognition;
        if (cog) {
          if (cog.thinkingLevel != null && !config.thinkingLevel)
            config.thinkingLevel = cog.thinkingLevel;
          if (cog.tokenBudget != null && config.tokenBudget == null)
            config.tokenBudget = cog.tokenBudget;
          if (cog.tokenBudgetPeriodMinutes != null && config.tokenBudgetPeriodMinutes == null)
            config.tokenBudgetPeriodMinutes = cog.tokenBudgetPeriodMinutes;
        }
        writeVoluteConfig(dest, config);

        // Apply model (and compaction) to SDK config.json
        const modelId = body.model ?? cog?.model;
        effectiveModel = modelId ? qualifyModelId(modelId) : undefined;
        const sdkConfigPath = resolve(dest, "home/.config/config.json");
        if (modelId || cog?.compaction) {
          const existing = existsSync(sdkConfigPath)
            ? JSON.parse(readFileSync(sdkConfigPath, "utf-8"))
            : {};
          if (modelId) {
            existing.model =
              template === "pi" ? qualifyModelId(modelId) : unqualifyModelId(modelId);
          }
          if (cog?.compaction && !existing.compaction) {
            existing.compaction = cog.compaction;
          }
          writeFileSync(sdkConfigPath, `${JSON.stringify(existing, null, 2)}\n`);
        }
      }

      // Stamp prompts.json with current DB defaults
      const mindPrompts = await getMindPromptDefaults();
      writeFileSync(
        resolve(dest, "home/.config/prompts.json"),
        `${JSON.stringify(mindPrompts, null, 2)}\n`,
      );

      const port = await nextPort();
      // Use createdBy from body, or fall back to the authenticated user's username
      const createdBy = body.createdBy ?? c.get("user")?.username;
      await addMind(name, port, body.stage, template, createdBy);
      try {
        await setMindTemplateHash(name, computeTemplateHash(template));
      } catch (err) {
        log.warn(`failed to set template hash for ${name}`, log.errorData(err));
      }

      // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
      const homeDir = resolve(dest, "home");
      ensureVoluteGroup();
      createMindUser(name, homeDir);
      await chownMindDir(dest, name);

      // Install dependencies as mind user (chown already ran above)
      await npmInstallAsMind(dest, name);

      // git init + template branch + initial commit (before seed modifications
      // so that initTemplateBranch can git-add all template files)
      let gitWarning: string | undefined;
      try {
        const env = isIsolationEnabled() ? { ...process.env, HOME: homeDir } : undefined;
        await gitExec(["init"], { cwd: dest, mindName: name, env });
        await configureGitIdentity(name, { cwd: dest, mindName: name, env });
        await initTemplateBranch(dest, composedDir, manifest, name, env);
      } catch (err) {
        log.error(`git setup failed for ${name}`, log.errorData(err));
        rmSync(resolve(dest, ".git"), { recursive: true, force: true });
        gitWarning =
          "Git setup failed — variants and upgrades won't be available until git is initialized.";
      }

      if (body.stage === "seed") {
        // Write orientation SOUL.md
        const descLine = body.description
          ? `\nYour creator described you as: "${body.description}"\n`
          : "";
        const seedSoulRaw =
          body.seedSoul ?? (await getPrompt("seed_soul", { name, description: descLine }));
        // getPrompt already substituted; custom seedSoul needs substitution too
        const seedSoul = body.seedSoul
          ? substitute(seedSoulRaw, { name, description: descLine })
          : seedSoulRaw;
        writeFileSync(resolve(dest, "home/SOUL.md"), seedSoul);
      }

      // Install skills from shared pool (after git init so installSkill can commit)
      let skillSet =
        body.skills ?? (body.stage === "seed" ? SEED_SKILLS : getStandardSkillsWithExtensions());

      // Add imagegen skill for seeds when image generation is enabled
      if (body.stage === "seed" && !body.skills) {
        const { isImagegenEnabled } = await import("../../lib/config/setup.js");
        if (isImagegenEnabled()) {
          skillSet = [...skillSet, "imagegen"];
        }
      }
      const skillWarnings: string[] = [];
      for (const skillId of skillSet) {
        try {
          await installSkill(name, dest, skillId);
        } catch (err) {
          log.error(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
          skillWarnings.push(`Failed to install skill: ${skillId}`);
        }
      }

      // Default autonomy: minds created directly as full minds get working
      // dreaming out of the box; seeds get it at sprout (#581)
      if (body.stage !== "seed") {
        skillWarnings.push(...setupDefaultDreaming(dest).warnings);
      }

      // Add nurture schedule to spirit if this is a seed
      if (body.stage === "seed") {
        try {
          const spiritName = getSpiritName();
          const spiritEntry = await findMind(spiritName);
          if (spiritEntry) {
            const { spiritDir } = await import("../../lib/mind/spirit.js");
            const sDir = spiritEntry.dir ?? spiritDir();
            const spiritConfig = readVoluteConfig(sDir) ?? {};
            const schedules = spiritConfig.schedules ?? [];
            const nurtureId = `nurture-${name}`;
            if (!schedules.some((s) => s.id === nurtureId)) {
              schedules.push({
                id: nurtureId,
                cron: process.env.VOLUTE_NURTURE_CRON ?? "*/5 * * * *",
                script: `volute seed check ${name} --nurture`,
                enabled: true,
                whileSleeping: "skip",
              });
              spiritConfig.schedules = schedules;
              writeVoluteConfig(sDir, spiritConfig);
              const { getScheduler } = await import("../../lib/daemon/scheduler.js");
              getScheduler().loadSchedules(spiritName, sDir);
            }
          }
        } catch (err) {
          log.warn(`failed to add nurture schedule for ${name}`, log.errorData(err));
        }
      }

      // Overwrite SOUL.md / MEMORY.md if custom defaults are set in DB
      if (body.stage !== "seed") {
        const customSoul = await getPromptIfCustom("default_soul");
        if (customSoul) {
          writeFileSync(resolve(dest, "home/SOUL.md"), customSoul.replace(/\{\{name\}\}/g, name));
        }
        const customMemory = await getPromptIfCustom("default_memory");
        if (customMemory) {
          writeFileSync(resolve(dest, "home/MEMORY.md"), customMemory);
        }
      }

      // Fix ownership after all root git/file operations (git objects, skill
      // installs, and SOUL.md/MEMORY.md writes above must end up mind-owned so
      // the mind can modify its own identity files under user isolation)
      await chownMindDir(dest, name);

      // Auto-publish public key to volute.systems (non-blocking)
      publishPublicKey(name, publicKeyPem).catch((err: unknown) =>
        log.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
      );

      fireWebhook({
        event: "mind_created",
        mind: name,
        data: {
          name,
          port,
          stage: body.stage ?? "sprouted",
          template,
          description: body.description,
        },
      });

      // Announce to #system channel
      announceToSystem(`${name} has joined`).catch(() => {});

      // Warn (don't block) when the mind will spawn without usable model credentials,
      // so a mute-on-first-turn mind is caught at creation rather than in silence (#573).
      // The mind is already created — an advisory check must never fail creation, so
      // swallow any hiccup and just omit the warning.
      const credentialWarning = await missingCredentialWarning(
        template,
        effectiveModel,
        name,
      ).catch((err) => {
        log.warn(`credential check failed for ${name}`, log.errorData(err));
        return null;
      });

      return c.json({
        ok: true,
        name,
        port,
        stage: body.stage ?? "sprouted",
        message: `Created mind: ${name} (port ${port})`,
        ...(gitWarning && { warning: gitWarning }),
        ...(credentialWarning && { credentialWarning }),
        ...(skillWarnings.length > 0 && { skillWarnings }),
      });
    } catch (err) {
      // Clean up partial state
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      try {
        await removeMind(name);
      } catch (cleanupErr) {
        log.warn(`failed to clean up registry for ${name}`, log.errorData(cleanupErr));
      }
      return c.json({ error: err instanceof Error ? err.message : "Failed to create mind" }, 500);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  })
  // Import mind from OpenClaw workspace or .volute archive — admin only
  .post("/import", requireAdmin, async (c) => {
    let body: {
      workspacePath?: string;
      name?: string;
      template?: string;
      sessionPath?: string;
      archivePath?: string;
      manifest?: ExportManifest;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Route to archive import if archivePath + manifest are present
    if (body.archivePath && body.manifest) {
      return importFromArchive(c, body.archivePath, body.name, body.manifest);
    }

    const wsDir = body.workspacePath;
    if (
      !wsDir ||
      !existsSync(resolve(wsDir, "SOUL.md")) ||
      !existsSync(resolve(wsDir, "IDENTITY.md"))
    ) {
      return c.json({ error: "Invalid workspace: missing SOUL.md or IDENTITY.md" }, 400);
    }

    const soul = readFileSync(resolve(wsDir, "SOUL.md"), "utf-8");
    const identity = readFileSync(resolve(wsDir, "IDENTITY.md"), "utf-8");
    const userPath = resolve(wsDir, "USER.md");
    const user = existsSync(userPath) ? readFileSync(userPath, "utf-8") : "";

    const name = body.name ?? parseNameFromIdentity(identity) ?? "imported-mind";
    const template = body.template ?? "claude";

    const nameErr = validateMindName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    if (await findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

    const mergedSoul = `${soul.trimEnd()}\n\n---\n\n${identity.trimEnd()}\n`;
    const mergedMemoryExtra = user ? `\n\n---\n\n${user.trimEnd()}\n` : "";

    ensureVoluteHome();
    const dest = mindDir(name);

    if (existsSync(dest)) return c.json({ error: "Mind directory already exists" }, 409);

    const templatesRoot = findTemplatesRoot();
    const { composedDir, manifest } = composeTemplate(templatesRoot, template);

    try {
      copyTemplateToDir(composedDir, dest, name, manifest);

      applyInitFiles(dest);

      // Generate Ed25519 keypair for mind identity
      const { publicKeyPem: importPublicKey } = generateIdentity(dest);

      // Write SOUL.md (with IDENTITY.md merged in)
      writeFileSync(resolve(dest, "home/SOUL.md"), mergedSoul);

      // Copy or create MEMORY.md
      const wsMemoryPath = resolve(wsDir, "MEMORY.md");
      const hasMemory = existsSync(wsMemoryPath);
      if (hasMemory) {
        const existingMemory = readFileSync(wsMemoryPath, "utf-8");
        writeFileSync(
          resolve(dest, "home/MEMORY.md"),
          `${existingMemory.trimEnd()}${mergedMemoryExtra}`,
        );
      } else if (user) {
        writeFileSync(resolve(dest, "home/MEMORY.md"), `${user.trimEnd()}\n`);
      }

      // Copy memory/*.md daily logs
      const wsMemoryDir = resolve(wsDir, "memory");
      let dailyLogCount = 0;
      if (existsSync(wsMemoryDir)) {
        const destMemoryDir = resolve(dest, "home/memory");
        const files = readdirSync(wsMemoryDir).filter((f) => f.endsWith(".md"));
        for (const file of files) {
          cpSync(resolve(wsMemoryDir, file), resolve(destMemoryDir, file));
        }
        dailyLogCount = files.length;
      }

      // Assign port and register
      const port = await nextPort();
      await addMind(name, port, undefined, template);
      try {
        await setMindTemplateHash(name, computeTemplateHash(template));
      } catch (err) {
        log.warn(`failed to set template hash for ${name}`, log.errorData(err));
      }

      // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
      const homeDir = resolve(dest, "home");
      ensureVoluteGroup();
      createMindUser(name, homeDir);
      await chownMindDir(dest, name);

      // Install dependencies as mind user (chown already ran above)
      await npmInstallAsMind(dest, name);

      // Consolidate memory if no MEMORY.md but daily logs exist
      if (!hasMemory && dailyLogCount > 0) {
        await consolidateMemory(dest);
      }

      // git init + initial commit
      const env = isIsolationEnabled()
        ? { ...process.env, HOME: resolve(dest, "home") }
        : undefined;
      await gitExec(["init"], { cwd: dest, mindName: name, env });
      await configureGitIdentity(name, { cwd: dest, mindName: name, env });
      await gitExec(["add", "-A"], { cwd: dest, mindName: name, env });
      await gitExec(["commit", "-m", "import from OpenClaw"], { cwd: dest, mindName: name, env });

      // Import session
      const sessionFile = body.sessionPath ? resolve(body.sessionPath) : findOpenClawSession(wsDir);
      if (sessionFile && existsSync(sessionFile)) {
        if (template === "pi") {
          importPiSession(sessionFile, dest);
        } else if (template === "claude") {
          const sessionId = convertSession({ sessionPath: sessionFile, projectDir: dest });
          const mindRuntimeDir = resolve(dest, ".mind");
          mkdirSync(mindRuntimeDir, { recursive: true });
          writeFileSync(resolve(mindRuntimeDir, "session.json"), JSON.stringify({ sessionId }));
        }
      }

      // Import OpenClaw connectors as system bridges (non-fatal)
      importOpenClawConnectors(name, dest);

      // Fix ownership after root git/file operations
      await chownMindDir(dest, name);

      // Auto-publish public key to volute.systems (non-blocking)
      publishPublicKey(name, importPublicKey).catch((err: unknown) =>
        log.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
      );

      return c.json({ ok: true, name, port, message: `Imported mind: ${name} (port ${port})` });
    } catch (err) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      try {
        await removeMind(name);
      } catch (cleanupErr) {
        log.warn(`failed to clean up registry for ${name}`, log.errorData(cleanupErr));
      }
      return c.json({ error: err instanceof Error ? err.message : "Failed to import mind" }, 500);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  })
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
  .post("/:name/start", requireSelf(), async (c) => {
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
      return c.json({ error: err instanceof Error ? err.message : "Failed to start mind" }, 500);
    }
  })
  // Restart mind (supports variants) — admin or self
  // Accepts optional JSON body: { context?: { type: string, name?: string, summary?: string, ... } }
  .post("/:name/restart", requireSelf(), async (c) => {
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

          // Auto-commit variant worktree
          if (existsSync(variantEntry.dir)) {
            const status = (
              await gitExec(["status", "--porcelain"], { cwd: variantEntry.dir })
            ).trim();
            if (status) {
              try {
                await gitExec(["add", "-A"], { cwd: variantEntry.dir });
                await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
                  cwd: variantEntry.dir,
                });
              } catch (e) {
                log.error(
                  `failed to auto-commit variant worktree for ${baseName}`,
                  log.errorData(e),
                );
              }
            }
          }

          // Auto-commit main worktree
          const mainStatus = (
            await gitExec(["status", "--porcelain"], { cwd: projectRoot })
          ).trim();
          if (mainStatus) {
            try {
              await gitExec(["add", "-A"], { cwd: projectRoot });
              await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
                cwd: projectRoot,
              });
            } catch (e) {
              log.error(`failed to auto-commit main worktree for ${baseName}`, log.errorData(e));
            }
          }

          // Merge (excluding the mind's living memory/journal — #440), narrate
          // the memory delta to the parent, then clean up worktree/branch and
          // reinstall if the merge touched dependencies.
          const preMergeHead = (await gitExec(["rev-parse", "HEAD"], { cwd: projectRoot })).trim();
          const memoryDelta = await mergeVariantExcludingMemory(projectRoot, variantEntry.branch);
          if (memoryDelta && context) context.memoryDelta = memoryDelta;
          await cleanupVariant(mergeVariantName, baseName, projectRoot, variantEntry.dir);
          if (await npmInstallNeeded(projectRoot, preMergeHead)) {
            try {
              await npmInstallAsMind(projectRoot, baseName);
            } catch (e) {
              log.error(`npm install failed after merge for ${baseName}`, log.errorData(e));
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
      return c.json({ error: err instanceof Error ? err.message : "Failed to restart mind" }, 500);
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
      return c.json({ error: err instanceof Error ? err.message : "Failed to stop mind" }, 500);
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
  // Initiate sleep — mind-or-admin (requireSelf: the mind itself or an admin/system user)
  .post("/:name/sleep", requireSelf(), async (c) => {
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

    sm.initiateSleep(name, wakeAt ? { voluntaryWakeAt: wakeAt } : undefined).catch((err) =>
      log.error(`failed to initiate sleep for ${name}`, log.errorData(err)),
    );

    return c.json({ ok: true });
  })
  // Wake a sleeping mind — mind-or-admin (requireSelf: the mind itself or an admin/system user)
  .post("/:name/wake", requireSelf(), async (c) => {
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
  .patch("/:name/profile", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as {
      displayName?: string;
      description?: string;
      avatar?: string;
    };

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
  })
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
    const waitParam = Number(c.req.query("wait"));
    const waitMs = Number.isFinite(waitParam) ? Math.min(Math.max(waitParam, 0), 60) * 1000 : 0;
    const job =
      waitMs > 0 ? await waitForImagegenJob(name, jobId, waitMs) : getImagegenJob(name, jobId);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json(job);
  })
  // Seed readiness check — used by spirit nurture schedule
  .get("/:name/seed-check", requireSelf(), async (c) => {
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

    // Join the #system commons now. Seeds are deliberately kept out until they
    // sprout (backfill and the spawn path both exclude stage="seed"), so sprouting
    // is the moment a mind enters the commons. Joining here — rather than relying on
    // the incidental restart that follows — makes membership a direct consequence of
    // sprouting for every caller. Idempotent; fail-soft so a join hiccup can't block
    // the sprout itself.
    await joinSystemChannelForMind(name).catch((err) =>
      log.warn(`failed to join #system on sprout for ${name}`, log.errorData(err)),
    );

    // Make sprouting a visible event (#665): prompt the spirit to hand-write a
    // welcome in #system, plus a persisted `mind_sprouted` activity event
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

    const dir = mindDir(name);
    const force = c.req.query("force") === "true";

    // Stop mind if running
    const manager = getMindManager();
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
      accept?: boolean;
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
    // (which process.exit()s on an unknown template), and the registry — validate
    // against the known set before any of that.
    if (!isKnownTemplate(template)) {
      return c.json({ error: `Unknown template: ${template}` }, 400);
    }
    const UPGRADE_BRANCH = "upgrade";
    const upgradeVariantName = `${mindName}-upgrade`;
    const worktreeDir = resolve(dir, ".variants", UPGRADE_BRANCH);

    if (body.abort) {
      if (!existsSync(worktreeDir)) {
        return c.json({ error: "No upgrade in progress" }, 400);
      }

      try {
        // Abort merge if mid-merge
        try {
          const gitDirContent = readFileSync(resolve(worktreeDir, ".git"), "utf-8").trim();
          const gitDir = gitDirContent.replace("gitdir: ", "");
          if (existsSync(resolve(gitDir, "MERGE_HEAD"))) {
            await gitExec(["merge", "--abort"], { cwd: worktreeDir });
          }
        } catch {}

        await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir, { stop: true });

        // Also delete the upgrade branch directly — cleanupVariant uses the variant
        // name as fallback branch, but the actual branch is UPGRADE_BRANCH
        try {
          await gitExec(["branch", "-D", UPGRADE_BRANCH], { cwd: dir });
        } catch {
          // Branch may already be deleted by cleanupVariant
        }

        return c.json({ ok: true });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to abort upgrade" },
          500,
        );
      }
    }

    if (body.continue) {
      // Continue upgrade after conflict resolution — merge back to main
      if (!existsSync(worktreeDir)) {
        return c.json({ error: "No upgrade in progress" }, 400);
      }

      const status = await gitExec(["status", "--porcelain"], { cwd: worktreeDir });
      const hasConflicts = status
        .split("\n")
        .some((line) => line.startsWith("UU") || line.startsWith("AA"));
      if (hasConflicts) {
        return c.json({ error: "Unresolved conflicts remain" }, 409);
      }

      try {
        await gitExec(["add", "-A"], { cwd: worktreeDir });
        await gitExec(["commit", "-m", "merge template update"], { cwd: worktreeDir });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const stderr = (e as any)?.stderr ?? "";
        const stdout = (e as any)?.stdout ?? "";
        if (
          !msg.includes("nothing to commit") &&
          !stderr.includes("nothing to commit") &&
          !stdout.includes("nothing to commit")
        )
          throw e;
      }

      // Re-add home files that match the new .gitignore allowlist patterns
      try {
        await gitExec(["add", "home/"], { cwd: worktreeDir });
      } catch (err) {
        log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
      }
      try {
        await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
      } catch {
        await gitExec(["commit", "-m", "re-add allowlisted home files"], {
          cwd: worktreeDir,
        });
      }

      // Fix ownership after root git operations
      await chownMindDir(dir, mindName);

      // Merge upgrade branch back to main, cleanup, and restart
      try {
        const result = await mergeUpgradeAndRestart(
          mindName,
          dir,
          worktreeDir,
          upgradeVariantName,
          UPGRADE_BRANCH,
          template,
          oldTemplate,
        );
        return c.json(result);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to merge upgrade" },
          500,
        );
      }
    }

    if (body.accept) {
      // Legacy — upgrades now auto-merge. Clean up any old-style upgrade state.
      if (existsSync(worktreeDir)) {
        try {
          await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir, { stop: true });
        } catch (err) {
          log.warn(`failed to clean up legacy upgrade variant for ${mindName}`, log.errorData(err));
        }
        try {
          await gitExec(["branch", "-D", UPGRADE_BRANCH], { cwd: dir });
        } catch {}
      }
      return c.json({ error: "Upgrades now auto-merge. Run 'volute mind upgrade' again." }, 400);
    }

    if (body.diff) {
      // Preview what the upgrade would change
      try {
        // Initialize git repo if missing
        if (!existsSync(resolve(dir, ".git"))) {
          return c.json({ error: "Mind has no git history — nothing to diff against" }, 400);
        }

        await updateTemplateBranch(dir, template, mindName);

        // Show what the template branch has that main doesn't
        let diff: string;
        try {
          diff = await gitExec(["diff", "HEAD...volute/template"], { cwd: dir });
        } catch {
          // If three-dot diff fails (no common ancestor), fall back to two-dot
          diff = await gitExec(["diff", "HEAD", "volute/template"], { cwd: dir });
        }

        return c.json({ ok: true, diff: diff || "(no changes)" });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to generate diff" },
          500,
        );
      }
    }

    // Fresh upgrade

    if (existsSync(worktreeDir)) {
      return c.json(
        { error: "Upgrade variant already exists. Use continue or delete it first." },
        409,
      );
    }

    // Initialize git repo if missing (minds created before git config was fixed)
    if (!existsSync(resolve(dir, ".git"))) {
      try {
        const env = isIsolationEnabled()
          ? { ...process.env, HOME: resolve(dir, "home") }
          : undefined;
        await gitExec(["init"], { cwd: dir, mindName: mindName, env });
        await configureGitIdentity(mindName, { cwd: dir, mindName: mindName, env });
        await gitExec(["add", "-A"], { cwd: dir, mindName: mindName, env });
        await gitExec(["commit", "-m", "initial commit"], { cwd: dir, mindName: mindName, env });
        await chownMindDir(dir, mindName);
      } catch (err) {
        rmSync(resolve(dir, ".git"), { recursive: true, force: true });
        return c.json(
          {
            error: `Git initialization failed: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    }

    // Clean up stale worktree refs and leftover branch
    await gitExec(["worktree", "prune"], { cwd: dir });
    try {
      await gitExec(["branch", "-D", UPGRADE_BRANCH], { cwd: dir });
    } catch {
      // branch doesn't exist
    }

    // Update template branch
    await updateTemplateBranch(dir, template, mindName);

    // Create upgrade worktree
    const parentDir = resolve(dir, ".variants");
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    await gitExec(["worktree", "add", "-b", UPGRADE_BRANCH, worktreeDir], { cwd: dir });

    // Prepare home/ allowlist migration: untrack home files so template
    // branch removal doesn't cause conflicts or deletions
    await gitExec(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], {
      cwd: worktreeDir,
    });
    // Re-add VOLUTE.md so template merge can update it
    try {
      await gitExec(["checkout", "HEAD", "--", "home/VOLUTE.md"], { cwd: worktreeDir });
      await gitExec(["add", "home/VOLUTE.md"], { cwd: worktreeDir });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!msg.includes("did not match")) {
        log.warn(
          `unexpected error restoring VOLUTE.md during upgrade for ${mindName}`,
          log.errorData(err),
        );
      }
    }
    // Commit prep step if there are changes
    try {
      await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
    } catch {
      await gitExec(["commit", "-m", "prepare for home/ allowlist migration"], {
        cwd: worktreeDir,
      });
    }

    // Merge template branch
    const hasConflicts = await mergeTemplateBranch(worktreeDir);

    if (!hasConflicts) {
      // Re-add home files that match the new .gitignore allowlist patterns
      try {
        await gitExec(["add", "home/"], { cwd: worktreeDir });
      } catch (err) {
        log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
      }
      try {
        await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
      } catch {
        await gitExec(["commit", "-m", "re-add allowlisted home files"], {
          cwd: worktreeDir,
        });
      }
    }

    // Fix ownership — daemon runs as root but mind needs to own its files
    await chownMindDir(dir, mindName);

    if (hasConflicts) {
      return c.json({
        ok: false,
        conflicts: true,
        worktreeDir,
        message: "Merge conflicts detected. Resolve them, then run with continue.",
      });
    }

    // Merge upgrade branch back to main, cleanup, and restart
    try {
      const result = await mergeUpgradeAndRestart(
        mindName,
        dir,
        worktreeDir,
        upgradeVariantName,
        UPGRADE_BRANCH,
        template,
        oldTemplate,
      );
      return c.json(result);
    } catch (err) {
      // Merge failed — clean up
      try {
        await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir);
      } catch (cleanupErr) {
        log.warn(`cleanup failed after upgrade error for ${mindName}`, log.errorData(cleanupErr));
      }
      return c.json({ error: err instanceof Error ? err.message : "Failed to merge upgrade" }, 500);
    }
  })
  // All conversations for a mind (across all channels)
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    const user = c.get("user");
    const convs = await listConversationsForMind(name);
    // Strip lastMessage from private conversations for non-participants/non-admins
    const filtered = convs.map((conv) => {
      if (conv.private !== 1) return conv;
      if (user.role === "admin") return conv;
      const userIsParticipant = conv.participants.some((p) => p.userId === user.id);
      if (userIsParticipant) return conv;
      const { lastMessage: _, ...rest } = conv;
      return rest;
    });
    return c.json(filtered);
  })
  // Read messages from a mind's conversation (privacy-enforced)
  .get("/:name/conversations/:convId/messages", async (c) => {
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
      if (user.role !== "admin") {
        const participant = await isParticipant(convId, user.id);
        if (!participant) {
          return c.json({ error: "This is a private conversation" }, 403);
        }
      }
    }
    const beforeStr = c.req.query("before");
    const limitStr = c.req.query("limit");
    if (!beforeStr && !limitStr) {
      const msgs = await getMessages(convId);
      return c.json({ items: await withSenderDisplayNames(msgs), hasMore: false });
    }
    const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (
      (before !== undefined && Number.isNaN(before)) ||
      (limit !== undefined && Number.isNaN(limit))
    ) {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const result = await getMessagesPaginated(convId, { before, limit });
    return c.json({
      items: await withSenderDisplayNames(result.messages),
      hasMore: result.hasMore,
    });
  })
  // Budget status
  .get("/:name/budget", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const usage = getTokenBudget().getUsage(baseName);
    if (!usage) return c.json({ error: "No budget configured" }, 404);
    return c.json(usage);
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
        tokenBudget: config?.tokenBudget ?? null,
        tokenBudgetPeriodMinutes: config?.tokenBudgetPeriodMinutes ?? null,
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
        tokenBudget: z.number().int().positive().nullable().optional(),
        tokenBudgetPeriodMinutes: z.number().int().positive().nullable().optional(),
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
      if (body.tokenBudget !== undefined) {
        if (body.tokenBudget === null) {
          delete existing.tokenBudget;
        } else {
          existing.tokenBudget = body.tokenBudget;
        }
      }
      if (body.tokenBudgetPeriodMinutes !== undefined) {
        if (body.tokenBudgetPeriodMinutes === null) {
          delete existing.tokenBudgetPeriodMinutes;
        } else {
          existing.tokenBudgetPeriodMinutes = body.tokenBudgetPeriodMinutes;
        }
      }
      if (body.unescapeNewlines !== undefined) {
        existing.unescapeNewlines = body.unescapeNewlines;
      }

      writeVoluteConfig(dir, existing);

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
  .post("/:name/gates/decline", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { channel?: string };
    const channel = body.channel?.trim();
    if (!channel) return c.json({ error: "channel required" }, 400);
    try {
      const archived = await getDeliveryManager().declineChannel(name, channel);
      return c.json({ ok: true, channel, archived });
    } catch (err) {
      if (err instanceof Error && err.message.includes("not initialized")) {
        return c.json({ error: "Delivery manager not available" }, 503);
      }
      log.error(`failed to decline channel ${channel} for ${name}`, log.errorData(err));
      return c.json({ error: "Failed to decline channel" }, 500);
    }
  })
  // AI completion proxy for minds
  .post("/:name/ai/complete", requireSelf(), async (c) => {
    const body = (await c.req.json()) as { systemPrompt: string; message: string; model?: string };
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
  })
  // Receive events from mind, persist to mind_history, publish to pub-sub
  .post("/:name/events", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);

    let body: {
      type: string;
      session?: string;
      channel?: string;
      messageId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.type) {
      return c.json({ error: "type required" }, 400);
    }
    if (DAEMON_AUTHORED_TYPES.has(body.type)) {
      return c.json({ error: `type "${body.type}" is daemon-authored` }, 400);
    }

    await handleMindEvent(baseName, body);

    return c.json({ ok: true });
  })
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
  .post("/:name/history", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);

    let body: { channel: string; content: string; sender?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

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
  })
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
  .get("/:name/history/contacts", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const rawHours = parseInt(c.req.query("hours") ?? "48", 10);
    const hours = Math.min(Math.max(Number.isNaN(rawHours) ? 48 : rawHours, 1), 168);
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

    // Prefer turn_id-based query; fall back to legacy session+range
    let rows: Array<typeof mindHistory.$inferSelect>;
    if (turnId) {
      rows = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, name), eq(mindHistory.turn_id, turnId), typeFilter))
        .orderBy(mindHistory.id);
    } else {
      // Legacy: session + from_id/to_id range
      const session = c.req.query("session");
      const fromId = parseInt(c.req.query("from_id") ?? "", 10);
      const toId = parseInt(c.req.query("to_id") ?? "", 10);
      if (!session || Number.isNaN(fromId) || Number.isNaN(toId)) {
        return c.json({ error: "turn_id, or session with from_id and to_id, required" }, 400);
      }

      rows = await db
        .select()
        .from(mindHistory)
        .where(
          and(
            eq(mindHistory.mind, name),
            eq(mindHistory.thread, session),
            sql`${mindHistory.id} >= ${fromId}`,
            sql`${mindHistory.id} <= ${toId}`,
            typeFilter,
          ),
        )
        .orderBy(mindHistory.id);
    }

    return c.json(rows);
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
  // List system events for a mind (schedule fires, wake summaries, lifecycle, notices…)
  // with their reflections. Self-or-admin only. Named /system-events because
  // GET /:name/events is the live SSE stream above.
  .get("/:name/system-events", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
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
  .get("/:name/history", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const session = c.req.query("session");
    const full = c.req.query("full") === "true";
    const preset = c.req.query("preset") as
      | "summary"
      | "conversation"
      | "detailed"
      | "all"
      | undefined;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const db = await getDb();
    const conditions = [eq(mindHistory.mind, name)];
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
