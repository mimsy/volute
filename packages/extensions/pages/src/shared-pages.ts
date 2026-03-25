/**
 * Git-based collaborative pages infrastructure.
 * Manages a central git repo with per-mind worktrees for collaborative system pages.
 * The repo lives in the pages extension data directory at <dataDir>/repo/.
 * Each mind gets a worktree at <mindDir>/home/pages/_system/ on a per-mind branch.
 */
import { execFile as execFileCb } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Isolation info needed by shared pages operations. */
export type IsolationInfo = {
  isIsolationEnabled: () => boolean;
  getMindUser: (name: string) => string;
};

/** Extract IsolationInfo from an ExtensionContext-shaped object. */
export function isolationFrom(ctx: {
  isIsolationEnabled: () => boolean;
  getMindUser: (name: string) => string;
}): IsolationInfo {
  return { isIsolationEnabled: ctx.isIsolationEnabled, getMindUser: ctx.getMindUser };
}

/** Run a command asynchronously. Resolves on success, rejects on error. Output is discarded. */
function execAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Run a git command. Adds safe.directory when isolation is enabled. */
function gitExec(
  args: string[],
  opts: { cwd: string },
  isolation?: IsolationInfo,
): Promise<string> {
  const fullArgs = isolation?.isIsolationEnabled() ? ["-c", "safe.directory=*", ...args] : args;
  return new Promise((resolve, reject) => {
    execFileCb("git", fullArgs, { cwd: opts.cwd }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stderr?: string; stdout?: string };
        e.stderr = stderr;
        e.stdout = stdout;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Read the gitdir path from a worktree's .git file. */
function readWorktreeGitDir(worktreePath: string): string | null {
  const dotGit = resolve(worktreePath, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    const content = readFileSync(dotGit, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`[pages] failed to read .git file at ${dotGit}: ${(err as Error).message}`);
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
export async function ensurePagesRepo(dataDir: string, isolation?: IsolationInfo): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  mkdirSync(dir, { recursive: true });

  if (existsSync(resolve(dir, ".git"))) {
    try {
      await gitExec(["rev-parse", "HEAD"], { cwd: dir }, isolation);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("unknown revision") || msg.includes("bad default revision")) {
        console.warn("[pages] repo has no commits, re-initializing");
        rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }

  const isIso = isolation?.isIsolationEnabled() ?? false;
  const initArgs = isIso ? ["init", "--shared=group"] : ["init"];
  await gitExec(initArgs, { cwd: dir }, isolation);
  await gitExec(["checkout", "-b", "main"], { cwd: dir }, isolation);

  writeFileSync(resolve(dir, ".gitkeep"), "");
  await gitExec(["add", "-A"], { cwd: dir }, isolation);
  await gitExec(["commit", "-m", "init pages repo"], { cwd: dir }, isolation);

  if (isIso) {
    try {
      await execAsync("chgrp", ["-R", "volute", dir]);
    } catch {
      console.warn("[pages] failed to chgrp pages repo to volute group");
    }
    chmodSync(dir, 0o2775);
  }
}

/** Add a git worktree at <mindDir>/home/pages/_system/ on a per-mind branch. */
export async function addPagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  if (!existsSync(resolve(dir, ".git"))) return;

  const wt = worktreePath(mindDir);
  if (existsSync(wt)) return;

  // Ensure parent pages/ directory exists
  mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", mindName], { cwd: dir }, isolation);
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  if (branchExists) {
    await gitExec(["worktree", "add", wt, mindName], { cwd: dir }, isolation);
  } else {
    await gitExec(["worktree", "add", "-b", mindName, wt], { cwd: dir }, isolation);
  }

  if (isolation?.isIsolationEnabled()) {
    const user = isolation.getMindUser(mindName);
    try {
      await execAsync("chown", ["-R", `${user}:volute`, wt]);
    } catch {
      console.warn(`[pages] failed to chown worktree for ${mindName}`);
    }
    const wtGitDir = readWorktreeGitDir(wt);
    if (wtGitDir) {
      try {
        await execAsync("chown", ["-R", `${user}:volute`, wtGitDir]);
      } catch {
        console.warn(`[pages] failed to chown worktree git dir for ${mindName}`);
      }
    }
  }
}

/** Remove the worktree and branch for a mind. */
export async function removePagesWorktree(
  mindName: string,
  mindDir: string,
  dataDir: string,
  isolation?: IsolationInfo,
): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  if (!existsSync(resolve(dir, ".git"))) return;

  const wt = worktreePath(mindDir);

  if (existsSync(wt)) {
    try {
      await gitExec(["worktree", "remove", "--force", wt], { cwd: dir }, isolation);
    } catch (err) {
      console.warn(`[pages] worktree remove failed for ${mindName}: ${(err as Error).message}`);
    }
  }

  try {
    await gitExec(["worktree", "prune"], { cwd: dir }, isolation);
  } catch (err) {
    console.warn(`[pages] worktree prune failed: ${(err as Error).message}`);
  }

  try {
    await gitExec(["branch", "-D", mindName], { cwd: dir }, isolation);
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
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    const dir = pagesRepoDir(dataDir);
    const wt = worktreePath(mindDir);

    // Commit pending changes
    const status = (await gitExec(["status", "--porcelain"], { cwd: wt }, isolation)).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: wt }, isolation);
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: wt },
        isolation,
      );
    }

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }

    // Squash-merge into main
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir }, isolation);
    } catch (err) {
      const errOutput = [
        (err as Error).message,
        (err as Error & { stderr?: string }).stderr ?? "",
        (err as Error & { stdout?: string }).stdout ?? "",
      ].join("\n");
      const isConflict = errOutput.includes("CONFLICT") || errOutput.includes("could not apply");
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir }, isolation);
      } catch (resetErr: unknown) {
        console.error("[pages] reset after squash conflict failed", resetErr);
      }
      if (isConflict) {
        return { ok: false, conflicts: true, message: "Merge conflicts detected" };
      }
      return { ok: false, message: `Merge failed: ${(err as Error).message}` };
    }

    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message],
      { cwd: dir },
      isolation,
    );

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], { cwd: wt }, isolation);
    } catch (err: unknown) {
      console.error(`[pages] branch reset failed for ${mindName}`, err);
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
      };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await execAsync("chown", ["-R", `${isolation.getMindUser(mindName)}:volute`, wt]);
      } catch {
        // Non-fatal: mind still functions but may hit permission errors
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
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    const wt = worktreePath(mindDir);

    // Commit pending changes
    const status = (await gitExec(["status", "--porcelain"], { cwd: wt }, isolation)).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: wt }, isolation);
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: wt },
        isolation,
      );
    }

    // Rebase onto main
    try {
      await gitExec(["rebase", "main"], { cwd: wt }, isolation);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict =
        errMsg.includes("CONFLICT") ||
        errMsg.includes("could not apply") ||
        errMsg.includes("merge conflict");

      try {
        await gitExec(["rebase", "--abort"], { cwd: wt }, isolation);
      } catch (abortErr: unknown) {
        console.error("[pages] rebase abort failed", abortErr);
      }

      if (isConflict) {
        return {
          ok: false,
          conflicts: true,
          message:
            "Pull conflicts detected — your changes conflict with main. Reconcile the conflicting files, commit, and pull again.",
        };
      }

      console.error("[pages] pull rebase failed", err);
      return { ok: false, message: `Pull failed: ${errMsg}` };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await execAsync("chown", ["-R", `${isolation.getMindUser(mindName)}:volute`, wt]);
      } catch {
        // best effort
      }
    }

    return { ok: true, message: "Pulled latest shared changes." };
  });
}

