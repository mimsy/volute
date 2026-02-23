import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  findOpenClawSession,
  importOpenClawConnectors,
  importPiSession,
  parseNameFromIdentity,
} from "../../commands/import.js";
import { deleteMindUser } from "../../lib/auth.js";
import { CHANNELS } from "../../lib/channels.js";
import { getConnectorManager } from "../../lib/connector-manager.js";
import { consolidateMemory } from "../../lib/consolidate.js";
import { addMessage } from "../../lib/conversations.js";
import { convertSession } from "../../lib/convert-session.js";
import { getDb } from "../../lib/db.js";
import { getDeliveryManager } from "../../lib/delivery-manager.js";
import { exec, gitExec } from "../../lib/exec.js";
import {
  generateIdentity,
  getFingerprint,
  getPrivateKey,
  getPublicKey,
  publishPublicKey,
  signMessage,
} from "../../lib/identity.js";
import {
  chownMindDir,
  createMindUser,
  deleteMindUser as deleteIsolationUser,
  ensureVoluteGroup,
  isIsolationEnabled,
  wrapForIsolation,
} from "../../lib/isolation.js";
import log from "../../lib/logger.js";
import { extractTextContent } from "../../lib/message-delivery.js";
import {
  publish as publishMindEvent,
  subscribe as subscribeMindEvent,
} from "../../lib/mind-events.js";
import { getMindManager } from "../../lib/mind-manager.js";
// Lifecycle functions from mind-service.ts
import {
  startMindFull as startMindFullService,
  stopMindFull as stopMindFullService,
} from "../../lib/mind-service.js";
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
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  setMindStage,
  stateDir,
  validateMindName,
} from "../../lib/registry.js";
import { conversations, mindHistory } from "../../lib/schema.js";
import { addSharedWorktree, removeSharedWorktree } from "../../lib/shared.js";
import { installSkill, SEED_SKILLS, STANDARD_SKILLS } from "../../lib/skills.js";
import { readSystemsConfig } from "../../lib/systems-config.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../../lib/template.js";
import { getTokenBudget } from "../../lib/token-budget.js";
import { getTypingMap } from "../../lib/typing.js";
import {
  addVariant,
  checkHealth,
  findVariant,
  readVariants,
  removeAllVariants,
  removeVariant,
  validateBranchName,
} from "../../lib/variants.js";
import { readVoluteConfig } from "../../lib/volute-config.js";
import { type AuthEnv, requireAdmin } from "../middleware/auth.js";

type ChannelStatus = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
};

async function getMindStatus(name: string, port: number) {
  const manager = getMindManager();
  let status: "running" | "stopped" | "starting" = "stopped";

  if (manager.isRunning(name)) {
    const health = await checkHealth(port);
    status = health.ok ? "running" : "starting";
  }

  const channelConfig = readVoluteConfig(mindDir(name))?.channels;
  const channels: ChannelStatus[] = [];

  // Built-in channels (e.g. volute)
  for (const [, provider] of Object.entries(CHANNELS)) {
    if (!provider.builtIn) continue;
    channels.push({
      name: provider.name,
      displayName: provider.displayName,
      status: status === "running" ? "connected" : "disconnected",
      showToolCalls: channelConfig?.[provider.name]?.showToolCalls ?? provider.showToolCalls,
    });
  }

  // External connectors
  const connectorStatuses = getConnectorManager().getConnectorStatus(name);
  for (const cs of connectorStatuses) {
    const provider = CHANNELS[cs.type];
    channels.push({
      name: provider?.name ?? cs.type,
      displayName: provider?.displayName ?? cs.type,
      status: cs.running ? "connected" : "disconnected",
      showToolCalls: channelConfig?.[cs.type]?.showToolCalls ?? provider?.showToolCalls ?? false,
    });
  }

  return { status, channels };
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
    const [cmd, args] = wrapForIsolation("npm", ["install"], mindName);
    await exec(cmd, args, { cwd, env: { ...process.env, HOME: resolve(cwd, "home") } });
  } else {
    await exec("npm", ["install"], { cwd });
  }
}

