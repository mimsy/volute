import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { log } from "./logger.js";

function exec(cmd: string, args: string[], cwd: string): Promise<{ code: number }> {
  return new Promise((r) => {
    execFile(cmd, args, { cwd }, (_err) => {
      r({ code: _err ? 1 : 0 });
    });
  });
}

// Serialize git operations to prevent concurrent commits from conflicting
let pending = Promise.resolve();

/**
 * Commit a file change in the agent's home directory.
 * Called by the PostToolUse hook when Edit or Write completes.
 */
export function commitFileChange(filePath: string, cwd: string): void {
  // Only commit files under the home directory
  const homeDir = resolve(cwd);
  const resolved = resolve(cwd, filePath);
  if (!resolved.startsWith(`${homeDir}/`) && resolved !== homeDir) return;

  const relativePath = resolved.slice(homeDir.length + 1);
  if (!relativePath) return;

  pending = pending.then(async () => {
    if ((await exec("git", ["add", relativePath], cwd)).code !== 0) {
      log("auto-commit", `git add failed for ${relativePath}`);
      return;
    }
    // Check if there are staged changes
    if ((await exec("git", ["diff", "--cached", "--quiet"], cwd)).code === 0) return;

    const message = `Update ${relativePath}`;
    if ((await exec("git", ["commit", "-m", message], cwd)).code === 0) {
      log("auto-commit", message);
    }
  });
}

export function waitForCommits(): Promise<void> {
  return pending.then(() => {});
}
