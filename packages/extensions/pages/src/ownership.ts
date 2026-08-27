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
import { realpathSync } from "node:fs";
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

/** Path containment, on real paths only — `startsWith` on unresolved paths proves nothing. */
function within(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
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
  const realMindDir = realpathSync(mindDir);
  const realPagesDir = realpathSync(resolve(mindDir, "home", "pages"));
  if (!within(realMindDir, realPagesDir)) {
    throw new Error(`Refusing to write: home/pages resolves outside ${mindDir}`);
  }
  // The file itself need not exist yet, but the directory it lands in must.
  const realTarget = resolve(realpathSync(dirname(target)), basename(target));
  if (!within(realPagesDir, realTarget)) {
    throw new Error(
      `Refusing to write outside the pages directory: ${target} resolves to ${realTarget}`,
    );
  }
  return realTarget;
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
