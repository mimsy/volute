import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { log, warn } from "./logger.js";

/** Args for a git command in a worktree the mind may not own (the pages worktree, under user isolation). */
export function gitArgs(args: string[]): string[] {
  return process.env.VOLUTE_ISOLATION === "user" ? ["-c", "safe.directory=*", ...args] : args;
}

type Run = {
  code: number;
  stdout: string;
  /** Ended by a signal (a stop's SIGTERM, say). */
  killed: boolean;
};

function exec(cmd: string, args: string[], cwd: string, input?: string): Promise<Run> {
  return new Promise((r) => {
    const child = execFile(cmd, args, { cwd }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      r({ code, stdout: (stdout ?? "").trim(), killed: Boolean(err?.signal) });
    });
    // A git that dies before reading its input must not take the mind down with an
    // unhandled EPIPE; its own exit already reports the failure.
    child.stdin?.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
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
  /** The failed ones whose git was killed by a signal. */
  killed: Set<string>;
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
  const git = (a: string[], input?: string) => exec("git", args(a), cwd, input);
  // Paths are file names, never glob patterns.
  const add = (ps: string[]) => git(["--literal-pathspecs", "add", "--", ...ps]);

  const all = await add(paths);
  if (all.code === 0) return { staged: paths, ignored: [], failed: [], killed: new Set() };
  if (all.killed) return { staged: [], ignored: [], failed: paths, killed: new Set(paths) };

  const flagged = await ignoredAmong(paths, git);
  const ignored = paths.filter((p) => flagged.has(p));
  const rest = paths.filter((p) => !flagged.has(p));
  if (rest.length === 0 || (await add(rest)).code === 0) {
    return { staged: rest, ignored, failed: [], killed: new Set() };
  }
  const staged: string[] = [];
  const failed: string[] = [];
  const killed = new Set<string>();
  for (const p of rest) {
    const one = await add([p]);
    if (one.code === 0) staged.push(p);
    else {
      failed.push(p);
      if (one.killed) killed.add(p);
    }
  }
  return { staged, ignored, failed, killed };
}

/**
 * Which of `paths` git ignores. One `check-ignore` for the lot (NUL-separated, so any
 * file name survives); if that fails outright (128 — one bad path, a pathspec beyond a
 * symlink, fails the lot) each path is checked alone, and one that can't be checked
 * counts as not ignored, so it is retried rather than written off.
 */
async function ignoredAmong(
  paths: string[],
  git: (a: string[], input?: string) => Promise<Run>,
): Promise<Set<string>> {
  const all = await git(["check-ignore", "-z", "--stdin"], `${paths.join("\0")}\0`);
  if (all.code === 0) return new Set(all.stdout.split("\0").filter(Boolean));
  if (all.code === 1 && !all.killed) return new Set();
  const flagged = new Set<string>();
  for (const p of paths) {
    if ((await git(["check-ignore", "-q", "--", p])).code === 0) flagged.add(p);
  }
  return flagged;
}

// Serialize git operations to prevent concurrent commits from conflicting
let pending = Promise.resolve();

// Pending file changes accumulated across all sessions, flushed on turn end
const pendingFiles = new Set<string>();
const pendingSharedFiles = new Set<string>();

/**
 * Files whose add (or commit) already failed once, not by being killed. Kept apart
 * because a file that stages fine and then fails to commit must still run out of
 * retries. An add mark clears when the file stages; a commit mark when its commit
 * lands or there turns out to be nothing to commit. Bounded, so neither grows over a
 * long life.
 */
const addRetried = new Set<string>();
const commitRetried = new Set<string>();
const RETRIED_MAX = 1000;

/**
 * Files given up on, with the state they were in. Skipped until they change — codex
 * re-tracks every changed path from `git status` each turn, and without this a file
 * that can't be committed would go round fail, retry, give up every other turn.
 * Bounded like the retry marks.
 */
const givenUp = new Map<string, string>();

function stamp(cwd: string, f: string): string {
  try {
    const st = statSync(resolve(cwd, f));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "gone";
  }
}

/** Whether a tracked file is worth trying: not given up on, or changed since. */
function fresh(cwd: string, f: string): boolean {
  const at = givenUp.get(f);
  if (at === undefined) return true;
  if (at === stamp(cwd, f)) return false;
  givenUp.delete(f);
  return true;
}

/**
 * Put files whose add or commit failed back in `into`, for the next flush. A git killed
 * mid-flight — a stop's group SIGTERM landing on a turn-end commit still running after
 * `done` — is always retried (#1206); any other failure gets one retry, so one that
 * keeps failing (a refusing hook, a path that's gone) doesn't loop every turn.
 * Returns the files given up on.
 */
function requeue(
  files: string[],
  killed: (f: string) => boolean,
  into: Set<string>,
  retried: Set<string>,
  cwd: string,
  addFailed = false,
): string[] {
  const dropped: string[] = [];
  for (const f of files) {
    // Killed first: a killed add of a tracked file's deletion must be retried, though
    // the file is gone — the deletion stages fine.
    if (killed(f)) into.add(f);
    // A failed add of a file no longer on disk (and not killed) has nothing left to
    // add, so it would only fail again.
    else if (addFailed && !existsSync(resolve(cwd, f))) dropped.push(f);
    else if (retried.delete(f)) dropped.push(f);
    else {
      retried.add(f);
      if (retried.size > RETRIED_MAX) retried.delete(retried.values().next().value as string);
      into.add(f);
    }
  }
  for (const f of dropped) {
    givenUp.set(f, stamp(cwd, f));
    if (givenUp.size > RETRIED_MAX) givenUp.delete(givenUp.keys().next().value as string);
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
  // Never left rejected: one failed flush must not fail every flush after it.
  pending = pending
    .then(() => commitPending(effectiveCwd))
    .catch((err) => warn("auto-commit", "flush failed:", err));
  return pending;
}

/**
 * Flush until nothing is pending and no flush is queued — for shutdown, so a commit the
 * stop killed is retried and a turn-end flush that starts meanwhile (the reap ending a
 * session) is waited for. Bounded in rounds (a git killed again and again, files held
 * through a stopped pages rebase), but never returns with a flush still queued.
 */
export async function drainFileChanges(cwd: string): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const tail = flushFileChanges(cwd);
    await tail;
    if (pending === tail && pendingFiles.size === 0 && pendingSharedFiles.size === 0) return;
  }
  let tail: Promise<void>;
  do {
    tail = pending;
    await tail;
  } while (pending !== tail);
}

