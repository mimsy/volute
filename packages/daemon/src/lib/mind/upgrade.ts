import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readSystemsConfig } from "../config/systems-config.js";
import { getMindManager } from "../daemon/mind-manager.js";
import { migrateSkillsToTemplate } from "../skills.js";
import {
  applyTemplateHomeFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
} from "../template/template.js";
import { computeTemplateHash } from "../template/template-hash.js";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { chownMindDir, isIsolationEnabled } from "./isolation.js";
import { npmInstallAsMind, npmInstallNeeded } from "./npm-install.js";
import { findMind, mindDir, setMindTemplate, setMindTemplateHash } from "./registry.js";
import { cleanupVariant } from "./variant-cleanup.js";

export type UpgradeOutcome =
  | { status: "upgraded"; warning?: string }
  | { status: "conflicts"; worktreeDir: string; files: string[]; message?: string };

/** Thrown by runUpgrade when an upgrade worktree exists and is genuinely mid-conflict-resolution (not a stale orphan). */
export class UpgradeInProgressError extends Error {
  worktreeDir: string;
  constructor(worktreeDir: string) {
    super("Upgrade variant already exists. Use continue or delete it first.");
    this.name = "UpgradeInProgressError";
    this.worktreeDir = worktreeDir;
  }
}

/** The orphan branch tracking the latest composed template files. */
export const TEMPLATE_BRANCH = "volute/template";

/** The worktree branch used to stage an in-progress upgrade merge. */
export const UPGRADE_BRANCH = "upgrade";

/** Message returned when the final merge into main conflicts (as opposed to the earlier template merge in the upgrade worktree). */
const FINAL_MERGE_CONFLICTS_MESSAGE =
  "Merge conflicts detected at the final merge step. The mind's directory has been restored to its pre-merge state; the upgrade worktree has been left in place for manual resolution.";

/** Configure per-repo git identity for a mind: name = mind name, email = [mind].[system]@volute.systems. */
export async function configureGitIdentity(
  mindName: string,
  opts: { cwd: string; mindName?: string; env?: NodeJS.ProcessEnv },
) {
  const systemsConfig = readSystemsConfig();
  const system = systemsConfig?.system ?? "local";
  await gitExec(["config", "user.name", mindName], opts);
  await gitExec(["config", "user.email", `${mindName}.${system}@volute.systems`], opts);
}

/**
 * Update the volute/template orphan branch with the latest template files.
 * Uses a temporary worktree to avoid touching the main working directory.
 */
