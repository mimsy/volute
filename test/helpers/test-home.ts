import { readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Prefix every per-run test home dir shares (see test/setup.ts). */
export const TEST_HOME_PREFIX = "volute-test-";

/**
 * How old a test home must be before either sweep — at startup or on exit —
 * collects it. Well past any real run, so a sibling test process running
 * concurrently right now, whose dir is minutes old, is never touched. Both
 * sweeps share this value deliberately: the exit sweep must not be able to
 * remove anything the startup sweep would have spared.
 */
export const STALE_TEST_HOME_MS = 2 * 60 * 60 * 1000;

/**
 * True when a process with this pid is still around, so its home must be spared.
 *
 * The dir name carries the pid that owns it, which makes liveness a fact we can
 * check rather than infer from age. Age alone is only a proxy, and a poor one at
 * the tail: `npm test` can hang under load, and a run still going after two hours
 * is exactly the live sibling the threshold is supposed to protect. `kill(pid, 0)`
 * sends no signal — it only asks. EPERM means the process exists but belongs to
 * someone else, which is still alive, so anything other than ESRCH counts as
 * running. A recycled pid can only make us spare a dead home, never remove a live
 * one; that is the direction to err in.
 */
function pidIsRunning(name: string): boolean {
  const suffix = name.slice(TEST_HOME_PREFIX.length);
  if (!/^\d+$/.test(suffix)) return false;
  try {
    process.kill(Number(suffix), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove leaked `volute-test-*` dirs left behind by prior runs that never ran their
 * exit cleanup (a SIGKILL, an OOM, a crash). A dir is removed only when its owning
 * process is gone *and* it is older than `maxAgeMs`, so a concurrently-running
 * sibling test process is never touched — not when its dir is fresh, and not when
 * its run has outlasted the threshold.
 *
 * Best-effort: races (another process removing the same dir) and stat failures are
 * swallowed. Returns the dirs actually removed, for tests.
 */
export function sweepStaleTestHomes(
  root: string,
  maxAgeMs: number,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.startsWith(TEST_HOME_PREFIX)) continue;
    if (pidIsRunning(name)) continue;
    const full = resolve(root, name);
    try {
      if (now - statSync(full).mtimeMs < maxAgeMs) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // Another process may have removed it, or stat raced a deletion — ignore.
    }
  }
  return removed;
}
