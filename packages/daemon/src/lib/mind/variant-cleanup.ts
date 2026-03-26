import { existsSync, rmSync } from "node:fs";
import { getMindManager } from "../daemon/mind-manager.js";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { chownMindDir } from "./isolation.js";
import { removeMind } from "./registry.js";

/**
 * Clean up a variant's git resources: stop process, remove worktree, delete branch,
 * remove from DB, and fix ownership. Each step is independently guarded so failures
 * don't prevent subsequent cleanup.
 */
export async function cleanupVariant(
  variantName: string,
  projectRoot: string,
  variantPath: string,
  opts?: { stop?: boolean },
): Promise<void> {
  if (opts?.stop) {
    try {
      await getMindManager().stopMind(variantName);
    } catch (err) {
      log.warn(`failed to stop variant ${variantName}`, log.errorData(err));
    }
  }

  // Get the branch name from the variant entry before removing from DB
  const { findMind } = await import("./registry.js");
  const variantEntry = await findMind(variantName);
  const branchName = variantEntry?.branch ?? variantName;

  if (existsSync(variantPath)) {
    try {
      await gitExec(["worktree", "remove", "--force", variantPath], { cwd: projectRoot });
    } catch {
      rmSync(variantPath, { recursive: true, force: true });
      try {
        await gitExec(["worktree", "prune"], { cwd: projectRoot });
      } catch (err) {
        log.warn(`failed to prune worktrees for ${variantName}`, log.errorData(err));
      }
    }
  }

  try {
    await gitExec(["branch", "-D", branchName], { cwd: projectRoot });
  } catch (err) {
    log.warn(`failed to delete branch ${branchName} for ${variantName}`, log.errorData(err));
  }

  // Get the base name before removing from DB (uses variantEntry.parent which is already fetched)
  const baseName = variantEntry?.parent ?? variantName;

  try {
    await removeMind(variantName);
  } catch (err) {
    log.warn(`failed to remove variant ${variantName} from DB`, log.errorData(err));
  }

  try {
    chownMindDir(projectRoot, baseName);
  } catch (err) {
    log.error(
      `failed to fix ownership during variant cleanup for ${variantName}`,
      log.errorData(err),
    );
  }
}