/** Import a mind from a .volute archive (extracted to tempDir by CLI). */
async function importFromArchive(
  c: any,
  tempDir: string,
  nameOverride: string | undefined,
  manifest: import("../../lib/archive.js").ExportManifest,
) {
  const extractedMindDir = resolve(tempDir, "mind");
  if (!existsSync(extractedMindDir)) {
    return c.json({ error: "Invalid archive: missing mind/ directory" }, 400);
  }

  if (!manifest?.includes || !manifest.name || !manifest.template) {
    return c.json({ error: "Invalid archive manifest" }, 400);
  }

  const name = nameOverride ?? manifest.name;

  const nameErr = validateMindName(name);
  if (nameErr) return c.json({ error: nameErr }, 400);

  if (findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

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

    // Copy state files (channels.json, env.json) to centralized state dir
    const state = stateDir(name);
    mkdirSync(state, { recursive: true });

    const channelsJson = resolve(tempDir, "state/channels.json");
    if (existsSync(channelsJson)) {
      cpSync(channelsJson, resolve(state, "channels.json"));
    }

    const envJson = resolve(tempDir, "state/env.json");
    if (existsSync(envJson)) {
      cpSync(envJson, resolve(state, "env.json"));
    }

    // Assign port and register
    const port = nextPort();
    addMind(name, port, undefined, manifest.template);

    // Set up per-mind user isolation
    const homeDir = resolve(dest, "home");
    ensureVoluteGroup();
    createMindUser(name, homeDir);
    chownMindDir(dest, name);

    // Install dependencies
    await npmInstallAsMind(dest, name);

    // Import history rows into DB (per-line to avoid losing all rows on a single bad line)
    const historyJsonl = resolve(tempDir, "history.jsonl");
    if (existsSync(historyJsonl)) {
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

    // Import sessions — copy JSONL files to .mind/sessions/
    const sessionsDir = resolve(tempDir, "sessions");
    if (existsSync(sessionsDir)) {
      const destSessions = resolve(dest, ".mind/sessions");
      mkdirSync(destSessions, { recursive: true });
      for (const file of readdirSync(sessionsDir)) {
        cpSync(resolve(sessionsDir, file), resolve(destSessions, file));
      }
    }

    // git init if .git/ doesn't exist
    if (!existsSync(resolve(dest, ".git"))) {
      const env = isIsolationEnabled()
        ? { ...process.env, HOME: resolve(dest, "home") }
        : undefined;
      await gitExec(["init"], { cwd: dest, mindName: name, env });
      await configureGitIdentity(name, { cwd: dest, mindName: name, env });
      await gitExec(["add", "-A"], { cwd: dest, mindName: name, env });
      await gitExec(["commit", "-m", "import from archive"], { cwd: dest, mindName: name, env });
    }

    // Fix ownership
    chownMindDir(dest, name);

    // Clean up temp dir
    rmSync(tempDir, { recursive: true, force: true });

    return c.json({ ok: true, name, port, message: `Imported mind: ${name} (port ${port})` });
  } catch (err) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    try {
      removeMind(name);
    } catch (cleanupErr) {
      log.error(`Failed to clean up registry for ${name}`, log.errorData(cleanupErr));
    }
    rmSync(tempDir, { recursive: true, force: true });
    return c.json({ error: err instanceof Error ? err.message : "Failed to import mind" }, 500);
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
});

