import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { log, warn } from "./logger.js";

/** Args for a git command in a worktree the mind may not own (the pages worktree, under user isolation). */
export function gitArgs(args: string[]): string[] {
  return process.env.VOLUTE_ISOLATION === "user" ? ["-c", "safe.directory=*", ...args] : args;
}

type Run = {
  code: number;
  stdout: string /** Ended by a signal (a stop's SIGTERM, say). */;
  killed: boolean;
};

function exec(cmd: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((r) => {
    execFile(cmd, args, { cwd }, (err, stdout) => {
      r({ code: err ? 1 : 0, stdout: (stdout ?? "").trim(), killed: Boolean(err?.signal) });
    });
  });
}

/**
 * Whether a rebase of the pages worktree onto main is stopped on a conflict. Committing
 * then would stage half-resolved files and leave the rebase unable to continue: the
 * mind resolves, `git add`s, and the next publish finishes it.
 */
async function rebaseStopped(cwd: string): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const { code, stdout } = await exec("git", gitArgs(["rev-parse", "--git-path", dir]), cwd);
    if (code === 0 && existsSync(resolve(cwd, stdout))) return true;
  }
  return false;
}

type Staging = {
  staged: string[];
  /** Refused because gitignored — never committed, so never retried. */
  ignored: string[];
  /** Failed for any other reason (killed, index.lock held, ...) — worth a retry. */
  failed: string[];
  killed: boolean;
};

/**
 * Stage `paths` (relative to `cwd`). One `git add` for the whole batch. Only when it
 * fails — typically because a path is gitignored, which fails the lot — are the paths
 * sorted out: `git check-ignore` names the ignored ones, and the rest are added again
 * (one by one if together they still fail), so a transient failure is never mistaken
 * for an ignored file.
 */
async function stage(
  paths: string[],
  cwd: string,
  args: (a: string[]) => string[] = (a) => a,
): Promise<Staging> {
  // Paths are file names, never glob patterns. (check-ignore takes plain paths, and
  // refuses the flag.)
  const git = (a: string[]) => exec("git", args(a), cwd);
  const add = (ps: string[]) => git(["--literal-pathspecs", "add", "--", ...ps]);

  const all = await add(paths);
  if (all.code === 0) return { staged: paths, ignored: [], failed: [], killed: false };
  if (all.killed) return { staged: [], ignored: [], failed: paths, killed: true };

  const check = await git(["check-ignore", "--", ...paths]);
  const flagged = new Set(check.code === 0 ? check.stdout.split("\n") : []);
  const ignored = paths.filter((p) => flagged.has(p));
  const rest = paths.filter((p) => !flagged.has(p));
  if (rest.length === 0 || (await add(rest)).code === 0) {
    return { staged: rest, ignored, failed: [], killed: false };
  }
  const staged: string[] = [];
  const failed: string[] = [];
  let killed = false;
  for (const p of rest) {
    const one = await add([p]);
    if (one.code === 0) staged.push(p);
    else {
      failed.push(p);
      killed ||= one.killed;
    }
  }
  return { staged, ignored, failed, killed };
}

// Serialize git operations to prevent concurrent commits from conflicting
let pending = Promise.resolve();

// Pending file changes accumulated across all sessions, flushed on turn end
const pendingFiles = new Set<string>();
const pendingSharedFiles = new Set<string>();

/** Files whose add or commit already failed once, not by being killed. */
const retried = new Set<string>();

/**
 * Put files whose add or commit failed back in `into`, for the next flush. A git killed
 * mid-flight — a stop's group SIGTERM landing on a turn-end commit still running after
 * `done` — is always retried (#1206); any other failure gets one retry, so one that
 * keeps failing (a refusing hook, a path that's gone) doesn't loop every turn.
 * Returns the files given up on.
 */
function requeue(files: string[], killed: boolean, into: Set<string>, cwd?: string): string[] {
  const dropped: string[] = [];
  for (const f of files) {
    // Given `cwd`, the files are ones whose add failed: one no longer on disk has nothing
    // left to add (a deletion of a tracked file adds fine), so it would only fail again.
    if (cwd && !existsSync(resolve(cwd, f))) dropped.push(f);
    else if (killed) into.add(f);
    else if (retried.delete(f)) dropped.push(f);
    else {
      retried.add(f);
      into.add(f);
    }
  }
  return dropped;
}

/**
 * Track a file change in the mind's home directory for batched commit.
 * Called by the PostToolUse hook when Edit or Write completes.
 *
 * Files under home/pages/_system/ are tracked separately for the collaborative pages worktree.
 * All other files go to the mind's own repo.
 */
export function trackFileChange(filePath: string, cwd: string): void {
  // Only track files under the home directory
  const homeDir = resolve(cwd);
  const resolved = resolve(cwd, filePath);
  if (!resolved.startsWith(`${homeDir}/`) && resolved !== homeDir) return;

  const relativePath = resolved.slice(homeDir.length + 1);
  if (!relativePath) return;

  const sharedPrefix = "pages/_system/";
  if (relativePath.startsWith(sharedPrefix)) {
    pendingSharedFiles.add(relativePath);
  } else {
    pendingFiles.add(relativePath);
  }
}

/**
 * Flush all pending file changes into batched commits.
 * Called at the end of each turn. Produces up to two commits:
 * one for the mind's own repo and one for the shared worktree.
 *
 * What's pending is read when this flush's turn on the chain comes, not when it's
 * called, so a flush always picks up files an earlier, failed one re-queued.
 */
export function flushFileChanges(cwd?: string): Promise<void> {
  const effectiveCwd = cwd ?? process.cwd();
  pending = pending.then(() => commitPending(effectiveCwd));
  return pending;
}

