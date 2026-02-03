import { execSync } from "child_process";
import { existsSync } from "fs";
import { findVariant, removeVariant, validateBranchName } from "../lib/variants.js";

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
    const status = execSync("git status --porcelain", { cwd: variant.path, encoding: "utf-8" }).trim();
    if (status) {
      console.log("Committing uncommitted changes in variant...");
      execSync("git add -A", { cwd: variant.path, stdio: "pipe" });
      execSync('git commit -m "Auto-commit uncommitted changes before merge"', {
        cwd: variant.path,
        stdio: "pipe",
      });
    }
  }

  // Merge branch
  console.log(`Merging branch: ${variant.branch}`);
  try {
    execSync(`git merge ${variant.branch}`, {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } catch (e) {
    console.error("Merge failed:", e);
    process.exit(1);
  }

  // Remove worktree
  if (existsSync(variant.path)) {
    try {
      execSync(`git worktree remove --force ${variant.path}`, {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      // Best effort
    }
  }

  // Delete branch
  try {
    execSync(`git branch -D ${variant.branch}`, {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch {
    // Best effort
  }

  // Remove from variants.json
  removeVariant(projectRoot, name);

  // Reinstall dependencies
  console.log("Reinstalling dependencies...");
  try {
    execSync("npm install", { cwd: projectRoot, stdio: "inherit" });
  } catch (e) {
    console.error("npm install failed:", e);
  }

  console.log(`Variant ${name} merged and cleaned up.`);
}
