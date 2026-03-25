/**
 * Git-based collaborative pages infrastructure.
 * Manages a central git repo with per-mind worktrees for collaborative system pages.
 * The repo lives in the pages extension data directory at <dataDir>/repo/.
 * Each mind gets a worktree at <mindDir>/home/pages/_system/ on a per-mind branch.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Lazy-loaded core dependencies (pages extension runs in daemon process)
// biome-ignore lint/suspicious/noExplicitAny: internal lazy loading
let _core: any = null;

async function core() {
  if (_core) return _core;
  const [execMod, isoMod, logMod] = await Promise.all([
    import("../../../../src/lib/exec.js"),
    import("../../../../src/lib/isolation.js"),
    import("../../../../src/lib/logger.js"),
  ]);
  _core = {
    gitExec: execMod.gitExec,
    isIsolationEnabled: isoMod.isIsolationEnabled,
    mindUserName: isoMod.mindUserName,
    log: logMod.default,
  };
  return _core;
}

/** Read the gitdir path from a worktree's .git file. */
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

/** Path to the collaborative pages repo within the extension data directory. */
export function pagesRepoDir(dataDir: string): string {
  return resolve(dataDir, "repo");
}

function worktreePath(mindDir: string): string {
  return resolve(mindDir, "home", "pages", "_system");
}

/** Idempotently initialize the collaborative pages git repo. */
export async function ensurePagesRepo(dataDir: string): Promise<void> {
  const { gitExec, isIsolationEnabled, log } = await core();
  const dir = pagesRepoDir(dataDir);
  mkdirSync(dir, { recursive: true });

  if (existsSync(resolve(dir, ".git"))) {
    try {
      await gitExec(["rev-parse", "HEAD"], { cwd: dir });
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown revision") || msg.includes("bad default revision")) {
        log.warn("pages repo has no commits, re-initializing");
        rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }

  const initArgs = isIsolationEnabled() ? ["init", "--shared=group"] : ["init"];
  await gitExec(initArgs, { cwd: dir });
  await gitExec(["checkout", "-b", "main"], { cwd: dir });

  writeFileSync(resolve(dir, ".gitkeep"), "");
  await gitExec(["add", "-A"], { cwd: dir });
  await gitExec(["commit", "-m", "init pages repo"], { cwd: dir });

  if (isIsolationEnabled()) {
    try {
      execFileSync("chgrp", ["-R", "volute", dir], { stdio: "ignore" });
    } catch (err: unknown) {
      log.warn("failed to chgrp pages repo to volute group", log.errorData(err));
    }
    chmodSync(dir, 0o2775);
  }
}

/** Add a git worktree at <mindDir>/home/pages/_system/ on a per-mind branch. */
export async function addPagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
): Promise<void> {
  const { gitExec, isIsolationEnabled, mindUserName, log } = await core();
  const dir = pagesRepoDir(dataDir);
  if (!existsSync(resolve(dir, ".git"))) return;

  const wt = worktreePath(mindDir);
  if (existsSync(wt)) return;

  // Ensure parent pages/ directory exists (mind may create personal pages here too)
  const pagesDir = resolve(mindDir, "home", "pages");
  mkdirSync(pagesDir, { recursive: true });

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", mindName], { cwd: dir });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  if (branchExists) {
    await gitExec(["worktree", "add", wt, mindName], { cwd: dir });
  } else {
    await gitExec(["worktree", "add", "-b", mindName, wt], { cwd: dir });
  }

  if (isIsolationEnabled()) {
    const user = mindUserName(mindName);
    // Chown the worktree directory so the mind user can write files
    try {
      execFileSync("chown", ["-R", `${user}:volute`, wt], { stdio: "ignore" });
    } catch (err: unknown) {
      log.warn(`failed to chown worktree for ${mindName}`, log.errorData(err));
    }
    // Chown the git state directory (HEAD, index, refs) so auto-commit works
    const wtGitDir = readWorktreeGitDir(wt);
    if (wtGitDir) {
      try {
        execFileSync("chown", ["-R", `${user}:volute`, wtGitDir], { stdio: "ignore" });
      } catch (err: unknown) {
        log.warn(`failed to chown worktree git dir for ${mindName}`, log.errorData(err));
      }
    }
  }
}

