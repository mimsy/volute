import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import { spawnServer } from "../lib/spawn-server.js";
import { addVariant, validateBranchName } from "../lib/variants.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    soul: { type: "string" },
    port: { type: "number" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });

  const agentName = positional[0];
  const variantName = positional[1];
  const { soul, port, json } = flags;
  const noStart = flags["no-start"];

  if (!agentName || !variantName) {
    console.error(
      'Usage: volute fork <agent> <variant> [--soul "..."] [--port N] [--no-start] [--json]',
    );
    process.exit(1);
  }

  const err = validateBranchName(variantName);
  if (err) {
    console.error(err);
    process.exit(1);
  }

  const { dir: projectRoot } = resolveAgent(agentName);
  const worktreeDir = resolve(projectRoot, ".worktrees", variantName);

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
    await exec("git", ["worktree", "add", "-b", variantName, worktreeDir], { cwd: projectRoot });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Failed to create worktree: ${msg}`);
    process.exit(1);
  }

  // Install dependencies
  if (!json) console.log("Installing dependencies...");
  try {
    if (json) {
      await exec("npm", ["install"], { cwd: worktreeDir });
    } else {
      await execInherit("npm", ["install"], { cwd: worktreeDir });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`npm install failed: ${msg}`);
    process.exit(1);
  }

  // Write SOUL.md if provided
  if (soul) {
    writeFileSync(resolve(worktreeDir, "home/SOUL.md"), soul);
  }

  let actualPort: number | null = null;
  let pid: number | null = null;

  if (!noStart) {
    const requestedPort = port ?? 0;
    if (!json) console.log("Starting server...");
    const result = await spawnServer(worktreeDir, requestedPort, { detached: true });
    if (!result) {
      console.error("Server failed to start within timeout");
      process.exit(1);
    }
    actualPort = result.actualPort;
    pid = result.child.pid ?? null;
  }

  const variant = {
    name: variantName,
    branch: variantName,
    path: worktreeDir,
    port: actualPort ?? port ?? 0,
    pid,
    created: new Date().toISOString(),
  };

  addVariant(projectRoot, variant);

  if (json) {
    console.log(JSON.stringify(variant, null, 2));
  } else {
    console.log(`\nVariant created: ${variantName}`);
    console.log(`  Branch: ${variant.branch}`);
    console.log(`  Path:   ${variant.path}`);
    if (actualPort) {
      console.log(`  Port:   ${actualPort}`);
      console.log(`  PID:    ${pid}`);
    }
  }
}
