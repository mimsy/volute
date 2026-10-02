import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { readSystemsConfig } from "../config/systems-config.js";
import { getMindManager, tryGetMindManager } from "../daemon/mind-manager.js";
import { publish as publishActivity } from "../events/activity-events.js";
import { migrateSkillsToTemplate } from "../skills.js";
import {
  applyTemplateHomeFiles,
  backfillInitInfrastructure,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  listFiles,
  type TemplateManifest,
} from "../template/template.js";
import { computeInfrastructureHash, computeTemplateHash } from "../template/template-hash.js";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { repairThreadBatchConfig } from "./event-routes.js";
import { writeAppliedInfrastructureHash } from "./infrastructure-sync.js";
import { chownMindDir, mindFileOwner, mindGitOpts } from "./isolation.js";

export { mindGitOpts };

import { beginUpgrade } from "./join-lock.js";
import { repairMechanicsDoc } from "./mechanics-doc.js";
import { writeMindFile } from "./mind-file-write.js";
import { npmInstallAsMind, npmInstallNeeded } from "./npm-install.js";
import { findMind, mindDir, setMindTemplate, setMindTemplateHash } from "./registry.js";
import { sharesTemplateBase, TEMPLATE_BRANCH } from "./template-branch.js";
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
 *
 * A variant join into the same mind is not queued behind, but refused against, in
 * both directions (#988): this throws `UpgradeBlockedByJoinError` while a join
 * is in flight, and a join is refused while any op here is queued or running.
 */
export async function withUpgradeLock<T>(mindName: string, fn: () => Promise<T>): Promise<T> {
  const endUpgrade = beginUpgrade(mindName);
  const prior = upgradeLocks.get(mindName) ?? Promise.resolve();
  const run = prior
    .catch(() => {})
    .then(fn)
    .finally(endUpgrade);
  upgradeLocks.set(
    mindName,
    run.catch(() => {}),
  );
  return run;
}

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
async function updateTemplateBranch(
  projectRoot: string,
  template: string,
  composeName: string,
  mindName: string,
) {
  const tempWorktree = resolve(projectRoot, ".variants", "_template_update");
  // As the mind: a worktree checkout and the commit run the mind's own hooks (#961).
  const asMind = mindGitOpts(projectRoot, mindName);
  const inWorktree = mindGitOpts(tempWorktree, mindName);

  let branchExists = false;
  try {
    await gitExec(["rev-parse", "--verify", TEMPLATE_BRANCH], asMind);
    branchExists = true;
  } catch {
    // branch doesn't exist
  }

  // Clean up any existing temp worktree
  try {
    await gitExec(["worktree", "remove", "--force", tempWorktree], asMind);
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
      await gitExec(["worktree", "add", tempWorktree, TEMPLATE_BRANCH], asMind);
    } else {
      await gitExec(["worktree", "add", "--detach", tempWorktree], asMind);
      await gitExec(["checkout", "--orphan", TEMPLATE_BRANCH], inWorktree);
      await gitExec(["rm", "-rf", "--cached", "."], inWorktree);
      await gitExec(["clean", "-fd"], inWorktree);
    }

    if (branchExists) {
      await gitExec(["rm", "-rf", "."], inWorktree).catch(() => {});
    }

    copyTemplateToDir(composedDir, tempWorktree, composeName, manifest);
    // The copy ran as the daemon; hand it over before the mind's git stages it, or
    // the worktree removal below can't unlink root-owned directories.
    await chownMindDir(tempWorktree, mindName);

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

    await gitExec(["add", "-A"], inWorktree);

    try {
      await gitExec(["diff", "--cached", "--quiet"], inWorktree);
    } catch {
      await gitExec(["commit", "-m", "template update"], inWorktree);
    }
  } finally {
    try {
      await gitExec(["worktree", "remove", "--force", tempWorktree], asMind);
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
 * The paths volute/template tracks for a composed template: everything but
 * `.init/` and home/ (save the mechanics-owned VOLUTE.md), under their on-disk
 * names.
 */
export function templateBranchPaths(composedDir: string, manifest: TemplateManifest): string[] {
  return listFiles(composedDir)
    .filter((f) => !f.startsWith(".init/") && !f.startsWith(".init\\"))
    .filter((f) => (!f.startsWith("home/") && !f.startsWith("home\\")) || f === "home/VOLUTE.md")
    .map((f) => manifest.rename[f] ?? f);
}

/**
 * Give a repo whose history shares nothing with volute/template a base it does
 * share (#1244): a volute/template commit, recorded as a second parent of HEAD
 * without changing HEAD's tree. The next {@link updateTemplateBranch} commits the
 * current template on top of it, so the upgrade merges 3-way instead of as two
 * unrelated histories — which conflicts on every template file that differs, on
 * every upgrade, since nothing ever joins the two.
 *
 * The base has to be what the mind's files actually descend from. One *newer*
 * than that is the dangerous error: every template change between the two reads
 * as already applied, and the merge silently keeps the old code. So:
 *
 * - `{ composedFor }` — the current template, composed with that name. Only for
 *   a mind known to descend from exactly this template (an archive whose recorded
 *   template hash matches this host's), and only with the name its files were
 *   composed for, so a rename since then arrives as a template change. The
 *   mind's own edits to template files then merge like any other.
 * - `"head"` — HEAD's own copy of each current template path, which can't be
 *   newer than the mind. Where the mind edited a template file, the upgrade hands
 *   it the template's version and the mind's stays in history. Paths the mind
 *   added are left out of the base, so the merge keeps them.
 *
 * Git runs as `mindName`, so the repo must already be the mind's: `update-ref` and
 * `branch -D` fire a `reference-transaction` hook if the repo config names one,
 * and `{ composedFor }` commits through {@link updateTemplateBranch} (#961).
 */
export async function establishTemplateBase(
  dir: string,
  template: string,
  base: "head" | { composedFor: string },
  mindName: string,
): Promise<void> {
  const opts = mindGitOpts(dir, mindName);
  const head = (await gitExec(["rev-parse", "HEAD"], opts)).trim();
  // A volute/template made by an upgrade that found no base is an orphan of the
  // current template — the very base this replaces.
  await gitExec(["branch", "-D", TEMPLATE_BRANCH], opts).catch(() => {});

  if (base === "head") {
    const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), template);
    let paths: Set<string>;
    try {
      paths = new Set(templateBranchPaths(composedDir, manifest));
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
    const entries = (await gitExec(["ls-tree", "-r", "-z", head], opts))
      .split("\0")
      .filter((e) => e && paths.has(e.slice(e.indexOf("\t") + 1)));
    // A scratch index inside .git, which the mind can write — git puts its lock
    // file beside it. Never the daemon's tmpdir, which the mind can't reach.
    const indexFile = resolve(dir, ".git", "volute-template-base.index");
    rmSync(indexFile, { force: true });
    try {
      const withIndex = { ...opts, env: { ...opts.env, GIT_INDEX_FILE: indexFile } };
      // ls-tree's "<mode> <type> <sha>\t<path>" is one of the forms --index-info reads.
      await gitExec(["update-index", "-z", "--index-info"], {
        ...withIndex,
        stdin: entries.map((e) => `${e}\0`).join(""),
      });
      const tree = (await gitExec(["write-tree"], withIndex)).trim();
      const commit = (await gitExec(["commit-tree", tree, "-m", "template base"], opts)).trim();
      await gitExec(["update-ref", `refs/heads/${TEMPLATE_BRANCH}`, commit], opts);
    } finally {
      rmSync(indexFile, { force: true });
    }
  } else {
    await updateTemplateBranch(dir, template, base.composedFor, mindName);
  }

  const joined = (
    await gitExec(
      [
        "commit-tree",
        `${head}^{tree}`,
        "-p",
        head,
        "-p",
        TEMPLATE_BRANCH,
        "-m",
        "adopt volute/template as a merge base",
      ],
      opts,
    )
  ).trim();
  // Against the HEAD it was built on: a commit landing in between (the mind's
  // auto-commit) fails this loudly rather than being dropped from the branch.
  await gitExec(["update-ref", "HEAD", joined, head], opts);
}

const JSON_CONFLICT = Symbol("json-conflict");
const DEPENDENCY_MAPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Three-way merge of JSON values, key by key; JSON_CONFLICT when both sides changed one key differently. */
function mergeJson(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (sameJson(ours, theirs)) return ours;
  if (sameJson(ours, base)) return theirs;
  if (sameJson(theirs, base)) return ours;
  if (!isPlainObject(ours) || !isPlainObject(theirs)) return JSON_CONFLICT;
  const b = isPlainObject(base) ? base : {};
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const v = mergeJson(b[key], ours[key], theirs[key]);
    if (v === JSON_CONFLICT) return JSON_CONFLICT;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Resolve a both-modified package.json conflict in `dir` by merging it key by key,
 * and stage the result. A skill's npm-dependencies land in the mind's package.json
 * right beside the template's own, so a template dependency bump collides line-wise
 * with a skill install that touched nothing the template did (#1185). Each side's
 * changes survive; a key both sides changed differently leaves the conflict as it
 * was. Returns true when package.json was resolved. Git runs as the mind (#961).
 */
export async function resolvePackageJsonConflict(dir: string, mindName: string): Promise<boolean> {
  const git = mindGitOpts(dir, mindName);
  let stages: unknown[];
  try {
    stages = await Promise.all(
      [1, 2, 3].map(async (n) => JSON.parse(await gitExec(["show", `:${n}:package.json`], git))),
    );
  } catch {
    return false; // package.json isn't a both-modified conflict, or a side isn't valid JSON
  }
  const merged = mergeJson(stages[0], stages[1], stages[2]);
  if (!isPlainObject(merged)) return false;
  // npm keeps dependency maps sorted; match it so the post-merge install writes no diff
  for (const key of DEPENDENCY_MAPS) {
    const deps = merged[key];
    if (isPlainObject(deps)) {
      merged[key] = Object.fromEntries(
        Object.entries(deps).sort(([a], [b]) => a.localeCompare(b, "en")),
      );
    }
  }
  await writeMindFile(dir, "package.json", `${JSON.stringify(merged, null, 2)}\n`, {
    owner: await mindFileOwner(mindName),
  });
  await gitExec(["add", "package.json"], git);
  return true;
}

/**
 * Merge the template branch into the current worktree.
 * Returns true if there are merge conflicts.
 */
async function mergeTemplateBranch(worktreeDir: string, mindName: string): Promise<boolean> {
  // As the mind: the merge and its commit run the mind's own hooks (#961).
  const git = mindGitOpts(worktreeDir, mindName);
  try {
    await gitExec(
      ["merge", TEMPLATE_BRANCH, "--allow-unrelated-histories", "-m", "merge template update"],
      git,
    );
    return false;
  } catch (e: unknown) {
    try {
      const status = await gitExec(["status", "--porcelain"], git);
      const hasConflictMarkers = status
        .split("\n")
        .some((line) => line.startsWith("UU") || line.startsWith("AA"));
      if (hasConflictMarkers) {
        if (await resolvePackageJsonConflict(worktreeDir, mindName)) {
          const left = await gitExec(["diff", "--name-only", "--diff-filter=U"], git);
          if (!left.trim()) {
            await gitExec(["commit", "--no-edit"], git);
            return false;
          }
        }
        return true;
      }
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
  mindName: string,
): Promise<{ merged: true } | { merged: false; files: string[] }> {
  // As the mind: the merge and the auto-untrack commit run the mind's own hooks (#961).
  const git = mindGitOpts(dir, mindName);
  try {
    await gitExec(["merge", branch], git);
    return { merged: true };
  } catch {
    // Conflict (or other failure) — inspect state below. Everything past this
    // point runs inside a try/catch whose catch always attempts merge --abort
    // before rethrowing, so an unexpected failure here can never leave dir
    // mid-merge.
  }
  try {
    const unmergedRaw = await gitExec(["diff", "--name-only", "--diff-filter=U"], git);
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
          await gitExec(["check-ignore", "--no-index", "-q", "--", file], git);
          resolvable.push(file); // exit 0 → ignored → resolvable by untracking
        } catch {
          // exit 1 → not ignored → real conflict
        }
      }
    }
    const remaining = unmerged.filter((f) => !resolvable.includes(f));
    if (remaining.length > 0) {
      await gitExec(["merge", "--abort"], git);
      return { merged: false, files: unmerged };
    }
    for (const file of resolvable) {
      // A UU (both-modified) conflict leaves <<<<<<< marker-polluted content in
      // the working tree file; checkout --ours restores main's clean content
      // before untracking. For modify/delete conflicts this is a no-op change
      // (the working tree already holds ours), so it's safe either way.
      await gitExec(["checkout", "--ours", "--", file], git);
      await gitExec(["rm", "--cached", "--", file], git);
    }
    await gitExec(["commit", "-m", "merge template update (auto-untrack ignored files)"], git);
    return { merged: true };
  } catch (err) {
    await gitExec(["merge", "--abort"], git).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Run `fn` with crash recovery held for `mindName`: from the merge until the upgrade's
 * own final start, the tree is half-written, and a recovery restart firing in that
 * window would boot the mind on it (#1279). A restart that comes due meanwhile runs on
 * release — when the upgrade restarts the mind, its final start has already cancelled it.
 */
export async function withRecoveryHold<T>(mindName: string, fn: () => Promise<T>): Promise<T> {
  const manager = tryGetMindManager();
  await manager?.holdRecovery(mindName);
  try {
    return await fn();
  } finally {
    manager?.releaseRecovery(mindName);
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
  // As the mind, not as the daemon: commits and merges here run the mind's own
  // hooks, and a hook that refuses (mimsy's MEMORY.md size wall, bardo Aug 2026)
  // must refuse a mind-privileged commit, not a root-privileged one.
  const asMind = mindGitOpts(dir, mindName);
  // Auto-commit any uncommitted changes in main worktree
  const mainStatus = (await gitExec(["status", "--porcelain"], asMind)).trim();
  if (mainStatus) {
    await gitExec(["add", "-A"], asMind);
    await gitExec(["commit", "-m", "Auto-commit before upgrade merge"], asMind);
  }

  const preMergeHead = (await gitExec(["rev-parse", "HEAD"], asMind)).trim();
  const mergeResult = await mergeWithUntrackResolution(dir, upgradeBranch, mindName);
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
  // The restore runs as the mind, so what it writes is already the mind's.
  let restoreWarning: string | undefined;
  try {
    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead, mindName);
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
    await gitExec(["branch", "-D", upgradeBranch], asMind);
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
      const migratedSkills = await migrateSkillsToTemplate(
        dir,
        oldTemplate,
        template,
        await mindFileOwner(mindName),
      );
      await gitExec(["add", "home/"], asMind);
      try {
        await gitExec(["diff", "--cached", "--quiet"], asMind);
      } catch {
        await gitExec(["commit", "-m", `swap template-owned home files for ${template}`], asMind);
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
  // edited are never touched, and neither are files it deleted after we gave
  // them to it (#811) — unless the restore above failed, in which case the
  // absences may be ours. Runs after any template switch so it picks up the
  // *new* template's composition. Untracked paths, so no commit is needed;
  // backfillInitInfrastructure throws rather than exiting, so a broken template
  // install is a warning here, not a failed upgrade.
  try {
    const { added, refreshed, withheld, unreadable } = await backfillInitInfrastructure(
      resolve(dir, "home"),
      template,
      mindName,
      // A failed restore above means files are missing from home/ because *this
      // upgrade* dropped them, not because the mind removed them. Don't read our
      // own damage as the mind's authorship and withhold them forever.
      { honorRemovals: !restoreWarning },
    );
    if (added.length > 0 || refreshed.length > 0) {
      log.info(
        `backfilled ${added.length} missing and refreshed ${refreshed.length} stale ` +
          `infrastructure files for ${mindName}`,
        { added, refreshed, withheld },
      );
      await chownMindDir(dir, mindName);
    } else if (withheld.length > 0) {
      // Steady state for a mind that has declined something: the same set every
      // upgrade, forever. Visible on demand, not noise in the info log.
      log.debug(`withheld ${withheld.length} infrastructure files ${mindName} removed`, {
        withheld,
      });
    }
    // What the daemon-start sync would otherwise redo, as a no-op, on the next start
    // (#1266). Recorded on the same terms it records them: nothing left unread.
    if (unreadable.length === 0) {
      writeAppliedInfrastructureHash(mindName, computeInfrastructureHash(template));
    }
  } catch (err) {
    log.warn(`failed to backfill infrastructure files for ${mindName}`, log.errorData(err));
  }

  // Rename routes.json `threads.*.batch` to the `delivery` key the router reads: the
  // template shipped the dead key, so channel batching never ran. `.config/` is the
  // mind's, so this is a surgical in-place key rename, and the mind is told. Never throws.
  await repairThreadBatchConfig(dir, mindName);

  // The mechanics doc is identity, so the merge never updates it — but a paragraph Volute
  // wrote may have stopped being true (#1144). Corrected only where still verbatim; a mind
  // that reworded it is told once instead. Never throws.
  await repairMechanicsDoc(dir, mindName, template);

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
  isUpOrRecovering(name: string): boolean;
  hasPendingRecovery(name: string): boolean;
  resumeRecovery(name: string): Promise<void>;
  stopMind(name: string): Promise<void>;
  startMind(name: string, opts?: { healthTimeoutMs?: number }): Promise<void>;
  setPendingContext(name: string, context: Record<string, unknown>): void;
};

/** Collaborators of {@link installDepsAndRestart}, defaulting to the real daemon singletons. */
export type InstallAndRestartDeps = {
  installNeeded: (dir: string, preMergeRef: string) => Promise<boolean>;
  install: (dir: string, mindName: string) => Promise<void>;
  /** Host-facing alert: a dashboard row, published the moment the failure happens. */
  publishHostError: (mindName: string, summary: string, kind: string) => Promise<void>;
  getManager: () => RestartTarget;
};

const defaultInstallAndRestartDeps: InstallAndRestartDeps = {
  installNeeded: npmInstallNeeded,
  install: npmInstallAsMind,
  publishHostError: publishMindError,
  getManager: getMindManager,
};

/**
 * Install the merged dependencies and restart the mind onto the new source.
 * A failure in either step becomes the returned warning rather than a throw — the
 * merge already landed, so there is nothing left to unwind.
 *
 * A failed install does **not** cancel the restart. The template hash in the DB is
 * advanced above, *before* this runs, so by the time an install can fail the mind is
 * already not stale: nothing — not the hourly auto-upgrade pass, not the staleness
 * badge — will ever come back and finish the job. Leaving the old process running
 * against new source on disk is therefore not "safe", it is permanent, and it is
 * what shipped mimsy fifteen days of 404s against an API path only its running code
 * still called (#973). Most upgrades don't need the new packages at all, so the
 * restart usually just works.
 *
 * When it doesn't, nothing else catches it: `setupCrashRecovery` is registered only
 * *after* the health probe passes, so a start that never becomes healthy is deleted
 * and thrown, not recovered; and `autoUpgradeOne` ignores `warning` on an
 * `upgraded` outcome. That is why both failure branches below publish a host-facing
 * error of their own rather than relying on the returned warning being read.
 */
export async function installDepsAndRestart(
  mindName: string,
  dir: string,
  preMergeHead: string,
  restart: boolean,
  deps: InstallAndRestartDeps = defaultInstallAndRestartDeps,
): Promise<string | undefined> {
  let depsWarning: string | undefined;
  /** Rides the "you were upgraded" lifecycle message; see {@link upgradeDepsFailureText}. */
  let depsFailure: string | undefined;

  // Skip npm install when the merge didn't touch dependencies — even a no-op
  // install writes enough to freeze slow storage for a minute or more.
  if (await deps.installNeeded(dir, preMergeHead)) {
    try {
      await deps.install(dir, mindName);
    } catch (err) {
      log.warn(`npm install failed after upgrade merge for ${mindName}`, log.errorData(err));
      const detail = installFailureDetail(err);
      depsFailure = upgradeDepsFailureText(mindName, dir, detail);
      depsWarning =
        `Upgrade merged but npm install failed (including a retry against the registry): ${firstLine(detail)} ` +
        `The mind runs the new code either way, which may not work until \`npm install\` ` +
        `succeeds in ${dir}. Nothing retries this automatically.`;
      // The host learns now — a dashboard row, not a log line. The mind learns on
      // its next start, via the pending context below.
      await deps.publishHostError(
        mindName,
        `Upgrade merged but npm install failed for ${mindName} — dependencies are stale`,
        "upgrade_deps_failed",
      );
    }
  } else {
    log.info(`skipping npm install for ${mindName} — dependencies unchanged by upgrade`);
  }

  // The mind's copy goes in the pending context, not out as its own event. A
  // separate event would be POSTed to the process stopMind kills microseconds
  // later, and `deliverEvent` marks a successful POST delivered — which takes it
  // out of the pending set `flushQueuedEvents` replays on start. Pending context
  // is delivered by `deliverPendingContext` only once the new process is healthy,
  // and survives on disk if the start fails (#973).
  const context = { type: "upgraded", ...(depsFailure ? { depsFailure } : {}) };

  const manager = deps.getManager();
  if (!restart) {
    manager.setPendingContext(mindName, context);
    return depsWarning;
  }

  // Restart mind with upgrade context
  const wasRecovering = manager.hasPendingRecovery(mindName);
  try {
    // A mind waiting out a crash backoff is stopped too: that cancels its pending
    // restart, which would otherwise race the start below (#1114).
    if (manager.isUpOrRecovering(mindName)) {
      await manager.stopMind(mindName);
    }
    manager.setPendingContext(mindName, context);
    // Generous health budget: right after an npm install the disk cache is
    // cold and I/O may still be saturated, so a tsx cold start can exceed the
    // default 30s — timing out here kills the child and leaves the mind down.
    await manager.startMind(mindName, { healthTimeoutMs: 120_000 });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // The stop above cancelled a pending crash recovery; without it back, a mind that
    // was coming back would stay down for good.
    if (wasRecovering) {
      await manager.resumeRecovery(mindName).catch((err) => {
        log.warn(`failed to resume crash recovery for ${mindName}`, log.errorData(err));
      });
    }
    // Nothing downstream reads the returned warning on an `upgraded` outcome, and a
    // start that never got healthy registered no crash recovery — so this row is the
    // only thing that tells anyone the mind is down. The pending context stays on
    // disk, so the mind still hears about it whenever it next starts.
    await deps.publishHostError(
      mindName,
      `Upgrade merged but ${mindName} failed to restart — the mind is down: ${firstLine(detail)}`,
      "upgrade_restart_failed",
    );
    return [depsWarning, `Upgrade merged but mind restart failed: ${detail}`]
      .filter(Boolean)
      .join(" ");
  }

  return depsWarning;
}

/**
 * The first non-empty line of `detail`, clipped. The CLI/API warning is a pointer;
 * npm's full output can run to dozens of lines and belongs in the mind's alert and
 * the log, not inline in a one-line command result.
 */
function firstLine(detail: string): string {
  const line =
    detail
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? detail.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** The failing install's stderr where there is any, else the error message. */
function installFailureDetail(err: unknown): string {
  const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
  return stderr || (err instanceof Error ? err.message : String(err));
}

/**
 * What the mind is told when its upgrade landed but its dependencies didn't.
 *
 * Written tense-neutrally on purpose: it is delivered with the "you were upgraded"
 * message, which arrives either right after the forced restart or at the mind's next
 * start (when no restart was requested). Either way the process reading it is
 * already running the new code, so "this start" is true in both.
 */
function upgradeDepsFailureText(mindName: string, dir: string, detail: string): string {
  return (
    `Your framework upgrade merged, but installing its dependencies failed — twice, the second ` +
    `time against the registry rather than your local npm cache.\n\n${detail}\n\n` +
    `This start is running the newly upgraded code with the old packages, so anything the ` +
    `upgrade added that needs a new one will not work until this is fixed. Nothing retries it ` +
    `for you: as far as Volute is concerned you are already upgraded. Run \`npm install\` in ` +
    `${dir} (or ask your host to), then \`volute mind restart ${mindName}\`.`
  );
}

/**
 * Put an upgrade failure in front of the host, as a `mind_error` row on the
 * dashboard. A `warn` in journald reaches nobody who can act (#808, #935), and on
 * the auto-upgrade path the returned warning is dropped, so this row is the signal.
 *
 * `publishActivity` swallows its own failures and returns id 0 rather than throwing,
 * so there is nothing here to guard against.
 */
async function publishMindError(mindName: string, summary: string, kind: string): Promise<void> {
  await publishActivity({
    type: "mind_error",
    mind: mindName,
    summary,
    metadata: { kind },
  });
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

  // Git runs as the mind (#961), so hand it the repo first — a pre-#961 upgrade
  // may have left root-owned entries behind, .variants/ among them.
  mkdirSync(resolve(dir, ".variants"), { recursive: true });
  await chownMindDir(dir, mindName);
  await updateTemplateBranch(dir, tmpl, mindName, mindName);

  const asMind = mindGitOpts(dir, mindName);
  try {
    return await gitExec(["diff", "HEAD...volute/template"], asMind);
  } catch {
    // If three-dot diff fails (no common ancestor), fall back to two-dot
    return await gitExec(["diff", "HEAD", "volute/template"], asMind);
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
  const asMind = mindGitOpts(dir, mindName);
  const inWorktree = mindGitOpts(worktreeDir, mindName);

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
      await gitExec(["init"], asMind);
      await configureGitIdentity(mindName, asMind);
      await gitExec(["add", "-A"], asMind);
      await gitExec(["commit", "-m", "initial commit"], asMind);
      await chownMindDir(dir, mindName);
    } catch (err) {
      rmSync(resolve(dir, ".git"), { recursive: true, force: true });
      throw new Error(
        `Git initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Every git command below runs as the mind, not as the daemon: commits, merges,
  // checkouts and ref updates run the mind's own hooks, and index reads its
  // configured fsmonitor — none of which may execute with the daemon's privilege
  // (#961, #871). The one exception is sharesTemplateBase's rev-parse/merge-base,
  // which read refs and objects only. All of it needs the repo — .variants/
  // included, where the worktrees go — to be the mind's first.
  const parentDir = resolve(dir, ".variants");
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  await chownMindDir(dir, mindName);

  // Clean up stale worktree refs and leftover branch
  await gitExec(["worktree", "prune"], asMind);
  try {
    await gitExec(["branch", "-D", UPGRADE_BRANCH], asMind);
  } catch {
    // branch doesn't exist
  }

  // A mind whose history never joined volute/template (a full-archive import, or
  // a repo made by the git init above) would merge as unrelated histories and
  // conflict on every differing template file, every time (#1244).
  if (!(await sharesTemplateBase(dir))) {
    log.info(`establishing a volute/template merge base for ${mindName}`);
    await establishTemplateBase(dir, oldTemplate, "head", mindName);
  }

  // Update template branch
  await updateTemplateBranch(dir, template, mindName, mindName);

  // Create upgrade worktree — as the mind, so it and its admin dir
  // (.git/worktrees/<branch>) are the mind's from the start.
  await gitExec(["worktree", "add", "-b", UPGRADE_BRANCH, worktreeDir], asMind);

  // Every exit path from here on has to remove the worktree and its admin dir. A
  // throw that skipped this used to leave both behind, root-owned, on a mind-owned repo —
  // after which the mind's own `git gc --auto` fails silently forever (#497, #653),
  // and the next hourly auto-upgrade pass just re-created them. The `conflicts`
  // returns below are deliberate exceptions: they *keep* the worktree for a host to
  // resolve by hand, and they return rather than throw.
  try {
    // Prepare home/ allowlist migration: untrack home files so template
    // branch removal doesn't cause conflicts or deletions
    await gitExec(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], inWorktree);
    // Re-add VOLUTE.md so template merge can update it
    try {
      await gitExec(["checkout", "HEAD", "--", "home/VOLUTE.md"], inWorktree);
      await gitExec(["add", "home/VOLUTE.md"], inWorktree);
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
      await gitExec(["diff", "--cached", "--quiet"], inWorktree);
    } catch {
      await gitExec(["commit", "-m", "prepare for home/ allowlist migration"], inWorktree);
    }

    // Merge template branch
    const hasConflicts = await mergeTemplateBranch(worktreeDir, mindName);

    if (!hasConflicts) {
      // Re-add home files that match the new .gitignore allowlist patterns
      try {
        await gitExec(["add", "home/"], inWorktree);
      } catch (err) {
        log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
      }
      try {
        await gitExec(["diff", "--cached", "--quiet"], inWorktree);
      } catch {
        await gitExec(["commit", "-m", "re-add allowlisted home files"], inWorktree);
      }
    }

    if (hasConflicts) {
      const filesRaw = await gitExec(["diff", "--name-only", "--diff-filter=U"], inWorktree);
      const files = filesRaw
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
      return { status: "conflicts", worktreeDir, files };
    }

    // Merge upgrade branch back to main, cleanup, and restart
    const result = await withRecoveryHold(mindName, () =>
      mergeUpgradeAndRestart(
        mindName,
        dir,
        worktreeDir,
        variantName,
        UPGRADE_BRANCH,
        template,
        oldTemplate,
        restart,
      ),
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
    // Belt and braces over cleanupVariant's own chownMindDir, which it
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

  // The host resolved the conflicts by hand, perhaps as root; the mind's git below
  // needs its tree back first.
  await chownMindDir(dir, mindName);
  const inWorktree = mindGitOpts(worktreeDir, mindName);
  const status = await gitExec(["status", "--porcelain"], inWorktree);
  const hasConflicts = status
    .split("\n")
    .some((line) => line.startsWith("UU") || line.startsWith("AA"));
  if (hasConflicts) {
    throw new Error("Unresolved conflicts remain");
  }

  try {
    await gitExec(["add", "-A"], inWorktree);
    await gitExec(["commit", "-m", "merge template update"], inWorktree);
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
    await gitExec(["add", "home/"], inWorktree);
  } catch (err) {
    log.warn(`failed to re-add home files during upgrade for ${mindName}`, log.errorData(err));
  }
  try {
    await gitExec(["diff", "--cached", "--quiet"], inWorktree);
  } catch {
    await gitExec(["commit", "-m", "re-add allowlisted home files"], inWorktree);
  }

  // Merge upgrade branch back to main, cleanup, and restart
  const result = await withRecoveryHold(mindName, () =>
    mergeUpgradeAndRestart(
      mindName,
      dir,
      worktreeDir,
      variantName,
      UPGRADE_BRANCH,
      template,
      oldTemplate,
      restart,
    ),
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
    await gitExec(["merge", "--abort"], mindGitOpts(worktreeDir, mindName)).catch(() => {});
  }

  await cleanupVariant(variantName, mindName, dir, worktreeDir, {
    stop: true,
    branch: UPGRADE_BRANCH,
  });
}