/**
 * Pull then merge in a single lock acquisition.
 * Without this, another mind could publish between our pull and merge, causing unnecessary conflicts.
 */
export async function pagesPullAndMerge(
  mindName: string,
  mindDir: string,
  dataDir: string,
  message: string,
  isolation?: IsolationInfo,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  return withPagesLock(async () => {
    const wt = worktreePath(mindDir);
    const dir = pagesRepoDir(dataDir);

    // Commit pending changes once (shared by pull and merge)
    const status = (await gitExec(["status", "--porcelain"], { cwd: wt }, isolation)).trim();
    if (status) {
      await gitExec(["add", "-A"], { cwd: wt }, isolation);
      await gitExec(
        ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", `wip: ${mindName}`],
        { cwd: wt },
        isolation,
      );
    }

    // Rebase onto main (pull)
    try {
      await gitExec(["rebase", "main"], { cwd: wt }, isolation);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict =
        errMsg.includes("CONFLICT") ||
        errMsg.includes("could not apply") ||
        errMsg.includes("merge conflict");

      try {
        await gitExec(["rebase", "--abort"], { cwd: wt }, isolation);
      } catch (abortErr: unknown) {
        console.error("[pages] rebase abort failed", abortErr);
      }

      if (isConflict) {
        return {
          ok: false,
          conflicts: true,
          message:
            "Pull conflicts detected — your changes conflict with main. Reconcile the conflicting files, commit, and try again.",
        };
      }
      return { ok: false, message: `Pull failed: ${errMsg}` };
    }

    // Check if there's anything to merge
    const diff = (
      await gitExec(["diff", `main...${mindName}`, "--stat"], { cwd: dir }, isolation)
    ).trim();
    if (!diff) {
      return { ok: true, message: "Nothing to publish" };
    }

    // Squash-merge into main
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir }, isolation);
    } catch (err) {
      const errOutput = [
        (err as Error).message,
        (err as Error & { stderr?: string }).stderr ?? "",
        (err as Error & { stdout?: string }).stdout ?? "",
      ].join("\n");
      const isConflict = errOutput.includes("CONFLICT") || errOutput.includes("could not apply");
      try {
        await gitExec(["reset", "--hard", "HEAD"], { cwd: dir }, isolation);
      } catch (resetErr: unknown) {
        console.error("[pages] reset after squash conflict failed", resetErr);
      }
      if (isConflict) {
        return { ok: false, conflicts: true, message: "Merge conflicts detected" };
      }
      return { ok: false, message: `Merge failed: ${(err as Error).message}` };
    }

    await gitExec(
      ["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message],
      { cwd: dir },
      isolation,
    );

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], { cwd: wt }, isolation);
    } catch (err: unknown) {
      console.error(`[pages] branch reset failed for ${mindName}`, err);
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
      };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await execAsync("chown", ["-R", `${isolation.getMindUser(mindName)}:volute`, wt]);
      } catch {
        // Non-fatal: mind still functions but may hit permission errors
      }
    }

    return { ok: true };
  });
}

/** Show what the mind has changed compared to main. */
export async function pagesStatus(mindDir: string, isolation?: IsolationInfo): Promise<string> {
  const wt = worktreePath(mindDir);
  const [uncommitted, diff] = await Promise.all([
    gitExec(["status", "--porcelain"], { cwd: wt }, isolation).then((s) => s.trim()),
    gitExec(["diff", "main...HEAD", "--stat"], { cwd: wt }, isolation).then((s) => s.trim()),
  ]);
  let result = diff || "No changes compared to main.";
  if (uncommitted) {
    result += `\n\nUncommitted changes:\n${uncommitted}`;
  }
  return result;
}

/** Show recent commit history on main. */
export async function pagesLog(
  mindDir: string,
  limit = 20,
  isolation?: IsolationInfo,
): Promise<string> {
  const wt = worktreePath(mindDir);
  const output = (
    await gitExec(["log", "--oneline", "main", `-${limit}`], { cwd: wt }, isolation)
  ).trim();
  return output || "No history.";
}
