import { statSync } from "node:fs";
import { resolve } from "node:path";
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
 * SDK-managed runtime subtrees under home/ — session transcripts, backups, cleanup
 * markers — that are permanently and deliberately kept out of git (PR #661) and get
 * regenerated every session. They aren't a mind's content to keep or discard, so
 * they're excluded from the unresolved-files scan below entirely: reporting them
 * would make nearly every join block by default (any mind with conversation history
 * has `.claude/projects/*.jsonl`), defeating the point of only interrupting the join
 * when a mind's *own* work is actually at risk. Skills/settings within these dirs are
 * already tracked normally and never show up here.
 */
const NEVER_REPORT_PREFIXES = ["home/.claude/", "home/.pi/", "home/.agents/"];

/** Cap the individual files listed in an unresolved-files report; huge trees (a cloned
 * repo, a venv) would otherwise flood the message. `totalCount`/`totalBytes` still
 * cover everything found, not just what's listed. */
const MAX_LISTED_UNRESOLVED_FILES = 20;

/** One untracked home/ file .gitignore hides from git, found at join time. */
export interface UnresolvedHomeFile {
  /** Path relative to the variant's repo root, e.g. "home/downloads/movie.mp4". */
  path: string;
  /** Size in bytes, or -1 if it couldn't be read (e.g. deleted mid-scan). */
  bytes: number;
}

/** Result of scanning a variant's home/ for files gitignore would silently drop. */
export interface UnresolvedHomeFiles {
  /** Up to {@link MAX_LISTED_UNRESOLVED_FILES} entries, for display. */
  files: UnresolvedHomeFile[];
  /** The true count, which may exceed `files.length`. */
  totalCount: number;
  /** Sum of bytes across every file found, not just the displayed subset. */
  totalBytes: number;
}

/**
 * Find every file under home/ that .gitignore hides from tracking and that's still
 * sitting on disk, uncommitted — exactly what `cleanupVariant`'s `git worktree remove`
 * would silently destroy at join (#656).
 *
 * `home/*` is gitignored by design: a mind's home can hold large downloads, nested git
 * repos, build output, anything. The daemon has no way to know what's precious and what
 * isn't, so unlike the previous force-add approach, this makes no judgment call on a
 * mind's own content — it only excludes the SDK's own permanently-ignored runtime
 * directories (see {@link NEVER_REPORT_PREFIXES}), which are never a mind's content.
 * Everything else found here is the caller's to report and block on, not resolve.
 *
 * Throws on a scan failure (e.g. the worktree is gone or corrupt) rather than treating
 * "couldn't check" as "nothing found" — a safety check that fails open isn't a safety
 * check. Callers must treat a thrown error as blocking too.
 */
export async function findUnresolvedHomeFiles(cwd: string): Promise<UnresolvedHomeFiles> {
  const raw = await gitExec(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "home"],
    { cwd },
  );

  const allPaths = raw
    .split("\0")
    .filter((path) => path && !NEVER_REPORT_PREFIXES.some((prefix) => path.startsWith(prefix)));

  const files: UnresolvedHomeFile[] = [];
  let totalBytes = 0;
  for (const path of allPaths) {
    let bytes = -1;
    try {
      bytes = statSync(resolve(cwd, path)).size;
    } catch {
      // Deleted between listing and stat, or an unreadable symlink — still report it,
      // just without a size, rather than silently dropping it from the count.
    }
    if (bytes > 0) totalBytes += bytes;
    if (files.length < MAX_LISTED_UNRESOLVED_FILES) files.push({ path, bytes });
  }

  return { files, totalCount: allPaths.length, totalBytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}

/**
 * Render {@link findUnresolvedHomeFiles}'s result as an unmistakable, actionable
 * message: which files are at risk, how big they are, and the three ways to resolve
 * each one before retrying the join. Paths drop the "home/" prefix so they read the
 * way the variant itself sees them (its cwd is already home/).
 */
export function formatUnresolvedHomeFilesMessage(
  variantName: string,
  result: UnresolvedHomeFiles,
): string {
  const lines = result.files.map(
    (f) => `  - ${f.path.replace(/^home\//, "")} (${formatBytes(f.bytes)})`,
  );
  const remaining = result.totalCount - result.files.length;
  if (remaining > 0) lines.push(`  ...and ${remaining} more`);

  return (
    `Cannot join variant "${variantName}": it has ${result.totalCount} untracked file` +
    `${result.totalCount === 1 ? "" : "s"} under home/ that .gitignore is hiding from git — ` +
    `never committed, and joining would destroy them when the variant is cleaned up ` +
    `(total: ${formatBytes(result.totalBytes)}):\n\n${lines.join("\n")}\n\n` +
    `Before retrying the join, resolve each file in the variant — one of:\n` +
    `  1. Track it: git add -f -- <path> (then commit it, or let auto-commit pick it up next turn)\n` +
    `  2. Copy it out of home/ to somewhere safe, then delete it\n` +
    `  3. Delete it if it's disposable\n\n` +
    `Once resolved, retry the join. To join anyway and discard everything listed above, pass ` +
    `discardUnresolved: true.`
  );
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
