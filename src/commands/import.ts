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
import { consolidateMemory } from "../lib/consolidate.js";
import { convertSession } from "../lib/convert-session.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { addAgent, agentDir, ensureVoluteHome, nextPort } from "../lib/registry.js";
import { composeTemplate, copyTemplateToDir, findTemplatesRoot } from "../lib/template.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    name: { type: "string" },
    session: { type: "string" },
    template: { type: "string" },
  });

  const workspacePath = positional[0];
  if (!workspacePath) {
    console.error(
      "Usage: volute import <openclaw-workspace-path> [--name <name>] [--session <session-jsonl-path>] [--template <name>]",
    );
    process.exit(1);
  }

  const wsDir = resolve(workspacePath);

  // Validate workspace
  const soulPath = resolve(wsDir, "SOUL.md");
  const identityPath = resolve(wsDir, "IDENTITY.md");
  if (!existsSync(soulPath) || !existsSync(identityPath)) {
    console.error("Not a valid OpenClaw workspace: missing SOUL.md or IDENTITY.md");
    process.exit(1);
  }

  // Read workspace files
  const soul = readFileSync(soulPath, "utf-8");
  const identity = readFileSync(identityPath, "utf-8");
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

  // Convert session if provided (only supported for anthropic template)
  if (flags.session && template !== "agent-sdk") {
    console.warn(
      "Warning: --session is only supported with the agent-sdk template, skipping session import",
    );
  }
  if (flags.session && template === "agent-sdk") {
    const sessionFile = resolve(flags.session);
    if (!existsSync(sessionFile)) {
      console.error(`Session file not found: ${sessionFile}`);
      process.exit(1);
    }

    console.log("Converting session...");
    const sessionId = convertSession({
      sessionPath: sessionFile,
      projectDir: dest,
    });

    // Write session ID so the agent can resume
    const voluteDir = resolve(dest, ".volute");
    mkdirSync(voluteDir, { recursive: true });
    writeFileSync(resolve(voluteDir, "session.json"), JSON.stringify({ sessionId }));
  }

  console.log(`\nImported agent: ${name} (port ${port})`);
  console.log(`\n  volute start ${name}`);
}

function parseNameFromIdentity(identity: string): string | undefined {
  const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
  if (match) {
    return match[1].trim().toLowerCase().replace(/\s+/g, "-");
  }
  return undefined;
}
