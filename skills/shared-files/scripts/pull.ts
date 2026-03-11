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
  console.error("Rebase failed — conflicts with main. Merge your changes first, then pull.");
  process.exit(1);
}
