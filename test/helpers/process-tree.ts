/**
 * Teardown helpers for the e2e tests that spawn real daemons under a scratch
 * VOLUTE_HOME (#1047).
 *
 * The hazard both helpers exist for: a spawned daemon is never the only process
 * writing under the scratch dir. `npx tsx daemon.ts` hands off to a grandchild,
 * and the daemon in turn spawns minds, npm installs and sqlite WAL writers.
 * Signalling only the pid we spawned leaves that tree alive, and a straggler
 * that writes one more file while `rmSync` walks the directory fails the whole
 * run with `ENOTEMPTY` — after every assertion has already passed.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * SIGTERM a spawned process *group*, then SIGKILL it if it outstays `timeoutMs`.
 *
 * Requires the process to have been spawned `detached: true`, which makes it the
 * leader of a new group its children inherit — `process.kill(-pid, sig)` then
 * reaches the whole tree. Signalling `proc.pid` alone reaches only the wrapper:
 * with `npx tsx daemon.ts` that is `npx`, and the node process actually holding
 * the port and running the shutdown handler never sees the signal.
 *
 * Never group-signals after the leader has exited: the pgid is the leader's pid,
 * and the OS is free to recycle it (mind-manager disarms its own force-kill for
 * the same reason). A member that ignored the group SIGTERM is left to
 * `sweepScratch()` to report rather than chased with a possibly-recycled pgid.
 */
export async function killTree(proc: ChildProcess, timeoutMs = 15000): Promise<void> {
  const pid = proc.pid;
  if (pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // No group (not detached) or already gone — fall back to the leader alone.
      try {
        proc.kill(sig);
      } catch {}
    }
  };

  const exited = new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
  signalGroup("SIGTERM");
  if (await raceTimeout(exited, timeoutMs)) return;

  signalGroup("SIGKILL");
  await raceTimeout(exited, 5000);
}

/**
 * SIGKILL a pid, and its whole process group when it leads one.
 *
 * For reaping a process we did not spawn — a mind server orphaned by a daemon
 * that died before it could stop it. Its listening socket is what we can find,
 * but its `tsx`/agent children are what keep writing, so killing the listener
 * alone leaves the writers running (#1047).
 *
 * The group is only signalled when the pid *is* the group leader. A pid that
 * merely belongs to someone else's group would make `kill(-pid)` land on an
 * unrelated group — including, potentially, the test runner's own.
 */
export function killPidTree(pid: number): void {
  if (processGroupOf(pid) === pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

/** The pid's process-group id, or null if it can't be read (e.g. already gone). */
function processGroupOf(pid: number): number | null {
  try {
    const pgid = Number.parseInt(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf-8" }).trim(),
      10,
    );
    return Number.isNaN(pgid) ? null : pgid;
  } catch {
    return null;
  }
}

/** Resolves true if `p` settled first, false if the timeout won. */
function raceTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolveRace) => {
    const timer = setTimeout(() => resolveRace(false), ms);
    p.then(() => {
      clearTimeout(timer);
      resolveRace(true);
    });
  });
}

/**
 * Remove a scratch dir, retrying, and never throw.
 *
 * `maxRetries`/`retryDelay` make Node re-attempt ENOTEMPTY/EBUSY/EPERM, which
 * covers a straggler that dies a beat after teardown signalled it. If the sweep
 * still fails, the run's assertions have already passed — failing CI on cleanup
 * would report a green test as red — so this logs what survived (paths, and any
 * process whose command line mentions the dir) and returns.
 */
export function sweepScratch(dir: string, maxRetries = 10, retryDelay = 200): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay });
    return;
  } catch (err) {
    console.warn(`[sweep] could not remove ${dir}: ${(err as Error).message}`);
  }
  for (const path of survivingPaths(dir)) console.warn(`[sweep] survivor: ${path}`);
  for (const line of processesMentioning(dir)) console.warn(`[sweep] process: ${line}`);
}

/** Paths still present under `dir`, walked to `maxDepth` so the log stays readable. */
function survivingPaths(dir: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (err) {
      out.push(`${current} (unreadable: ${(err as Error).message})`);
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {}
      if (isDir && depth < maxDepth) walk(path, depth + 1);
      else out.push(path);
    }
  };
  walk(dir, 1);
  return out;
}

/** Live processes whose command line mentions `dir` — the likely writers. */
function processesMentioning(dir: string): string[] {
  try {
    return execFileSync("ps", ["-ww", "-eo", "pid,command"], { encoding: "utf-8" })
      .split("\n")
      .filter((line) => line.includes(dir))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}
