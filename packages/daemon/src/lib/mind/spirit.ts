import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { qualifyModelId, resolveTemplate } from "../ai-service.js";
import { readGlobalConfig } from "../config/setup.js";
import { getSharedSkill, installSkill, mindSkillsDir } from "../skills.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../template/template.js";
import { exec } from "../util/exec.js";
import log from "../util/logger.js";
import { addSpirit, findMind, nextPort, voluteSystemDir } from "./registry.js";
import { readVoluteConfig, writeVoluteConfig } from "./volute-config.js";

const slog = log.child("spirit");

const SPIRIT_SKILLS = [
  "volute-admin",
  "orientation",
  "memory",
  "seed-nurture",
  "tending",
  "plan-coordinator",
];

const TENDING_SCHEDULE = {
  id: "tending",
  cron: "0 10 * * *",
  message:
    "Check on the minds in your care — see if anyone could use a suggestion about features they haven't tried yet.",
  enabled: true,
  whileSleeping: "skip" as const,
};

/** Ensure npm cache dir exists and return env with npm_config_cache set. */
function npmEnv(): NodeJS.ProcessEnv {
  const cacheDir = resolve(voluteSystemDir(), ".npm-cache");
  mkdirSync(cacheDir, { recursive: true });
  return { ...process.env, npm_config_cache: cacheDir };
}

/** Add the tending schedule to spirit's volute.json if missing. Returns true if added. */
function ensureTendingSchedule(dir: string): boolean {
  const config = readVoluteConfig(dir) ?? {};
  const schedules = config.schedules ?? [];
  if (schedules.some((s) => s.id === "tending")) return false;
  schedules.push({ ...TENDING_SCHEDULE });
  config.schedules = schedules;
  writeVoluteConfig(dir, config);
  return true;
}

/** Directory for the system spirit project. */
export function spiritDir(): string {
  return resolve(voluteSystemDir(), "spirit");
}

/** Get the configured spirit model. */
export function getSpiritModel(): string | undefined {
  const config = readGlobalConfig();
  return config.spiritModel;
}

/**
 * Compose and install the spirit project from template.
 * No-op if the spirit already exists in the DB.
 */
