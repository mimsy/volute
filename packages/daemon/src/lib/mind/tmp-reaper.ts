import { lstat, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import log from "../util/logger.js";

const rlog = log.child("minds");

/**
 * How old an entry in a mind's tmp dir must be before the reaper collects it.
 *
 * The reap runs at spawn, so the mind's *server* is not running and this is not
 * protecting the mind from itself. What it protects is a process that shares the
 * dir without being the server: a scheduled mind script gets the same TMPDIR
 * (`mind-script.ts`), is not held by the mind's start lock, and the scheduler
 * passes it no timeout — so a script genuinely can outlive a restart. Two hours
 * plus the freshness check below is what stands between the two.
 */
export const STALE_MIND_TMP_MS = 2 * 60 * 60 * 1000;

/**
 * True when this entry, or anything directly inside it, was touched inside the
 * window — in which case something is plausibly still using it.
 *
 * A directory's own mtime moves only when entries are added or removed *in* it,
 * not when a file inside is written. So a script that creates `work/` and then
 * appends to `work/log` for three hours leaves `work/` looking three hours idle.
 * One level down catches that; a full recursive walk would be the complete
 * answer but is not worth doing over gigabytes on an SD card at every start.
 */
async function recentlyTouched(path: string, cutoff: number): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    return true; // Can't tell — leave it alone.
  }
  if (stats.mtimeMs >= cutoff) return true;
  if (!stats.isDirectory()) return false;
  let children: string[];
  try {
    children = await readdir(path);
  } catch {
    return true;
  }
  for (const child of children) {
    try {
      if ((await lstat(resolve(path, child))).mtimeMs >= cutoff) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Collect stale entries from a mind's private tmp dir.
 *
 * Minds get `TMPDIR=<mindDir>/.mind/tmp` so they never share a writable /tmp.
 * That trade left them without the one thing a real /tmp comes with — something
 * that eventually clears it — so anything a killed process leaves there stays
 * forever. On bardo that was 4.7G of scratch from three force-killed test runs,
 * on a Pi hosting live minds (#805). Volute handed minds a private /tmp; this is
 * its janitor.
 *
 * Called at mind spawn, the one moment the daemon knows the mind's server is not
 * running. Deliberately *not* run against a live mind: an age threshold can't
 * tell a week-old abandoned dir from the `tsx-<uid>/` dir holding the socket a
 * mind server started eight days ago is still using.
 *
 * Async throughout, not the sync fs calls the surrounding spawn code uses:
 * clearing gigabytes off an SD card takes seconds, and doing it synchronously
 * would stall the daemon — every other mind's delivery and the web server with
 * it — for the duration. One mind waiting on its own start is the right cost.
 *
 * ## Why it refuses a tmp dir that isn't a real directory
 *
 * This is the daemon deleting recursively — as root on a system install — inside
 * a tree the mind owns and can restructure (`.mind` is chowned to the mind, and
 * the whole mind dir is in the sandbox's allowWrite set). A mind that replaces
 * `.mind/tmp` with a symlink to `/minds` would otherwise have the daemon walk
 * through it and delete every other mind's directory on its behalf. So `tmpDir`
 * itself is `lstat`ed and anything but a real directory is refused, and every
 * entry is judged by `lstat` and removed as it lies — a symlink is unlinked as a
 * link, never followed. Refusing rather than repairing is deliberate: a host may
 * have pointed a mind's tmp at a tmpfs on purpose, and Volute should decline to
 * reap what it cannot vouch for rather than delete a host's arrangement.
 *
 * Best-effort — it never throws, because nothing here is worth failing a mind
 * start over. Returns the paths actually removed, for tests.
 */
export async function reapMindTmp(
  tmpDir: string,
  maxAgeMs: number = STALE_MIND_TMP_MS,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = now - maxAgeMs;

  try {
    if (!(await lstat(tmpDir)).isDirectory()) {
      rlog.warn(
        `not reaping ${tmpDir}: it is not a real directory. A mind's tmp dir that is a ` +
          `symlink would make this a recursive delete aimed wherever it points, so it is ` +
          `left alone — scratch there will accumulate until the link is removed.`,
      );
      return removed;
    }
  } catch {
    return removed; // Missing, or unreadable — nothing to do.
  }

  let entries: string[];
  try {
    entries = await readdir(tmpDir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const full = resolve(tmpDir, name);
    try {
      if (await recentlyTouched(full, cutoff)) continue;
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // Raced a deletion, or the mind's own process recreated it — ignore.
    }
  }
  if (removed.length > 0) {
    rlog.info(
      `reaped ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"} from ${tmpDir}`,
    );
  }
  return removed;
}
