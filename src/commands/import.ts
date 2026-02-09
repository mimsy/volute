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
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { consolidateMemory } from "../lib/consolidate.js";
import { convertSession } from "../lib/convert-session.js";
import { agentEnvPath, readEnv, writeEnv } from "../lib/env.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { addAgent, agentDir, ensureVoluteHome, nextPort } from "../lib/registry.js";
import { composeTemplate, copyTemplateToDir, findTemplatesRoot } from "../lib/template.js";
import { readVoluteConfig, writeVoluteConfig } from "../lib/volute-config.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    name: { type: "string" },
    session: { type: "string" },
    template: { type: "string" },
  });

  // Auto-detect workspace: explicit path > cwd > ~/.openclaw/workspace
  const wsDir = resolveWorkspace(positional[0]);

  // Read workspace files
  const soul = readFileSync(resolve(wsDir, "SOUL.md"), "utf-8");
  const identity = readFileSync(resolve(wsDir, "IDENTITY.md"), "utf-8");
  const userPath = resolve(wsDir, "USER.md");
  const user = existsSync(userPath) ? readFileSync(userPath, "utf-8") : "";

  // Parse name from IDENTITY.md if not provided
  const name = flags.name ?? parseNameFromIdentity(identity) ?? "imported-agent";

  // Merge IDENTITY.md into SOUL.md and USER.md into MEMORY.md
  const mergedSoul = `${soul.trimEnd()}\n\n---\n\n${identity.trimEnd()}\n`;
  const mergedMemoryExtra = user ? `\n\n---\n\n${user.trimEnd()}\n` : "";

  ensureVoluteHome();
  const dest = agentDir(name);

  if (existsSync(dest)) {
    console.error(`Agent already exists: ${name}`);
    process.exit(1);
  }

  // Compose and copy template
  const template = flags.template ?? "agent-sdk";
  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    console.log(`Creating project: ${name}`);
    copyTemplateToDir(composedDir, dest, name, manifest);
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }

  // Apply init files (CLAUDE.md, memory/.gitkeep, etc.) then remove .init/
  // We copy all init files, then overwrite SOUL.md/MEMORY.md below
  const initDir = resolve(dest, ".init");
  if (existsSync(initDir)) {
    cpSync(initDir, resolve(dest, "home"), { recursive: true });
    rmSync(initDir, { recursive: true, force: true });
  }

  // Write SOUL.md (with IDENTITY.md merged in)
  writeFileSync(resolve(dest, "home/SOUL.md"), mergedSoul);
  console.log("Wrote SOUL.md (merged with IDENTITY.md)");

  // Copy or create MEMORY.md (with USER.md merged in if present)
  const wsMemoryPath = resolve(wsDir, "MEMORY.md");
  const hasMemory = existsSync(wsMemoryPath);
  if (hasMemory) {
    const existingMemory = readFileSync(wsMemoryPath, "utf-8");
    writeFileSync(
      resolve(dest, "home/MEMORY.md"),
      `${existingMemory.trimEnd()}${mergedMemoryExtra}`,
    );
    console.log(user ? "Wrote MEMORY.md (merged with USER.md)" : "Copied MEMORY.md");
  } else if (user) {
    writeFileSync(resolve(dest, "home/MEMORY.md"), `${user.trimEnd()}\n`);
    console.log("Wrote MEMORY.md (from USER.md)");
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
    if (dailyLogCount > 0) {
      console.log(`Copied ${dailyLogCount} daily log(s)`);
    }
  }

  // Assign port and register
  const port = nextPort();
  addAgent(name, port);

  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: dest });

  // Consolidate memory if no MEMORY.md but daily logs exist
  if (!hasMemory && dailyLogCount > 0) {
    console.log("No MEMORY.md — running memory consolidation...");
    await consolidateMemory(dest);
  }

  // git init + initial commit
  await exec("git", ["init"], { cwd: dest });
  await exec("git", ["add", "-A"], { cwd: dest });
  await exec("git", ["commit", "-m", "import from OpenClaw"], { cwd: dest });

  // Import session: auto-discover if not provided
  const sessionFile = flags.session ? resolve(flags.session) : findOpenClawSession(wsDir);
  if (sessionFile) {
    if (!existsSync(sessionFile)) {
      console.error(`Session file not found: ${sessionFile}`);
      process.exit(1);
    }

    if (template === "pi") {
      importPiSession(sessionFile, dest);
    } else if (template === "agent-sdk") {
      console.log("Converting session...");
      const sessionId = convertSession({ sessionPath: sessionFile, projectDir: dest });
      const voluteDir = resolve(dest, ".volute");
      mkdirSync(voluteDir, { recursive: true });
      writeFileSync(resolve(voluteDir, "session.json"), JSON.stringify({ sessionId }));
    } else {
      console.warn(`Session import not supported for template: ${template}`);
    }
  }

  // Import connectors from openclaw.json
  importOpenClawConnectors(dest);

  console.log(`\nImported agent: ${name} (port ${port})`);
  console.log(`\n  volute start ${name}`);
}

