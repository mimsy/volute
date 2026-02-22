import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { log } from "./logger.js";

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

/**
 * Commit a file change in the mind's home directory.
 * Called by the PostToolUse hook when Edit or Write completes.
 *
 * Files under home/shared/ are committed to the shared worktree repo
 * with mind attribution. All other files go to the mind's own repo.
 */
export function commitFileChange(filePath: string, cwd: string): void {
  // Only commit files under the home directory
  const homeDir = resolve(cwd);
  const resolved = resolve(cwd, filePath);
  if (!resolved.startsWith(`${homeDir}/`) && resolved !== homeDir) return;

  const relativePath = resolved.slice(homeDir.length + 1);
  if (!relativePath) return;

  // Check if this file is under the shared/ worktree
  const sharedPrefix = "shared/";
  const isShared = relativePath.startsWith(sharedPrefix);

  pending = pending.then(async () => {
    if (isShared) {
      // Route to shared worktree
      const sharedCwd = resolve(cwd, "shared");
      const sharedRelative = relativePath.slice(sharedPrefix.length);
      const mindName = process.env.VOLUTE_MIND ?? "unknown";

      if ((await exec("git", gitArgs(["add", sharedRelative]), sharedCwd)).code !== 0) {
        log("auto-commit", `git add failed for shared/${sharedRelative}`);
        return;
      }
      if ((await exec("git", gitArgs(["diff", "--cached", "--quiet"]), sharedCwd)).code === 0)
        return;

      const message = `Update ${sharedRelative}`;
      const authorFlag = `${mindName} <${mindName}@volute>`;
      if (
        (await exec("git", gitArgs(["commit", "--author", authorFlag, "-m", message]), sharedCwd))
          .code === 0
      ) {
        log("auto-commit", `[shared] ${message}`);
      }
      // No auto-push for shared files — sharing is deliberate
    } else {
      // Existing behavior: commit to mind's own repo
      if ((await exec("git", ["add", relativePath], cwd)).code !== 0) {
        log("auto-commit", `git add failed for ${relativePath}`);
        return;
      }
      if ((await exec("git", ["diff", "--cached", "--quiet"], cwd)).code === 0) return;

      const message = `Update ${relativePath}`;
      if ((await exec("git", ["commit", "-m", message], cwd)).code === 0) {
        log("auto-commit", message);
        // Push if a remote is configured
        const { stdout: remote } = await exec("git", ["remote"], cwd);
        if (remote) {
          await exec("git", ["push"], cwd);
        }
      }
    }
  });
}

export function waitForCommits(): Promise<void> {
  return pending.then(() => {});
}
