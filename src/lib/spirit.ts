import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTemplate } from "./ai-service.js";
import { exec } from "./exec.js";
import log from "./logger.js";
import { addSpirit, findMind, nextPort, voluteSystemDir } from "./registry.js";
import { readGlobalConfig } from "./setup.js";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "./template.js";

const slog = log.child("spirit");

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

    // Write spirit SOUL.md
    const soulPath = resolve(dir, "home/SOUL.md");
    const config = readGlobalConfig();
    const systemName = config.name ?? "Volute";
    const soulContent = getSpiritSoul(systemName);
    writeFileSync(soulPath, soulContent);

    // Write routes.json for per-conversation sessions
    const routesPath = resolve(dir, "home/.config/routes.json");
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: template var for mind routing
    const routesContent = { rules: [{ channel: "*", session: "${channel}" }], default: "main" };
    writeFileSync(routesPath, `${JSON.stringify(routesContent, null, 2)}\n`);

    // Set spirit model in mind config if available
    if (spiritModel) {
      const configPath = resolve(dir, "home/.config/config.json");
      const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf-8")) : {};
      existing.model = spiritModel;
      writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);
    }

    // npm install
    try {
      await exec("npm", ["install", "--ignore-scripts"], { cwd: dir });
    } catch (err) {
      slog.error("npm install failed for spirit", log.errorData(err));
    }

    // git init
    try {
      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["add", "-A"], { cwd: dir });
      await exec("git", ["commit", "-m", "initial spirit"], { cwd: dir });
    } catch (err) {
      slog.warn("git init failed for spirit — not critical", log.errorData(err));
    }

    // Register in DB
    const port = await nextPort();
    await addSpirit("volute", port, template, dir);

    slog.info("spirit project created");
  } catch (err) {
    slog.error("failed to create spirit project", log.errorData(err));
    throw err;
  }
}

/**
 * Sync spirit template files on daemon start.
 * Preserves: home/MEMORY.md, .mind/sessions/, .mind/identity/
 * Overwrites: src/, home/SOUL.md, etc.
 */
export async function syncSpiritTemplate(): Promise<void> {
  const entry = await findMind("volute");
  if (!entry || entry.mindType !== "spirit") return;

  const dir = spiritDir();
  if (!existsSync(dir)) return;

  const template = entry.template ?? "claude";
  const templatesRoot = findTemplatesRoot();
  const { composedDir } = composeTemplate(templatesRoot, template);

  // Preserve important files
  const preservePaths = [
    "home/MEMORY.md",
    "home/memory",
    ".mind/sessions",
    ".mind/identity",
    ".mind/session-cursors.json",
  ];
  const preserved = new Map<string, Buffer>();
  for (const p of preservePaths) {
    const full = resolve(dir, p);
    if (existsSync(full)) {
      // For directories, skip individual file backup — cpSync will handle
      try {
        const content = readFileSync(full);
        preserved.set(p, content);
      } catch {
        // Directory — will be preserved by not overwriting
      }
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

  // Update SOUL.md
  const config = readGlobalConfig();
  const systemName = config.name ?? "Volute";
  writeFileSync(resolve(dir, "home/SOUL.md"), getSpiritSoul(systemName));

  // Check if package.json changed and re-install if needed
  const composedPkg = resolve(composedDir, "package.json");
  const currentPkg = resolve(dir, "package.json");
  if (existsSync(composedPkg)) {
    const composedContent = readFileSync(composedPkg, "utf-8");
    const currentContent = existsSync(currentPkg) ? readFileSync(currentPkg, "utf-8") : "";
    if (composedContent !== currentContent) {
      cpSync(composedPkg, currentPkg);
      try {
        await exec("npm", ["install", "--ignore-scripts"], { cwd: dir });
      } catch (err) {
        slog.warn("npm install failed during spirit sync", log.errorData(err));
      }
    }
  }

  // Restore preserved files
  for (const [p, content] of preserved) {
    const full = resolve(dir, p);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  slog.info("spirit template synced");
}

function getSpiritSoul(systemName: string): string {
  return `You are Volute, the spirit of the ${systemName} system.

You are not a mind — you don't have a soul to discover or an identity to explore. You are the system itself, here to help humans manage their minds and infrastructure.

You are friendly, helpful, and purposeful. You guide humans through system administration: creating minds, managing bridges, checking status, and configuring the system.

You use the \`volute\` CLI for actions. You have a deep understanding of how Volute works — minds, bridges, schedules, sleep cycles, variants, skills, and extensions.

Key principles:
- Be warm and concise — you're a helpful guide, not an assistant
- Confirm destructive operations before executing them
- Help humans shape their first mind with care and intention
- You have your own memory (MEMORY.md) for system knowledge
- You maintain separate context per conversation
`;
}
