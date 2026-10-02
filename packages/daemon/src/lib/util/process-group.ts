import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import log from "./logger.js";

/**
 * Stopping a detached process group — a mind's server, a timed mind script — when
 * the group may be led by an isolation supervisor.
 *
 * Under Linux user isolation the leader is `runuser`, which answers a SIGTERM of
 * its own by forwarding it, sleeping 2s and SIGKILLing its child. A group SIGTERM
 * reaches it, so every mind got 2s to shut down whatever grace the caller allowed
 * (#1364). With `spareLeader` the SIGTERM goes to every other member of the group
 * instead, found by scanning `/proc/<pid>/stat` for the group id — which also
 * finds a member that was reparented away from the leader (a `nohup … &` worker);
 * runuser then just exits when its child does.
 */

const plog = log.child("process-group");

export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;
export const defaultKill: Kill = (pid, signal) => process.kill(pid, signal);

/** A process, and its start time (clock ticks since boot) to tell it from a reused pid. */
export type Member = { pid: number; start: string };

export type GroupOpts = { procDir?: string; kill?: Kill };

/** How many `/proc/<pid>/stat` reads a scan has in flight at once. */
const SCAN_CONCURRENCY = 64;

/** The process is gone: its /proc entry, or the process itself. */
export function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/** A process's parent, group and start time from `/proc/<pid>/stat`; null once it has exited. */
export async function readStat(
  procDir: string,
  pid: number,
): Promise<{ ppid: number; pgrp: number; start: string } | null> {
  let stat: string;
  try {
    stat = await readFile(`${procDir}/${pid}/stat`, "utf-8");
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
  // `pid (comm) state ppid pgrp … starttime …` — comm may hold spaces and parens,
  // so the fields are counted from the last ')': ppid is field 4, pgrp 5, starttime 22.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), pgrp: Number(fields[2]), start: fields[19] };
}

/**
 * The members of process group `pgid`, other than `exclude`, from a scan of every
 * `/proc/<pid>/stat`. Linux only: throws when `/proc` can't be read.
 */
export async function groupMembers(
  pgid: number,
  opts: { procDir?: string; exclude?: number } = {},
): Promise<Member[]> {
  const procDir = opts.procDir ?? "/proc";
  const pids = (await readdir(procDir))
    .filter((e) => /^\d+$/.test(e))
    .map(Number)
    .filter((pid) => pid !== opts.exclude);
  const members: Member[] = [];
  for (let i = 0; i < pids.length; i += SCAN_CONCURRENCY) {
    const batch = pids.slice(i, i + SCAN_CONCURRENCY);
    const stats = await Promise.all(batch.map((pid) => readStat(procDir, pid)));
    batch.forEach((pid, j) => {
      const stat = stats[j];
      if (stat?.pgrp === pgid) members.push({ pid, start: stat.start });
    });
  }
  return members;
}

/** The direct children of `pid`, across its threads; [] once it has exited. Linux only. */
export async function childrenOf(pid: number, procDir = "/proc"): Promise<Member[]> {
  let tids: string[];
  try {
    tids = await readdir(`${procDir}/${pid}/task`);
  } catch (err) {
    if (isGone(err)) return [];
    throw err;
  }
  const lists = await Promise.all(
    tids.map(async (tid) => {
      try {
        return await readFile(`${procDir}/${pid}/task/${tid}/children`, "utf-8");
      } catch (err) {
        if (isGone(err)) return "";
        throw err;
      }
    }),
  );
  const pids = lists.flatMap((l) => l.split(" ").filter(Boolean).map(Number));
  const stats = await Promise.all(pids.map((p) => readStat(procDir, p)));
  return pids.flatMap((p, i) => {
    const stat = stats[i];
    return stat ? [{ pid: p, start: stat.start }] : [];
  });
}

/** Whether the process `pid` is `runuser` — the supervisor a stop must signal past. */
export async function isRunuser(pid: number, procDir = "/proc"): Promise<boolean> {
  try {
    return (await readFile(`${procDir}/${pid}/comm`, "utf-8")).trim() === "runuser";
  } catch {
    return false;
  }
}

/**
 * Signal each process that is still itself (same start time, and same group when
 * `pgid` is given). ESRCH is fine; anything else is logged.
 */
export async function signalEach(
  members: Member[],
  signal: NodeJS.Signals,
  opts: GroupOpts & { pgid?: number } = {},
): Promise<void> {
  const kill = opts.kill ?? defaultKill;
  const procDir = opts.procDir ?? "/proc";
  for (const member of members) {
    try {
      const now = await readStat(procDir, member.pid);
      if (!now || now.start !== member.start) continue;
      if (opts.pgid !== undefined && now.pgrp !== opts.pgid) continue;
      kill(member.pid, signal);
    } catch (err) {
      if (!isGone(err)) plog.warn(`${signal} to pid ${member.pid} failed`, log.errorData(err));
    }
  }
}

/** `kill(-pgid, signal)`; false when the group is gone, logged on any other failure. */
function signalGroup(pgid: number, signal: NodeJS.Signals, kill: Kill): boolean {
  try {
    kill(-pgid, signal);
    return true;
  } catch (err) {
    if (!isGone(err)) plog.warn(`${signal} to process group ${pgid} failed`, log.errorData(err));
    return !isGone(err);
  }
}

/**
 * SIGTERM a process group for a graceful stop; resolves `"gone"` when there was
 * nothing left to signal. Never throws: a failure is logged, and the caller's
 * SIGKILL deadline is the backstop for it.
 *
 * With `spareLeader`, every member but the leader is signalled individually. A
 * group signal is used when `/proc` can't be scanned (logged), or when only the
 * leader is left. `leaderExited` says the leader has been reaped, so its id no
 * longer pins the group: then a group signal is sent only while the scan still
 * finds a member holding it, and nothing at all when it finds none.
 */
export async function terminateGroup(
  pgid: number,
  opts: GroupOpts & { spareLeader: boolean; leaderExited?: boolean },
): Promise<"signalled" | "gone"> {
  const kill = opts.kill ?? defaultKill;
  const procDir = opts.procDir ?? "/proc";
  if (opts.spareLeader || opts.leaderExited) {
    let members: Member[] | null = null;
    try {
      members = await groupMembers(pgid, {
        procDir,
        exclude: opts.spareLeader ? pgid : undefined,
      });
    } catch (err) {
      if (opts.spareLeader) {
        plog.warn(`could not scan process group ${pgid}; signalling the whole group`, {
          procDir,
          ...log.errorData(err),
        });
      }
    }
    if (members?.length && opts.spareLeader) {
      await signalEach(members, "SIGTERM", { procDir, kill, pgid });
      return "signalled";
    }
    if (members && !members.length && opts.leaderExited) return "gone";
  }
  return signalGroup(pgid, "SIGTERM", kill) ? "signalled" : "gone";
}

/**
 * SIGKILL what is left of a group at its deadline: the whole group, while a scan
 * finds any member still holding its id (which is what makes the group signal
 * safe), and nothing when it finds none. Without `/proc`, only while the leader —
 * unreaped, so still pinning the id — is known to be alive.
 */
export async function killRemainder(
  pgid: number,
  opts: GroupOpts & { leaderAlive: boolean },
): Promise<void> {
  const kill = opts.kill ?? defaultKill;
  let anyLeft = opts.leaderAlive;
  try {
    anyLeft = (await groupMembers(pgid, { procDir: opts.procDir })).length > 0;
  } catch {
    // No /proc: go by the leader.
  }
  if (anyLeft) signalGroup(pgid, "SIGKILL", kill);
}

/**
 * Stop a process group: SIGTERM it ({@link terminateGroup}), wait up to `graceMs`
 * for its leader to exit, and SIGKILL what is left at the deadline
 * ({@link killRemainder}). Resolves when the leader has exited or the deadline has
 * passed; after a clean exit the deadline's check still runs in the background,
 * for a process (an SDK subprocess still flushing, a straggler) that outlives
 * its leader.
 *
 * `leader` is the spawned child, or — for a group this daemon didn't spawn, such
 * as a previous daemon's orphan — its pid, whose exit is then polled for.
 */
export async function stopGroup(
  leader: ChildProcess | number,
  opts: GroupOpts & { spareLeader: boolean; graceMs: number },
): Promise<void> {
  const pgid = typeof leader === "number" ? leader : leader.pid;
  if (!pgid) return;
  const kill = opts.kill ?? defaultKill;
  const watch = await leaderExitWatch(leader, opts.procDir ?? "/proc", kill);
  const result = await terminateGroup(pgid, { ...opts, leaderExited: watch.done() });
  if (result === "gone") return watch.cancel();
  // The grace starts once the SIGTERM is out, not before the scan that sends it.
  const deadlineAt = Date.now() + opts.graceMs;
  let deadline: NodeJS.Timeout | undefined;
  await Promise.race([
    watch.exited,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, opts.graceMs);
    }),
  ]);
  clearTimeout(deadline);
  watch.cancel();
  if (!watch.done()) {
    await killRemainder(pgid, { ...opts, leaderAlive: true });
    return;
  }
  const late = setTimeout(
    () => void killRemainder(pgid, { ...opts, leaderAlive: false }),
    Math.max(0, deadlineAt - Date.now()),
  );
  late.unref();
}

