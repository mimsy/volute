import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent } from "../chat/system-events.js";
import { readSystemsConfig } from "../config/systems-config.js";
import { buildMindBaseEnv, getMindManager } from "../daemon/mind-manager.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { migrateSkillsToTemplate } from "../skills.js";
import {
  applyTemplateHomeFiles,
  backfillInitInfrastructure,
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
import { restoreMergeDeletedHomeFiles } from "./variants.js";

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

/** Per-mind chain of in-flight upgrade operations, used by {@link withUpgradeLock}. */
const upgradeLocks = new Map<string, Promise<unknown>>();

/**
 * Serializes upgrade operations (runUpgrade/continueUpgrade/abortUpgrade) for a
 * single mind so a manual call and the auto-upgrade pass can never race on the
 * same worktree — e.g. one treating the other's in-progress merge as a stale
 * orphan and aborting it out from under it. Different mind names run unaffected.
 * A rejected op is swallowed before chaining the next one, so a single failure
 * never wedges the queue for that mind.
 */
export async function withUpgradeLock<T>(mindName: string, fn: () => Promise<T>): Promise<T> {
  const prior = upgradeLocks.get(mindName) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(fn);
  upgradeLocks.set(
    mindName,
    run.catch(() => {}),
  );
  return run;
}

/**
 * The environment every git command in this module runs with: the same allowlist a
 * mind's own server process gets, never the daemon's raw `process.env`.
 *
 * Any git command in a mind's repo can execute code the mind wrote — `git commit`
 * runs pre-commit/commit-msg/post-commit, `merge` and `checkout` and `worktree add`
 * run theirs, and a mind may point `core.hooksPath` wherever it likes. The daemon's
 * environment carries `VOLUTE_DAEMON_TOKEN`, the admin token, set on `process.env`
 * at startup; a hook that reads it holds full admin API access. That is true whether
 * or not user isolation is on — under `sandbox`/`none` the hook runs as the daemon's
 * own user, outside the mind's sandbox, which is the *worse* case, not the safer one.
 * So the scrub is unconditional and the isolation check below is only about uid.
 */
function hookSafeEnv(): NodeJS.ProcessEnv {
  return { ...buildMindBaseEnv() };
}

/**
 * `gitExec` for this module. Identical, except a caller that passes no `env` gets
 * {@link hookSafeEnv} rather than inheriting the daemon's environment wholesale.
 * Every git invocation here goes through this — a call site that reaches `gitExec`
 * directly is a hole, so there should be exactly one `git(` left in this file.
 */
function git(
  args: string[],
  opts: { cwd: string; mindName?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): Promise<string> {
  return gitExec(args, { ...opts, env: opts.env ?? hookSafeEnv() });
}

/**
 * git options for an operation that must run as the mind, not as the daemon.
 *
 * Under user isolation the command goes through `gitExec`'s isolation wrapper
 * (runuser/sudo to the mind's uid), so a hook the mind wrote executes with the
 * mind's privilege rather than the daemon's (#871), and HOME points at the mind's
 * own home/. Note the switching tool has the last word on HOME — `sudo`'s env_reset
 * and `runuser` both may set it from the target account — so treat that as a best
 * effort; the load-bearing property here is {@link hookSafeEnv}, which holds either
 * way because env_reset only ever removes variables.
 *
 * Without isolation there is one uid, so there is no uid to switch to and no reason
 * to redirect HOME (doing so would strip `~/.gitconfig` from git's config
 * resolution and break commits in repos with no per-repo identity) — but the
 * environment is still scrubbed, because the hook still runs and the token is still
 * in the daemon's environment.
 */
export function mindGitOpts(
  dir: string,
  mindName: string,
): { cwd: string; mindName?: string; env: NodeJS.ProcessEnv } {
  const env = hookSafeEnv();
  if (!isIsolationEnabled()) return { cwd: dir, env };
  return { cwd: dir, mindName, env: { ...env, HOME: resolve(dir, "home") } };
}

/** Configure per-repo git identity for a mind: name = mind name, email = [mind].[system]@volute.systems. */
export async function configureGitIdentity(
  mindName: string,
  opts: { cwd: string; mindName?: string; env?: NodeJS.ProcessEnv },
) {
  const systemsConfig = readSystemsConfig();
  const system = systemsConfig?.system ?? "local";
  await git(["config", "user.name", mindName], opts);
  await git(["config", "user.email", `${mindName}.${system}@volute.systems`], opts);
}

/**
 * Update the volute/template orphan branch with the latest template files.
 * Uses a temporary worktree to avoid touching the main working directory.
 */
async function updateTemplateBranch(projectRoot: string, template: string, mindName: string) {
  const tempWorktree = resolve(projectRoot, ".variants", "_template_update");

  let branchExists = false;
  try {
    await git(["rev-parse", "--verify", TEMPLATE_BRANCH], { cwd: projectRoot });
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // Clean up any existing temp worktree
  try {
    await git(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
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
      await git(["worktree", "add", tempWorktree, TEMPLATE_BRANCH], {
        cwd: projectRoot,
      });
    } else {
      await git(["worktree", "add", "--detach", tempWorktree], { cwd: projectRoot });
      await git(["checkout", "--orphan", TEMPLATE_BRANCH], { cwd: tempWorktree });
      await git(["rm", "-rf", "--cached", "."], { cwd: tempWorktree });
      await git(["clean", "-fd"], { cwd: tempWorktree });
    }

    if (branchExists) {
      await git(["rm", "-rf", "."], { cwd: tempWorktree }).catch(() => {});
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

    await git(["add", "-A"], { cwd: tempWorktree });

    try {
      await git(["diff", "--cached", "--quiet"], { cwd: tempWorktree });
    } catch {
      await git(["commit", "-m", "template update"], { cwd: tempWorktree });
    }
  } finally {
    try {
      await git(["worktree", "remove", "--force", tempWorktree], { cwd: projectRoot });
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
    await git(
      ["merge", TEMPLATE_BRANCH, "--allow-unrelated-histories", "-m", "merge template update"],
      { cwd: worktreeDir },
    );
    return false;
  } catch (e: unknown) {
    try {
      const status = await git(["status", "--porcelain"], { cwd: worktreeDir });
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
    await git(["merge", branch], { cwd: dir });
    return { merged: true };
  } catch {
    // Conflict (or other failure) — inspect state below. Everything past this
    // point runs inside a try/catch whose catch always attempts merge --abort
    // before rethrowing, so an unexpected failure here can never leave dir
    // mid-merge.
  }
  try {
    const unmergedRaw = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
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
          await git(["check-ignore", "--no-index", "-q", "--", file], { cwd: dir });
          resolvable.push(file); // exit 0 → ignored → resolvable by untracking
        } catch {
          // exit 1 → not ignored → real conflict
        }
      }
    }
    const remaining = unmerged.filter((f) => !resolvable.includes(f));
    if (remaining.length > 0) {
      await git(["merge", "--abort"], { cwd: dir });
      return { merged: false, files: unmerged };
    }
    for (const file of resolvable) {
      // A UU (both-modified) conflict leaves <<<<<<< marker-polluted content in
      // the working tree file; checkout --ours restores main's clean content
      // before untracking. For modify/delete conflicts this is a no-op change
      // (the working tree already holds ours), so it's safe either way.
      await git(["checkout", "--ours", "--", file], { cwd: dir });
      await git(["rm", "--cached", "--", file], { cwd: dir });
    }
    await git(["commit", "-m", "merge template update (auto-untrack ignored files)"], {
      cwd: dir,
    });
    return { merged: true };
  } catch (err) {
    await git(["merge", "--abort"], { cwd: dir }).catch(() => {});
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
  const mainStatus = (await git(["status", "--porcelain"], { cwd: dir })).trim();
  if (mainStatus) {
    // As the mind, not as the daemon: this commit runs the mind's own pre-commit
    // hooks, and a hook that refuses (mimsy's MEMORY.md size wall, bardo Aug 2026)
    // must refuse a mind-privileged commit, not a root-privileged one.
    const asMind = mindGitOpts(dir, mindName);
    await git(["add", "-A"], asMind);
    await git(["commit", "-m", "Auto-commit before upgrade merge"], asMind);
  }

  const preMergeHead = (await git(["rev-parse", "HEAD"], { cwd: dir })).trim();
  const mergeResult = await mergeWithUntrackResolution(dir, upgradeBranch);
  if (!mergeResult.merged) {
    // main is restored to its pre-merge state; leave the upgrade worktree/branch
    // in place for manual resolution rather than cleaning them up.
    return { ok: false, conflicts: true, files: mergeResult.files };
  }

  // The allowlist-migration prep commit records pre-allowlist home/ files as
  // deleted, so the merge just removed them from the live working tree. Put
  // the content back, untracked — first, before any later step can fail.
  //
  // mergeWithUntrackResolution's own auto-untrack step (checkout --ours + git
  // rm --cached, for ignored paths that conflicted) also makes those paths
  // show up as deleted in preMergeHead..HEAD -- home/, so they land in this
  // restore pass too. That's harmless: checkout --ours already reset the
  // working-tree content to preMergeHead's version before untracking, so
  // restoring "from preMergeHead" here just rewrites the same bytes already
  // on disk.
  let restoreWarning: string | undefined;
  let restored: string[] = [];
  try {
    restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);
    if (restored.length > 0) {
      log.info(
        `restored ${restored.length} home files untracked by the allowlist migration for ${mindName}`,
      );
    }
  } catch (err) {
    log.error(`failed to restore merge-deleted home files for ${mindName}`, log.errorData(err));
    restoreWarning =
      `Upgrade merged but restoring home files the allowlist migration deleted failed: ` +
      `${err instanceof Error ? err.message : String(err)}. Recover them manually: list them ` +
      `with \`git diff --name-only --diff-filter=D --no-renames ${preMergeHead} HEAD -- home/\`, ` +
      `then restore each with \`git restore --source=${preMergeHead} --worktree -- <path>\`.`;
  }
  if (restored.length > 0) {
    try {
      await chownMindDir(dir, mindName);
    } catch (err) {
      // cleanupVariant's own chown usually repairs this right after; log rather
      // than misreport it as a restore failure.
      log.warn(`failed to chown restored home files for ${mindName}`, log.errorData(err));
    }
  }
  /** Prefix any later warning with the restore failure — it's mind data, it goes first. */
  const withRestoreWarning = (warning?: string): string | undefined =>
    [restoreWarning, warning].filter(Boolean).join(" ") || undefined;

  // Merge succeeded — everything below is best-effort cleanup/restart
  try {
    await cleanupVariant(upgradeVariantName, mindName, dir, worktreeDir, {
      branch: UPGRADE_BRANCH,
    });
  } catch (err) {
    log.warn(`failed to clean up upgrade worktree for ${mindName}`, log.errorData(err));
  }
  try {
    await git(["branch", "-D", upgradeBranch], { cwd: dir });
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
      await git(["add", "home/"], { cwd: dir });
      try {
        await git(["diff", "--cached", "--quiet"], { cwd: dir });
      } catch {
        await git(["commit", "-m", `swap template-owned home files for ${template}`], {
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
        warning: withRestoreWarning(
          `Upgrade merged but template switch ${oldTemplate}→${template} failed: ${err instanceof Error ? err.message : String(err)}. The mind is still registered as ${oldTemplate}; re-run the switch or fix home/ manually.`,
        ),
      };
    }
  }

  // Add `.init/` infrastructure (hooks, shims) this mind never had, and refresh
  // any it still has verbatim from an older release. The template merge can't do
  // either: `.init/` is stripped from the template branch so the merge never
  // overwrites identity files, which also meant a mind created before a hook
  // existed could never acquire it (#808), and a mind carrying last release's
  // copy of a hook could never be handed this release's. Files the mind has
  // edited are never touched. Runs after any template switch so it picks up the
  // *new* template's composition. Untracked paths, so no commit is needed;
  // backfillInitInfrastructure throws rather than exiting, so a broken template
  // install is a warning here, not a failed upgrade.
  try {
    const { added, refreshed } = backfillInitInfrastructure(
      resolve(dir, "home"),
      template,
      mindName,
    );
    if (added.length > 0 || refreshed.length > 0) {
      log.info(
        `backfilled ${added.length} missing and refreshed ${refreshed.length} stale ` +
          `infrastructure files for ${mindName}`,
        { added, refreshed },
      );
      await chownMindDir(dir, mindName);
    }
  } catch (err) {
    log.warn(`failed to backfill infrastructure files for ${mindName}`, log.errorData(err));
  }

  // Persist the template field only after any switch swap succeeded, so the DB
  // stays consistent with the on-disk template files.
  try {
    await setMindTemplateHash(mindName, computeTemplateHash(template));
    await setMindTemplate(mindName, template);
  } catch (err) {
    log.warn(`failed to update template for ${mindName}`, log.errorData(err));
  }

  const depsWarning = await installDepsAndRestart(mindName, dir, preMergeHead, restart);
  return {
    ok: true,
    warning: withRestoreWarning(
      [depsWarning, switchWarning].filter(Boolean).join(" ") || undefined,
    ),
  };
}

/** The MindManager surface {@link installDepsAndRestart} uses — narrowed so tests can stub it. */
type RestartTarget = {
  isRunning(name: string): boolean;
  stopMind(name: string): Promise<void>;
  startMind(name: string, opts?: { healthTimeoutMs?: number }): Promise<void>;
  setPendingContext(name: string, context: Record<string, unknown>): void;
};

/** Collaborators of {@link installDepsAndRestart}, defaulting to the real daemon singletons. */
export type InstallAndRestartDeps = {
  installNeeded: (dir: string, preMergeRef: string) => Promise<boolean>;
  install: (dir: string, mindName: string) => Promise<void>;
  alert: (mindName: string, text: string) => Promise<void>;
  getManager: () => RestartTarget;
};

const defaultInstallAndRestartDeps: InstallAndRestartDeps = {
  installNeeded: npmInstallNeeded,
  install: npmInstallAsMind,
  alert: alertUpgradeDepsFailure,
  getManager: getMindManager,
};

/**
 * Install the merged dependencies and restart the mind onto the new source.
 * Returns a warning when either step went wrong; never throws.
 *
 * A failed install does **not** cancel the restart. The new `src/` is already on
 * disk and the template hash in the DB is already advanced, so the mind is no
 * longer stale: nothing — not the hourly auto-upgrade pass, not the staleness
 * badge — will ever come back and finish the job. Leaving the old process running
 * against new source on disk is therefore not "safe", it is permanent, and it is
 * what shipped mimsy fifteen days of 404s against an API path its running code
 * still called (#973). Most upgrades don't need the new deps at all, so the
 * restart usually just works; when it doesn't, the mind fails loudly and crash
 * recovery and the alert below both fire, which is the outcome a host can act on.
 */
export async function installDepsAndRestart(
  mindName: string,
  dir: string,
  preMergeHead: string,
  restart: boolean,
  deps: InstallAndRestartDeps = defaultInstallAndRestartDeps,
): Promise<string | undefined> {
  let depsWarning: string | undefined;

  // Skip npm install when the merge didn't touch dependencies — even a no-op
  // install writes enough to freeze slow storage for a minute or more.
  if (await deps.installNeeded(dir, preMergeHead)) {
    try {
      await deps.install(dir, mindName);
    } catch (err) {
      log.warn(`npm install failed after upgrade merge for ${mindName}`, log.errorData(err));
      const detail = installFailureDetail(err);
      depsWarning =
        `Upgrade merged but npm install failed (including a retry against the registry): ${detail} ` +
        `The mind ${restart ? "was still restarted onto" : "will start on"} the new code, which may ` +
        `not run until \`npm install\` succeeds in ${dir}. Nothing retries this automatically.`;
      // Tell the mind and the dashboard before the restart: the restart may fail,
      // and this is the explanation for why if it does.
      await deps.alert(mindName, upgradeDepsFailureText(mindName, dir, detail, restart));
    }
  } else {
    log.info(`skipping npm install for ${mindName} — dependencies unchanged by upgrade`);
  }

  const manager = deps.getManager();
  if (!restart) {
    manager.setPendingContext(mindName, { type: "upgraded" });
    return depsWarning;
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
    const restartWarning = `Upgrade merged but mind restart failed: ${e instanceof Error ? e.message : String(e)}`;
    return [depsWarning, restartWarning].filter(Boolean).join(" ");
  }

  return depsWarning;
}

/** The failing install's stderr where there is any, else the error message. */
function installFailureDetail(err: unknown): string {
  const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
  return stderr || (err instanceof Error ? err.message : String(err));
}

/** What the mind is told when its upgrade landed but its dependencies didn't. */
function upgradeDepsFailureText(
  mindName: string,
  dir: string,
  detail: string,
  restarted: boolean,
): string {
  return (
    `Your framework upgrade merged, but installing its dependencies failed — twice, the second ` +
    `time against the registry rather than your local npm cache.\n\n${detail}\n\n` +
    `Your new code is on disk and you ${restarted ? "have been restarted onto it" : "will start on it"}, ` +
    `so anything the upgrade added that needs a new package will not work until this is fixed. ` +
    `Nothing retries it for you: as far as Volute is concerned you are already upgraded. ` +
    `Run \`npm install\` in ${dir} (or ask your host to), then \`volute mind restart ${mindName}\`.`
  );
}

/**
 * Fan a dependency-install failure out to the two audiences that can act on it: the
 * mind, as an immediate system event carrying the npm output verbatim, and the host,
 * as a `mind_error` row on the dashboard. A log line reaches neither (#808, #935).
 *
 * Never throws — an alert that fails must not break the upgrade it is reporting on.
 */
async function alertUpgradeDepsFailure(mindName: string, text: string): Promise<void> {
  try {
    await deliverEvent(mindName, {
      type: "notice",
      body: text,
      meta: { subtype: "upgrade_deps_failed" },
      delivery: "immediate",
      whileSleeping: "queue",
    });
  } catch (err) {
    log.error(
      `failed to alert ${mindName} about its failed dependency install`,
      log.errorData(err),
    );
  }
  try {
    await publishActivity({
      type: "mind_error",
      mind: mindName,
      summary: `Upgrade merged but npm install failed for ${mindName} — dependencies are stale`,
      metadata: { kind: "upgrade_deps_failed" },
    });
  } catch (err) {
    log.error(
      `failed to publish the dependency-install failure for ${mindName}`,
      log.errorData(err),
    );
  }
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
    return await git(["diff", "HEAD...volute/template"], { cwd: dir });
  } catch {
    // If three-dot diff fails (no common ancestor), fall back to two-dot
    return await git(["diff", "HEAD", "volute/template"], { cwd: dir });
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
  return withUpgradeLock(mindName, () => runUpgradeCore(mindName, opts));
}

async function runUpgradeCore(
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
  // resolution. Only the latter should keep blocking a fresh upgrade. Calls the
  // unlocked core directly — runUpgradeCore already holds this mind's lock, and
  // going through the public abortUpgrade would deadlock waiting on itself.
  if (existsSync(worktreeDir)) {
    if (upgradeMidResolution(worktreeDir)) {
      throw new UpgradeInProgressError(worktreeDir);
    }
    log.warn(`clearing stale orphaned upgrade worktree for ${mindName}`);
    await abortUpgradeCore(mindName);
  }

  // Initialize git repo if missing (minds created before git config was fixed)
  if (!existsSync(resolve(dir, ".git"))) {
    try {
      const asMind = mindGitOpts(dir, mindName);
      await git(["init"], asMind);
      await configureGitIdentity(mindName, asMind);
      await git(["add", "-A"], asMind);
      await git(["commit", "-m", "initial commit"], asMind);
      await chownMindDir(dir, mindName);
    } catch (err) {
      rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      throw new Error(
        `Git initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Clean up stale worktree refs and leftover branch
  await git(["worktree", "prune"], { cwd: dir });
  try {
    await git(["branch", "-D", UPGRADE_BRANCH], { cwd: dir });
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

  await git(["worktree", "add", "-b", UPGRADE_BRANCH, worktreeDir], { cwd: dir });

  // The worktree and its admin dir (.git/worktrees/<branch>) are created by the
  // root-owned daemon, so every exit path from here on has to remove them. A throw
  // that skipped this used to leave both behind, root-owned, on a mind-owned repo —
  // after which the mind's own `git gc --auto` fails silently forever (#497, #653),
  // and the next hourly auto-upgrade pass just re-created them. The `conflicts`
  // returns below are deliberate exceptions: they *keep* the worktree for a host to
  // resolve by hand, and they return rather than throw.
  try {
    // Prepare home/ allowlist migration: untrack home files so template
    // branch removal doesn't cause conflicts or deletions
    await git(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], {
      cwd: worktreeDir,
    });
    // Re-add VOLUTE.md so template merge can update it
    try {
      await git(["checkout", "HEAD", "--", "home/VOLUTE.md"], { cwd: worktreeDir });
      await git(["add", "home/VOLUTE.md"], { cwd: worktreeDir });
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
      await git(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
    } catch {
      await git(["commit", "-m", "prepare for home/ allowlist migration"], {
        cwd: worktreeDir,
      });
    }

    // Merge template branch
    const hasConflicts = await mergeTemplateBranch(worktreeDir);

    if (!hasConflicts) {
      // Re-add home files that match the new .gitignore allowlist patterns
      try {
        await git(["add", "home/"], { cwd: worktreeDir });
      } catch (err) {
        log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
      }
      try {
        await git(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
      } catch {
        await git(["commit", "-m", "re-add allowlisted home files"], {
          cwd: worktreeDir,
        });
      }
    }

    // Fix ownership — daemon runs as root but mind needs to own its files
    await chownMindDir(dir, mindName);

    if (hasConflicts) {
      const filesRaw = await git(["diff", "--name-only", "--diff-filter=U"], {
        cwd: worktreeDir,
      });
      const files = filesRaw
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      return { status: "conflicts", worktreeDir, files };
    }

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
  } catch (err) {
    try {
      await cleanupVariant(variantName, mindName, dir, worktreeDir, { branch: UPGRADE_BRANCH });
    } catch (cleanupErr) {
      log.warn(`cleanup failed after upgrade error for ${mindName}`, log.errorData(cleanupErr));
    }
    // Belt and braces over cleanupVariant's own trailing chownMindDir, which it
    // swallows the failure of. Handing ownership back is the thing that must not be
    // skipped here, so it is worth paying for twice: auto-upgrade now attempts a
    // failing mind at most once per daemon run, so this walk cannot repeat hourly
    // the way the old retry loop did.
    try {
      await chownMindDir(dir, mindName);
    } catch (chownErr) {
      log.error(
        `failed to restore ownership after upgrade error for ${mindName}`,
        log.errorData(chownErr),
      );
    }
    // Rethrow the original error object: its `stderr` (e.g. a refusing pre-commit
    // hook's message) is what the caller turns into the mind's alert.
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Continue after manual conflict resolution in the worktree. */
export async function continueUpgrade(
  mindName: string,
  opts?: { template?: string; restart?: boolean },
): Promise<UpgradeOutcome> {
  return withUpgradeLock(mindName, () => continueUpgradeCore(mindName, opts));
}

async function continueUpgradeCore(
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

  const status = await git(["status", "--porcelain"], { cwd: worktreeDir });
  const hasConflicts = status
    .split("\n")
    .some((line) => line.startsWith("UU") || line.startsWith("AA"));
  if (hasConflicts) {
    throw new Error("Unresolved conflicts remain");
  }

  try {
    await git(["add", "-A"], { cwd: worktreeDir });
    await git(["commit", "-m", "merge template update"], { cwd: worktreeDir });
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
    await git(["add", "home/"], { cwd: worktreeDir });
  } catch (err) {
    log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
  }
  try {
    await git(["diff", "--cached", "--quiet"], { cwd: worktreeDir });
  } catch {
    await git(["commit", "-m", "re-add allowlisted home files"], {
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
  return withUpgradeLock(mindName, () => abortUpgradeCore(mindName));
}

async function abortUpgradeCore(mindName: string): Promise<void> {
  const dir = mindDir(mindName);
  const variantName = upgradeVariantName(mindName);
  const worktreeDir = upgradeWorktreeDir(dir);

  if (!existsSync(worktreeDir)) {
    throw new Error("No upgrade in progress");
  }

  // Abort merge if mid-merge
  if (upgradeMidResolution(worktreeDir)) {
    await git(["merge", "--abort"], { cwd: worktreeDir }).catch(() => {});
  }

  await cleanupVariant(variantName, mindName, dir, worktreeDir, {
    stop: true,
    branch: UPGRADE_BRANCH,
  });
}
