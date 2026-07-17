import { gitExec } from "../util/exec.js";
import log from "../util/logger.js";

const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export function validateBranchName(branch: string): string | null {
  if (!SAFE_BRANCH_RE.test(branch)) {
    return `Invalid branch name: ${branch}. Only alphanumeric, '.', '_', '-', '/' allowed.`;
  }
  if (branch.includes("..")) {
    return `Invalid branch name: ${branch}. '..' not allowed.`;
  }
  return null;
}

/**
 * The mind's living memory — long-term memory and the daily journal — is
 * accumulated perspective, not code. Two divergent timelines shouldn't be
 * line-merged by git any more than two people's diaries should be zipped
 * together, and a conflict here lands in a mind's most identity-critical
 * files. These paths are excluded from the variant join merge (#440).
 */
const MERGE_EXCLUDED_PATHS = ["home/MEMORY.md", "home/memory/journal/"];

/** Cap the narrated delta so a long-running variant's week can't blow up the parent's context. */
const MAX_DELTA_CHARS = 12000;

/**
 * Paths under home/ that the platform deliberately keeps untracked, even though
 * a mind's own new files there should be rescued (see below). Never resurrect:
 *
 * - SDK runtime session state and backups under home/.claude/, home/.pi/,
 *   home/.agents/ (minus their whitelisted skills/settings, already tracked
 *   normally) — fixed by PR #661's gitignore rules so this noise stops merging
 *   into parents.
 * - node_modules/dist anywhere under home/ — templates/_base/gitignore ignores
 *   these repo-wide (no leading slash, so the rule matches at any depth), for
 *   the same reason they're excluded everywhere else: dependency trees and
 *   build output aren't a mind's creative work and don't belong in git history.
 *
 * Kept in manual sync with templates/_base/gitignore (search there for "#656").
 */
const NEVER_RESCUE_PREFIXES = ["home/.claude/", "home/.pi/", "home/.agents/"];
const NEVER_RESCUE_SEGMENTS = new Set(["node_modules", "dist"]);

function isRescuable(path: string): boolean {
  if (NEVER_RESCUE_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return !path.split("/").some((segment) => NEVER_RESCUE_SEGMENTS.has(segment));
}

/**
 * Force-stage any file a mind created directly under home/ that .gitignore's
 * `home/*` catch-all silently blocks from tracking. New top-level home/ files
 * are the normal creative path variants exist to support, but auto-commit's
 * `git add` no-ops on them (it only logs the failure), so they sit uncommitted
 * in the variant's working tree — and `cleanupVariant`'s `git worktree remove`
 * deletes the working tree wholesale, destroying them (#656).
 *
 * Deliberately-ignored SDK runtime noise and build/dependency output (see
 * {@link isRescuable}) stay excluded — resurrecting either would bake noise or
 * unrelated build artifacts into the parent's permanent git history.
 *
 * Call this before the pre-merge auto-commit in the variant's own worktree, so
 * the rescued files land in a real commit on the variant branch and merge into
 * the parent like any other change. Never throws — a scan or stage failure is
 * logged and treated as "nothing to rescue," falling back to the pre-#656
 * behavior for that join rather than blocking it.
 *
 * @returns the repo-relative paths that were force-added.
 */
export async function rescueIgnoredHomeFiles(cwd: string): Promise<string[]> {
  const opts = { cwd };
  let raw: string;
  try {
    raw = await gitExec(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "home"],
      opts,
    );
  } catch (err) {
    log.warn("variant join: failed to scan for ignored home/ files", log.errorData(err));
    return [];
  }

  const rescued = raw.split("\0").filter((path) => path && isRescuable(path));
  if (rescued.length === 0) return [];

  try {
    await gitExec(["add", "-f", "--", ...rescued], opts);
  } catch (err) {
    log.warn(
      `variant join: failed to rescue ignored home/ files: ${rescued.join(", ")}`,
      log.errorData(err),
    );
    return [];
  }
  log.info(`variant join: rescued gitignored home/ files: ${rescued.join(", ")}`);
  return rescued;
}

/**
 * Merge a variant branch into the parent worktree, excluding the mind's living
 * memory (MEMORY.md, memory/journal/) from the textual merge. The parent keeps
 * its own copy of those files; the variant's delta is returned so it can be
 * narrated to the parent as context — "here is what your variant learned and
 * wrote; integrate what you want to keep" — the way memory consolidation
 * already works (#440).
 *
 * Code, skills, and config merge with normal git semantics. A real conflict
 * there (or a restore that can't fully strip the variant's memory) aborts the
 * merge and throws {@link VariantMergeError} with the unmerged files, leaving
 * the parent worktree clean.
 *
 * @returns the git diff of the excluded paths across the split, or "" if the
 *   variant wrote none. Callers thread it into the post-merge context message.
 */
