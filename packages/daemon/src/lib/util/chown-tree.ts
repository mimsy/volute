import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { buildMindBaseEnv } from "./mind-env.js";
import { trackChild } from "./tracked-children.js";

/**
 * Run a host binary on no mind's behalf, returning its stdout. Not `util/exec.ts`:
 * that module imports isolation, and this one must stay importable from the pages
 * extension without dragging the registry and DB in. Same env rule as the wrapper
 * there — the allowlist, never the daemon's own environment.
 */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      cmd,
      args,
      { env: { ...buildMindBaseEnv(), PATH: FIND_PATH } },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = stderr;
          rej(err);
        } else {
          res(stdout);
        }
      },
    );
    trackChild(child, { group: false, supervised: false });
  });
}

/**
 * A fixed PATH for find and the chown it runs: GNU find refuses -execdir outright
 * when PATH has an empty or relative entry, and the host's PATH is not ours to
 * vouch for. chown is in /usr/sbin on macOS, /usr/bin or /bin on Linux.
 */
const FIND_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** `path` as a find(1) `-path` pattern that matches only itself. */
function findPathPattern(path: string): string {
  return path.replace(/[\\*?[\]]/g, "\\$&");
}

/**
 * Recursively give everything below `root` to `user:group` (or only to `group`,
 * with no `user`) — the hard-link-safe `chown -R` / `chgrp -R` for a tree a mind
 * can write into (#1235). `root` itself is the caller's: `chownMindDir` re-owns
 * it through an open handle (`chownNoFollow`), `chownTree` by path. Returns the
 * entries it left alone because they have other names.
 *
 * A hard link is not a pointer: it is the file itself under a second name, so
 * re-owning it re-owns the file. The daemon is root under user isolation, and a
 * mind that can write into the tree can hard-link any file on the same
 * filesystem into it — `ln /private/etc/sudoers ~/home/x` works on macOS, which
 * has no protected_hardlinks, and on Linux wherever fs.protected_hardlinks=0. A
 * plain recursive chown then hands the mind sudoers. So a non-directory with more
 * than one link is never re-owned; directories can't be hard-linked, and every one
 * has at least two links (its entry and its `.`), so they are exempt from the
 * count. Entries already owned right are not touched, so a mind hard-linking its
 * own files costs nothing and reports nothing.
 *
 * The walk is physical (`find` defaults to -P: a planted symlink, the root
 * included, is never descended), and each chown runs via -execdir from inside
 * the directory the walk is already in, with -h so a symlink is re-owned itself
 * rather than its target — nothing is resolved by path twice. The walk starts
 * below the root because BSD find's -execdir mis-resolves a starting point.
 *
 * Batched (`+`), unlike `chownForeignOwned`: one chown per entry costs ~10ms, so
 * a fresh or restored tree of thousands of root-owned files would take minutes.
 * The price is a wider test→chown window in directories the mind already owns,
 * where it could swap a tested entry for a hard link before the batch runs.
 * Closing that needs an fd-based walk Node and find do not offer; a planted link
 * sitting in the tree — the attack that needs no timing — is what this stops.
 *
 * `prune` names top-level entries to leave out. A failing find or chown throws:
 * both GNU and BSD find exit non-zero when an `-exec… {} +` batch fails.
 */
export async function chownBelow(
  root: string,
  owner: Owner,
  opts: { prune?: string[] } = {},
): Promise<string[]> {
  const prune = (opts.prune ?? []).flatMap((name) => [
    "-path",
    findPathPattern(resolve(root, name)),
    "-prune",
    "-o",
  ]);
  return findAndChown([root, "-mindepth", "1", ...prune], owner, "-execdir");
}

/**
 * `chownBelow`, then `root` itself by path with `chown -h` — for callers holding
 * only names, not the numeric ids `chownNoFollow` needs. The same skip applies
 * to the root: a hard-linked root is reported, not re-owned.
 */
export async function chownTree(root: string, owner: Owner): Promise<string[]> {
  const below = await chownBelow(root, owner);
  return [...below, ...(await findAndChown([root, "-maxdepth", "0"], owner, "-exec"))];
}

type Owner = { user?: string; group: string };

/**
 * Run `find <start…>`, re-owning each match that is not owned right and is a
 * directory or has one name, and returning the rest of the not-owned-right ones.
 * NUL-separated, so a filename carrying a newline cannot forge a report line.
 */
async function findAndChown(
  start: string[],
  owner: Owner,
  execAction: "-exec" | "-execdir",
): Promise<string[]> {
  const spec = `${owner.user ?? ""}:${owner.group}`;
  const owned = owner.user ? ["-user", owner.user, "-group", owner.group] : ["-group", owner.group];
  const out = await run("find", [
    ...start,
    "!",
    "(",
    ...owned,
    ")",
    "(",
    "(",
    "-type",
    "d",
    "-o",
    "-links",
    "1",
    ")",
    execAction,
    "chown",
    "-h",
    spec,
    "{}",
    "+",
    "-o",
    "-print0",
    ")",
  ]);
  return out.split("\0").filter(Boolean);
}