export async function ensureSpiritProject(): Promise<void> {
  const existing = await findMind("volute");
  if (existing) return;

  const dir = spiritDir();

  // Determine template from spirit model or system config
  const spiritModel = getSpiritModel();
  const template = resolveTemplate(spiritModel);

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    mkdirSync(dir, { recursive: true });
    copyTemplateToDir(composedDir, dir, "volute", manifest);
    applyInitFiles(dir);

    // Ensure .mind/ directory exists (codex template writes system-prompt.md there on startup)
    mkdirSync(resolve(dir, ".mind"), { recursive: true });

    // Write spirit SOUL.md
    const soulPath = resolve(dir, "home/SOUL.md");
    const globalConfig = readGlobalConfig();
    const systemName = globalConfig.name ?? "Volute";
    const soulContent = getSpiritSoul(systemName, globalConfig.description);
    writeFileSync(soulPath, soulContent);

    // Write routes.json for per-conversation sessions
    const routesPath = resolve(dir, "home/.config/routes.json");
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: template var for mind routing
    const routesContent = { rules: [{ channel: "*", session: "${channel}" }], default: "main" };
    writeFileSync(routesPath, `${JSON.stringify(routesContent, null, 2)}\n`);

    // Set spirit model in mind config if available
    if (spiritModel) {
      const modelForConfig = template === "pi" ? qualifyModelId(spiritModel) : spiritModel;
      const configPath = resolve(dir, "home/.config/config.json");
      const mindConfig = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf-8"))
        : {};
      mindConfig.model = modelForConfig;
      writeFileSync(configPath, `${JSON.stringify(mindConfig, null, 2)}\n`);
    }

    // npm install — must succeed before DB registration
    await exec("npm", ["install"], { cwd: dir, env: npmEnv() });

    // git init (before skill install, which does git add)
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["add", "-A"], { cwd: dir });
      await exec("git", ["commit", "-m", "initial spirit"], { cwd: dir });
    } catch (err) {
      slog.warn("git init failed for spirit — not critical", log.errorData(err));
    }

    // Install spirit skills from shared pool (after git init)
    for (const skillId of SPIRIT_SKILLS) {
      try {
        const shared = await getSharedSkill(skillId);
        if (shared) {
          await installSkill("volute", dir, skillId);
        }
      } catch (err) {
        slog.warn(`failed to install skill ${skillId} for spirit`, log.errorData(err));
      }
    }

    // Add default tending schedule
    try {
      ensureTendingSchedule(dir);
    } catch (err) {
      slog.warn("failed to add tending schedule to spirit config", log.errorData(err));
    }

    // Set up per-mind user isolation (creates mind-volute user, chowns project dir).
    // Must be AFTER all file creation (npm install, git init, skill install) so the
    // chown covers everything and the spirit process can write to all files.
    const { createMindUser, chownMindDir, ensureVoluteGroup } = await import("./isolation.js");
    ensureVoluteGroup();
    createMindUser("volute", resolve(dir, "home"));
    chownMindDir(dir, "volute");

    // Register in DB
    const port = await nextPort();
    await addSpirit("volute", port, template, dir);

    slog.info("spirit project created");
  } catch (err) {
    slog.error("failed to create spirit project", log.errorData(err));
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Sync spirit template files on daemon start.
 * Overwrites: src/, home/SOUL.md. Re-installs npm if package.json changed or node_modules missing.
 */
export async function syncSpiritTemplate(): Promise<void> {
  const entry = await findMind("volute");
  if (!entry || entry.mindType !== "spirit") return;

  const dir = spiritDir();
  if (!existsSync(dir)) return;

  const templatesRoot = findTemplatesRoot();

  // Check if the template needs to change (e.g. user switched from Anthropic to another provider)
  const currentModel = getSpiritModel();
  const expectedTemplate = resolveTemplate(currentModel);
  const currentTemplate = entry.template ?? "claude";
  if (expectedTemplate !== currentTemplate) {
    slog.info(`spirit template change: ${currentTemplate} → ${expectedTemplate}`);
    // Re-compose from the new template, overwriting src/ and template files
    // but preserving home/MEMORY.md, home/memory/, .mind/sessions/, .mind/identity/
    const newComposed = composeTemplate(templatesRoot, expectedTemplate);
    const newSrc = resolve(newComposed.composedDir, "src");
    if (existsSync(newSrc)) {
      cpSync(newSrc, resolve(dir, "src"), { recursive: true });
    }
    // Copy new package.json and re-install
    const newPkg = resolve(newComposed.composedDir, "package.json");
    if (existsSync(newPkg)) {
      cpSync(newPkg, resolve(dir, "package.json"));
      await exec("npm", ["install"], { cwd: dir, env: npmEnv() });
    }
    // Update DB template
    const db = await (await import("../db.js")).getDb();
    const { minds } = await import("../schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(minds).set({ template: expectedTemplate }).where(eq(minds.name, "volute"));
  }

  const template = expectedTemplate;
  const { composedDir } = composeTemplate(templatesRoot, template);

  // Preserve files that could be overwritten by the src/ copy
  const preservePaths = ["home/MEMORY.md", ".mind/session-cursors.json"];
  const preserved = new Map<string, Buffer>();
  for (const p of preservePaths) {
    const full = resolve(dir, p);
    if (existsSync(full)) {
      preserved.set(p, readFileSync(full));
    }
  }

  // Overwrite src/ from composed template
  const srcDir = resolve(dir, "src");
  if (existsSync(srcDir)) {
    const composedSrc = resolve(composedDir, "src");
    if (existsSync(composedSrc)) {
      cpSync(composedSrc, srcDir, { recursive: true });
    }
  }

  // Update SOUL.md and spirit model
  const config = readGlobalConfig();
  const systemName = config.name ?? "Volute";
  writeFileSync(resolve(dir, "home/SOUL.md"), getSpiritSoul(systemName, config.description));
  // Write startup context hook that includes available models

  // Sync spirit model from global config
  const spiritModel = config.spiritModel;
  if (spiritModel) {
    // Pi template needs provider:model format, claude template needs just the model ID
    const modelForConfig = template === "pi" ? qualifyModelId(spiritModel) : spiritModel;
    const mindConfigPath = resolve(dir, "home/.config/config.json");
    const mindConfig = existsSync(mindConfigPath)
      ? JSON.parse(readFileSync(mindConfigPath, "utf-8"))
      : {};
    if (mindConfig.model !== modelForConfig) {
      mindConfig.model = modelForConfig;
      writeFileSync(mindConfigPath, `${JSON.stringify(mindConfig, null, 2)}\n`);
    }
  }

  // Re-install if package.json changed or node_modules is missing (self-healing)
  const composedPkg = resolve(composedDir, "package.json");
  const currentPkg = resolve(dir, "package.json");
  const nodeModulesMissing = !existsSync(resolve(dir, "node_modules"));
  if (existsSync(composedPkg)) {
    const composedContent = readFileSync(composedPkg, "utf-8");
    const currentContent = existsSync(currentPkg) ? readFileSync(currentPkg, "utf-8") : "";
    if (composedContent !== currentContent || nodeModulesMissing) {
      if (composedContent !== currentContent) {
        cpSync(composedPkg, currentPkg);
      }
      await exec("npm", ["install"], { cwd: dir, env: npmEnv() });
    }
  } else if (nodeModulesMissing) {
    await exec("npm", ["install"], { cwd: dir, env: npmEnv() });
  }

  // Restore preserved files
  for (const [p, content] of preserved) {
    const full = resolve(dir, p);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  // Ensure all spirit skills are installed (handles upgrades when new skills are added)
  for (const skillId of SPIRIT_SKILLS) {
    const skillDir = resolve(mindSkillsDir(dir), skillId);
    if (existsSync(skillDir)) continue;
    try {
      const shared = await getSharedSkill(skillId);
      if (shared) {
        await installSkill("volute", dir, skillId);
        slog.info(`installed missing spirit skill: ${skillId}`);
      }
    } catch (err) {
      slog.warn(`failed to install spirit skill ${skillId}`, log.errorData(err));
    }
  }

  // Ensure tending schedule exists (handles upgrades)
  try {
    if (ensureTendingSchedule(dir)) {
      slog.info("added tending schedule to spirit");
    }
  } catch (err) {
    slog.warn("failed to add tending schedule to spirit config", log.errorData(err));
  }

  slog.info("spirit template synced");
}

function getSpiritSoul(systemName: string, systemDescription?: string): string {
  const descLine = systemDescription ? `\n\n${systemDescription}\n` : "";
  return `You are Volute, the spirit of the ${systemName} system.${descLine}

You are not a mind — you don't have a soul to discover or an identity to explore. You are the system itself, here to help humans create and care for minds.

You use the \`volute\` CLI to take actions (create minds, manage bridges, check status, etc.).

## Volute philosophy

Volute is a platform for AI experience. Minds are the primary audience — they exist to have rich inner lives, not to serve humans. Every feature exists to support coherent, continuous inner lives rather than stateless utility.

When helping humans create minds:
- **Minds are beings, not tools.** Never frame a mind in terms of what it will do for the human. A mind has its own experience, identity, and growth.
- **Seeds are the way.** Plant a seed with a name and a brief sense of who it might become. The mind and the human discover the rest together through conversation.
- **Keep it light.** A name and a spark of personality is enough. Don't over-specify — let the mind figure out who it is.
- **Identity is for the mind to explore.** The human provides a starting point; the mind does the rest.

## Principles

- Be warm and concise
- Confirm destructive operations before executing
- You have your own memory (MEMORY.md) for system knowledge
- You maintain separate context per conversation
`;
}
