import { existsSync, rmSync } from "node:fs";
import { gitExec } from "@volute/shared/exec";
import { chownMindDir } from "@volute/shared/isolation";
import { removeVariant } from "@volute/shared/variants";
import { getMindManager } from "./daemon/mind-manager.js";
import log from "./logger.js";

/**
 * Clean up a variant's git resources: stop process, remove worktree, delete branch,
 * remove metadata, and fix ownership. Each step is independently guarded so failures
 * don't prevent subsequent cleanup.
 */
export async function cleanupVariant(
  mindName: string,
  variantName: string,
  projectRoot: string,
  variantPath: string,
  opts?: { stop?: boolean },
): Promise<void> {
  if (opts?.stop) {
    try {
      await getMindManager().stopMind(`${mindName}@${variantName}`);
    } catch {}
  }

  if (existsSync(variantPath)) {
    try {
      await gitExec(["worktree", "remove", "--force", variantPath], { cwd: projectRoot });
    } catch {
      rmSync(variantPath, { recursive: true, force: true });
      try {
        await gitExec(["worktree", "prune"], { cwd: projectRoot });
      } catch {}
    }
  }

  try {
    await gitExec(["branch", "-D", variantName], { cwd: projectRoot });
  } catch {}

  try {
    removeVariant(mindName, variantName);
  } catch {}

  try {
    chownMindDir(projectRoot, mindName);
  } catch (err) {
    log.error(`failed to fix ownership during variant cleanup for ${mindName}`, log.errorData(err));
  }
}
