import { randomBytes } from "node:crypto";
import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";

const glog = log.child("last-known-good");

/** Are there uncommitted changes (tracked or untracked) under the repo's src/ dir? */
async function hasSrcChanges(dir: string, mindName?: string): Promise<boolean> {
  const status = (
    await gitExec(["status", "--porcelain", "--", "src"], { cwd: dir, mindName })
  ).trim();
  return status.length > 0;
}

/**
 * Park uncommitted changes under `src/` on a `broken/<timestamp>-<rand>` branch, then revert
 * the working tree's `src/` back to HEAD (the last known-good state). Changes elsewhere
 * (e.g. the mind's `home/` directory) are left untouched.
 *
 * Used by the restart route's last-known-good recovery: when a mind edits its own
 * server source and the edit breaks startup, this preserves the broken change for the
 * mind to inspect while restoring a bootable src/.
 *
 * Under user-isolation, `mindName` makes git run as the mind's OS user so it doesn't
 * leave root-owned objects/refs in the mind's `.git` (which would break the mind's own
 * auto-commit with EACCES).
 *
 * Never uses `git stash` — the daemon shares one git object store across worktrees, so a
 * stash entry here could collide with concurrent work. We commit-then-rewind instead.
 *
 * The rewind (`reset --mixed HEAD~1`) happens BEFORE the fragile branch step so that if
 * branch creation ever fails, HEAD is already back at the good state and the broken src/
 * is still in the working tree — leaving the mind recoverable on the next restart rather
 * than permanently stuck on committed-but-broken src/.
 *
 * Returns whether anything was parked and, if so, the branch it was parked on.
 */
export async function rollbackSrcChanges(
  dir: string,
  mindName?: string,
): Promise<{ parked: boolean; branch?: string }> {
  if (!(await hasSrcChanges(dir, mindName))) return { parked: false };

  // Collision-proof branch name: two variants sharing the object store can roll back in
  // the same second, so a second-resolution timestamp alone isn't unique.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = `broken/${ts}-${randomBytes(4).toString("hex")}`;
  const opts = { cwd: dir, mindName };

  // Stage only src/ (home/ stays unstaged and untouched) and commit ONLY src/ — `--only`
  // ignores any pre-staged non-src content so it can't be swept into the parked commit.
  await gitExec(["add", "--", "src"], opts);
  await gitExec(
    ["commit", "--only", "-m", `Parked broken src changes (${branch})`, "--", "src"],
    opts,
  );
  // Capture the broken commit, rewind HEAD to the good state, THEN park the broken commit
  // on a branch (created from the captured hash, not from HEAD). Rewinding first keeps the
  // repo recoverable if `git branch` fails.
  const brokenHash = (await gitExec(["rev-parse", "HEAD"], opts)).trim();
  await gitExec(["reset", "--mixed", "HEAD~1"], opts);
  await gitExec(["branch", branch, brokenHash], opts);
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
 *
 * Under user-isolation, `mindName` makes git run as the mind's OS user (see
 * {@link rollbackSrcChanges}).
 */
export async function commitSrcChanges(dir: string, mindName?: string): Promise<void> {
  if (!(await hasSrcChanges(dir, mindName))) return;
  const opts = { cwd: dir, mindName };
  // Commit ONLY src/ so pre-staged non-src content isn't swept into the baseline commit.
  await gitExec(["add", "--", "src"], opts);
  await gitExec(["commit", "--only", "-m", "Update src (self-edit)", "--", "src"], opts);
  glog.info(`committed known-good src changes (${dir})`);
}