/** Auto-detect OpenClaw workspace: explicit path > cwd > ~/.openclaw/workspace */
function resolveWorkspace(explicitPath?: string): string {
  if (explicitPath) {
    const wsDir = resolve(explicitPath);
    if (!existsSync(resolve(wsDir, "SOUL.md")) || !existsSync(resolve(wsDir, "IDENTITY.md"))) {
      console.error("Not a valid OpenClaw workspace: missing SOUL.md or IDENTITY.md");
      process.exit(1);
    }
    return wsDir;
  }

  // Try cwd
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "SOUL.md")) && existsSync(resolve(cwd, "IDENTITY.md"))) {
    console.log(`Using workspace: ${cwd}`);
    return cwd;
  }

  // Try ~/.openclaw/workspace
  const openclawWs = resolve(homedir(), ".openclaw/workspace");
  if (
    existsSync(resolve(openclawWs, "SOUL.md")) &&
    existsSync(resolve(openclawWs, "IDENTITY.md"))
  ) {
    console.log(`Using workspace: ${openclawWs}`);
    return openclawWs;
  }

  console.error(
    "Usage: volute import [<workspace-path>] [--name <name>] [--session <path>] [--template <name>]\n\n" +
      "No OpenClaw workspace found. Provide a path, run from a workspace, or ensure ~/.openclaw/workspace exists.",
  );
  process.exit(1);
}

/** Find the most recent OpenClaw session whose cwd matches the workspace being imported. */
function findOpenClawSession(workspaceDir: string): string | undefined {
  const agentsDir = resolve(homedir(), ".openclaw/agents");
  if (!existsSync(agentsDir)) return undefined;

  // Scan all session JSONL files across all agents, match by workspace cwd
  const matches: { path: string; mtime: number }[] = [];
  try {
    for (const agent of readdirSync(agentsDir)) {
      const sessionsDir = resolve(agentsDir, agent, "sessions");
      if (!existsSync(sessionsDir)) continue;

      for (const file of readdirSync(sessionsDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = resolve(sessionsDir, file);
        if (sessionMatchesWorkspace(fullPath, workspaceDir)) {
          matches.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
        }
      }
    }
  } catch {
    return undefined;
  }

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => b.mtime - a.mtime);
  console.log(`Found session: ${matches[0].path}`);
  return matches[0].path;
}

/** Check if a session JSONL file's header cwd matches the given workspace directory. */
function sessionMatchesWorkspace(sessionPath: string, workspaceDir: string): boolean {
  try {
    const fd = readFileSync(sessionPath, "utf-8");
    const firstLine = fd.slice(0, fd.indexOf("\n"));
    const header = JSON.parse(firstLine);
    return header.type === "session" && resolve(header.cwd) === resolve(workspaceDir);
  } catch {
    return false;
  }
}

/**
 * Import a session for the pi template.
 * OpenClaw sessions use the same JSONL format as pi-coding-agent,
 * so we copy directly and just update the cwd in the session header.
 */
function importPiSession(sessionFile: string, agentDirPath: string) {
  const homeDir = resolve(agentDirPath, "home");
  const piSessionDir = resolve(agentDirPath, ".volute/pi-sessions/main");
  mkdirSync(piSessionDir, { recursive: true });

  // Read session and update cwd in header to point to new agent's home dir
  const content = readFileSync(sessionFile, "utf-8");
  const lines = content.trim().split("\n");

  if (lines.length > 0) {
    try {
      const header = JSON.parse(lines[0]);
      if (header.type === "session") {
        header.cwd = homeDir;
        lines[0] = JSON.stringify(header);
      }
    } catch {
      // Not a valid header, copy as-is
    }
  }

  const filename = basename(sessionFile);
  const destPath = resolve(piSessionDir, filename);
  writeFileSync(destPath, `${lines.join("\n")}\n`);
  console.log(`Imported session (${lines.length} entries)`);
}

/** Import connector config from ~/.openclaw/openclaw.json into the new agent. */
function importOpenClawConnectors(agentDirPath: string) {
  const configPath = resolve(homedir(), ".openclaw/openclaw.json");
  if (!existsSync(configPath)) return;

  let config: { channels?: Record<string, { enabled?: boolean; token?: string }> };
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }

  const discord = config.channels?.discord;
  if (!discord?.enabled || !discord.token) return;

  // Write DISCORD_TOKEN to agent env
  const envPath = agentEnvPath(agentDirPath);
  const env = readEnv(envPath);
  env.DISCORD_TOKEN = discord.token;
  writeEnv(envPath, env);

  // Enable discord connector in volute.json
  const voluteConfig = readVoluteConfig(agentDirPath) ?? {};
  const connectors = new Set(voluteConfig.connectors ?? []);
  connectors.add("discord");
  voluteConfig.connectors = [...connectors];
  writeVoluteConfig(agentDirPath, voluteConfig);

  console.log("Imported Discord connector config");
}

function parseNameFromIdentity(identity: string): string | undefined {
  const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
  if (match) {
    const raw = match[1].trim();
    // Skip template placeholder text
    if (!raw || raw.startsWith("*") || raw.startsWith("(")) return undefined;
    return raw.toLowerCase().replace(/\s+/g, "-");
  }
  return undefined;
}
