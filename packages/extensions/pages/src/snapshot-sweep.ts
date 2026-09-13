/**
 * Removing symlinks left behind in already-published site snapshots.
 *
 * Publishing used to copy `home/pages` with `cpSync(..., { recursive: true })`,
 * whose `dereference` defaults to false — so a symlink the mind put in its pages
 * directory was copied into `dataDir/sites/<mind>/` *as a symlink*, and the
 * unauthenticated public route then read through it as the daemon. Publish and
 * serve are both fixed now, but a snapshot written before the fix still holds
 * whatever links it was given, and it is live the moment the daemon starts.
 *
 * So this runs once per daemon start over `dataDir/sites/`, and it is the only
 * half of the fix that reaches backwards. It is deliberately narrow: it removes
 * symlinks and nothing else, never follows one, and leaves every real file alone.
 *
 * `dataDir/repo` — the commons checkout — is *not* swept. Git owns that tree and
 * would restore anything removed here on its next checkout, so a sweep there
 * would be a no-op that looked like a guarantee. The commons is covered instead at
 * the point of reading: the public serve route refuses a link, and so does
 * `readPageBody`, the command path a mind reads a published page through.
 */
import { type Dirent, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Delete every symlink under `dataDir/sites/`, returning the paths removed.
 *
 * Bounded and idempotent: a symlinked directory is unlinked rather than descended
 * into, so the walk only ever visits real directories inside the snapshot tree,
 * and a second run over a swept tree finds nothing. Errors on individual entries
 * are reported and skipped — one unreadable snapshot must not stop the others
 * from being cleaned.
 */
export function sweepSnapshotSymlinks(dataDir: string): string[] {
  const removed: string[] = [];
  walk(resolve(dataDir, "sites"), removed);
  return removed;
}

function walk(dir: string, removed: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing `sites/` is the normal state of a fresh install, not a problem.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[pages] snapshot sweep could not read ${dir}: ${(err as Error).message}`);
    }
    return;
  }

  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    try {
      // `readdirSync`'s Dirent already answers this without a second syscall, and
      // it answers it about the entry itself — `isDirectory()` on a Dirent is
      // false for a symlink to a directory, which is exactly the distinction that
      // keeps the walk from stepping outside the tree.
      if (entry.isSymbolicLink()) {
        unlinkSync(full);
        removed.push(full);
        console.warn(`[pages] removed symlink from published snapshot: ${full}`);
      } else if (entry.isDirectory()) {
        walk(full, removed);
      }
    } catch (err) {
      console.warn(`[pages] snapshot sweep could not handle ${full}: ${(err as Error).message}`);
    }
  }
}
