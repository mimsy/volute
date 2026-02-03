import { existsSync } from "fs";
import { findVariant, removeVariant, validateBranchName } from "../lib/variants.js";
import { exec, execInherit } from "../lib/exec.js";

function parseArgs(args: string[]) {
  let name: string | undefined;
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      name = arg;
    }
  }
  return { name };
}

export async function run(args: string[]) {
  const { name } = parseArgs(args);

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
}
