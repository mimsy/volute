/**
 * The daemon writing into a directory the mind controls: where it may write, and
 * who owns the result.
 *
 * Extension commands run *daemon-side* — `volute pages write` is an HTTP POST to
 * `/api/ext/pages/commands/write`, so the file lands under the daemon's uid. On a
 * user-isolation install that is root, which makes both halves of this module
 * security-relevant:
 *
 * - **Ownership.** A page the daemon births root-owned is a page its author cannot
 *   edit, rename, or delete: the mind wrote it and then found the door locked.
 * - **Containment.** The mind owns `home/pages`, so every path component under it is
 *   attacker-controlled. It can replace `notes/` with a symlink and, without the
 *   check here, make the daemon write through it as root and then `chown` the
 *   symlink's *target* to the mind's user — handing away whatever it pointed at.
 *
 * The `exec` parameter exists so tests can watch the argv without a real `chown`
 * (which needs root and behaves differently per platform). Production callers take
 * the default.
 */
import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/** The slice of `ExtensionContext` this needs. Structural, so any ctx satisfies it. */
export type MindOwnership = {
  isIsolationEnabled: () => boolean;
  getMindUser: (name: string) => string;
};

export type ChownExec = (cmd: string, args: string[]) => Promise<void>;

/** Async by rule: sync exec on a daemon request path blocks the loop for every mind. */
const defaultExec: ChownExec = (cmd, args) =>
  new Promise((res, rej) => {
    execFile(cmd, args, (err) => (err ? rej(err) : res()));
  });

/**
 * A file with more than one name on disk. Refused wherever the daemon reads or
 * copies a mind's pages, for the same reason a symlink is (#1089).
 *
 * A hard link is not a pointer, it is a second name for the same inode, and it
 * carries none of the marks a symlink does: `lstat` reports a plain regular file,
 * containment resolves to a path inside the tree because that *is* where the name
 * lives, and the bytes come back as the file's own. On Linux
 * `fs.protected_hardlinks` stops an unprivileged user linking to a file it cannot
 * read; macOS has no equivalent, so on a macOS system install a mind can put a
 * second name for a root-only inode straight into `home/pages`, and every check
 * built for symlinks waves it through.
 *
 * The test is `nlink`, and it applies to **regular files only**: every directory
 * has at least two links — its own entry and its `.` — so testing directories
 * would refuse the whole tree.
 *
 * It does refuse a page a mind hardlinked on purpose. That is vanishingly rare,
 * and every refusal names the entry and the reason, so nothing vanishes silently.
 */
export function isMultiplyLinkedFile(st: { isFile(): boolean; nlink: number }): boolean {
  return st.isFile() && st.nlink > 1;
}

/**
 * Refusal of a page that has more than one name on disk, distinguished from a
 * containment refusal so a caller can say something true about it.
 *
 * The generic wording elsewhere exists to avoid answering the question a symlink
 * was pointed at something to ask — telling a mind where its link landed is the
 * one thing the refusal is preventing. A hard link is different: saying "this
 * page has a second name" reports only what the mind did itself, and reveals
 * nothing about the inode. So this one gets said plainly, and "must stay within
 * pages/" is not said about a file that is plainly within pages/.
 */
export class MultiplyLinkedPageError extends Error {}

/** Path containment, on real paths only — `startsWith` on unresolved paths proves nothing. */
export function within(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}

/**
 * The mind's `home/pages`, resolved through every symlink and proven to still be
 * inside the mind's own directory. The mind owns `home/`, so `pages` itself could
 * be a link to somewhere else entirely; every containment check below is measured
 * against this, not against the unresolved string.
 */
export function resolvePagesDir(mindDir: string): string {
  const realMindDir = realpathSync(mindDir);
  const realPages = realpathSync(resolve(mindDir, "home", "pages"));
  if (!within(realMindDir, realPages)) {
    throw new Error(`Refusing: home/pages resolves outside ${mindDir}`);
  }
  return realPages;
}

/**
 * Where a write to `target` will *actually* land, proven to be inside the mind's own
 * pages directory. Returns the resolved path to write and chown; throws otherwise.
 *
 * The string-prefix check this replaces was not a containment check. `resolve()`
 * does not consult the filesystem, so `home/pages/notes/x.md` passes it whether
 * `notes` is a directory or a symlink to `/etc` — and the mind owns that directory
 * and can make it either. Both links in the chain are checked, because the mind owns
 * `home/` too and could point `pages` itself somewhere else.
 *
 * This closes the durable hole; it is not a defence against a symlink swapped in
 * during the microseconds between this call and the write. Callers pair it with an
 * exclusive create (`wx`), which cannot follow a final symlink, and the chown uses
 * `-h` so it can never dereference one either. A parent-directory swap mid-write
 * remains theoretically live and would need `O_NOFOLLOW` opens to close completely.
 */
