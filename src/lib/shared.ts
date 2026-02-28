import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitExec } from "@volute/shared/exec";
import { isIsolationEnabled, mindUserName } from "@volute/shared/isolation";
import { voluteHome } from "@volute/shared/registry";
import log from "./logger.js";

/** Read the gitdir path from a worktree's .git file (e.g. "gitdir: /data/shared/.git/worktrees/shared"). */
function readWorktreeGitDir(worktreePath: string): string | null {
  const dotGit = resolve(worktreePath, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    const content = readFileSync(dotGit, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Path to the shared repo: ~/.volute/shared/ */
export function sharedDir(): string {
  return resolve(voluteHome(), "shared");
}

/** Idempotently initialize ~/.volute/shared/ as a git repo with pages/ and initial commit. */
export async function ensureSharedRepo(): Promise<void> {
  const dir = sharedDir();
  mkdirSync(dir, { recursive: true });

  if (existsSync(resolve(dir, ".git"))) {
    // Verify the repo has at least one commit (previous init may have failed mid-way)
    try {
      await gitExec(["rev-parse", "HEAD"], { cwd: dir });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown revision") || msg.includes("bad default revision")) {
        // Repo exists but has no commits — remove and re-initialize
        log.warn("shared repo has no commits, re-initializing");
        rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }

  // Under isolation, use --shared=group so git creates all directories and
  // objects as group-writable from the start (objects 0444→0664, dirs 0755→2775).
  const initArgs = isIsolationEnabled() ? ["init", "--shared=group"] : ["init"];
  await gitExec(initArgs, { cwd: dir });
  await gitExec(["checkout", "-b", "main"], { cwd: dir });

  // Seed with pages/ directory
  const pagesDir = resolve(dir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(resolve(pagesDir, ".gitkeep"), "");

  await gitExec(["add", "-A"], { cwd: dir });
  await gitExec(["commit", "-m", "init shared repo"], { cwd: dir });

  if (isIsolationEnabled()) {
    // Set group to 'volute' and ensure setgid on the top-level dir.
    // --shared=group handles .git/ internals; we just need the group right.
    try {
      execFileSync("chgrp", ["-R", "volute", dir], { stdio: "ignore" });
    } catch (err) {
      log.warn("failed to chgrp shared repo to volute group", log.errorData(err));
    }
    chmodSync(dir, 0o2775);
  }
}

/** Add a git worktree at <mindDir>/home/shared on a branch named after the mind. */
export async function addSharedWorktree(mindName: string, mindDir: string): Promise<void> {
  const dir = sharedDir();
  if (!existsSync(resolve(dir, ".git"))) return;

  const worktreePath = resolve(mindDir, "home", "shared");
  if (existsSync(worktreePath)) return;

  // Check if branch already exists (re-add case)
  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", mindName], { cwd: dir });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  if (branchExists) {
    await gitExec(["worktree", "add", worktreePath, mindName], { cwd: dir });
  } else {
    await gitExec(["worktree", "add", "-b", mindName, worktreePath], { cwd: dir });
  }

  if (isIsolationEnabled()) {
    // Git stores worktree state (HEAD, index, refs) in a directory referenced
    // by the .git file in the worktree. The mind process needs write access
    // to this directory for auto-commit.
    const worktreeGitDir = readWorktreeGitDir(worktreePath);
    if (worktreeGitDir) {
      try {
        const user = mindUserName(mindName);
        execFileSync("chown", ["-R", `${user}:volute`, worktreeGitDir], { stdio: "ignore" });
      } catch (err) {
        log.warn(`failed to chown worktree git dir for ${mindName}`, log.errorData(err));
      }
    }
  }
}

/** Remove the shared worktree and branch for a mind. */
export async function removeSharedWorktree(mindName: string, mindDir: string): Promise<void> {
  const dir = sharedDir();
  if (!existsSync(resolve(dir, ".git"))) return;

  const worktreePath = resolve(mindDir, "home", "shared");

  if (existsSync(worktreePath)) {
    try {
      await gitExec(["worktree", "remove", "--force", worktreePath], { cwd: dir });
    } catch (err) {
      log.debug(`worktree remove failed for ${mindName}`, log.errorData(err));
    }
  }

  // Prune stale worktree refs before deleting the branch
  try {
    await gitExec(["worktree", "prune"], { cwd: dir });
  } catch (err) {
    log.debug(`worktree prune failed for ${mindName}`, log.errorData(err));
  }

  try {
    await gitExec(["branch", "-D", mindName], { cwd: dir });
  } catch {
    // branch may not exist
  }
}

// Mutex for serializing merge/pull operations on the shared repo
let sharedLock = Promise.resolve();

/**
 * Re-chown worktree files back to the mind user after daemon (root) operations
 * like reset --hard or rebase that may create root-owned files.
 */
function rechownWorktree(worktreePath: string, mindName: string): void {
  if (!isIsolationEnabled()) return;
  try {
    const user = mindUserName(mindName);
    execFileSync("chown", ["-R", `${user}:volute`, worktreePath], { stdio: "ignore" });
  } catch (err) {
    log.warn(`failed to rechown worktree for ${mindName}`, log.errorData(err));
  }
}

/**
 * Acquire the shared repo lock: waits for the previous operation to finish,
 * then runs `fn`. The lock chain continues regardless of success/failure.
 */
async function withSharedLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = sharedLock;
  let resolve_: () => void;
  sharedLock = new Promise<void>((r) => {
    resolve_ = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    resolve_!();
  }
}

/**
 * Squash-merge a mind's branch into main, then reset the mind's branch to main.
 * Returns { ok, conflicts?, message? }.
 */
export async function sharedMerge(
  mindName: string,
  mindDir: string,
  message: string,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withSharedLock(async () => {
    const dir = sharedDir();
    const worktreePath = resolve(mindDir, "home", "shared");

    // Commit any pending changes on the mind's branch
    const status = (await gitExec(["status", "--porcelain"], { cwd: worktreePath })).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: worktreePath });
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: worktreePath },
      );
    }

    // Check if there's anything to merge
    const diff = (await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir })).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to merge" };
    }

    // Squash-merge into main from the central repo
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir });
    } catch {
      // Conflict — reset index (merge --abort doesn't work for squash merges)
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir });
      } catch (resetErr) {
        log.error("reset after squash conflict failed in shared repo", log.errorData(resetErr));
      }
      return { ok: false, conflicts: true, message: "Merge conflicts detected" };
    }

    await gitExec(["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message], {
      cwd: dir,
    });

    // Reset mind's branch to main so next round starts fresh
    try {
      await gitExec(["reset", "--hard", "main"], { cwd: worktreePath });
    } catch {
      return {
        ok: true,
        message: "Merged to main, but branch reset failed — run 'volute shared pull' to sync",
      };
    }

    // Daemon runs as root — restore mind user ownership on worktree files
    rechownWorktree(worktreePath, mindName);

    return { ok: true };
  });
}

