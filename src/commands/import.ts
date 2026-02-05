import {
  cpSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "fs";
import { resolve, dirname } from "path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { convertSession } from "../lib/convert-session.js";
import { ensureMoltHome, addAgent, agentDir, nextPort } from "../lib/registry.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    name: { type: "string" },
    session: { type: "string" },
    template: { type: "string" },
  });

  const workspacePath = positional[0];
  if (!workspacePath) {
    console.error(
      "Usage: molt import <openclaw-workspace-path> [--name <name>] [--session <session-jsonl-path>] [--template <name>]",
    );
    process.exit(1);
  }

  const wsDir = resolve(workspacePath);

  // Validate workspace
  const soulPath = resolve(wsDir, "SOUL.md");
  const identityPath = resolve(wsDir, "IDENTITY.md");
  if (!existsSync(soulPath) || !existsSync(identityPath)) {
    console.error(
      "Not a valid OpenClaw workspace: missing SOUL.md or IDENTITY.md",
    );
    process.exit(1);
  }

  // Read workspace files
  const soul = readFileSync(soulPath, "utf-8");
  const identity = readFileSync(identityPath, "utf-8");
  const userPath = resolve(wsDir, "USER.md");
  const user = existsSync(userPath) ? readFileSync(userPath, "utf-8") : "";

  // Parse name from IDENTITY.md if not provided
  const name =
    flags.name ?? parseNameFromIdentity(identity) ?? "imported-agent";

  ensureMoltHome();
  const dest = agentDir(name);

  if (existsSync(dest)) {
    console.error(`Agent already exists: ${name}`);
    process.exit(1);
  }

  // Find template directory (same logic as create.ts)
  const template = flags.template ?? "agent-sdk";
  let dir = dirname(new URL(import.meta.url).pathname);
  let templateDir = "";
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "templates", template);
    if (existsSync(candidate)) {
      templateDir = candidate;
      break;
    }
    dir = dirname(dir);
  }

  if (!templateDir) {
    console.error(
      "Template not found. Searched up from:",
      dirname(new URL(import.meta.url).pathname),
    );
    process.exit(1);
  }

  // Copy template
  console.log(`Creating project: ${name}`);
  cpSync(templateDir, dest, { recursive: true });
  renameSync(resolve(dest, "package.json.tmpl"), resolve(dest, "package.json"));

  // Replace {{name}} in package.json
  const pkgPath = resolve(dest, "package.json");
  writeFileSync(
    pkgPath,
    readFileSync(pkgPath, "utf-8").replaceAll("{{name}}", name),
  );

  // Apply init files (CLAUDE.md, memory/.gitkeep, etc.) then remove .init/
  // We don't use applyInitFiles() because import overwrites SOUL.md/MEMORY.md below
  const initDir = resolve(dest, ".init");
  if (existsSync(initDir)) {
    // Only copy non-SOUL/MEMORY files (like CLAUDE.md, memory/.gitkeep)
    cpSync(initDir, resolve(dest, "home"), { recursive: true });
    rmSync(initDir, { recursive: true, force: true });
  }

  // Write SOUL.md to home/
  writeFileSync(resolve(dest, "home/SOUL.md"), soul + "\n");

  // Copy IDENTITY.md and USER.md as separate files in home/
  cpSync(identityPath, resolve(dest, "home/IDENTITY.md"));
  console.log("Copied IDENTITY.md");
  if (user) {
    cpSync(userPath, resolve(dest, "home/USER.md"));
    console.log("Copied USER.md");
  }

  // Copy MEMORY.md if present in workspace
  const wsMemoryPath = resolve(wsDir, "MEMORY.md");
  const hasMemory = existsSync(wsMemoryPath);
  if (hasMemory) {
    cpSync(wsMemoryPath, resolve(dest, "home/MEMORY.md"));
    console.log("Copied MEMORY.md");
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
    await execInherit("npx", ["tsx", "src/consolidate.ts"], { cwd: dest });
  }

  // git init + initial commit
  await exec("git", ["init"], { cwd: dest });
  await exec("git", ["add", "-A"], { cwd: dest });
  await exec("git", ["commit", "-m", "import from OpenClaw"], { cwd: dest });

  // Convert session if provided (only supported for anthropic template)
  if (flags.session && template !== "agent-sdk") {
    console.warn("Warning: --session is only supported with the agent-sdk template, skipping session import");
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
    const moltDir = resolve(dest, ".molt");
    mkdirSync(moltDir, { recursive: true });
    writeFileSync(
      resolve(moltDir, "session.json"),
      JSON.stringify({ sessionId }),
    );

  }

  console.log(`\nImported agent: ${name} (port ${port})`);
  console.log(`\n  molt start ${name}`);
}

function parseNameFromIdentity(identity: string): string | undefined {
  const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
  if (match) {
    return match[1].trim().toLowerCase().replace(/\s+/g, "-");
  }
  return undefined;
}
