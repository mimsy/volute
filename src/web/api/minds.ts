import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  findOpenClawSession,
  importOpenClawConnectors,
  importPiSession,
  parseNameFromIdentity,
} from "../../commands/import.js";
import { qualifyModelId, resolveTemplate, unqualifyModelId } from "../../lib/ai-service.js";
import { type ExportManifest, isHomeOnlyArchive } from "../../lib/archive.js";
import { deleteMindUser } from "../../lib/auth.js";
import { CHANNELS } from "../../lib/channels.js";
import { consolidateMemory } from "../../lib/consolidate.js";
import { convertSession } from "../../lib/convert-session.js";
import { getMindManager } from "../../lib/daemon/mind-manager.js";
// Lifecycle functions from mind-service.ts
import {
  startMindFull as startMindFullService,
  stopMindFull as stopMindFullService,
} from "../../lib/daemon/mind-service.js";
import { getTokenBudget } from "../../lib/daemon/token-budget.js";
import { summarizeTurn } from "../../lib/daemon/turn-summarizer.js";
import {
  assignSession,
  completeTurn,
  createTurn,
  getActiveTurnId,
  trackToolUse,
} from "../../lib/daemon/turn-tracker.js";
import { getDb } from "../../lib/db.js";
import { getDeliveryManager } from "../../lib/delivery/delivery-manager.js";
import { recordInbound, tagUntaggedInbound } from "../../lib/delivery/message-delivery.js";
import { broadcast } from "../../lib/events/activity-events.js";
import {
  addMessage,
  getConversation,
  getMessages,
  getMessagesPaginated,
  isConversationForMind,
  isParticipant,
  listConversationsForMind,
} from "../../lib/events/conversations.js";
import { onMindEvent } from "../../lib/events/mind-activity-tracker.js";
import {
  publish as publishMindEvent,
  subscribe as subscribeMindEvent,
} from "../../lib/events/mind-events.js";
import { exec, gitExec } from "../../lib/exec.js";
import { checkHealth } from "../../lib/health.js";
import { generateIdentity, publishPublicKey } from "../../lib/identity.js";
import {
  chownMindDir,
  createMindUser,
  deleteMindUser as deleteIsolationUser,
  ensureVoluteGroup,
  isIsolationEnabled,
  wrapForIsolation,
} from "../../lib/isolation.js";
import log from "../../lib/logger.js";
import {
  getMindPromptDefaults,
  getPrompt,
  getPromptIfCustom,
  substitute,
} from "../../lib/prompts.js";
import {
  addMind,
  ensureVoluteHome,
  findMind,
  findVariants,
  getBaseName,
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  setMindStage,
  setMindTemplateHash,
  stateDir,
  validateMindName,
} from "../../lib/registry.js";
import { activity, conversations, mindHistory, turns } from "../../lib/schema.js";
import { addSharedWorktree, removeSharedWorktree } from "../../lib/shared.js";
import { getStandardSkillsWithExtensions, installSkill, SEED_SKILLS } from "../../lib/skills.js";
import { announceToSystem } from "../../lib/system-channel.js";
import { readSystemsConfig } from "../../lib/systems-config.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../../lib/template.js";
import { computeTemplateHash } from "../../lib/template-hash.js";
import { getTypingMap, publishTypingForChannels } from "../../lib/typing.js";
import { cleanupVariant } from "../../lib/variant-cleanup.js";
import { validateBranchName } from "../../lib/variants.js";
import { readVoluteConfig, writeVoluteConfig } from "../../lib/volute-config.js";
import { fireWebhook } from "../../lib/webhook.js";
import {
  type AuthEnv,
  requireAdmin,
  requireAdminOrSystem,
  requireSelf,
} from "../middleware/auth.js";

/** Event types that trigger turn creation (hoisted for perf — avoid per-request allocation). */
const SUBSTANTIVE_TYPES = new Set(["thinking", "text", "tool_use", "tool_result", "outbound"]);

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
};

