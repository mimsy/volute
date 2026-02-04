import { existsSync, writeFileSync, readFileSync, mkdirSync, openSync } from "fs";
import { spawn } from "child_process";
import { resolve } from "path";
import { findVariant, removeVariant, validateBranchName } from "../lib/variants.js";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional } = parseArgs(args, {});

  const name = positional[0];
  if (!name) {
    console.error("Usage: molt merge <name>");
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const variant = findVariant(projectRoot, name);

  if (!variant) {
    console.error(`Unknown variant: ${name}`);
    process.exit(1);
  }

  const branchErr = validateBranchName(variant.branch);
  if (branchErr) {
    console.error(branchErr);
    process.exit(1);
  }

  // Kill server if running
  if (variant.pid) {
    try {
      process.kill(variant.pid);
      console.log(`Killed server (pid ${variant.pid})`);
    } catch {
      // Already dead
    }
  }

  // Auto-commit any uncommitted changes in the variant worktree
  if (existsSync(variant.path)) {
    const status = (await exec("git", ["status", "--porcelain"], { cwd: variant.path })).trim();
    if (status) {
      console.log("Committing uncommitted changes in variant...");
      await exec("git", ["add", "-A"], { cwd: variant.path });
      await exec("git", ["commit", "-m", "Auto-commit uncommitted changes before merge"], {
        cwd: variant.path,
      });
    }
  }

  // Merge branch
  console.log(`Merging branch: ${variant.branch}`);
  try {
    await execInherit("git", ["merge", variant.branch], { cwd: projectRoot });
  } catch (e) {
    console.error("Merge failed:", e);
    process.exit(1);
  }

  // Remove worktree
  if (existsSync(variant.path)) {
    try {
      await exec("git", ["worktree", "remove", "--force", variant.path], { cwd: projectRoot });
    } catch {
      // Best effort
    }
  }

  // Delete branch
  try {
    await exec("git", ["branch", "-D", variant.branch], { cwd: projectRoot });
  } catch {
    // Best effort
  }

  // Remove from variants.json
  removeVariant(projectRoot, name);

  // Reinstall dependencies
  console.log("Reinstalling dependencies...");
  try {
    await execInherit("npm", ["install"], { cwd: projectRoot });
  } catch (e) {
    console.error("npm install failed:", e);
  }

  console.log(`Variant ${name} merged and cleaned up.`);

  // If running under supervisor, it handles restart — just exit
  if (process.env.MOLT_SUPERVISOR) return;

  // Direct CLI flow: write merged.json for post-restart orientation
  const moltDir = resolve(projectRoot, ".molt");
  if (!existsSync(moltDir)) mkdirSync(moltDir, { recursive: true });
  writeFileSync(resolve(moltDir, "merged.json"), JSON.stringify({ name }));

  // Kill old supervisor if running
  const pidPath = resolve(moltDir, "supervisor.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid);
      console.log(`Killed old supervisor (pid ${pid})`);
    } catch {
      // Already dead or invalid
    }
  }

  // Start new supervisor detached with log redirection
  const tsxBin = resolve(projectRoot, "node_modules", ".bin", "tsx");
  const supervisorPath = resolve(projectRoot, "supervisor.ts");
  if (existsSync(supervisorPath)) {
    console.log("Starting new supervisor...");
    const logsDir = resolve(projectRoot, ".molt", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFd = openSync(resolve(logsDir, "supervisor.log"), "a");
    const child = spawn(tsxBin, [supervisorPath], {
      cwd: projectRoot,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();
    console.log(`Supervisor started (pid ${child.pid})`);
  }
}