// Create mind — admin only
const app = new Hono<AuthEnv>()
  .post("/", requireAdmin, zValidator("json", createMindSchema), async (c) => {
    const body = c.req.valid("json");

    const { name, template = "claude" } = body;

    const nameErr = validateMindName(name);
    if (nameErr) return c.json({ error: nameErr }, 400);

    if (findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

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

      if (body.model) {
        const configPath = resolve(dest, "home/.config/config.json");
        const existing = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf-8"))
          : {};
        existing.model = body.model;
        writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
      }

      // Stamp prompts.json with current DB defaults
      const mindPrompts = await getMindPromptDefaults();
      writeFileSync(
        resolve(dest, "home/.config/prompts.json"),
        `${JSON.stringify(mindPrompts, null, 2)}\n`,
      );

      const port = nextPort();
      addMind(name, port, body.stage, template);

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
      const skillSet = body.skills ?? (body.stage === "seed" ? SEED_SKILLS : STANDARD_SKILLS);
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
        removeMind(name);
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
      manifest?: import("../../lib/archive.js").ExportManifest;
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

    if (findMind(name)) return c.json({ error: `Mind already exists: ${name}` }, 409);

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
      const port = nextPort();
      addMind(name, port, undefined, template);

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

      // Import connectors
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
        removeMind(name);
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
    const entries = readRegistry();
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
        const { status, channels } = await getMindStatus(entry.name, entry.port);
        const hasPages = existsSync(resolve(mindDir(entry.name), "home", "pages"));
        return {
          ...entry,
          status,
          channels,
          hasPages,
          lastActiveAt: lastActiveMap.get(entry.name) ?? null,
        };
      }),
    );
    return c.json(minds);
  })
  // Recent pages across all minds
  .get("/pages/recent", async (c) => {
    const entries = readRegistry();
    const pages: { mind: string; file: string; modified: string; url: string }[] = [];

    for (const entry of entries) {
      const pagesDir = resolve(mindDir(entry.name), "home", "pages");
      if (!existsSync(pagesDir)) continue;

      let items: string[];
      try {
        items = readdirSync(pagesDir);
      } catch (err) {
        log.warn("Failed to read pages dir", { mind: entry.name, error: (err as Error).message });
        continue;
      }

      for (const item of items) {
        const fullPath = resolve(pagesDir, item);
        try {
          const s = statSync(fullPath);
          if (s.isFile()) {
            pages.push({
              mind: entry.name,
              file: item,
              modified: s.mtime.toISOString(),
              url: `/pages/${entry.name}/${item}`,
            });
          } else if (s.isDirectory()) {
            const indexPath = resolve(fullPath, "index.html");
            if (existsSync(indexPath)) {
              const indexStat = statSync(indexPath);
              pages.push({
                mind: entry.name,
                file: join(item, "index.html"),
                modified: indexStat.mtime.toISOString(),
                url: `/pages/${entry.name}/${item}/`,
              });
            }
          }
        } catch (err) {
          log.warn("Failed to stat page item", {
            mind: entry.name,
            item,
            error: (err as Error).message,
          });
        }
      }
    }

    pages.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return c.json(pages.slice(0, 10));
  })
  // Get single mind
  .get("/:name", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    if (!existsSync(mindDir(name))) return c.json({ error: "Mind directory missing" }, 404);

    const { status, channels } = await getMindStatus(name, entry.port);

    // Include variant info
    const variants = readVariants(name);
    const manager = getMindManager();
    const variantStatuses = await Promise.all(
      variants.map(async (v) => {
        const compositeKey = `${name}@${v.name}`;
        let variantStatus: "running" | "stopped" | "starting" = "stopped";
        if (manager.isRunning(compositeKey)) {
          const health = await checkHealth(v.port);
          variantStatus = health.ok ? "running" : "starting";
        }
        return { name: v.name, port: v.port, status: variantStatus };
      }),
    );

    const hasPages = existsSync(resolve(mindDir(name), "home", "pages"));
    return c.json({ ...entry, status, channels, variants: variantStatuses, hasPages });
  })
  // Start mind (supports name@variant) — admin only
  .post("/:name/start", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    } else {
      const dir = mindDir(baseName);
      if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);
    }

    if (getMindManager().isRunning(name)) {
      return c.json({ error: "Mind already running" }, 409);
    }

    try {
      await startMindFullService(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to start mind" }, 500);
    }
  })
  // Restart mind (supports name@variant) — admin only
  // Accepts optional JSON body: { context?: { type: string, name?: string, summary?: string, ... } }
  .post("/:name/restart", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    } else {
      const dir = mindDir(baseName);
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
      // Stop running mind and connectors
      if (manager.isRunning(name)) {
        await stopMindFullService(name);
      }

      // Handle mind-initiated merge: perform merge operations directly
      if (context?.type === "merge" && context.name && !variantName) {
        const mergeVariantName = String(context.name);
        const branchErr = validateBranchName(mergeVariantName);
        if (branchErr) {
          return c.json({ error: `Invalid variant name: ${branchErr}` }, 400);
        }
        log.error(`merging variant for ${baseName}: ${mergeVariantName}`);
        const variant = findVariant(baseName, mergeVariantName);
        if (variant) {
          const projectRoot = mindDir(baseName);

          // Auto-commit variant worktree
          if (existsSync(variant.path)) {
            const status = (await gitExec(["status", "--porcelain"], { cwd: variant.path })).trim();
            if (status) {
              try {
                await gitExec(["add", "-A"], { cwd: variant.path });
                await gitExec(["commit", "-m", "Auto-commit uncommitted changes before merge"], {
                  cwd: variant.path,
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
          await gitExec(["merge", variant.branch], { cwd: projectRoot });
          if (existsSync(variant.path)) {
            try {
              await gitExec(["worktree", "remove", "--force", variant.path], {
                cwd: projectRoot,
              });
            } catch {}
          }
          try {
            await gitExec(["branch", "-D", variant.branch], { cwd: projectRoot });
          } catch {}
          removeVariant(baseName, mergeVariantName);
          chownMindDir(projectRoot, baseName);
          try {
            await npmInstallAsMind(projectRoot, baseName);
          } catch (e) {
            log.error(`npm install failed after merge for ${baseName}`, log.errorData(e));
          }
        }
      }

      // Store context for delivery after restart
      if (context) {
        manager.setPendingContext(name, context);
      }

      // Inject "[seed has sprouted]" system message into active volute conversations
      if (context?.type === "sprouted" && !variantName) {
        try {
          const db = await getDb();
          const activeConvs = await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.mind_name, baseName))
            .all();
          for (const conv of activeConvs) {
            await addMessage(conv.id, "assistant", "system", [
              { type: "text", text: "[seed has sprouted]" },
            ]);
          }
        } catch (err) {
          log.error(`failed to inject sprouted message for ${baseName}`, log.errorData(err));
        }
      }

      await startMindFullService(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to restart mind" }, 500);
    }
  })
  // Stop mind (supports name@variant) — admin only
  .post("/:name/stop", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    }

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
  // Sprout a seed mind — admin only
  .post("/:name/sprout", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);
    if (entry.stage !== "seed") {
      return c.json({ error: `Mind is not a seed (stage: ${entry.stage})` }, 409);
    }
    setMindStage(name, "sprouted");
    return c.json({ ok: true });
  })
  // Delete mind — admin only
  .delete("/:name", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const force = c.req.query("force") === "true";

    // Stop connectors and mind if running
    const manager = getMindManager();
    if (manager.isRunning(name)) {
      await stopMindFullService(name);
    }

    removeAllVariants(name);

    // Clean up shared worktree (best effort)
    try {
      await removeSharedWorktree(name, dir);
    } catch (err) {
      log.warn(`failed to clean up shared worktree for ${name}`, log.errorData(err));
    }

    removeMind(name);
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

    return c.json({ ok: true });
  })
  // Upgrade mind — admin only
  .post("/:name/upgrade", requireAdmin, async (c) => {
    const mindName = c.req.param("name");
    const entry = findMind(mindName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(mindName);
    if (!existsSync(dir)) return c.json({ error: "Mind directory missing" }, 404);

    let body: { template?: string; continue?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine
    }

    const template = body.template ?? entry.template ?? "claude";
    const UPGRADE_VARIANT = "upgrade";

    if (body.continue) {
      // Continue upgrade after conflict resolution
      const worktreeDir = resolve(dir, ".variants", UPGRADE_VARIANT);
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
        if (!msg.includes("nothing to commit")) throw e;
      }

      // Fix ownership after root git operations so npm install can run as mind user
      chownMindDir(dir, mindName);

      try {
        await npmInstallAsMind(worktreeDir, mindName);

        const variantPort = nextPort();
        addVariant(mindName, {
          name: UPGRADE_VARIANT,
          branch: UPGRADE_VARIANT,
          path: worktreeDir,
          port: variantPort,
          created: new Date().toISOString(),
        });

        await getMindManager().startMind(`${mindName}@${UPGRADE_VARIANT}`);

        return c.json({
          ok: true,
          name: mindName,
          variant: UPGRADE_VARIANT,
          port: variantPort,
        });
      } catch (err) {
        try {
          removeVariant(mindName, UPGRADE_VARIANT);
        } catch {}
        try {
          await gitExec(["worktree", "remove", "--force", worktreeDir], { cwd: dir });
        } catch {}
        try {
          await gitExec(["branch", "-D", UPGRADE_VARIANT], { cwd: dir });
        } catch {}
        try {
          chownMindDir(dir, mindName);
        } catch (chownErr) {
          log.error(
            `failed to fix ownership during upgrade cleanup for ${mindName}`,
            log.errorData(chownErr),
          );
        }
        return c.json(
          { error: err instanceof Error ? err.message : "Failed to continue upgrade" },
          500,
        );
      }
    }

    // Fresh upgrade
    const worktreeDir = resolve(dir, ".variants", UPGRADE_VARIANT);

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
      await gitExec(["branch", "-D", UPGRADE_VARIANT], { cwd: dir });
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

    await gitExec(["worktree", "add", "-b", UPGRADE_VARIANT, worktreeDir], { cwd: dir });

    // Merge template branch
    const hasConflicts = await mergeTemplateBranch(worktreeDir);

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

    // Install, register, start
    try {
      await npmInstallAsMind(worktreeDir, mindName);

      const variantPort = nextPort();
      addVariant(mindName, {
        name: UPGRADE_VARIANT,
        branch: UPGRADE_VARIANT,
        path: worktreeDir,
        port: variantPort,
        created: new Date().toISOString(),
      });

      await getMindManager().startMind(`${mindName}@${UPGRADE_VARIANT}`);

      return c.json({
        ok: true,
        name: mindName,
        variant: UPGRADE_VARIANT,
        port: variantPort,
      });
    } catch (err) {
      try {
        removeVariant(mindName, UPGRADE_VARIANT);
      } catch {}
      try {
        await gitExec(["worktree", "remove", "--force", worktreeDir], { cwd: dir });
      } catch {}
      try {
        await gitExec(["branch", "-D", UPGRADE_VARIANT], { cwd: dir });
      } catch {}
      try {
        chownMindDir(dir, mindName);
      } catch (chownErr) {
        log.error(
          `failed to fix ownership during upgrade cleanup for ${mindName}`,
          log.errorData(chownErr),
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to complete upgrade" },
        500,
      );
    }
  })
  // Proxy message to mind — enriches, then delegates to delivery manager
  .post("/:name/message", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
    }

    if (!getMindManager().isRunning(name)) {
      return c.json({ error: "Mind is not running" }, 409);
    }

    const body = await c.req.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      log.error(`failed to parse message body for ${baseName}`, log.errorData(err));
    }

    const channel = (parsed?.channel as string) ?? "unknown";

    // Record inbound message
    const db = await getDb();
    if (parsed) {
      try {
        const sender = (parsed.sender as string) ?? null;
        const content = extractTextContent(parsed.content);
        await db.insert(mindHistory).values({
          mind: baseName,
          type: "inbound",
          channel,
          sender,
          content,
        });
      } catch (err) {
        log.error(`failed to persist inbound message for ${baseName}`, log.errorData(err));
      }
    }

    // Check token budget before forwarding
    const budget = getTokenBudget();
    const budgetStatus = budget.checkBudget(baseName);

    if (budgetStatus === "exceeded") {
      const textContent = parsed ? extractTextContent(parsed.content) : "";

      budget.enqueue(baseName, {
        channel,
        sender: (parsed?.sender as string) ?? null,
        textContent,
      });

      return c.json({ error: "Token budget exceeded — message queued for next period" }, 429);
    }

    if (!parsed) return c.json({ error: "Invalid JSON" }, 400);

    // Enrich payload with currently-typing senders (exclude the receiving mind
    // and the message sender — they just sent a message, so they're not typing)
    const typingMap = getTypingMap();
    const sender = (parsed.sender as string) ?? "";
    if (sender) typingMap.delete(channel, sender);
    const currentlyTyping = typingMap.get(channel).filter((s) => s !== baseName);
    if (currentlyTyping.length > 0) {
      parsed.typing = currentlyTyping;
    }

    // Sign message BEFORE content mutation (budget warnings, seed nudges)
    // so the signature covers the original content the sender intended
    if (sender && findMind(sender)) {
      try {
        const senderDir = mindDir(sender);
        const senderPrivateKey = getPrivateKey(senderDir);
        const senderPublicKey = getPublicKey(senderDir);
        if (senderPrivateKey && senderPublicKey) {
          const textContent = extractTextContent(parsed.content);
          const timestamp = new Date().toISOString();
          parsed.signature = signMessage(senderPrivateKey, textContent, timestamp);
          parsed.signatureTimestamp = timestamp;
          parsed.signerFingerprint = getFingerprint(senderPublicKey);
        }
      } catch (err) {
        log.warn(`failed to sign message from ${sender}`, { error: (err as Error).message });
      }
    }

    // Inject one-time budget warning (triggers once at >=80% per period)
    if (budgetStatus === "warning") {
      const usage = budget.getUsage(baseName);
      const pct = usage?.percentUsed ?? 80;
      const warningText = `\n[System: Token budget is at ${pct}% — conserve tokens to avoid message queuing]`;
      if (typeof parsed.content === "string") {
        parsed.content = parsed.content + warningText;
      } else if (Array.isArray(parsed.content)) {
        parsed.content = [...parsed.content, { type: "text", text: warningText }];
      }
      budget.acknowledgeWarning(baseName);
    }

    // Nudge seed minds toward sprouting after extended conversation
    const seedEntry = findMind(baseName);
    if (seedEntry?.stage === "seed") {
      try {
        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(mindHistory)
          .where(eq(mindHistory.mind, baseName));
        const msgCount = countResult[0]?.count ?? 0;
        if (msgCount >= 10 && msgCount % 10 === 0) {
          const nudge =
            "\n[You've been exploring for a while. Whenever you feel ready, write your SOUL.md and MEMORY.md, then run volute sprout.]";
          if (typeof parsed.content === "string") {
            parsed.content = parsed.content + nudge;
          } else if (Array.isArray(parsed.content)) {
            parsed.content = [...parsed.content, { type: "text", text: nudge }];
          }
        }
      } catch (err) {
        log.error(`failed to check seed message count for ${baseName}`, log.errorData(err));
      }
    }

    // Delegate to delivery manager for routing + delivery
    const deliveryPayload: Record<string, unknown> = {
      channel: parsed.channel as string,
      sender: (parsed.sender as string) ?? null,
      content: parsed.content,
      conversationId: (parsed.conversationId as string) ?? undefined,
      typing: parsed.typing as string[] | undefined,
      platform: (parsed.platform as string) ?? undefined,
      isDM: (parsed.isDM as boolean) ?? undefined,
      participants: (parsed.participants as string[]) ?? undefined,
      participantCount: (parsed.participantCount as number) ?? undefined,
    };
    // Pass through signature fields for verification by mind
    if (parsed.signature) {
      deliveryPayload.signature = parsed.signature;
      deliveryPayload.signatureTimestamp = parsed.signatureTimestamp;
      deliveryPayload.signerFingerprint = parsed.signerFingerprint;
    }

    // Fire-and-forget: delivery manager handles routing, timing, and HTTP delivery
    getDeliveryManager()
      .routeAndDeliver(name, deliveryPayload as any)
      .catch((err) => {
        log.error(`delivery failed for ${name}`, log.errorData(err));
      });

    return c.json({ ok: true });
  })
  // Budget status
  .get("/:name/budget", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);
    const usage = getTokenBudget().getUsage(baseName);
    if (!usage) return c.json({ error: "No budget configured" }, 404);
    return c.json(usage);
  })
  // Get pending/gated delivery messages
  .get("/:name/delivery/pending", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);
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
  // Receive events from mind, persist to mind_history, publish to pub-sub
  .post("/:name/events", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);

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

    // Persist to mind_history
    const db = await getDb();
    try {
      await db.insert(mindHistory).values({
        mind: baseName,
        type: body.type,
        session: body.session ?? null,
        channel: body.channel ?? null,
        message_id: body.messageId ?? null,
        content: body.content ?? null,
        metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      });
    } catch (err) {
      log.error(`failed to persist event for ${baseName}`, log.errorData(err));
      // Continue — persistence is best-effort, don't block real-time streaming
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
    });

    // Clear typing on first outbound event for a channel (text, outbound)
    // This gives faster feedback than waiting for done
    if ((body.type === "text" || body.type === "outbound") && body.channel) {
      getTypingMap().delete(body.channel, baseName);
    }

    // Clear all typing + notify delivery manager when mind finishes processing
    if (body.type === "done") {
      if (body.channel) {
        getTypingMap().delete(body.channel, baseName);
      } else {
        getTypingMap().deleteSender(baseName);
      }
      // Notify delivery manager of session completion
      try {
        getDeliveryManager().sessionDone(baseName, body.session);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("not initialized"))) {
          log.error(`delivery manager sessionDone failed for ${baseName}`, log.errorData(err));
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
    const [baseName] = name.split("@", 2);

    const entry = findMind(baseName);
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

        const unsubscribe = subscribeMindEvent(baseName, (event) => {
          // Apply filters
          if (typeFilter && !typeFilter.includes(event.type)) return;
          if (sessionFilter && event.session !== sessionFilter) return;
          if (channelFilter && event.channel !== channelFilter) return;

          send(JSON.stringify(event));
        });

        // Clean up on close
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe();
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
  .post("/:name/history", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);

    let body: { channel: string; content: string; sender?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (!body.channel || !body.content) {
      return c.json({ error: "channel and content required" }, 400);
    }

    const db = await getDb();
    try {
      await db.insert(mindHistory).values({
        mind: baseName,
        type: "outbound",
        channel: body.channel,
        sender: body.sender ?? baseName,
        content: body.content,
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
  .get("/:name/history", async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const session = c.req.query("session");
    const full = c.req.query("full") === "true";
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
    // Default to conversation view (inbound/outbound only)
    if (!full) {
      conditions.push(sql`${mindHistory.type} IN ('inbound', 'outbound')`);
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
