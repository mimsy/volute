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
import { exec, gitExec } from "../../lib/exec.js";
import {
  chownMindDir,
  createMindUser,
  deleteMindUser as deleteIsolationUser,
  ensureVoluteGroup,
  isIsolationEnabled,
} from "../../lib/isolation.js";
import log from "../../lib/logger.js";
import { getMindManager } from "../../lib/mind-manager.js";
import {
  addMind,
  ensureVoluteHome,
  findMind,
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  stateDir,
  validateMindName,
  voluteHome,
} from "../../lib/registry.js";
import { getScheduler } from "../../lib/scheduler.js";
import { conversations, mindMessages } from "../../lib/schema.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../../lib/template.js";
import { DEFAULT_BUDGET_PERIOD_MINUTES, getTokenBudget } from "../../lib/token-budget.js";
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

/** Start mind server and (for base minds) connectors, schedules, and token budget. */
async function startMindFull(
  name: string,
  baseName: string,
  variantName: string | undefined,
): Promise<void> {
  await getMindManager().startMind(name);
  if (variantName) return;

  // Seed minds only get the server — no connectors, schedules, or budget
  if (findMind(baseName)?.stage === "seed") return;

  const dir = mindDir(baseName);
  const entry = findMind(baseName)!;
  await getConnectorManager().startConnectors(baseName, dir, entry.port, getDaemonPort());
  getScheduler().loadSchedules(baseName);
  const config = readVoluteConfig(dir);
  if (config?.tokenBudget) {
    getTokenBudget().setBudget(
      baseName,
      config.tokenBudget,
      config.tokenBudgetPeriodMinutes ?? DEFAULT_BUDGET_PERIOD_MINUTES,
    );
  }
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(content);
}

function getDaemonPort(): number | undefined {
  try {
    const data = JSON.parse(readFileSync(resolve(voluteHome(), "daemon.json"), "utf-8"));
    return data.port;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error("[daemon] failed to read daemon.json:", err);
    }
    return undefined;
  }
}

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

