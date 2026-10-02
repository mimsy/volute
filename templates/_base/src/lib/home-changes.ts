import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { flushFileChanges, gitArgs, trackFileChange, waitForCommits } from "./auto-commit.js";

/**
 * Untrimmed, unlike auto-commit's `exec`: porcelain's first record can begin with a space
 * (an unstaged change), and trimming it would shift every field.
 */
function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((r) => {
    execFile("git", gitArgs(args), { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      r(err ? null : stdout),
    );
  });
}

/**
 * Every path git sees as changed under `cwd` — modified, added, deleted, or untracked and
 * not ignored — as absolute paths.
 *
 * Codex makes most of its edits through shell commands, not `file_change` items (a live
 * mind showed 847 `exec` calls against 2 patch applies), so tracking only the items it
 * reports leaves nearly all of a codex mind's work uncommitted (#1189). Asking git what
 * changed catches both, and inherits the repo's `home/*` allowlist: a path the gitignore
 * keeps out of history never appears here, exactly as it never commits for claude.
 *
 * Porcelain paths are relative to the repository root, not to `cwd`, so each is re-based
 * onto `cwd` through its prefix within the repo — not through `--show-toplevel`, which
 * resolves symlinks and so wouldn't share a prefix with a `cwd` reached through one.
 * Returns [] when `cwd` isn't in a repo, doesn't exist, or git fails.
 */
export async function changedPaths(cwd: string): Promise<string[]> {
  const prefix = await git(["rev-parse", "--show-prefix"], cwd);
  if (prefix === null) return [];
  const status = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
    cwd,
  );
  if (!status) return [];
  const within = prefix.trim();
  const paths: string[] = [];
  const add = (repoPath: string | undefined) => {
    if (repoPath?.startsWith(within)) paths.push(resolve(cwd, repoPath.slice(within.length)));
  };
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    add(record.slice(3));
    // A rename or copy — in the index or the worktree column — carries its source as the
    // next NUL-separated field; the source is a change too (it went away).
    if ("RC".includes(record[0]) || "RC".includes(record[1])) add(records[++i]);
  }
  return paths;
}

/**
 * Commit everything git sees changed under home/ and in the pages worktree (which the
 * mind's own repo ignores), not just the files tracked since the last flush.
 *
 * Codex commits this way after every turn. Claude and pi commit their tracked files at
 * turn end and call this at shutdown: their turn-end commit starts after `done`, so a
 * stop that follows `done` closely signals the whole process group and kills that
 * commit's git mid-flight. The files it was carrying are no longer pending by then, so
 * only asking git again recovers them (#1206).
 */
export async function commitHomeChanges(cwd: string): Promise<void> {
  // Let an in-flight commit finish (or fail) first, so git is read after it, not mid-write.
  await waitForCommits();
  for (const dir of [cwd, resolve(cwd, "pages/_system")]) {
    for (const path of await changedPaths(dir)) trackFileChange(path, cwd);
  }
  await flushFileChanges(cwd);
}
