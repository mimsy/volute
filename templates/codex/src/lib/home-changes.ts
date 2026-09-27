import { execFile } from "node:child_process";
import { resolve } from "node:path";

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((r) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
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
 * Returns [] when `cwd` isn't in a repo or git fails.
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
    // A rename or copy carries its source as the next NUL-separated field; the source is
    // a change too (it went away).
    if (record[0] === "R" || record[0] === "C") add(records[++i]);
  }
  return paths;
}
