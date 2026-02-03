import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  addVariant,
  validateBranchName,
} from "../lib/variants.js";
import { spawnServer } from "../lib/spawn-server.js";

function parseArgs(args: string[]) {
  let name: string | undefined;
  let soul: string | undefined;
  let port: number | undefined;
  let noStart = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--soul" && args[i + 1]) {
      soul = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--no-start") {
      noStart = true;
    } else if (args[i] === "--json") {
      json = true;
    } else if (!args[i].startsWith("-")) {
      name = args[i];
    }
  }

  return { name, soul, port, noStart, json };
}

export async function run(args: string[]) {
  const { name, soul, port, noStart, json } = parseArgs(args);

  if (!name) {
    console.error("Usage: molt fork <name> [--soul \"...\"] [--port N] [--no-start] [--json]");
    process.exit(1);
  }

  const err = validateBranchName(name);
  if (err) {
    console.error(err);
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const worktreeDir = resolve(projectRoot, ".worktrees", name);

  if (existsSync(worktreeDir)) {
    console.error(`Worktree already exists: ${worktreeDir}`);
    process.exit(1);
  }

  const parentDir = resolve(projectRoot, ".worktrees");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // Create git worktree
  try {
    execSync(`git worktree add -b ${name} ${worktreeDir}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to create worktree: ${msg}`);
    process.exit(1);
  }

  // Install dependencies
  if (!json) console.log("Installing dependencies...");
  try {
    execSync("bun install", { cwd: worktreeDir, stdio: json ? "pipe" : "inherit" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`bun install failed: ${msg}`);
    process.exit(1);
  }

  // Write SOUL.md if provided
  if (soul) {
    writeFileSync(resolve(worktreeDir, "SOUL.md"), soul);
  }

  let actualPort: number | null = null;
  let pid: number | null = null;

  if (!noStart) {
    const requestedPort = port ?? 0;
    if (!json) console.log("Starting server...");
    const result = await spawnServer(worktreeDir, requestedPort);
    if (!result) {
      console.error("Server failed to start within timeout");
      process.exit(1);
    }
    actualPort = result.actualPort;
    pid = result.child.pid ?? null;

    // Detach the child so the CLI can exit while server runs
    result.child.unref();
    result.child.stdout?.destroy();
    result.child.stderr?.destroy();
  }

  const variant = {
    name,
    branch: name,
    path: worktreeDir,
    port: actualPort ?? (port ?? 0),
    pid,
    created: new Date().toISOString(),
  };

  addVariant(projectRoot, variant);

  if (json) {
    console.log(JSON.stringify(variant, null, 2));
  } else {
    console.log(`\nVariant created: ${name}`);
    console.log(`  Branch: ${variant.branch}`);
    console.log(`  Path:   ${variant.path}`);
    if (actualPort) {
      console.log(`  Port:   ${actualPort}`);
      console.log(`  PID:    ${pid}`);
    }
  }
}