export async function mergeVariantExcludingMemory(
  projectRoot: string,
  variantBranch: string,
): Promise<string> {
  const opts = { cwd: projectRoot };

  // Capture the variant's memory/journal delta before merging. An empty diff is
  // fine (the variant wrote nothing), but a real git failure would silently lose
  // the variant's only surviving memory — the branch is deleted right after — so
  // narrate that honestly to the parent instead of dropping it.
  let memoryDelta = "";
  try {
    const base = (await gitExec(["merge-base", "HEAD", variantBranch], opts)).trim();
    memoryDelta = (
      await gitExec(["diff", `${base}..${variantBranch}`, "--", ...MERGE_EXCLUDED_PATHS], opts)
    ).trim();
  } catch (err) {
    log.error(
      `variant join: failed to compute memory delta for ${variantBranch}`,
      log.errorData(err),
    );
    memoryDelta = `(journal delta unavailable — ${err instanceof Error ? err.message : String(err)})`;
  }
  if (memoryDelta.length > MAX_DELTA_CHARS) {
    memoryDelta = `${memoryDelta.slice(0, MAX_DELTA_CHARS)}\n… (delta truncated)`;
  }

  // Everything from the merge attempt to the commit is guarded: any failure —
  // a restore that can't fully strip the variant's memory, or a real code/config
  // conflict — aborts the merge and throws so the join fails loudly with a clean
  // worktree, never a contaminated or half-done commit (cleanupVariant deletes
  // the branch right after, so a bad commit here is unrecoverable).
  try {
    // --no-ff --no-commit stages the merge without committing so we can restore
    // the parent's copy of the excluded paths first. Conflicts (or the
    // --no-commit stop) are expected; a real code/config conflict resurfaces at
    // commit time below.
    await gitExec(["merge", "--no-ff", "--no-commit", variantBranch], opts).catch(() => {});

    // Restore the excluded paths to the parent's committed state: unstage any
    // variant entries, restore the parent's tracked versions to the worktree
    // (tolerating paths the parent doesn't track — the variant added them, and
    // clean removes them), and drop any variant-added files left untracked.
    await gitExec(["reset", "-q", "HEAD", "--", ...MERGE_EXCLUDED_PATHS], opts);
    for (const path of MERGE_EXCLUDED_PATHS) {
      await gitExec(["checkout", "--", path], opts).catch(() => {});
    }
    await gitExec(["clean", "-fdq", "--", ...MERGE_EXCLUDED_PATHS], opts);
    await assertExcludedPathsRestored(opts);

    // Only commit if the merge actually started. A variant with no new commits
    // leaves "Already up to date" — no MERGE_HEAD, nothing staged — and an
    // unconditional commit would fail "nothing to commit".
    if (await mergeInProgress(opts)) {
      await gitExec(["commit", "--no-edit"], opts);
    }
  } catch (err) {
    const conflicts = await listConflicts(opts);
    // Restore the parent worktree. If the abort itself fails, the parent is left
    // mid-merge — surface that so the caller can warn about on-disk conflict
    // markers the still-running mind might auto-commit.
    const abortFailed = await gitExec(["merge", "--abort"], opts).then(
      () => false,
      () => true,
    );
    throw new VariantMergeError(
      `variant join aborted: ${err instanceof Error ? err.message : String(err)}`,
      conflicts,
      abortFailed,
    );
  }

  return memoryDelta;
}

/** Thrown when a variant join is aborted; carries the unmerged files and whether the abort completed. */
export class VariantMergeError extends Error {
  constructor(
    message: string,
    readonly conflicts: string[],
    readonly abortFailed: boolean = false,
  ) {
    super(message);
    this.name = "VariantMergeError";
  }
}

/** True while a merge is in progress (MERGE_HEAD present) — worktree-safe via rev-parse. */
async function mergeInProgress(opts: { cwd: string }): Promise<boolean> {
  return gitExec(["rev-parse", "-q", "--verify", "MERGE_HEAD"], opts).then(
    () => true,
    () => false,
  );
}

/** List the files left in conflict (unmerged) in the worktree. */
async function listConflicts(opts: { cwd: string }): Promise<string[]> {
  try {
    const out = (await gitExec(["diff", "--name-only", "--diff-filter=U"], opts)).trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Confirm the excluded paths (index and worktree) match the parent's HEAD after
 * the restore, so the merge commit can't carry any of the variant's memory or
 * journal. Throws if a difference or a leftover untracked file remains.
 */
async function assertExcludedPathsRestored(opts: { cwd: string }): Promise<void> {
  await gitExec(["diff", "--cached", "--quiet", "HEAD", "--", ...MERGE_EXCLUDED_PATHS], opts);
  await gitExec(["diff", "--quiet", "HEAD", "--", ...MERGE_EXCLUDED_PATHS], opts);
  // `git diff` ignores untracked files, so a variant-added file the clean step
  // missed (e.g. a new journal day, or a MEMORY.md the parent never tracked)
  // would slip past the checks above — and the parent's next auto-commit
  // (`git add -A`) would commit it. Catch it explicitly.
  const untracked = (
    await gitExec(
      ["ls-files", "--others", "--exclude-standard", "--", ...MERGE_EXCLUDED_PATHS],
      opts,
    )
  ).trim();
  if (untracked) {
    throw new Error(
      `untracked memory files remain after restore: ${untracked.replace(/\n/g, ", ")}`,
    );
  }
}