async function getMindStatus(name: string, port: number) {
  const manager = getMindManager();
  let status: "running" | "stopped" | "starting" | "sleeping" = "stopped";

  // Check sleep state first
  try {
    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    if (getSleepManagerIfReady()?.isSleeping(name)) {
      status = "sleeping";
    }
  } catch {}

  if (status !== "sleeping" && manager.isRunning(name)) {
    const health = await checkHealth(port);
    status = health.ok ? "running" : "starting";
  }

  const config = readVoluteConfig(mindDir(name));
  const channels: ChannelStatus[] = [];

  // Built-in channels (e.g. volute)
  for (const [, provider] of Object.entries(CHANNELS)) {
    if (!provider.builtIn) continue;
    channels.push({
      name: provider.name,
      displayName: provider.displayName,
      status: status === "running" ? "connected" : "disconnected",
    });
  }

  return {
    status,
    channels,
    displayName: config?.profile?.displayName,
    description: config?.profile?.description,
    avatar: config?.profile?.avatar,
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
 * Run npm install in a directory, using the mind user's identity when isolation is enabled.
 * This avoids creating root-owned node_modules that the mind can't modify later.
 */
async function npmInstallAsMind(cwd: string, mindName: string): Promise<void> {
  if (isIsolationEnabled()) {
    const [cmd, args] = await wrapForIsolation("npm", ["install"], mindName);
    await exec(cmd, args, { cwd, env: { ...process.env, HOME: resolve(cwd, "home") } });
  } else {
    await exec("npm", ["install"], { cwd });
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
): Promise<{ ok: true; warning?: string }> {
  // Auto-commit any uncommitted changes in main worktree
  const mainStatus = (await gitExec(["status", "--porcelain"], { cwd: dir })).trim();
  if (mainStatus) {
    await gitExec(["add", "-A"], { cwd: dir });
    await gitExec(["commit", "-m", "Auto-commit before upgrade merge"], { cwd: dir });
  }

  await gitExec(["merge", upgradeBranch], { cwd: dir });

  // Merge succeeded — everything below is best-effort cleanup/restart
  try {
    await cleanupVariant(upgradeVariantName, dir, worktreeDir);
  } catch (err) {
    log.warn(`failed to clean up upgrade worktree for ${mindName}`, log.errorData(err));
  }
  try {
    await gitExec(["branch", "-D", upgradeBranch], { cwd: dir });
  } catch {
    // branch may already be deleted by cleanupVariant
  }

  try {
    await setMindTemplateHash(mindName, computeTemplateHash(template));
  } catch (err) {
    log.warn(`failed to update template hash for ${mindName}`, log.errorData(err));
  }

  try {
    await npmInstallAsMind(dir, mindName);
  } catch (err) {
    log.warn(`npm install failed after upgrade merge for ${mindName}`, log.errorData(err));
    return {
      ok: true,
      warning: `Upgrade merged but npm install failed: ${err instanceof Error ? err.message : String(err)}. You may need to run npm install manually.`,
    };
  }

  // Restart mind with upgrade context
  const manager = getMindManager();
  try {
    if (manager.isRunning(mindName)) {
      await manager.stopMind(mindName);
    }
    manager.setPendingContext(mindName, { type: "upgraded" });
    await manager.startMind(mindName);
  } catch (e) {
    return {
      ok: true,
      warning: `Upgrade merged but mind restart failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true };
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
    chownMindDir(dest, name);

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
    chownMindDir(dest, name);

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
    chownMindDir(dest, name);

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

    // 11. Shared worktree setup (non-fatal — mind works fine without it)
    try {
      await addSharedWorktree(name, dest);
    } catch (err) {
      log.warn(`failed to add shared worktree for ${name}`, log.errorData(err));
    }

    // 12. Install skills based on stage
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
    chownMindDir(dest, name);
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
          session: row.session ?? null,
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

const app = new Hono<AuthEnv>()
  .post("/", requireAdminOrSystem, zValidator("json", createMindSchema), async (c) => {
    const body = c.req.valid("json");

    const { name } = body;
    const template = body.template ?? resolveTemplate(body.model);

    const nameErr = validateMindName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    if (await findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

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

      // Merge default schedules, sleep config, and description into volute.json
      {
        const config = readVoluteConfig(dest);
        if (!config) throw new Error("Failed to read volute.json after identity generation");
        if (body.description) {
          config.profile = { ...config.profile, description: body.description };
        }
        if (!config.sleep) {
          config.sleep = {
            enabled: true,
            schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" },
          };
        }
        if (!config.schedules || config.schedules.length === 0) {
          config.schedules = [
            {
              id: "heartbeat",
              cron: "0 12,16,20 * * *",
              message:
                "A quiet moment. You might write something — a note, a journal entry, a page. You could explore a topic that interests you, check in on #system, or just think. No obligations, just time.",
              enabled: true,
              whileSleeping: "skip",
            },
          ];
        }
        writeVoluteConfig(dest, config);
      }

      if (body.model) {
        const configPath = resolve(dest, "home/.config/config.json");
        const existing = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf-8"))
          : {};
        // Pi template needs provider:model format; other templates need bare model ID
        existing.model =
          template === "pi" ? qualifyModelId(body.model) : unqualifyModelId(body.model);
        writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
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
      chownMindDir(dest, name);

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

      // Add shared worktree (non-fatal — mind works fine without it)
      try {
        await addSharedWorktree(name, dest);
      } catch (err) {
        log.warn(`failed to add shared worktree for ${name}`, log.errorData(err));
      }

      // Fix ownership after root git/file operations
      chownMindDir(dest, name);

      if (body.stage === "seed") {
        // Write orientation SOUL.md
        const descLine = body.description
          ? `\nThe human who planted you described you as: "${body.description}"\n`
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
      const skillSet =
        body.skills ?? (body.stage === "seed" ? SEED_SKILLS : getStandardSkillsWithExtensions());
      const skillWarnings: string[] = [];
      for (const skillId of skillSet) {
        try {
          await installSkill(name, dest, skillId);
        } catch (err) {
          log.error(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
          skillWarnings.push(`Failed to install skill: ${skillId}`);
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

      return c.json({
        ok: true,
        name,
        port,
        stage: body.stage ?? "sprouted",
        message: `Created mind: ${name} (port ${port})`,
        ...(gitWarning && { warning: gitWarning }),
        ...(skillWarnings.length > 0 && { skillWarnings }),
      });
    } catch (err) {
      // Clean up partial state
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      try {
        await removeMind(name);
      } catch {
        // ignore cleanup errors
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
      chownMindDir(dest, name);

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

      // Add shared worktree (non-fatal)
      try {
        await addSharedWorktree(name, dest);
      } catch (err) {
        log.warn(`failed to add shared worktree for ${name}`, log.errorData(err));
      }

      // Fix ownership after root git/file operations
      chownMindDir(dest, name);

      // Auto-publish public key to volute.systems (non-blocking)
      publishPublicKey(name, importPublicKey).catch((err: unknown) =>
        log.warn(`failed to publish key for ${name}`, { error: (err as Error).message }),
      );

      return c.json({ ok: true, name, port, message: `Imported mind: ${name} (port ${port})` });
    } catch (err) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      try {
        await removeMind(name);
      } catch {
        // ignore cleanup errors
      }
      return c.json({ error: err instanceof Error ? err.message : "Failed to import mind" }, 500);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  })
  // List all minds
  .get("/", async (c) => {
    const entries = await readRegistry();
    let lastActiveMap = new Map<string, string>();
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
    } catch {
      // Non-essential: degrade gracefully without activity data
    }

    const minds = await Promise.all(
      entries.map(async (entry) => {
        const mindStatus = await getMindStatus(entry.name, entry.port);
        const hasPages = existsSync(resolve(mindDir(entry.name), "home", "public", "pages"));
        return {
          ...entry,
          ...mindStatus,
          hasPages,
          lastActiveAt: lastActiveMap.get(entry.name) ?? null,
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

    const mindStatus = await getMindStatus(name, entry.port);

    // Include variant info
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

    const hasPages = existsSync(resolve(mindDir(name), "home", "public", "pages"));
    return c.json({ ...entry, ...mindStatus, variants: variantStatuses, hasPages });
  })
  // Start mind (supports variants) — admin only
  .post("/:name/start", requireSelf(), async (c) => {
    const name = c.req.param("name");

    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const targetPort = entry.port;
    if (entry.parent) {
      if (!entry.dir) return c.json({ error: `Variant ${name} has no directory` }, 404);
    } else {
      const dir = mindDir(name);
      if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);
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
    if (entry.parent) {
      if (!entry.dir) return c.json({ error: `Variant ${name} has no directory` }, 404);
    } else {
      const dir = mindDir(name);
      if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);
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

          // Merge, cleanup worktree/branch, reinstall
          await gitExec(["merge", variantEntry.branch], { cwd: projectRoot });
          await cleanupVariant(mergeVariantName, projectRoot, variantEntry.dir);
          try {
            await npmInstallAsMind(projectRoot, baseName);
          } catch (e) {
            log.error(`npm install failed after merge for ${baseName}`, log.errorData(e));
          }
        }
      }

      // Store context for delivery after restart (skip "reload" — identity file
      // edits and compaction are self-initiated, so the mind doesn't need a notification)
      if (context && context.type !== "reload") {
        manager.setPendingContext(name, context);
      }

      // Inject "[seed has sprouted]" system message into active volute conversations
      if (context?.type === "sprouted" && !entry.parent) {
        try {
          const db = await getDb();
          const activeConvs = await db
            .select({ id: conversations.id, channel: conversations.channel })
            .from(conversations)
            .where(eq(conversations.mind_name, baseName))
            .all();
          for (const conv of activeConvs) {
            await recordInbound(baseName, conv.channel, "system", "[seed has sprouted]");
            await addMessage(conv.id, "assistant", "system", [
              { type: "text", text: "[seed has sprouted]" },
            ]);
          }
        } catch (err) {
          log.error(`failed to inject sprouted message for ${baseName}`, log.errorData(err));
        }
      }

      await startMindFullService(name);
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
  // Initiate sleep — admin only
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
  // Wake a sleeping mind — admin only
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
  // Flush queued sleep messages — admin only
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
  // Sprout a seed mind — admin only
  .post("/:name/sprout", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage !== "seed") {
      return c.json({ error: `Mind is not a seed (stage: ${entry.stage})` }, 409);
    }
    await setMindStage(name, "sprouted");
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
        await cleanupVariant(s.name, dir, s.dir, { stop: true });
      }
    }

    // Clean up shared worktree (best effort)
    try {
      await removeSharedWorktree(name, dir);
    } catch (err) {
      log.warn(`failed to clean up shared worktree for ${name}`, log.errorData(err));
    }

    await removeMind(name);
    await deleteMindUser(name);

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

    const template = body.template ?? entry.template ?? "claude";
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

        await cleanupVariant(upgradeVariantName, dir, worktreeDir, { stop: true });

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
      chownMindDir(dir, mindName);

      // Merge upgrade branch back to main, cleanup, and restart
      try {
        const result = await mergeUpgradeAndRestart(
          mindName,
          dir,
          worktreeDir,
          upgradeVariantName,
          UPGRADE_BRANCH,
          template,
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
          await cleanupVariant(upgradeVariantName, dir, worktreeDir, { stop: true });
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
        chownMindDir(dir, mindName);
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

    // Retroactively add shared worktree if missing (pre-feature minds)
    if (!existsSync(resolve(dir, "home", "shared"))) {
      try {
        await addSharedWorktree(mindName, dir);
      } catch (err) {
        log.warn(
          `failed to add shared worktree during upgrade for ${mindName}`,
          log.errorData(err),
        );
      }
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
    chownMindDir(dir, mindName);

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
      );
      return c.json(result);
    } catch (err) {
      // Merge failed — clean up
      try {
        await cleanupVariant(upgradeVariantName, dir, worktreeDir);
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
      return c.json({ items: msgs, hasMore: false });
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
    return c.json({ items: result.messages, hasMore: result.hasMore });
  })
  // Budget status
  .get("/:name/budget", async (c) => {
    const name = c.req.param("name");
    const baseName = await getBaseName(name);
    const usage = getTokenBudget().getUsage(baseName);
    if (!usage) return c.json({ error: "No budget configured" }, 404);
    return c.json(usage);
  })
  // Get mind config (registry + volute.json + env)
  .get("/:name/config", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
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

    return c.json({
      registry: {
        name: entry.name,
        port: entry.port,
        created: entry.created,
        stage: entry.stage,
        template: entry.template,
      },
      config: {
        model: config?.model ?? null,
        thinkingLevel: config?.thinkingLevel ?? null,
        tokenBudget: config?.tokenBudget ?? null,
        tokenBudgetPeriodMinutes: config?.tokenBudgetPeriodMinutes ?? null,
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
      }),
    ),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const dir = mindDir(name);
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

      writeVoluteConfig(dir, existing);
      return c.json({ ok: true });
    },
  )
  // Get pending/gated delivery messages
  .get("/:name/delivery/pending", async (c) => {
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

    // Assign session to sessionless turn on first session_start
    if (body.type === "session_start" && body.session) {
      const activeTurnId = getActiveTurnId(baseName);
      if (activeTurnId) {
        await assignSession(baseName, activeTurnId, body.session);
      }
    }

    // Look up active turn for this event; create one if missing for substantive events.
    // Turns are created per-session when the mind starts processing, not when inbound arrives.
    let turnId = getActiveTurnId(baseName, body.session);
    if (!turnId && SUBSTANTIVE_TYPES.has(body.type)) {
      turnId = await createTurn(baseName);
      if (!turnId) {
        // DB failure — skip turn tracking for this event
        log.warn(`skipping turn tracking for ${baseName}: createTurn failed`);
      } else {
        publishMindEvent(baseName, { mind: baseName, type: "turn_created", turnId });
        if (body.session) {
          await assignSession(baseName, turnId, body.session);
        }
        // Link trigger and retroactively tag recent untagged inbound events/messages
        try {
          await tagUntaggedInbound(baseName, turnId, {
            setTrigger: true,
            channel: body.channel,
          });
        } catch (err) {
          log.warn(
            `failed to link trigger/tag inbounds for turn ${turnId} (mind: ${baseName})`,
            log.errorData(err),
          );
        }
      } // end if (turnId) after createTurn
    }

    // Persist to mind_history
    const db = await getDb();
    let insertedId: number | undefined;
    try {
      const result = await db
        .insert(mindHistory)
        .values({
          mind: baseName,
          type: body.type,
          session: body.session ?? null,
          channel: body.channel ?? null,
          message_id: body.messageId ?? null,
          content: body.content ?? null,
          metadata: body.metadata ? JSON.stringify(body.metadata) : null,
          turn_id: turnId ?? null,
        })
        .returning({ id: mindHistory.id });
      insertedId = result[0]?.id;
    } catch (err) {
      log.error(`failed to persist event for ${baseName}`, log.errorData(err));
      // Continue — persistence is best-effort, don't block real-time streaming
    }

    // Track tool_use events for source_event_id linking
    if (body.type === "tool_use" && insertedId != null) {
      trackToolUse(baseName, body.session, insertedId);
    }

    // Publish to in-process pub-sub
    publishMindEvent(baseName, {
      mind: baseName,
      type: body.type,
      session: body.session,
      channel: body.channel,
      messageId: body.messageId,
      content: body.content,
      metadata: body.metadata,
      turnId: turnId ?? undefined,
    });

    // Track mind activity for dashboard timeline
    onMindEvent(baseName, body.type, body.channel);

    // Clear typing on first outbound event for a channel (text, outbound)
    // Use deleteSender to clear both slug and conversationId-based keys
    if ((body.type === "text" || body.type === "outbound") && body.channel) {
      const map = getTypingMap();
      const affected = map.deleteSender(baseName);
      publishTypingForChannels(affected, map);
    }

    // Clear all typing + notify delivery manager when mind finishes processing
    if (body.type === "done") {
      const map = getTypingMap();
      const affected = map.deleteSender(baseName);
      publishTypingForChannels(affected, map);
      // Broadcast mind_done to SSE subscribers (ephemeral — not persisted to DB)
      broadcast({ type: "mind_done", mind: baseName, summary: "Finished processing" });
      // Notify delivery manager of session completion (synchronous — decrement
      // must happen atomically before the busy check to avoid race conditions
      // where a concurrent delivery's incrementActive interleaves)
      try {
        getDeliveryManager().sessionDone(baseName, body.session);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("not initialized"))) {
          log.error(`delivery manager sessionDone failed for ${baseName}`, log.errorData(err));
        }
      }
      // Complete the turn if the session has no more pending deliveries.
      // When messages arrive mid-turn, their incrementActive() keeps the
      // count > 0, so we skip here. The subsequent done will re-check.
      try {
        // Only gate on delivery busy state when we have a session to check.
        // Sessionless done events (e.g., background/system work) complete immediately
        // to avoid being blocked by unrelated active sessions.
        const dm = getDeliveryManager();
        const busy = body.session ? dm.isSessionBusy(baseName, body.session) : false;
        if (!busy) {
          const completedTurnId = await completeTurn(baseName, body.session);
          if (insertedId != null) {
            summarizeTurn(baseName, body.session, body.channel, insertedId, completedTurnId).catch(
              (err) => log.error("turn summarization failed", log.errorData(err)),
            );
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("not initialized"))) {
          log.error("turn completion check failed", log.errorData(err));
        }
        // DM unavailable — complete immediately as fallback
        const completedTurnId = await completeTurn(baseName, body.session);
        if (insertedId != null) {
          summarizeTurn(baseName, body.session, body.channel, insertedId, completedTurnId).catch(
            (err) => log.error("turn summarization failed", log.errorData(err)),
          );
        }
      }
    }

    // Record usage against budget
    if (body.type === "usage" && body.metadata) {
      const inputTokens = (body.metadata.input_tokens as number) ?? 0;
      const outputTokens = (body.metadata.output_tokens as number) ?? 0;
      getTokenBudget().recordUsage(baseName, inputTokens, outputTokens);
    }

    return c.json({ ok: true });
  })
  // SSE endpoint for mind events
  .get("/:name/events", async (c) => {
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

    // Look up active turn for this mind (outbound happens during a turn)
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
  .get("/:name/history/sessions", async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .select({
        session: mindHistory.session,
        started_at: sql<string>`MIN(${mindHistory.created_at})`,
        event_count: sql<number>`COUNT(*)`,
        message_count: sql<number>`SUM(CASE WHEN ${mindHistory.type} IN ('inbound','outbound') THEN 1 ELSE 0 END)`,
        tool_count: sql<number>`SUM(CASE WHEN ${mindHistory.type}='tool_use' THEN 1 ELSE 0 END)`,
      })
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, name), sql`${mindHistory.session} IS NOT NULL`))
      .groupBy(mindHistory.session)
      .orderBy(sql`MIN(${mindHistory.created_at}) DESC`);
    return c.json(rows);
  })
  // Get message history
  .get("/:name/history/channels", async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .selectDistinct({ channel: mindHistory.channel })
      .from(mindHistory)
      .where(eq(mindHistory.mind, name));
    return c.json(rows.map((r) => r.channel));
  })
  .get("/:name/history/export", async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, name));
    return c.json(rows);
  })
  .get("/:name/history/turns", async (c) => {
    const name = c.req.param("name");
    const turnIdFilter = c.req.query("turnId");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const db = await getDb();

    // 1. Get turns for this mind
    const conditions = [eq(turns.mind, name)];
    if (turnIdFilter) conditions.push(eq(turns.id, turnIdFilter));
    const turnRows = await db
      .select()
      .from(turns)
      .where(and(...conditions))
      .orderBy(desc(turns.created_at))
      .limit(limit)
      .offset(offset);

    if (turnRows.length === 0) return c.json([]);

    const turnIds = turnRows.map((t) => t.id);

    // 2. Get summaries
    const summaryRows = await db
      .select()
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          eq(mindHistory.type, "summary"),
          inArray(mindHistory.turn_id, turnIds),
        ),
      );
    const summaryByTurn = new Map<string, { content: string; metadata: string | null }>();
    for (const s of summaryRows) {
      if (s.turn_id)
        summaryByTurn.set(s.turn_id, { content: s.content ?? "", metadata: s.metadata });
    }

    // 3. Get inbound/outbound events from mind_history for these turns.
    // We use mind_history instead of the messages table because mind_history has
    // correct per-mind turn_id tagging. The messages table can only hold one turn_id,
    // so mind-to-mind messages get tagged with the sender's turn, not the receiver's.
    const historyMsgRows = await db
      .select({
        id: mindHistory.id,
        type: mindHistory.type,
        channel: mindHistory.channel,
        sender: mindHistory.sender,
        content: mindHistory.content,
        turn_id: mindHistory.turn_id,
        created_at: mindHistory.created_at,
      })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          inArray(mindHistory.turn_id, turnIds),
          sql`${mindHistory.type} IN ('inbound', 'outbound')`,
        ),
      )
      .orderBy(mindHistory.created_at);

    // Group all events by turn and channel
    type ConvEvent = {
      id: number;
      role: "user" | "assistant";
      sender: string | null;
      content: string | null;
      created_at: string | null;
    };
    const msgsByTurnChannel = new Map<string, Map<string, ConvEvent[]>>();

    function addToTurnChannel(turnId: string, channel: string, event: ConvEvent) {
      let byChannel = msgsByTurnChannel.get(turnId);
      if (!byChannel) {
        byChannel = new Map();
        msgsByTurnChannel.set(turnId, byChannel);
      }
      let arr = byChannel.get(channel);
      if (!arr) {
        arr = [];
        byChannel.set(channel, arr);
      }
      arr.push(event);
    }

    // Add inbound and outbound events from mind_history
    for (const m of historyMsgRows) {
      if (!m.turn_id || !m.channel) continue;
      addToTurnChannel(m.turn_id, m.channel, {
        id: m.id,
        role: m.type === "inbound" ? "user" : "assistant",
        sender: m.type === "inbound" ? (m.sender ?? null) : name,
        content: m.content,
        created_at: m.created_at,
      });
    }

    // Build conversation label from channel slug
    function getChannelLabel(channel: string): { label: string; type: "dm" | "channel" } {
      const isDM = channel.startsWith("@");
      const colonIdx = channel.indexOf(":");
      const raw = colonIdx >= 0 ? channel.substring(colonIdx + 1) : channel;
      const label = isDM ? raw : raw.startsWith("#") ? raw : `#${raw}`;
      return { label, type: isDM ? "dm" : "channel" };
    }

    // 4. Get activities linked to these turns
    const activityRows = await db
      .select()
      .from(activity)
      .where(inArray(activity.turn_id, turnIds))
      .orderBy(activity.created_at);

    const activitiesByTurn = new Map<string, typeof activityRows>();
    for (const a of activityRows) {
      if (!a.turn_id) continue;
      let arr = activitiesByTurn.get(a.turn_id);
      if (!arr) {
        arr = [];
        activitiesByTurn.set(a.turn_id, arr);
      }
      arr.push(a);
    }

    // 5. Fetch trigger events for turns that have trigger_event_id
    const triggerIds = turnRows
      .filter((t) => t.trigger_event_id != null)
      .map((t) => t.trigger_event_id!);
    const triggerMap = new Map<
      number,
      { channel: string | null; sender: string | null; content: string | null }
    >();
    if (triggerIds.length > 0) {
      const triggerRows = await db
        .select({
          id: mindHistory.id,
          channel: mindHistory.channel,
          sender: mindHistory.sender,
          content: mindHistory.content,
        })
        .from(mindHistory)
        .where(inArray(mindHistory.id, triggerIds));
      for (const r of triggerRows) triggerMap.set(r.id, r);
    }

    // 6. Assemble response
    const result = turnRows.map((t) => {
      const summary = summaryByTurn.get(t.id);
      const turnChannels = msgsByTurnChannel.get(t.id) ?? new Map<string, ConvEvent[]>();
      const convEntries = [...turnChannels.entries()].map(([channel, evts]) => {
        const { label, type } = getChannelLabel(channel);
        return {
          id: channel,
          label,
          type,
          messages: evts.map((m) => ({
            id: m.id,
            role: m.role as string,
            sender_name: m.sender,
            content: [{ type: "text", text: m.content ?? "" }],
            source_event_id: m.id,
            created_at: m.created_at,
          })),
        };
      });

      const turnActivities = (activitiesByTurn.get(t.id) ?? []).map((a) => {
        let metadata: Record<string, unknown> | null = null;
        if (a.metadata) {
          try {
            metadata = JSON.parse(a.metadata);
          } catch (err) {
            log.debug(`malformed activity metadata for activity ${a.id}`, log.errorData(err));
          }
        }
        return {
          id: a.id,
          type: a.type,
          summary: a.summary,
          metadata,
          source_event_id: a.source_event_id,
          created_at: a.created_at,
        };
      });

      let summaryMeta: Record<string, unknown> | null = null;
      if (summary?.metadata) {
        try {
          summaryMeta = JSON.parse(summary.metadata);
        } catch (err) {
          log.debug(`malformed summary metadata for turn ${t.id}`, log.errorData(err));
        }
      }

      const trigger = t.trigger_event_id ? triggerMap.get(t.trigger_event_id) : null;

      return {
        id: t.id,
        summary: summary?.content ?? null,
        summary_meta: summaryMeta,
        status: t.status,
        created_at: t.created_at,
        trigger: trigger
          ? { channel: trigger.channel, sender: trigger.sender, content: trigger.content }
          : null,
        conversations: convEntries,
        activities: turnActivities,
      };
    });

    return c.json(result);
  })
  .get("/:name/history/turn", async (c) => {
    const name = c.req.param("name");
    const turnId = c.req.query("turn_id");

    const db = await getDb();

    // Prefer turn_id-based query; fall back to legacy session+range
    if (turnId) {
      const rows = await db
        .select()
        .from(mindHistory)
        .where(
          and(
            eq(mindHistory.mind, name),
            eq(mindHistory.turn_id, turnId),
            sql`${mindHistory.type} IN ('inbound','outbound','tool_use','tool_result','text','thinking')`,
          ),
        )
        .orderBy(mindHistory.id);
      return c.json(rows);
    }

    // Legacy: session + from_id/to_id range
    const session = c.req.query("session");
    const fromId = parseInt(c.req.query("from_id") ?? "", 10);
    const toId = parseInt(c.req.query("to_id") ?? "", 10);
    if (!session || Number.isNaN(fromId) || Number.isNaN(toId)) {
      return c.json({ error: "turn_id, or session with from_id and to_id, required" }, 400);
    }

    const rows = await db
      .select()
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, name),
          eq(mindHistory.session, session),
          sql`${mindHistory.id} >= ${fromId}`,
          sql`${mindHistory.id} <= ${toId}`,
          sql`${mindHistory.type} IN ('inbound','outbound','tool_use','tool_result','text','thinking')`,
        ),
      )
      .orderBy(mindHistory.id);

    return c.json(rows);
  })
  .get("/:name/history/cross-session", async (c) => {
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
            eq(mindHistory.session, currentSession),
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

    // Query summaries from other sessions since the timestamp
    const conditions = [
      eq(mindHistory.mind, name),
      eq(mindHistory.type, "summary"),
      sql`${mindHistory.created_at} > ${sinceTimestamp}`,
    ];
    if (currentSession) {
      conditions.push(sql`${mindHistory.session} != ${currentSession}`);
    }

    const rows = await db
      .select({
        session: mindHistory.session,
        content: mindHistory.content,
        created_at: mindHistory.created_at,
      })
      .from(mindHistory)
      .where(and(...conditions))
      .orderBy(desc(mindHistory.created_at))
      .limit(50);

    if (rows.length === 0) {
      return c.json({ context: null });
    }

    // Format as [Session Activity] block
    const lines = rows.map((row) => {
      const ts = new Date(row.created_at.endsWith("Z") ? row.created_at : `${row.created_at}Z`);
      const ago = formatTimeAgo(ts);
      return `- ${row.session ?? "unknown"} (${ago}): ${row.content ?? ""}`;
    });

    return c.json({ context: `[Session Activity]\n${lines.join("\n")}` });
  })
  .get("/:name/history", async (c) => {
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
      conditions.push(eq(mindHistory.session, session));
    }

    // Preset-based type filtering
    const effectivePreset = full ? "all" : preset;
    switch (effectivePreset) {
      case "all":
        // No type filter
        break;
      case "conversation":
        conditions.push(sql`${mindHistory.type} IN ('summary','inbound','outbound','tool_use')`);
        break;
      case "detailed":
        conditions.push(
          sql`${mindHistory.type} IN ('summary','inbound','outbound','tool_use','tool_result','text','thinking')`,
        );
        break;
      default:
        conditions.push(sql`${mindHistory.type} IN ('summary')`);
        break;
    }

    const rows = await db
      .select()
      .from(mindHistory)
      .where(and(...conditions))
      .orderBy(desc(mindHistory.created_at))
      .limit(limit)
      .offset(offset);

    return c.json(rows);
  });

export default app;