export function resolvePagesWrite(mindDir: string, target: string): string {
  const realPages = resolvePagesDir(mindDir);
  // The file itself need not exist yet, but the directory it lands in must.
  const realTarget = resolve(realpathSync(dirname(target)), basename(target));
  if (!within(realPages, realTarget)) {
    throw new Error(
      `Refusing to write outside the pages directory: ${target} resolves to ${realTarget}`,
    );
  }
  return realTarget;
}

/**
 * The read-side sibling of `resolvePagesWrite`: where a *read* of `target` will
 * actually land, proven to be inside the mind's own pages directory.
 *
 * The difference is the final component. `resolvePagesWrite` resolves only the
 * parent directory and leans on an exclusive create (`wx`) to refuse a file that is
 * already there — a symlink included. A read has no such protection: opening
 * `home/pages/x.md` follows the link wherever it goes. So this resolves the whole
 * path, the last hop included, and the file must therefore already exist.
 *
 * It matters because the daemon reads as the daemon. On a user-isolation install
 * that is root, and anything root can read the mind can then be shown — so a page
 * that is really a link to a file outside `home/pages` has to be refused here
 * rather than opened.
 */
export function resolvePagesRead(mindDir: string, target: string): string {
  const realPages = resolvePagesDir(mindDir);
  const realTarget = realpathSync(target);
  if (!within(realPages, realTarget)) {
    throw new Error(
      `Refusing to read outside the pages directory: ${target} resolves to ${realTarget}`,
    );
  }
  // Containment cannot see a hard link, because a hard link has nothing to see:
  // it is a second *name* for an inode, so the name really is inside `home/pages`
  // and the check above is right to say so. The count of names is the only thing
  // that gives it away. This belongs in the resolver rather than only at the
  // servers, because the markdown preview reads the resolved path *directly* —
  // it renders the `.md` itself and never fetches it over the preview origin —
  // so a check that lived only in the servers would miss that read entirely.
  if (isMultiplyLinkedFile(statSync(realTarget))) {
    throw new MultiplyLinkedPageError(
      `Refusing to read a page with more than one name on disk: ${target}`,
    );
  }
  return realTarget;
}

/**
 * A daemon-created directory directly under the mind's `home/`, proven to be
 * exactly where it claims to be. Returns the real path to write into.
 *
 * For the scratch directories that are not pages — `home/.preview`, where the
 * renderer drops its PNGs. `mkdirSync({ recursive: true })` on a path the mind has
 * replaced with a symlink to a directory succeeds silently and `resolve()` never
 * notices, so without this the daemon would write (and then hand the mind) a file
 * at a location of the mind's choosing.
 *
 * The test is equality, not containment, and that distinction is the whole point:
 * "somewhere inside the mind's directory" is not a useful guarantee when the mind
 * owns all of it. `home/.preview` → `home/pages` stays inside and would quietly
 * deposit the render into the mind's published pages; the same trick aims the write
 * at `.mind/sessions` or `home/.local/hooks`. So the resolved path must sit at its
 * literal position under the real `home/` — which means it is not a link at all.
 */
export function resolveHomeScratchDir(mindDir: string, name: string): string {
  const realMindDir = realpathSync(mindDir);
  const realHome = realpathSync(resolve(mindDir, "home"));
  if (!within(realMindDir, realHome)) {
    throw new Error(`Refusing: home resolves outside ${mindDir}`);
  }
  const expected = resolve(realHome, name);
  const real = realpathSync(expected);
  if (real !== expected) {
    throw new Error(`Refusing: home/${name} resolves to ${real}, not to where it sits`);
  }
  return real;
}

/**
 * Give `paths` to the mind's OS user. A no-op when isolation is off — there is no
 * separate user to give them to, and the daemon already runs as the host user.
 *
 * Pass **real** paths (see `resolvePagesWrite`). `-h` makes `chown` act on a symlink
 * rather than through it, so even a path that slipped past containment cannot be
 * used to hand away whatever it points at. (No `--` terminator: BSD `chown` treats
 * it as a filename. Every caller passes absolute paths, so none can read as a flag.)
 *
 * Never throws. A failed chown must not undo a write that already succeeded: the
 * page exists and is worth publishing even if its ownership is wrong. The reason
 * comes back as a string instead, so the caller can tell the *mind* — a warning
 * only the host's journal sees is a warning the author never reads.
 */
export async function chownToMind(
  ownership: MindOwnership,
  mindName: string,
  paths: string[],
  exec: ChownExec = defaultExec,
): Promise<string | null> {
  if (paths.length === 0 || !ownership.isIsolationEnabled()) return null;
  try {
    // Inside the try: `getMindUser` throws on a name that fails isolation's own
    // validation, and a throw here would escape *after* the page was written and
    // *before* it was published — the one outcome this function promises not to
    // produce.
    const user = ownership.getMindUser(mindName);
    await exec("chown", ["-h", `${user}:volute`, ...paths]);
    return null;
  } catch (err) {
    const msg = `could not give ${mindName} ownership of ${paths.join(", ")}: ${(err as Error).message}`;
    console.warn(`[pages] ${msg}`);
    return msg;
  }
}
