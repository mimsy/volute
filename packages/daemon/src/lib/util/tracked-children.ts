import type { ChildProcess } from "node:child_process";
import { childrenOf, type Member, signalEach, stopGroup } from "./process-group.js";

/**
 * The daemon's in-flight child processes that act on a mind — its scheduled
 * scripts and hooks, git, npm, chown — so a daemon shutdown can stop them with a
 * grace rather than leave them to the service manager. Under the system unit's
 * `KillMode=mixed` only the daemon gets the stop's SIGTERM, and whatever it leaves
 * behind is SIGKILLed the moment it exits: a script mid-write, a commit mid-index.
 *
 * A leaf module (it imports nothing that reaches the registry or the DB), so the
 * pages extension and `chown-tree` can register their children too.
 */

type How = {
  /** The child leads its own process group (spawned `detached`). */
  group: boolean;
  /** The child is `runuser`, which SIGKILLs its own child 2s after it is SIGTERMed (#1364). */
  supervised: boolean;
};

const inFlight = new Map<ChildProcess, How>();

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Register a child until it exits. */
export function trackChild(child: ChildProcess, how: How): void {
  if (exited(child)) return;
  inFlight.set(child, how);
  child.once("exit", () => inFlight.delete(child));
  child.once("error", () => inFlight.delete(child));
}

/**
 * Stop every tracked child: SIGTERM, up to `graceMs` for it to exit, then SIGKILL.
 * Keeps picking up children registered while it runs — a mind's own stop can
 * start a git command — until none are left and `alongside` (the rest of the
 * shutdown) has settled, or the grace is spent.
 */
export async function stopTrackedChildren(
  graceMs: number,
  alongside: Promise<unknown> = Promise.resolve(),
): Promise<void> {
  const deadlineAt = Date.now() + graceMs;
  const stopping = new Map<ChildProcess, Promise<void>>();
  const active = new Set<Promise<void>>();
  let settled = false;
  void alongside.finally(() => {
    settled = true;
  });
  while ((inFlight.size || !settled) && Date.now() < deadlineAt) {
    for (const [child, how] of inFlight) {
      if (stopping.has(child)) continue;
      const stop = stopOne(child, how, deadlineAt - Date.now()).finally(() => active.delete(stop));
      stopping.set(child, stop);
      active.add(stop);
    }
    // Wake on the next exit or after a beat — never spin on settled promises.
    await Promise.race([...active, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  await Promise.all(stopping.values());
}

async function stopOne(child: ChildProcess, how: How, graceMs: number): Promise<void> {
  if (exited(child)) return;
  if (how.group) return stopGroup(child, { spareLeader: how.supervised, graceMs });
  // In the daemon's own group, so signalled alone — past runuser to the command
  // it supervises, which then gets the whole grace instead of runuser's 2s.
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let below: Member[] = [];
  if (how.supervised && child.pid) {
    try {
      below = await childrenOf(child.pid);
    } catch {
      // No /proc: runuser relays the SIGTERM, with its own 2s.
    }
  }
  if (below.length) await signalEach(below, "SIGTERM");
  else child.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([done, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
  clearTimeout(timer);
  if (exited(child)) return;
  if (below.length) await signalEach(below, "SIGKILL");
  child.kill("SIGKILL");
}