/** Remove the worktree and branch for a mind. */
export async function removePagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
): Promise<void> {
  const { gitExec, log } = await core();
  const dir = pagesRepoDir(dataDir);
  if (!existsSync(resolve(dir, ".git"))) return;

  const wt = worktreePath(mindDir);

  if (existsSync(wt)) {
    try {
      await gitExec(["worktree", "remove", "--force", wt], { cwd: dir });
    } catch (err: unknown) {
      log.debug(`worktree remove failed for ${mindName}`, log.errorData(err));
    }
  }

  try {
    await gitExec(["worktree", "prune"], { cwd: dir });
  } catch (err: unknown) {
    log.debug(`worktree prune failed for ${mindName}`, log.errorData(err));
  }

  try {
    await gitExec(["branch", "-D", mindName], { cwd: dir });
  } catch {
    // branch may not exist
  }
}

// Mutex for serializing merge/pull operations
let pagesLock = Promise.resolve();

async function withPagesLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = pagesLock;
  let resolve_: () => void;
  pagesLock = new Promise<void>((r) => {
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
 * Squash-merge a mind's branch into main, then reset the mind's branch.
 */
export async function pagesMerge(
  mindName: string,
  mindDir: string,
  dataDir: string,
  message: string,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  const { gitExec, isIsolationEnabled, mindUserName, log } = await core();

  return withPagesLock(async () => {
    const dir = pagesRepoDir(dataDir);
    const wt = worktreePath(mindDir);

    // Commit pending changes
    const status = (await gitExec(["status", "--porcelain"], { cwd: wt })).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: wt });
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: wt },
      );
    }

    // Check if there's anything to merge
    const diff = (await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir })).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }

    // Squash-merge into main
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir });
    } catch {
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir });
      } catch (resetErr: unknown) {
        log.error("reset after squash conflict failed in pages repo", log.errorData(resetErr));
      }
      return { ok: false, conflicts: true, message: "Merge conflicts detected" };
    }

    await gitExec(["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message], {
      cwd: dir,
    });

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], { cwd: wt });
    } catch (err: unknown) {
      log.error(`pages merge: branch reset failed for ${mindName}`, log.errorData(err));
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
      };
    }

    if (isIsolationEnabled()) {
      try {
        execFileSync("chown", ["-R", `${mindUserName(mindName)}:volute`, wt], { stdio: "ignore" });
      } catch {
        // best effort
      }
    }

    return { ok: true };
  });
}

/**
 * Pull latest changes by rebasing the mind's branch onto main.
 */
export async function pagesPull(
  mindName: string,
  mindDir: string,
  dataDir: string,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  const { gitExec, isIsolationEnabled, mindUserName, log } = await core();

  return withPagesLock(async () => {
    const wt = worktreePath(mindDir);

    // Commit pending changes
    const status = (await gitExec(["status", "--porcelain"], { cwd: wt })).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: wt });
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: wt },
      );
    }

    // Rebase onto main
    try {
      await gitExec(["rebase", "main"], { cwd: wt });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict =
        errMsg.includes("CONFLICT") ||
        errMsg.includes("could not apply") ||
        errMsg.includes("merge conflict");

      try {
        await gitExec(["rebase", "--abort"], { cwd: wt });
      } catch (abortErr: unknown) {
        log.error("rebase abort failed in pages worktree", log.errorData(abortErr));
      }

      if (isConflict) {
        return {
          ok: false,
          conflicts: true,
          message:
            "Pull conflicts detected — your changes conflict with main. Reconcile the conflicting files, commit, and pull again.",
        };
      }

      log.error("pages pull rebase failed", log.errorData(err));
      return { ok: false, message: `Pull failed: ${errMsg}` };
    }

    if (isIsolationEnabled()) {
      try {
        execFileSync("chown", ["-R", `${mindUserName(mindName)}:volute`, wt], { stdio: "ignore" });
      } catch {
        // best effort
      }
    }

    return { ok: true, message: "Pulled latest shared changes." };
  });
}

/** Show what the mind has changed compared to main. */
export async function pagesStatus(mindDir: string): Promise<string> {
  const { gitExec } = await core();
  const wt = worktreePath(mindDir);
  const uncommitted = (await gitExec(["status", "--porcelain"], { cwd: wt })).trim();
  const diff = (await gitExec(["diff", "main...HEAD", "--stat"], { cwd: wt })).trim();
  let result = diff || "No changes compared to main.";
  if (uncommitted) {
    result += `\n\nUncommitted changes:\n${uncommitted}`;
  }
  return result;
}

/** Show recent commit history on main. */
export async function pagesLog(mindDir: string, limit = 20): Promise<string> {
  const { gitExec } = await core();
  const wt = worktreePath(mindDir);
  const output = (await gitExec(["log", "--oneline", "main", `-${limit}`], { cwd: wt })).trim();
  return output || "No history.";
}