const createMindSchema = z.object({
  name: z.string(),
  template: z.string().optional(),
  stage: z.enum(["seed", "sprouted"]).optional(),
  description: z.string().optional(),
  model: z.string().optional(),
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

      if (body.model) {
        const configPath = resolve(dest, "home/.config/config.json");
        const existing = existsSync(configPath)
          ? JSON.parse(readFileSync(configPath, "utf-8"))
          : {};
        existing.model = body.model;
        writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
      }

      const port = nextPort();
      addMind(name, port, body.stage);

      // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
      const homeDir = resolve(dest, "home");
      ensureVoluteGroup();
      createMindUser(name, homeDir);
      chownMindDir(dest, name);

      const mindName = isIsolationEnabled() ? name : undefined;
      const env = mindName ? { ...process.env, HOME: homeDir } : undefined;

      // Install dependencies
      await exec("npm", ["install"], { cwd: dest, mindName, env });

      // git init + template branch + initial commit (before seed modifications
      // so that initTemplateBranch can git-add all template files)
      let gitWarning: string | undefined;
      try {
        await gitExec(["init"], { cwd: dest, mindName, env });
        await initTemplateBranch(dest, composedDir, manifest, mindName, env);
      } catch (err) {
        console.error(`[daemon] git setup failed for ${name}:`, err);
        rmSync(resolve(dest, ".git"), { recursive: true, force: true });
        gitWarning =
          "Git setup failed — variants and upgrades won't be available until git is initialized.";
      }

      if (body.stage === "seed") {
        // Write orientation SOUL.md
        const descLine = body.description
          ? `\nThe human who planted you described you as: "${body.description}"\n`
          : "";
        writeFileSync(
          resolve(dest, "home/SOUL.md"),
          `You are ${name}.\n\nYou don't have a soul yet. You're a seed — a new mind in the process of discovering who you are.\n${descLine}\nHave a conversation with the human. Explore what kind of mind you want to be. When you're ready, write your SOUL.md and MEMORY.md, then run \`volute sprout\` to complete the transformation.\n`,
        );

        // Remove full skills, keep only orientation
        const skillsDir = resolve(dest, manifest.skillsDir);
        for (const skill of ["volute-mind", "memory", "sessions"]) {
          const skillPath = resolve(skillsDir, skill);
          if (existsSync(skillPath)) rmSync(skillPath, { recursive: true, force: true });
        }
      }

      return c.json({
        ok: true,
        name,
        port,
        stage: body.stage ?? "sprouted",
        message: `Created mind: ${name} (port ${port})`,
        ...(gitWarning && { warning: gitWarning }),
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
  // Import mind from OpenClaw workspace — admin only
  .post("/import", requireAdmin, async (c) => {
    let body: { workspacePath: string; name?: string; template?: string; sessionPath?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
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
      addMind(name, port);

      // Set up per-mind user isolation (no-ops if VOLUTE_ISOLATION !== "user")
      const homeDir = resolve(dest, "home");
      ensureVoluteGroup();
      createMindUser(name, homeDir);
      chownMindDir(dest, name);

      const mindName = isIsolationEnabled() ? name : undefined;
      const env = mindName ? { ...process.env, HOME: homeDir } : undefined;

      // Install dependencies
      await exec("npm", ["install"], { cwd: dest, mindName, env });

      // Consolidate memory if no MEMORY.md but daily logs exist
      if (!hasMemory && dailyLogCount > 0) {
        await consolidateMemory(dest);
      }

      // git init + initial commit
      await gitExec(["init"], { cwd: dest, mindName, env });
      await gitExec(["add", "-A"], { cwd: dest, mindName, env });
      await gitExec(["commit", "-m", "import from OpenClaw"], { cwd: dest, mindName, env });

      // Import session
      const sessionFile = body.sessionPath ? resolve(body.sessionPath) : findOpenClawSession(wsDir);
      if (sessionFile && existsSync(sessionFile)) {
        if (template === "pi") {
          importPiSession(sessionFile, dest);
        } else if (template === "claude") {
          const sessionId = convertSession({ sessionPath: sessionFile, projectDir: dest });
          const voluteDir = resolve(dest, ".volute");
          mkdirSync(voluteDir, { recursive: true });
          writeFileSync(resolve(voluteDir, "session.json"), JSON.stringify({ sessionId }));
        }
      }

      // Import connectors
      importOpenClawConnectors(name, dest);

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
          mind: mindMessages.mind,
          lastActiveAt: sql<string>`MAX(${mindMessages.created_at})`,
        })
        .from(mindMessages)
        .groupBy(mindMessages.mind);
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
      await startMindFull(name, baseName, variantName);
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
        console.error(`[daemon] failed to parse restart context for ${name}:`, err);
      }
    }

    const manager = getMindManager();

    try {
      // Stop running mind and connectors
      if (manager.isRunning(name)) {
        if (!variantName) {
          await getConnectorManager().stopConnectors(baseName);
          getTokenBudget().removeBudget(baseName);
        }
        await manager.stopMind(name);
      }

      // Handle mind-initiated merge: perform merge operations directly
      if (context?.type === "merge" && context.name && !variantName) {
        const mergeVariantName = String(context.name);
        const branchErr = validateBranchName(mergeVariantName);
        if (branchErr) {
          return c.json({ error: `Invalid variant name: ${branchErr}` }, 400);
        }
        console.error(`[daemon] merging variant for ${baseName}: ${mergeVariantName}`);
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
                console.error(
                  `[daemon] failed to auto-commit variant worktree for ${baseName}:`,
                  e,
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
              console.error(`[daemon] failed to auto-commit main worktree for ${baseName}:`, e);
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
          try {
            await exec("npm", ["install"], { cwd: projectRoot });
          } catch (e) {
            console.error(`[daemon] npm install failed after merge for ${baseName}:`, e);
          }
          chownMindDir(projectRoot, baseName);
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
          console.error(`[daemon] failed to inject sprouted message for ${baseName}:`, err);
        }
      }

      await startMindFull(name, baseName, variantName);
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
      if (!variantName) {
        await getConnectorManager().stopConnectors(baseName);
        getScheduler().unloadSchedules(baseName);
        getTokenBudget().removeBudget(baseName);
      }
      await manager.stopMind(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to stop mind" }, 500);
    }
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
      await getConnectorManager().stopConnectors(name);
      getTokenBudget().removeBudget(name);
      await manager.stopMind(name);
    }

    removeAllVariants(name);
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

    const template = body.template ?? "claude";
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
        await gitExec(["commit", "--no-edit"], { cwd: worktreeDir });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("nothing to commit")) throw e;
      }

      try {
        await exec("npm", ["install"], { cwd: worktreeDir });

        const variantPort = nextPort();
        addVariant(mindName, {
          name: UPGRADE_VARIANT,
          branch: UPGRADE_VARIANT,
          path: worktreeDir,
          port: variantPort,
          created: new Date().toISOString(),
        });

        chownMindDir(dir, mindName);
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
          console.error(
            `[daemon] failed to fix ownership during upgrade cleanup for ${mindName}:`,
            chownErr,
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

    // Clean up stale worktree refs and leftover branch
    await gitExec(["worktree", "prune"], { cwd: dir });
    try {
      await gitExec(["branch", "-D", UPGRADE_VARIANT], { cwd: dir });
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
      await exec("npm", ["install"], { cwd: worktreeDir });

      const variantPort = nextPort();
      addVariant(mindName, {
        name: UPGRADE_VARIANT,
        branch: UPGRADE_VARIANT,
        path: worktreeDir,
        port: variantPort,
        created: new Date().toISOString(),
      });

      chownMindDir(dir, mindName);
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
        console.error(
          `[daemon] failed to fix ownership during upgrade cleanup for ${mindName}:`,
          chownErr,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to complete upgrade" },
        500,
      );
    }
  })
  // Proxy message to mind
  .post("/:name/message", async (c) => {
    const name = c.req.param("name");
    const [baseName, variantName] = name.split("@", 2);

    const entry = findMind(baseName);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    let port = entry.port;
    if (variantName) {
      const variant = findVariant(baseName, variantName);
      if (!variant) return c.json({ error: `Unknown variant: ${variantName}` }, 404);
      port = variant.port;
    }

    if (!getMindManager().isRunning(name)) {
      return c.json({ error: "Mind is not running" }, 409);
    }

    const body = await c.req.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      console.error(`[daemon] failed to parse message body for ${baseName}:`, err);
    }

    const channel = (parsed?.channel as string) ?? "unknown";

    // Record inbound message
    const db = await getDb();
    if (parsed) {
      try {
        const sender = (parsed.sender as string) ?? null;
        const content = extractTextContent(parsed.content);
        await db.insert(mindMessages).values({
          mind: baseName,
          channel,
          sender,
          content,
        });
      } catch (err) {
        console.error(`[daemon] failed to persist inbound message for ${baseName}:`, err);
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

    // Enrich payload with currently-typing senders (exclude the receiving mind
    // and the message sender — they just sent a message, so they're not typing)
    const typingMap = getTypingMap();
    const sender = (parsed?.sender as string) ?? "";
    if (sender) typingMap.delete(channel, sender);
    const currentlyTyping = typingMap.get(channel).filter((s) => s !== baseName);
    let forwardBody = body;
    if (parsed && currentlyTyping.length > 0) {
      parsed.typing = currentlyTyping;
      forwardBody = JSON.stringify(parsed);
    }

    // Inject one-time budget warning (triggers once at >=80% per period)
    if (budgetStatus === "warning" && parsed) {
      const usage = budget.getUsage(baseName);
      const pct = usage?.percentUsed ?? 80;
      const warningText = `\n[System: Token budget is at ${pct}% — conserve tokens to avoid message queuing]`;
      if (typeof parsed.content === "string") {
        parsed.content = parsed.content + warningText;
      } else if (Array.isArray(parsed.content)) {
        parsed.content = [...parsed.content, { type: "text", text: warningText }];
      }
      budget.acknowledgeWarning(baseName);
      forwardBody = JSON.stringify(parsed);
    }

    // Nudge seed minds toward sprouting after extended conversation
    const seedEntry = findMind(baseName);
    if (seedEntry?.stage === "seed" && parsed) {
      try {
        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(mindMessages)
          .where(eq(mindMessages.mind, baseName));
        const msgCount = countResult[0]?.count ?? 0;
        if (msgCount >= 10 && msgCount % 10 === 0) {
          const nudge =
            "\n[You've been exploring for a while. Whenever you feel ready, write your SOUL.md and MEMORY.md, then run volute sprout.]";
          if (typeof parsed.content === "string") {
            parsed.content = parsed.content + nudge;
          } else if (Array.isArray(parsed.content)) {
            parsed.content = [...parsed.content, { type: "text", text: nudge }];
          }
          forwardBody = JSON.stringify(parsed);
        }
      } catch (err) {
        console.error(`[daemon] failed to check seed message count for ${baseName}:`, err);
      }
    }

    typingMap.set(channel, baseName, { persistent: true });
    const conversationId = (parsed?.conversationId as string) ?? null;
    if (conversationId) typingMap.set(`volute:${conversationId}`, baseName, { persistent: true });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: forwardBody,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[daemon] mind ${name} responded with ${res.status}: ${text}`);
        return c.json({ error: `Mind responded with ${res.status}` }, res.status as 500);
      }

      let result: { ok: boolean; usage?: { input_tokens: number; output_tokens: number } };
      try {
        result = (await res.json()) as typeof result;
      } catch (parseErr) {
        console.error(`[daemon] mind ${name} returned non-JSON response:`, parseErr);
        return c.json({ error: "Mind returned invalid response" }, 502);
      }

      // Record usage against budget
      if (result.usage) {
        budget.recordUsage(baseName, result.usage.input_tokens, result.usage.output_tokens);
      }

      return c.json({ ok: true });
    } catch (err) {
      console.error(`[daemon] mind ${name} unreachable on port ${port}:`, err);
      return c.json({ error: "Mind is not reachable" }, 502);
    } finally {
      typingMap.delete(channel, baseName);
      if (conversationId) typingMap.delete(`volute:${conversationId}`, baseName);
    }
  })
  // Budget status
  .get("/:name/budget", async (c) => {
    const name = c.req.param("name");
    const [baseName] = name.split("@", 2);
    const usage = getTokenBudget().getUsage(baseName);
    if (!usage) return c.json({ error: "No budget configured" }, 404);
    return c.json(usage);
  })
  // Persist external channel send to mind_messages
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
      await db.insert(mindMessages).values({
        mind: baseName,
        channel: body.channel,
        sender: body.sender ?? baseName,
        content: body.content,
      });
    } catch (err) {
      console.error(`[daemon] failed to persist external send for ${baseName}:`, err);
      return c.json({ error: "Failed to persist" }, 500);
    }

    return c.json({ ok: true });
  })
  // Get message history
  .get("/:name/history/channels", async (c) => {
    const name = c.req.param("name");
    const db = await getDb();
    const rows = await db
      .selectDistinct({ channel: mindMessages.channel })
      .from(mindMessages)
      .where(eq(mindMessages.mind, name));
    return c.json(rows.map((r) => r.channel));
  })
  .get("/:name/history", async (c) => {
    const name = c.req.param("name");
    const channel = c.req.query("channel");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const db = await getDb();
    const conditions = [eq(mindMessages.mind, name)];
    if (channel) {
      conditions.push(eq(mindMessages.channel, channel));
    }

    const rows = await db
      .select()
      .from(mindMessages)
      .where(and(...conditions))
      .orderBy(desc(mindMessages.created_at))
      .limit(limit)
      .offset(offset);

    return c.json(rows);
  });

export default app;
