import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitExec } from "./exec.js";
import { isIsolationEnabled } from "./isolation.js";
import { voluteHome } from "./registry.js";

/** Path to the shared repo: ~/.volute/shared/ */
export function sharedDir(): string {
  return resolve(voluteHome(), "shared");
}

/** Idempotently initialize ~/.volute/shared/ as a git repo with pages/ and initial commit. */
export async function ensureSharedRepo(): Promise<void> {
  const dir = sharedDir();
  mkdirSync(dir, { recursive: true });

  if (existsSync(resolve(dir, ".git"))) return;

  await gitExec(["init"], { cwd: dir });
  await gitExec(["checkout", "-b", "main"], { cwd: dir });

  // Seed with pages/ directory
  const pagesDir = resolve(dir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(resolve(pagesDir, ".gitkeep"), "");

  await gitExec(["add", "-A"], { cwd: dir });
  await gitExec(["commit", "-m", "init shared repo"], { cwd: dir });

  if (isIsolationEnabled()) {
    // Make group-writable so all mind users can access via volute group
    chmodSync(dir, 0o2775);
    await gitExec(["config", "core.sharedRepository", "group"], { cwd: dir });
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
}

/** Remove the shared worktree and branch for a mind. */
export async function removeSharedWorktree(mindName: string, mindDir: string): Promise<void> {
  const dir = sharedDir();
  if (!existsSync(resolve(dir, ".git"))) return;

  const worktreePath = resolve(mindDir, "home", "shared");

  if (existsSync(worktreePath)) {
    try {
      await gitExec(["worktree", "remove", "--force", worktreePath], { cwd: dir });
    } catch {
      // best effort
    }
  }

  // Prune stale worktree refs before deleting the branch
  try {
    await gitExec(["worktree", "prune"], { cwd: dir });
  } catch {
    // best effort
  }

  try {
    await gitExec(["branch", "-D", mindName], { cwd: dir });
  } catch {
    // branch may not exist
  }
}

// Mutex for serializing merge operations on main
let mergeLock = Promise.resolve();

/**
 * Squash-merge a mind's branch into main, then reset the mind's branch to main.
 * Returns { ok, conflicts?, message? }.
 */
export async function sharedMerge(
  mindName: string,
  mindDir: string,
  message: string,
): Promise<{ ok: boolean; conflicts?: boolean; message?: string }> {
  const dir = sharedDir();
  const worktreePath = resolve(mindDir, "home", "shared");

  // Serialize on the merge lock
  let result: { ok: boolean; conflicts?: boolean; message?: string };
  const prev = mergeLock;
  mergeLock = prev.then(() => doMerge()).catch(() => {});

  async function doMerge() {
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
      result = { ok: true, message: "Nothing to merge" };
      return;
    }

    // Squash-merge into main from the central repo
    try {
      await gitExec(["merge", "--squash", mindName], { cwd: dir });
    } catch {
      // Conflict — abort and report
      try {
        await gitExec(["merge", "--abort"], { cwd: dir });
      } catch {
        // may not be in merge state
      }
      result = { ok: false, conflicts: true, message: "Merge conflicts detected" };
      return;
    }

    await gitExec(["commit", "--author", `${mindName} <${mindName}@volute>`, "-m", message], {
      cwd: dir,
    });

    // Reset mind's branch to main so next round starts fresh
    await gitExec(["checkout", mindName], { cwd: worktreePath });
    await gitExec(["reset", "--hard", "main"], { cwd: worktreePath });

    result = { ok: true };
  }

  await prev;
  await doMerge();
  return result!;
}

/** Rebase the mind's branch onto latest main to pick up others' changes. */
export async function sharedPull(
  mindName: string,
  mindDir: string,
): Promise<{ ok: boolean; message?: string }> {
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
    return { ok: true };
  } catch {
    // Abort failed rebase
    try {
      await gitExec(["rebase", "--abort"], { cwd: worktreePath });
    } catch {
      // best effort
    }
    return { ok: false, message: "Rebase failed — conflicts with main" };
  }
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
