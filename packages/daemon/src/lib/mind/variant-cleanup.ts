import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getMindManager } from "../daemon/mind-manager.js";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { chownMindDir } from "./isolation.js";
import { deleteMindDbFootprint, mindDir, readAllMinds, removeMind } from "./registry.js";

/**
 * Clean up a variant's git resources: stop process, remove worktree, delete branch,
 * remove from DB, and fix ownership. Each step is independently guarded so failures
 * don't prevent subsequent cleanup.
 *
 * `baseName` is the parent mind that owns projectRoot — passed explicitly because
 * upgrade variants have no DB row to derive it from, and a wrong fallback chowns
 * the mind dir to a nonexistent user, leaving merge-written files root-owned.
 *
 * `opts.branch` overrides the DB/name-fallback branch to delete — upgrade-flow
 * callers pass the real branch (`UPGRADE_BRANCH`) since the upgrade "variant"
 * has no DB row and the name-fallback branch never exists.
 */
export async function cleanupVariant(
  variantName: string,
  baseName: string,
  projectRoot: string,
  variantPath: string,
  opts?: { stop?: boolean; branch?: string },
): Promise<void> {
  if (opts?.stop) {
    try {
      await getMindManager().stopMind(variantName);
    } catch (err) {
      log.warn(`failed to stop variant ${variantName}`, log.errorData(err));
    }
  }

  // Get the branch name from the variant entry before removing from DB — skip
  // the lookup entirely when the caller already knows the real branch (the
  // upgrade flow's "variant" has no DB row to look up in the first place).
  let branchName = opts?.branch;
  if (!branchName) {
    const { findMind } = await import("./registry.js");
    const variantEntry = await findMind(variantName);
    branchName = variantEntry?.branch ?? variantName;
  }

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
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    if (stderr.includes("not found")) {
      // Already deleted (e.g. by a sibling explicit `git branch -D` in the
      // upgrade flow) — not a real failure, don't warn about it.
      log.info(`branch ${branchName} already deleted for ${variantName}`);
    } else {
      log.warn(`failed to delete branch ${branchName} for ${variantName}`, log.errorData(err));
    }
  }

  try {
    await removeMind(variantName);
  } catch (err) {
    log.warn(`failed to remove variant ${variantName} from DB`, log.errorData(err));
  }

  // Purge the variant's remaining DB footprint (user, owned conversations, and
  // free-text-keyed rows) so nothing is left attributed to a gone variant (#444).
  try {
    await deleteMindDbFootprint(variantName);
  } catch (err) {
    log.warn(`failed to purge DB footprint for variant ${variantName}`, log.errorData(err));
  }

  try {
    await chownMindDir(projectRoot, baseName);
  } catch (err) {
    log.error(
      `failed to fix ownership during variant cleanup for ${variantName}`,
      log.errorData(err),
    );
  }
}

/**
 * Reconcile variant rows against what's actually on disk (#444). Runs on daemon
 * startup, before minds are started, to clean up state stranded by older flows:
 *
 * - A variant row whose worktree directory is gone (e.g. the legacy `whorl@upgrade`
 *   row observed in production, whose `.variants/upgrade` dir and branch no longer
 *   existed) is fully cleaned up — worktree/branch best-effort, row dropped, DB
 *   footprint purged. Such names can predate today's validation, so this path uses
 *   parameterized deletes rather than the branch-name-validating routes.
 * - A `.variants/<name>` directory on disk with no registry row is reported (not
 *   deleted — it may hold un-merged work), so a host can investigate.
 */
export async function reconcileVariants(): Promise<void> {
  const all = await readAllMinds();
  const variants = all.filter((e) => e.parent);
  const bases = all.filter((e) => !e.parent);
  const baseDir = (name: string) => bases.find((b) => b.name === name)?.dir ?? mindDir(name);

  for (const v of variants) {
    if (v.dir && existsSync(v.dir)) continue;
    log.warn(
      `reconcile: dropping stale variant row ${v.name} (worktree ${v.dir ?? "<none>"} missing)`,
    );
    try {
      await cleanupVariant(v.name, v.parent!, baseDir(v.parent!), v.dir ?? "");
    } catch (err) {
      log.warn(`reconcile: failed to drop stale variant ${v.name}`, log.errorData(err));
    }
  }

  const knownDirs = new Set(variants.map((v) => v.dir).filter((d): d is string => Boolean(d)));
  for (const base of bases) {
    const variantsDir = resolve(base.dir ?? mindDir(base.name), ".variants");
    if (!existsSync(variantsDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(variantsDir);
    } catch (err) {
      log.warn(`reconcile: failed to read ${variantsDir}`, log.errorData(err));
      continue;
    }
    for (const name of entries) {
      const full = resolve(variantsDir, name);
      if (knownDirs.has(full)) continue;
      try {
        if (statSync(full).isDirectory()) {
          log.warn(`reconcile: orphaned variant worktree on disk with no registry row: ${full}`);
        }
      } catch {
        // Entry vanished between readdir and stat — nothing to report.
      }
    }
  }
}
