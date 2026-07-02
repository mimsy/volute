import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";

const glog = log.child("last-known-good");

/** Are there uncommitted changes (tracked or untracked) under the repo's src/ dir? */
async function hasSrcChanges(dir: string): Promise<boolean> {
  const status = (await gitExec(["status", "--porcelain", "--", "src"], { cwd: dir })).trim();
  return status.length > 0;
}

/**
 * Park uncommitted changes under `src/` on a `broken/<timestamp>` branch, then revert
 * the working tree's `src/` back to HEAD (the last known-good state). Changes elsewhere
 * (e.g. the mind's `home/` directory) are left untouched.
 *
 * Used by the restart route's last-known-good recovery: when a mind edits its own
 * server source and the edit breaks startup, this preserves the broken change for the
 * mind to inspect while restoring a bootable src/.
 *
 * Never uses `git stash` — the daemon shares one git object store across worktrees, so a
 * stash entry here could collide with concurrent work. We commit-then-rewind instead.
 *
 * Returns whether anything was parked and, if so, the branch it was parked on.
 */
export async function rollbackSrcChanges(
  dir: string,
): Promise<{ parked: boolean; branch?: string }> {
  if (!(await hasSrcChanges(dir))) return { parked: false };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = `broken/${ts}`;
  const opts = { cwd: dir };

  // Stage only src/ (home/ stays unstaged and untouched), commit it, mark the commit with
  // a branch, then move the working branch back one commit so HEAD is the good state again.
  await gitExec(["add", "--", "src"], opts);
  await gitExec(["commit", "-m", `Parked broken src changes (${branch})`], opts);
  await gitExec(["branch", branch], opts);
  await gitExec(["reset", "--mixed", "HEAD~1"], opts);
  // Restore tracked src/ files to HEAD and drop any newly-added (untracked) src/ files, so
  // an added-but-broken file can't linger and re-break startup.
  await gitExec(["checkout", "--", "src"], opts);
  await gitExec(["clean", "-fdq", "--", "src"], opts);

  glog.info(`parked broken src changes on ${branch} (${dir})`);
  return { parked: true, branch };
}

/**
 * Commit uncommitted `src/` changes as the new known-good baseline. Called after a
 * successful (re)start so HEAD always reflects the last src/ that actually booted —
 * giving {@link rollbackSrcChanges} a clean point to revert to next time. The mind's
 * auto-commit hook only tracks `home/`, so without this src/ edits would never be
 * committed and every rollback would discard prior good work. No-op if src/ is clean.
 */
export async function commitSrcChanges(dir: string): Promise<void> {
  if (!(await hasSrcChanges(dir))) return;
  await gitExec(["add", "--", "src"], { cwd: dir });
  await gitExec(["commit", "-m", "Update src (self-edit)"], { cwd: dir });
  glog.info(`committed known-good src changes (${dir})`);
}