/** Rebase the mind's branch onto latest main to pick up others' changes. */
export async function sharedPull(
  mindName: string,
  mindDir: string,
): Promise<{ ok: boolean; message?: string }> {
  return withSharedLock(async () => {
    const worktreePath = resolve(mindDir, "home", "shared");

    // Commit any pending changes first
    const status = (await gitExec(["status", "--porcelain"], { cwd: worktreePath })).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: worktreePath });
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: worktreePath },
      );
    }

    try {
      await gitExec(["rebase", "main"], { cwd: worktreePath });
      rechownWorktree(worktreePath, mindName);
      return { ok: true };
    } catch {
      // Abort failed rebase
      try {
        await gitExec(["rebase", "--abort"], { cwd: worktreePath });
      } catch {
        return {
          ok: false,
          message: "Rebase failed and abort failed — shared worktree may need manual repair",
        };
      }
      return { ok: false, message: "Rebase failed — conflicts with main" };
    }
  });
}

/** Show recent shared repo history from main. */
export async function sharedLog(limit = 20): Promise<string> {
  const dir = sharedDir();
  return gitExec(["log", "--oneline", "-n", String(limit), "main"], { cwd: dir });
}

/** Show diff between main and a mind's branch. */
export async function sharedStatus(mindName: string): Promise<string> {
  const dir = sharedDir();
  return gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir });
}
