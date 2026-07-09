import { readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** Prefix every per-run test home dir shares (see test/setup.ts). */
export const TEST_HOME_PREFIX = "volute-test-";

/**
 * Remove leaked `volute-test-*` dirs left behind by prior runs that never ran their
 * exit cleanup (a SIGKILL, an OOM, a crash). Only dirs older than `maxAgeMs` are
 * swept so a concurrently-running sibling test process — whose freshly-created dir
 * is younger than the threshold — is never touched.
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
