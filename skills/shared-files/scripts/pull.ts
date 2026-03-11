#!/usr/bin/env tsx
/**
 * Pull latest shared changes by rebasing onto main.
 * Usage: tsx pull.ts
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const mind = process.env.VOLUTE_MIND;
if (!mind) {
  console.error("Missing VOLUTE_MIND env var");
  process.exit(1);
}

const worktree = resolve("shared");

// Commit any pending changes first
try {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: worktree,
    encoding: "utf-8",
  }).trim();
  if (status) {
    execFileSync("git", ["add", "-A"], { cwd: worktree, stdio: "ignore" });
    execFileSync("git", ["commit", "--author", `${mind} <${mind}@volute>`, "-m", `wip: ${mind}`], {
      cwd: worktree,
      stdio: "ignore",
    });
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Failed to commit pending changes in shared worktree: ${msg}`);
  process.exit(1);
}

// Rebase onto main
try {
  execFileSync("git", ["rebase", "main"], { cwd: worktree, stdio: "ignore" });
  console.log("Pulled latest shared changes.");
} catch {
  // Abort failed rebase
  try {
    execFileSync("git", ["rebase", "--abort"], { cwd: worktree, stdio: "ignore" });
  } catch {
    console.error("Rebase failed and abort failed — shared worktree may need manual repair.");
    process.exit(1);
  }
  console.error(
    "Rebase failed — your branch conflicts with main. Resolve the conflicting files and commit, then pull again.",
  );
  process.exit(1);
}
