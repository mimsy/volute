/**
 * Git-based collaborative pages infrastructure.
 * Manages a central git repo with per-mind worktrees for collaborative system pages.
 * The repo lives in the pages extension data directory at <dataDir>/repo/.
 * Each mind gets a worktree at <mindDir>/home/pages/_system/ on a per-mind branch.
 */
import { execFile as execFileCb } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";

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

/**
 * Committer identity for pages commits. `--author` on the commit calls sets the
 * author but not the committer, so without this a host lacking a global git
 * identity fails at the commit step (leaving a partial repo). Setting it per
 * invocation keeps commits independent of host git config.
 */
const IDENTITY_ARGS = ["-c", "user.name=volute", "-c", "user.email=volute@localhost"];

/**
 * Run a git command. Adds safe.directory when isolation is enabled, and a
 * committer identity for `commit` so commits never depend on host git config.
 */
function gitExec(
  args: string[],
  opts: { cwd: string },
  isolation?: IsolationInfo,
): Promise<string> {
  const prefix: string[] = [];
  if (isolation?.isIsolationEnabled()) prefix.push("-c", "safe.directory=*");
  if (args[0] === "commit") prefix.push(...IDENTITY_ARGS);
  const fullArgs = prefix.length ? [...prefix, ...args] : args;
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

/**
 * Paths that must be owned by the mind user when isolation is enabled.
 * The daemon runs as root, so the parent home/pages directory it provisions is
 * created root-owned — chowning only the _system worktree would leave the mind
 * unable to write its own pages. The parent dir is chowned recursively (covering
 * the _system worktree too); the worktree git dir lives outside pages/ and is
 * chowned separately.
 */
export function pagesIsolationChownPaths(mindDir: string, wtGitDir: string | null): string[] {
  const paths = [resolve(mindDir, "home", "pages")];
  if (wtGitDir) paths.push(wtGitDir);
  return paths;
}

/**
 * Whether `dir` is a usable pages repo: a valid git repository with at least one
 * commit on HEAD. A husk `.git` left by an interrupted init (e.g. only a
 * `branches/` subdir), or a valid-but-commitless repo, both fail this probe.
 */
async function isRepoValid(dir: string, isolation?: IsolationInfo): Promise<boolean> {
  try {
    await gitExec(["rev-parse", "HEAD"], { cwd: dir }, isolation);
    return true;
  } catch {
    return false;
  }
}

/** Idempotently initialize the collaborative pages git repo. */
export async function ensurePagesRepo(dataDir: string, isolation?: IsolationInfo): Promise<void> {
  const dir = pagesRepoDir(dataDir);
  mkdirSync(dir, { recursive: true });

  if (existsSync(resolve(dir, ".git"))) {
    if (await isRepoValid(dir, isolation)) return;
    // Any invalid or incomplete state — a husk .git from an interrupted init, or
    // a repo with no commits — is wiped and re-initialized. The repo's content
    // is regenerable (it's synced from minds' pages), so aggressive re-init is
    // safe, and it self-heals boxes stuck with a broken repo on next daemon start.
    console.warn("[pages] repo invalid or incomplete, re-initializing");
    rmSync(resolve(dir, ".git"), { recursive: true, force: true });
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
  // Never shell into a broken repo: skip quietly and let ensurePagesRepo repair
  // it on the next daemon start rather than failing every mind start noisily.
  if (!(await isRepoValid(dir, isolation))) {
    console.warn(`[pages] repo not usable, skipping worktree for ${mindName}`);
    return;
  }

  const wt = worktreePath(mindDir);
  if (existsSync(wt)) {
    // A real worktree has a `.git` file. A plain directory here is what a mind
    // creates by hand when publishing failed for lack of a worktree (#795) — say
    // so, because git then refuses to provision over it and every later publish
    // fails with an opaque `invalid upstream` deep inside the rebase.
    if (!existsSync(resolve(wt, ".git"))) {
      console.warn(
        `[pages] ${wt} exists but is not a worktree — shared publishing will fail for ${mindName}. Move it aside and restart the mind to provision one.`,
      );
    }
    return;
  }

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
    const wtGitDir = readWorktreeGitDir(wt);
    for (const target of pagesIsolationChownPaths(mindDir, wtGitDir)) {
      try {
        await execAsync("chown", ["-R", `${user}:volute`, target]);
      } catch {
        console.warn(`[pages] failed to chown ${target} for ${mindName}`);
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
): Promise<{
  ok: boolean;
  conflicts?: boolean;
  message?: string;
  changedFiles?: string[];
  priorAuthors?: Record<string, string[]>;
}> {
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

    // Contributor bookkeeping for the caller's social events. Inside the lock on
    // purpose: HEAD is guaranteed to still be our squash commit.
    let changedFiles: string[] = [];
    const priorAuthors: Record<string, string[]> = {};
    try {
      changedFiles = (
        await gitExec(["diff", "--name-only", "HEAD^", "HEAD"], { cwd: dir }, isolation)
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const file of changedFiles) {
        const names = (
          await gitExec(["log", "--format=%an", "HEAD^", "--", file], { cwd: dir }, isolation)
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        // "volute" is the committer identity used for the repo-init commit — not a mind.
        const unique = [...new Set(names)].filter((n) => n !== mindName && n !== "volute");
        if (unique.length > 0) priorAuthors[file] = unique;
      }
    } catch (err) {
      console.warn(`[pages] contributor lookup failed: ${(err as Error).message}`);
    }

    // Reset mind's branch to main
    try {
      await gitExec(["reset", "--hard", "main"], { cwd: wt }, isolation);
    } catch (err: unknown) {
      console.error(`[pages] branch reset failed for ${mindName}`, err);
      return {
        ok: true,
        message: "Published to main, but branch reset failed — run 'volute pages pull' to sync",
        changedFiles,
        priorAuthors,
      };
    }

    if (isolation?.isIsolationEnabled()) {
      try {
        await execAsync("chown", ["-R", `${isolation.getMindUser(mindName)}:volute`, wt]);
      } catch {
        // Non-fatal: mind still functions but may hit permission errors
      }
    }

    return { ok: true, changedFiles, priorAuthors };
  });
}

/** Recursively collect HTML and Markdown files in a directory, returning paths relative to baseDir. */
export function collectPageFiles(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string) {
    let items: string[];
    try {
      items = readdirSync(d);
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const item of items) {
      if (item.startsWith(".")) continue;
      const full = resolve(d, item);
      try {
        const s = statSync(full);
        if (s.isFile() && (item.endsWith(".html") || item.endsWith(".md"))) {
          files.push(relative(dir, full));
        } else if (s.isDirectory()) {
          walk(full);
        }
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EACCES") continue;
        throw err;
      }
    }
  }
  walk(dir);
  return files.sort();
}

/** Whether a file path is a page file we track (HTML or Markdown). */
export function isPageFile(f: string): boolean {
  return f.endsWith(".html") || f.endsWith(".md");
}

/** Show files in the mind's shared pages worktree with draft/published status. */
export async function pagesStatus(mindDir: string, isolation?: IsolationInfo): Promise<string> {
  const wt = worktreePath(mindDir);

  // Get files on main and files on the mind's branch (including uncommitted)
  const errors: Error[] = [];
  const [mainFiles, branchFiles, uncommitted] = await Promise.all([
    gitExec(["ls-tree", "-r", "--name-only", "main"], { cwd: wt }, isolation)
      .then((s) => s.trim().split("\n").filter(Boolean))
      .catch((err) => {
        errors.push(err);
        return [] as string[];
      }),
    gitExec(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: wt }, isolation)
      .then((s) => s.trim().split("\n").filter(Boolean))
      .catch((err) => {
        errors.push(err);
        return [] as string[];
      }),
    gitExec(["status", "--porcelain"], { cwd: wt }, isolation)
      .then((s) => s.trim())
      .catch((err) => {
        errors.push(err);
        return "";
      }),
  ]);

  if (errors.length === 3) {
    throw new Error(`Shared pages git error: ${errors[0].message}`);
  }

  // Parse uncommitted files (new/modified)
  const uncommittedFiles = new Set<string>();
  if (uncommitted) {
    for (const line of uncommitted.split("\n")) {
      const match = line.match(/^.{2}\s+(.+)$/);
      if (match) uncommittedFiles.add(match[1]);
    }
  }

  const mainSet = new Set(mainFiles.filter(isPageFile));
  const allPageFiles = new Set([
    ...mainFiles.filter(isPageFile),
    ...branchFiles.filter(isPageFile),
    ...[...uncommittedFiles].filter(isPageFile),
  ]);

  if (allPageFiles.size === 0) return "No shared pages found.";

  const lines = [...allPageFiles].sort().map((file) => {
    const onMain = mainSet.has(file);
    const isUncommitted = uncommittedFiles.has(file);
    let status: string;
    if (isUncommitted) {
      status = "uncommitted";
    } else if (onMain) {
      status = "published";
    } else {
      status = "draft";
    }
    return `${status.padEnd(13)} ${file}`;
  });

  return lines.join("\n");
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
