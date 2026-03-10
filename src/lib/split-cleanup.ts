import { existsSync, rmSync } from "node:fs";
import { getMindManager } from "./daemon/mind-manager.js";
import { gitExec } from "./exec.js";
import { chownMindDir } from "./isolation.js";
import log from "./logger.js";
import { getBaseName, removeMind } from "./registry.js";

/**
 * Clean up a split's git resources: stop process, remove worktree, delete branch,
 * remove from DB, and fix ownership. Each step is independently guarded so failures
 * don't prevent subsequent cleanup.
 */
export async function cleanupSplit(
  splitName: string,
  projectRoot: string,
  splitPath: string,
  opts?: { stop?: boolean },
): Promise<void> {
  if (opts?.stop) {
    try {
      await getMindManager().stopMind(splitName);
    } catch {}
  }

  // Get the branch name from the split entry before removing from DB
  const { findMind } = await import("./registry.js");
  const splitEntry = findMind(splitName);
  const branchName = splitEntry?.branch ?? splitName;

  if (existsSync(splitPath)) {
    try {
      await gitExec(["worktree", "remove", "--force", splitPath], { cwd: projectRoot });
    } catch {
      rmSync(splitPath, { recursive: true, force: true });
      try {
        await gitExec(["worktree", "prune"], { cwd: projectRoot });
      } catch {}
    }
  }

  try {
    await gitExec(["branch", "-D", branchName], { cwd: projectRoot });
  } catch {}

  try {
    removeMind(splitName);
  } catch {}

  const baseName = getBaseName(splitName);
  try {
    chownMindDir(projectRoot, baseName);
  } catch (err) {
    log.error(`failed to fix ownership during split cleanup for ${splitName}`, log.errorData(err));
  }
}