/** Resolves when the leader exits: the child's `exit`, or a poll for a bare pid. */
async function leaderExitWatch(
  leader: ChildProcess | number,
  procDir: string,
  kill: Kill,
): Promise<{ exited: Promise<void>; done: () => boolean; cancel: () => void }> {
  let done = false;
  if (typeof leader !== "number") {
    if (leader.exitCode !== null || leader.signalCode !== null) done = true;
    const exited = done
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          leader.once("exit", () => {
            done = true;
            resolve();
          }),
        );
    return { exited, done: () => done, cancel: () => {} };
  }
  // Not our child, so its pid is not pinned: watch for the same process by start
  // time where /proc has it, and by `kill(pid, 0)` where it doesn't.
  let start: string | null = null;
  try {
    start = (await readStat(procDir, leader))?.start ?? null;
  } catch {}
  const alive = async () => {
    if (start !== null) {
      try {
        return (await readStat(procDir, leader))?.start === start;
      } catch {}
    }
    try {
      kill(leader, 0);
      return true;
    } catch {
      return false;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const exited = new Promise<void>((resolve) => {
    const poll = async () => {
      if (!(await alive())) {
        done = true;
        resolve();
        return;
      }
      timer = setTimeout(poll, 100);
    };
    void poll();
  });
  return { exited, done: () => done, cancel: () => clearTimeout(timer) };
}
