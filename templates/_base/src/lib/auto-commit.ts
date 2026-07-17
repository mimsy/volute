import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { log, warn } from "./logger.js";

function gitArgs(args: string[]): string[] {
  return process.env.VOLUTE_ISOLATION === "user" ? ["-c", "safe.directory=*", ...args] : args;
}

function exec(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((r) => {
    execFile(cmd, args, { cwd }, (_err, stdout) => {
      r({ code: _err ? 1 : 0, stdout: (stdout ?? "").trim() });
    });
  });
}

// Serialize git operations to prevent concurrent commits from conflicting
let pending = Promise.resolve();

// Pending file changes accumulated across all sessions, flushed on turn end
const pendingFiles = new Set<string>();
const pendingSharedFiles = new Set<string>();

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
 */
export function flushFileChanges(cwd?: string): Promise<void> {
  const filesToCommit = [...pendingFiles];
  const sharedToCommit = [...pendingSharedFiles];
  pendingFiles.clear();
  pendingSharedFiles.clear();

  if (filesToCommit.length === 0 && sharedToCommit.length === 0) {
    return pending.then(() => {});
  }

  const effectiveCwd = cwd ?? process.cwd();

  pending = pending.then(async () => {
    // Commit mind's own files. Only files that actually staged go into the commit
    // message — a file `git add` couldn't stage (typically because it's gitignored)
    // must never be named alongside files that really did commit, or the mind is
    // told its work is safe when it isn't (#656).
    if (filesToCommit.length > 0) {
      const staged: string[] = [];
      const blocked: string[] = [];
      for (const f of filesToCommit) {
        if ((await exec("git", ["add", f], effectiveCwd)).code === 0) {
          staged.push(f);
        } else {
          blocked.push(f);
        }
      }
      if (blocked.length > 0) {
        const pronoun = blocked.length === 1 ? "it" : "they";
        warn(
          "auto-commit",
          `git add failed for ${blocked.join(", ")} — likely gitignored, so ` +
            `${pronoun} will NOT be committed or survive a variant join`,
        );
      }
      // staged.length check guards against committing under a blank "Update "
      // message when every file in this batch was blocked — `diff --cached` can
      // still be non-empty from unrelated content already in the index (e.g. the
      // mind ran `git add` itself), which isn't this batch's to name or claim.
      if (
        staged.length > 0 &&
        (await exec("git", ["diff", "--cached", "--quiet"], effectiveCwd)).code !== 0
      ) {
        const names = staged.map((f) => f.replace(/^.*\//, "")).join(", ");
        const message = `Update ${names}`;
        if ((await exec("git", ["commit", "-m", message], effectiveCwd)).code === 0) {
          log("auto-commit", message);
          // Push if a remote is configured
          const { stdout: remote } = await exec("git", ["remote"], effectiveCwd);
          if (remote) {
            const pushResult = await exec("git", ["push"], effectiveCwd);
            if (pushResult.code !== 0) {
              log("auto-commit", `git push failed`);
            }
          }
        } else {
          log("auto-commit", `commit failed for: ${names}`);
        }
      }
    }

    // Commit collaborative pages worktree files. Same rule as the mind's own
    // files above: only what actually staged gets named in the commit message.
    if (sharedToCommit.length > 0) {
      const sharedCwd = resolve(effectiveCwd, "pages", "_system");
      const sharedPrefix = "pages/_system/";
      const mindName = process.env.VOLUTE_MIND ?? "unknown";

      const sharedStaged: string[] = [];
      const sharedBlocked: string[] = [];
      for (const f of sharedToCommit) {
        const sharedRelative = f.slice(sharedPrefix.length);
        if ((await exec("git", gitArgs(["add", sharedRelative]), sharedCwd)).code === 0) {
          sharedStaged.push(f);
        } else {
          sharedBlocked.push(f);
        }
      }
      if (sharedBlocked.length > 0) {
        const pronoun = sharedBlocked.length === 1 ? "it" : "they";
        warn(
          "auto-commit",
          `git add failed for ${sharedBlocked.join(", ")} — likely gitignored, so ` +
            `${pronoun} will NOT be committed`,
        );
      }
      if (
        sharedStaged.length > 0 &&
        (await exec("git", gitArgs(["diff", "--cached", "--quiet"]), sharedCwd)).code !== 0
      ) {
        const names = sharedStaged
          .map((f) => f.slice(sharedPrefix.length).replace(/^.*\//, ""))
          .join(", ");
        const message = `Update ${names}`;
        const authorFlag = `${mindName} <${mindName}@volute>`;
        if (
          (await exec("git", gitArgs(["commit", "--author", authorFlag, "-m", message]), sharedCwd))
            .code === 0
        ) {
          log("auto-commit", `[pages/_system] ${message}`);
        } else {
          log("auto-commit", `[pages/_system] commit failed`);
        }
      }
    }
  });

  return pending.then(() => {});
}

export function waitForCommits(): Promise<void> {
  return flushFileChanges();
}