async function commitPending(cwd: string): Promise<void> {
  const filesToCommit = [...pendingFiles].filter((f) => fresh(cwd, f));
  const sharedToCommit = [...pendingSharedFiles].filter((f) => fresh(cwd, f));
  pendingFiles.clear();
  pendingSharedFiles.clear();

  // Commit mind's own files. Only files that actually staged go into the commit
  // message — a file `git add` couldn't stage (typically because it's gitignored)
  // must never be named alongside files that really did commit, or the mind is
  // told its work is safe when it isn't (#656).
  if (filesToCommit.length > 0) {
    const { staged, ignored, failed, killed } = await stage(filesToCommit, cwd);
    for (const f of staged) addRetried.delete(f);
    reportUnstaged(
      ignored,
      requeue(failed, (f) => killed.has(f), pendingFiles, addRetried, cwd, true),
      "or survive a variant join",
    );
    // staged.length check guards against committing under a blank "Update "
    // message when every file in this batch was blocked — `diff --cached` can
    // still be non-empty from unrelated content already in the index (e.g. the
    // mind ran `git add` itself), which isn't this batch's to name or claim.
    const changed =
      staged.length > 0 && (await exec("git", ["diff", "--cached", "--quiet"], cwd)).code !== 0;
    if (!changed) for (const f of staged) commitRetried.delete(f); // nothing left to commit
    if (changed) {
      const names = staged.map((f) => f.replace(/^.*\//, "")).join(", ");
      const message = `Update ${names}`;
      const commit = await exec("git", ["commit", "-m", message], cwd);
      if (commit.code === 0) {
        for (const f of staged) commitRetried.delete(f);
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
        const dropped = requeue(staged, () => commit.killed, pendingFiles, commitRetried, cwd);
        if (dropped.length === 0) log("auto-commit", `commit failed for: ${names} — will retry`);
        else await giveUp(dropped, cwd, (a) => a, `commit failed twice for ${names}`);
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
    for (const f of sharedStaged) addRetried.delete(f);
    reportUnstaged(
      prefixed(shared.ignored),
      requeue(
        prefixed(shared.failed),
        (f) => shared.killed.has(f.slice(sharedPrefix.length)),
        pendingSharedFiles,
        addRetried,
        cwd,
        true,
      ),
    );
    const changed =
      sharedStaged.length > 0 &&
      (await exec("git", gitArgs(["diff", "--cached", "--quiet"]), sharedCwd)).code !== 0;
    if (!changed) for (const f of sharedStaged) commitRetried.delete(f);
    if (changed) {
      const names = shared.staged.map((f) => f.replace(/^.*\//, "")).join(", ");
      const message = `Update ${names}`;
      const authorFlag = `${mindName} <${mindName}@volute>`;
      const commit = await exec(
        "git",
        gitArgs(["commit", "--author", authorFlag, "-m", message]),
        sharedCwd,
      );
      if (commit.code === 0) {
        for (const f of sharedStaged) commitRetried.delete(f);
        log("auto-commit", `[pages/_system] ${message}`);
      } else {
        const dropped = requeue(
          sharedStaged,
          () => commit.killed,
          pendingSharedFiles,
          commitRetried,
          cwd,
        );
        if (dropped.length === 0) log("auto-commit", `[pages/_system] commit failed — will retry`);
        else {
          await giveUp(
            dropped.map((f) => f.slice(sharedPrefix.length)),
            sharedCwd,
            gitArgs,
            `[pages/_system] commit failed twice for ${names}`,
          );
        }
      }
    }
  }
}

/**
 * Give up on files whose commit failed twice: unstage them, so they can't ride into some
 * later commit under another file's name (#656), and tell the mind.
 */
async function giveUp(
  paths: string[],
  cwd: string,
  args: (a: string[]) => string[],
  why: string,
): Promise<void> {
  await exec("git", args(["--literal-pathspecs", "reset", "-q", "--", ...paths]), cwd);
  const pronoun = paths.length === 1 ? "it" : "they";
  warn("auto-commit", `${why}, so ${pronoun} will NOT be committed — left unstaged`);
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