/**
 * Flush until nothing is pending and no flush is queued — for shutdown, so a commit the
 * stop killed is retried and a turn-end flush that starts meanwhile (the reap ending a
 * session) is waited for. Bounded: a git killed again and again can't hold shutdown.
 */
export async function drainFileChanges(cwd: string): Promise<void> {
  const waiting = () => [...pendingFiles, "|", ...pendingSharedFiles].sort().join("\n");
  for (let round = 0; round < 5; round++) {
    const before = waiting();
    const tail = flushFileChanges(cwd);
    await tail;
    if (pending !== tail) continue; // another flush queued meanwhile
    // Settled — or only files that will wait regardless (a stopped pages rebase) remain.
    if (waiting() === "|" || waiting() === before) return;
  }
}

async function commitPending(cwd: string): Promise<void> {
  const filesToCommit = [...pendingFiles];
  const sharedToCommit = [...pendingSharedFiles];
  pendingFiles.clear();
  pendingSharedFiles.clear();

  // Commit mind's own files. Only files that actually staged go into the commit
  // message — a file `git add` couldn't stage (typically because it's gitignored)
  // must never be named alongside files that really did commit, or the mind is
  // told its work is safe when it isn't (#656).
  if (filesToCommit.length > 0) {
    const { staged, ignored, failed, killed } = await stage(filesToCommit, cwd);
    reportUnstaged(
      ignored,
      requeue(failed, killed, pendingFiles, cwd),
      "or survive a variant join",
    );
    // staged.length check guards against committing under a blank "Update "
    // message when every file in this batch was blocked — `diff --cached` can
    // still be non-empty from unrelated content already in the index (e.g. the
    // mind ran `git add` itself), which isn't this batch's to name or claim.
    if (staged.length > 0 && (await exec("git", ["diff", "--cached", "--quiet"], cwd)).code !== 0) {
      const names = staged.map((f) => f.replace(/^.*\//, "")).join(", ");
      const message = `Update ${names}`;
      const commit = await exec("git", ["commit", "-m", message], cwd);
      if (commit.code === 0) {
        for (const f of staged) retried.delete(f);
        log("auto-commit", message);
        // Push if a remote is configured
        const { stdout: remote } = await exec("git", ["remote"], cwd);
        if (remote) {
          const pushResult = await exec("git", ["push"], cwd);
          if (pushResult.code !== 0) {
            log("auto-commit", `git push failed`);
          }
        }
      } else {
        const dropped = requeue(staged, commit.killed, pendingFiles);
        log(
          "auto-commit",
          `commit failed for: ${names}${dropped.length > 0 ? " — giving up on it" : " — will retry"}`,
        );
      }
    }
  }

  // Commit collaborative pages worktree files. Same rule as the mind's own
  // files above: only what actually staged gets named in the commit message.
  const sharedCwd = resolve(cwd, "pages", "_system");
  if (sharedToCommit.length > 0 && (await rebaseStopped(sharedCwd))) {
    // Held, not dropped: the next flush after the rebase finishes commits them.
    for (const f of sharedToCommit) pendingSharedFiles.add(f);
    log("auto-commit", "[pages/_system] rebase in progress, not committing yet");
  } else if (sharedToCommit.length > 0) {
    const sharedPrefix = "pages/_system/";
    const mindName = process.env.VOLUTE_MIND ?? "unknown";
    const prefixed = (fs: string[]) => fs.map((f) => sharedPrefix + f);

    const shared = await stage(
      sharedToCommit.map((f) => f.slice(sharedPrefix.length)),
      sharedCwd,
      gitArgs,
    );
    const sharedStaged = prefixed(shared.staged);
    reportUnstaged(
      prefixed(shared.ignored),
      requeue(prefixed(shared.failed), shared.killed, pendingSharedFiles, cwd),
    );
    if (
      sharedStaged.length > 0 &&
      (await exec("git", gitArgs(["diff", "--cached", "--quiet"]), sharedCwd)).code !== 0
    ) {
      const names = shared.staged.map((f) => f.replace(/^.*\//, "")).join(", ");
      const message = `Update ${names}`;
      const authorFlag = `${mindName} <${mindName}@volute>`;
      const commit = await exec(
        "git",
        gitArgs(["commit", "--author", authorFlag, "-m", message]),
        sharedCwd,
      );
      if (commit.code === 0) {
        for (const f of sharedStaged) retried.delete(f);
        log("auto-commit", `[pages/_system] ${message}`);
      } else {
        const dropped = requeue(sharedStaged, commit.killed, pendingSharedFiles);
        log(
          "auto-commit",
          `[pages/_system] commit failed${dropped.length > 0 ? " — giving up on it" : " — will retry"}`,
        );
      }
    }
  }
}

/** Warn about files that will not be committed: gitignored, gone, or given up on after a retry. */
function reportUnstaged(ignored: string[], dropped: string[], consequence = ""): void {
  const tail = consequence ? ` ${consequence}` : "";
  if (ignored.length > 0) {
    const pronoun = ignored.length === 1 ? "it" : "they";
    const verb = ignored.length === 1 ? "is" : "are";
    warn(
      "auto-commit",
      `${ignored.join(", ")} ${verb} gitignored, so ${pronoun} will NOT be committed${tail}`,
    );
  }
  if (dropped.length > 0) {
    const pronoun = dropped.length === 1 ? "it" : "they";
    warn(
      "auto-commit",
      `git add failed for ${dropped.join(", ")} (twice, or the file is gone), so ${pronoun} will NOT be committed${tail}`,
    );
  }
}