async function updateTemplateBranch(projectRoot: string, template: string, mindName: string) {
  const tempWorktree = resolve(projectRoot, ".variants", "_template_update");

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", TEMPLATE_BRANCH], { cwd: projectRoot });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // Clean up any existing temp worktree
  try {
    await gitExec(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
  } catch {
    // doesn't exist
  }
  if (existsSync(tempWorktree)) {
    rmSync(tempWorktree, { recursive: true, force: true });
  }

  const templatesRoot = findTemplatesRoot();
  const { composedDir, manifest } = composeTemplate(templatesRoot, template);

  try {
    if (branchExists) {
      await gitExec(["worktree", "add", tempWorktree, TEMPLATE_BRANCH], {
        cwd: projectRoot,
      });
    } else {
      await gitExec(["worktree", "add", "--detach", tempWorktree], { cwd: projectRoot });
      await gitExec(["checkout", "--orphan", TEMPLATE_BRANCH], { cwd: tempWorktree });
      await gitExec(["rm", "-rf", "--cached", "."], { cwd: tempWorktree });
      await gitExec(["clean", "-fd"], { cwd: tempWorktree });
    }

    if (branchExists) {
      await gitExec(["rm", "-rf", "."], { cwd: tempWorktree }).catch(() => {});
    }

    copyTemplateToDir(composedDir, tempWorktree, mindName, manifest);

    const initDir = resolve(tempWorktree, ".init");
    if (existsSync(initDir)) {
      rmSync(initDir, { recursive: true, force: true });
    }

    // Remove home files except VOLUTE.md — template branch should only track infrastructure
    const homeDir = resolve(tempWorktree, "home");
    if (existsSync(homeDir)) {
      for (const entry of readdirSync(homeDir)) {
        if (entry !== "VOLUTE.md") {
          rmSync(resolve(homeDir, entry), { recursive: true, force: true });
        }
      }
    }

    await gitExec(["add", "-A"], { cwd: tempWorktree });

    try {
      await gitExec(["diff", "--cached", "--quiet"], { cwd: tempWorktree });
    } catch {
      await gitExec(["commit", "-m", "template update"], { cwd: tempWorktree });
    }
  } finally {
    try {
      await gitExec(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
    } catch {
      // best effort cleanup
    }
    if (existsSync(tempWorktree)) {
      rmSync(tempWorktree, { recursive: true, force: true });
    }
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/**
 * Merge the template branch into the current worktree.
 * Returns true if there are merge conflicts.
 */
async function mergeTemplateBranch(worktreeDir: string): Promise<boolean> {
  try {
    await gitExec(
      ["merge", TEMPLATE_BRANCH, "--allow-unrelated-histories", "-m", "merge template update"],
      { cwd: worktreeDir },
    );
    return false;
  } catch (e: unknown) {
    try {
      const status = await gitExec(["status", "--porcelain"], { cwd: worktreeDir });
      const hasConflictMarkers = status
        .split("\n")
        .some((line) => line.startsWith("UU") || line.startsWith("AA"));
      if (hasConflictMarkers) return true;
    } catch {
      // fall through to rethrow
    }
    throw e;
  }
}

/**
 * Attempt `git merge <branch>` in dir. On conflict, auto-resolve modify/delete
 * conflicts for paths ignored by the merged .gitignore (git rm --cached; file
 * stays on disk) and commit. If other conflicts remain, `git merge --abort` and
 * return { merged: false, files }. Never leaves dir mid-merge.
 */
export async function mergeWithUntrackResolution(
  dir: string,
  branch: string,
): Promise<{ merged: true } | { merged: false; files: string[] }> {
  try {
    await gitExec(["merge", branch], { cwd: dir });
    return { merged: true };
  } catch {
    // Conflict (or other failure) — inspect state below. Everything past this
    // point runs inside a try/catch whose catch always attempts merge --abort
    // before rethrowing, so an unexpected failure here can never leave dir
    // mid-merge.
  }
  try {
    const unmergedRaw = await gitExec(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
    const unmerged = unmergedRaw.split("\n").filter(Boolean);
    if (unmerged.length === 0) {
      // merge failed for a non-conflict reason
      throw new Error(`git merge ${branch} failed without conflicts`);
    }
    // Which unmerged paths does the merged .gitignore (from `branch`) ignore?
    // check-ignore --no-index consults the working tree's .gitignore; during the
    // merge the working tree already has the merged .gitignore when it doesn't
    // itself conflict. If .gitignore IS conflicted, treat nothing as ignorable.
    const resolvable: string[] = [];
    if (!unmerged.includes(".gitignore")) {
      for (const file of unmerged) {
        try {
          await gitExec(["check-ignore", "--no-index", "-q", "--", file], { cwd: dir });
          resolvable.push(file); // exit 0 → ignored → resolvable by untracking
        } catch {
          // exit 1 → not ignored → real conflict
        }
      }
    }
    const remaining = unmerged.filter((f) => !resolvable.includes(f));
    if (remaining.length > 0) {
      await gitExec(["merge", "--abort"], { cwd: dir });
      return { merged: false, files: unmerged };
    }
    for (const file of resolvable) {
      // A UU (both-modified) conflict leaves <<<<<<< marker-polluted content in
      // the working tree file; checkout --ours restores main's clean content
      // before untracking. For modify/delete conflicts this is a no-op change
      // (the working tree already holds ours), so it's safe either way.
      await gitExec(["checkout", "--ours", "--", file], { cwd: dir });
      await gitExec(["rm", "--cached", "--", file], { cwd: dir });
    }
    await gitExec(["commit", "-m", "merge template update (auto-untrack ignored files)"], {
      cwd: dir,
    });
    return { merged: true };
  } catch (err) {
    await gitExec(["merge", "--abort"], { cwd: dir }).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Merge the upgrade branch back into main, clean up, install deps, and restart.
 * Returns { ok: true, warning? } on success, { ok: false, conflicts, files } if
 * the final merge couldn't be auto-resolved (main is left clean either way — see
 * mergeWithUntrackResolution), throws on other merge failures.
 */
async function mergeUpgradeAndRestart(
  mindName: string,
  dir: string,
  worktreeDir: string,
  upgradeVariantName: string,
  upgradeBranch: string,
  template: string,
  oldTemplate: string,
  restart: boolean,
): Promise<{ ok: true; warning?: string } | { ok: false; conflicts: true; files: string[] }> {
  const templateChanged = template !== oldTemplate;
  // Auto-commit any uncommitted changes in main worktree
  const mainStatus = (await gitExec(["status", "--porcelain"], { cwd: dir })).trim();
  if (mainStatus) {
    await gitExec(["add", "-A"], { cwd: dir });
    await gitExec(["commit", "-m", "Auto-commit before upgrade merge"], { cwd: dir });
  }

  const preMergeHead = (await gitExec(["rev-parse", "HEAD"], { cwd: dir })).trim();
  const mergeResult = await mergeWithUntrackResolution(dir, upgradeBranch);
  if (!mergeResult.merged) {
    // main is restored to its pre-merge state; leave the upgrade worktree/branch
    // in place for manual resolution rather than cleaning them up.
    return { ok: false, conflicts: true, files: mergeResult.files };
  }

  // Merge succeeded — everything below is best-effort cleanup/restart
  try {
    await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir, {
      branch: UPGRADE_BRANCH,
    });
  } catch (err) {
    log.warn(`failed to clean up upgrade worktree for ${mindName}`, log.errorData(err));
  }
  try {
    await gitExec(["branch", "-D", upgradeBranch], { cwd: dir });
  } catch {
    // branch may already be deleted by cleanupVariant
  }

  // On an actual template switch, swap the template-owned home/ files (mechanics
  // doc, .claude/settings.json, config.json) which the merge never touches. This
  // must succeed *before* the DB template field is advanced: that field drives
  // credential injection at spawn (mind-manager), so it has to stay consistent
  // with the on-disk config. On failure, leave the field at oldTemplate and
  // surface the failure rather than reporting a clean success.
  let switchWarning: string | undefined;
  if (templateChanged) {
    try {
      applyTemplateHomeFiles(resolve(dir, "home"), template);
      // Move installed skills into the new template's skills dir and regenerate
      // their shims, so they aren't stranded (invisible + shims pointing at the
      // old path) after the switch.
      const migratedSkills = migrateSkillsToTemplate(dir, oldTemplate, template);
      await gitExec(["add", "home/"], { cwd: dir });
      try {
        await gitExec(["diff", "--cached", "--quiet"], { cwd: dir });
      } catch {
        await gitExec(["commit", "-m", `swap template-owned home files for ${template}`], {
          cwd: dir,
        });
      }
      await chownMindDir(dir, mindName);
      const skillNote =
        migratedSkills.length > 0
          ? ` Migrated skills to the ${template} skills dir: ${migratedSkills.join(", ")}.`
          : "";
      switchWarning = `Switched ${oldTemplate}→${template}: config reset to ${template} defaults, mechanics doc replaced, conversation starts fresh (sessions aren't portable across runtimes).${skillNote}`;
    } catch (err) {
      log.warn(`failed to swap template home files for ${mindName}`, log.errorData(err));
      return {
        ok: true,
        warning: `Upgrade merged but template switch ${oldTemplate}→${template} failed: ${err instanceof Error ? err.message : String(err)}. The mind is still registered as ${oldTemplate}; re-run the switch or fix home/ manually.`,
      };
    }
  }

  // Persist the template field only after any switch swap succeeded, so the DB
  // stays consistent with the on-disk template files.
  try {
    await setMindTemplateHash(mindName, computeTemplateHash(template));
    await setMindTemplate(mindName, template);
  } catch (err) {
    log.warn(`failed to update template for ${mindName}`, log.errorData(err));
  }

  // Skip npm install when the merge didn't touch dependencies — even a no-op
  // install writes enough to freeze slow storage for a minute or more.
  if (await npmInstallNeeded(dir, preMergeHead)) {
    try {
      await npmInstallAsMind(dir, mindName);
    } catch (err) {
      log.warn(`npm install failed after upgrade merge for ${mindName}`, log.errorData(err));
      return {
        ok: true,
        warning: `Upgrade merged but npm install failed: ${err instanceof Error ? err.message : String(err)}. You may need to run npm install manually.`,
      };
    }
  } else {
    log.info(`skipping npm install for ${mindName} — dependencies unchanged by upgrade`);
  }

  const manager = getMindManager();
  if (!restart) {
    manager.setPendingContext(mindName, { type: "upgraded" });
    return { ok: true, warning: switchWarning };
  }

  // Restart mind with upgrade context
  try {
    if (manager.isRunning(mindName)) {
      await manager.stopMind(mindName);
    }
    manager.setPendingContext(mindName, { type: "upgraded" });
    // Generous health budget: right after an npm install the disk cache is
    // cold and I/O may still be saturated, so a tsx cold start can exceed the
    // default 30s — timing out here kills the child and leaves the mind down.
    await manager.startMind(mindName, { healthTimeoutMs: 120_000 });
  } catch (e) {
    return {
      ok: true,
      warning: `Upgrade merged but mind restart failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, warning: switchWarning };
}

function upgradeVariantName(mindName: string): string {
  return `${mindName}-upgrade`;
}

function upgradeWorktreeDir(dir: string): string {
  return resolve(dir, ".variants", UPGRADE_BRANCH);
}

/** True if an upgrade worktree exists for this mind. */
export function upgradeInProgress(mindName: string): boolean {
  return existsSync(upgradeWorktreeDir(mindDir(mindName)));
}

/**
 * True if the upgrade worktree is mid-conflict-resolution: reads the worktree's
 * `.git` file to find its gitdir, then checks for MERGE_HEAD there. Any failure
 * reading that (e.g. the worktree is mid-repair) is treated as "not mid-merge"
 * so a stale orphan doesn't get stuck behind a false positive.
 */
function upgradeMidResolution(worktreeDir: string): boolean {
  try {
    const gitDirContent = readFileSync(resolve(worktreeDir, ".git"), "utf-8").trim();
    const gitDir = gitDirContent.replace("gitdir: ", "");
    return existsSync(resolve(gitDir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}

/** Diff preview (HEAD...volute/template). */
export async function upgradeDiff(mindName: string, template?: string): Promise<string> {
  const entry = await findMind(mindName);
  if (!entry) throw new Error("Mind not found");
  const dir = mindDir(mindName);
  const tmpl = template ?? entry.template ?? "claude";

  await updateTemplateBranch(dir, tmpl, mindName);

  try {
    return await gitExec(["diff", "HEAD...volute/template"], { cwd: dir });
  } catch {
    // If three-dot diff fails (no common ancestor), fall back to two-dot
    return await gitExec(["diff", "HEAD", "volute/template"], { cwd: dir });
  }
}

/**
 * Fresh end-to-end upgrade. Throws on unexpected errors (git failures, unknown template
 * is validated by caller). opts.restart controls whether the mind process is started
 * after the merge (default true, preserving current behavior).
 */
export async function runUpgrade(
  mindName: string,
  opts?: { template?: string; restart?: boolean },
): Promise<UpgradeOutcome> {
  const entry = await findMind(mindName);
  if (!entry) throw new Error("Mind not found");
  const dir = mindDir(mindName);
  const oldTemplate = entry.template ?? "claude";
  const template = opts?.template ?? oldTemplate;
  const restart = opts?.restart ?? true;

  const variantName = upgradeVariantName(mindName);
  const worktreeDir = upgradeWorktreeDir(dir);

  // An upgrade worktree from a prior run may still be sitting here — either a
  // daemon restart orphaned it mid-run, or a caller is genuinely mid-conflict-
  // resolution. Only the latter should keep blocking a fresh upgrade.
  if (existsSync(worktreeDir)) {
    if (upgradeMidResolution(worktreeDir)) {
      throw new UpgradeInProgressError(worktreeDir);
    }
    log.warn(`clearing stale orphaned upgrade worktree for ${mindName}`);
    await abortUpgrade(mindName);
  }

  // Initialize git repo if missing (minds created before git config was fixed)
  if (!existsSync(resolve(dir, ".git"))) {
    try {
      const env = isIsolationEnabled() ? { ...process.env, HOME: resolve(dir, "home") } : undefined;
      await gitExec(["init"], { cwd: dir, mindName, env });
      await configureGitIdentity(mindName, { cwd: dir, mindName, env });
      await gitExec(["add", "-A"], { cwd: dir, mindName, env });
      await gitExec(["commit", "-m", "initial commit"], { cwd: dir, mindName, env });
      await chownMindDir(dir, mindName);
    } catch (err) {
      rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      throw new Error(
        `Git initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clean up stale worktree refs and leftover branch
  await gitExec(["worktree", "prune"], { cwd: dir });
  try {
    await gitExec(["branch", "-D", UPGRADE_BRANCH], { cwd: dir });
  } catch {
    // branch doesn't exist
  }

  // Update template branch
  await updateTemplateBranch(dir, template, mindName);

  // Create upgrade worktree
  const parentDir = resolve(dir, ".variants");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  await gitExec(["worktree", "add", "-b", UPGRADE_BRANCH, worktreeDir], { cwd: dir });

  // Prepare home/ allowlist migration: untrack home files so template
  // branch removal doesn't cause conflicts or deletions
  await gitExec(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], {
    cwd: worktreeDir,
  });
  // Re-add VOLUTE.md so template merge can update it
  try {
    await gitExec(["checkout", "HEAD", "--", "home/VOLUTE.md"], { cwd: worktreeDir });
    await gitExec(["add", "home/VOLUTE.md"], { cwd: worktreeDir });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!msg.includes("did not match")) {
      log.warn(
        `unexpected error restoring VOLUTE.md during upgrade for ${mindName}`,
        log.errorData(err),
      );
    }
  }
  // Commit prep step if there are changes
  try {
    await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
  } catch {
    await gitExec(["commit", "-m", "prepare for home/ allowlist migration"], {
      cwd: worktreeDir,
    });
  }

  // Merge template branch
  const hasConflicts = await mergeTemplateBranch(worktreeDir);

  if (!hasConflicts) {
    // Re-add home files that match the new .gitignore allowlist patterns
    try {
      await gitExec(["add", "home/"], { cwd: worktreeDir });
    } catch (err) {
      log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
    }
    try {
      await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
    } catch {
      await gitExec(["commit", "-m", "re-add allowlisted home files"], {
        cwd: worktreeDir,
      });
    }
  }

  // Fix ownership — daemon runs as root but mind needs to own its files
  await chownMindDir(dir, mindName);

  if (hasConflicts) {
    const filesRaw = await gitExec(["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreeDir,
    });
    const files = filesRaw
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return { status: "conflicts", worktreeDir, files };
  }

  // Merge upgrade branch back to main, cleanup, and restart
  try {
    const result = await mergeUpgradeAndRestart(
      mindName,
      dir,
      worktreeDir,
      variantName,
      UPGRADE_BRANCH,
      template,
      oldTemplate,
      restart,
    );
    if (!result.ok) {
      return {
        status: "conflicts",
        worktreeDir,
        files: result.files,
        message: FINAL_MERGE_CONFLICTS_MESSAGE,
      };
    }
    return { status: "upgraded", warning: result.warning };
  } catch (err) {
    // Merge failed — clean up
    try {
      await cleanupVariant(variantName, mindName, dir, worktreeDir, { branch: UPGRADE_BRANCH });
    } catch (cleanupErr) {
      log.warn(`cleanup failed after upgrade error for ${mindName}`, log.errorData(cleanupErr));
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Continue after manual conflict resolution in the worktree. */
export async function continueUpgrade(
  mindName: string,
  opts?: { template?: string; restart?: boolean },
): Promise<UpgradeOutcome> {
  const entry = await findMind(mindName);
  if (!entry) throw new Error("Mind not found");
  const dir = mindDir(mindName);
  const oldTemplate = entry.template ?? "claude";
  const template = opts?.template ?? oldTemplate;
  const restart = opts?.restart ?? true;

  const variantName = upgradeVariantName(mindName);
  const worktreeDir = upgradeWorktreeDir(dir);

  if (!existsSync(worktreeDir)) {
    throw new Error("No upgrade in progress");
  }

  const status = await gitExec(["status", "--porcelain"], { cwd: worktreeDir });
  const hasConflicts = status
    .split("\n")
    .some((line) => line.startsWith("UU") || line.startsWith("AA"));
  if (hasConflicts) {
    throw new Error("Unresolved conflicts remain");
  }

  try {
    await gitExec(["add", "-A"], { cwd: worktreeDir });
    await gitExec(["commit", "-m", "merge template update"], { cwd: worktreeDir });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stderr = (e as any)?.stderr ?? "";
    const stdout = (e as any)?.stdout ?? "";
    if (
      !msg.includes("nothing to commit") &&
      !stderr.includes("nothing to commit") &&
      !stdout.includes("nothing to commit")
    )
      throw e;
  }

  // Re-add home files that match the new .gitignore allowlist patterns
  try {
    await gitExec(["add", "home/"], { cwd: worktreeDir });
  } catch (err) {
    log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
  }
  try {
    await gitExec(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
  } catch {
    await gitExec(["commit", "-m", "re-add allowlisted home files"], {
      cwd: worktreeDir,
    });
  }

  // Fix ownership after root git operations
  await chownMindDir(dir, mindName);

  // Merge upgrade branch back to main, cleanup, and restart
  const result = await mergeUpgradeAndRestart(
    mindName,
    dir,
    worktreeDir,
    variantName,
    UPGRADE_BRANCH,
    template,
    oldTemplate,
    restart,
  );
  if (!result.ok) {
    return {
      status: "conflicts",
      worktreeDir,
      files: result.files,
      message: FINAL_MERGE_CONFLICTS_MESSAGE,
    };
  }
  return { status: "upgraded", warning: result.warning };
}

/** Abort an in-progress upgrade: abort worktree merge if mid-merge, cleanupVariant, delete branch. */
export async function abortUpgrade(mindName: string): Promise<void> {
  const dir = mindDir(mindName);
  const variantName = upgradeVariantName(mindName);
  const worktreeDir = upgradeWorktreeDir(dir);

  if (!existsSync(worktreeDir)) {
    throw new Error("No upgrade in progress");
  }

  // Abort merge if mid-merge
  if (upgradeMidResolution(worktreeDir)) {
    await gitExec(["merge", "--abort"], { cwd: worktreeDir }).catch(() => {});
  }

  await cleanupVariant(variantName, mindName, dir, worktreeDir, {
    stop: true,
    branch: UPGRADE_BRANCH,
  });
}
