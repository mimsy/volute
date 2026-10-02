import type { ChildProcess } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import log from "./logger.js";

/**
 * Stopping a detached process group — a mind's server, a timed mind script — when
 * the group may be led by an isolation supervisor.
 *
 * Under Linux user isolation the leader is `runuser`, which answers a SIGTERM of
 * its own by forwarding it, sleeping 2s and SIGKILLing its child. A group SIGTERM
 * reaches it, so every mind got 2s to shut down whatever grace the caller allowed
 * (#1364). With `spareLeader` the SIGTERM goes to the leader's descendants in the
 * group instead, found by walking `/proc/<pid>/task/<tid>/children`; runuser then
 * just exits when its child does.
 */

const plog = log.child("process-group");

type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;
const defaultKill: Kill = (pid, signal) => process.kill(pid, signal);

/** A process, and its start time (clock ticks since boot) to tell it from a reused pid. */
export type Member = { pid: number; start: string };

export type GroupOpts = { procDir?: string; kill?: Kill };

/** The process is gone: its /proc entry, or the process itself. */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/** A process's group and start time from `/proc/<pid>/stat`; null once it has exited. */
async function readStat(
  procDir: string,
  pid: number,
): Promise<{ pgrp: number; start: string } | null> {
  let stat: string;
  try {
    stat = await readFile(`${procDir}/${pid}/stat`, "utf-8");
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
  // `pid (comm) state ppid pgrp … starttime …` — comm may hold spaces and parens,
  // so the fields are counted from the last ')': pgrp is field 5, starttime 22.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pgrp: Number(fields[2]), start: fields[19] };
}

/** Whether `member` is still the process it was, in group `pgid`. */
async function stillMember(procDir: string, pgid: number, member: Member): Promise<boolean> {
  const now = await readStat(procDir, member.pid);
  return now?.pgrp === pgid && now.start === member.start;
}

/** The direct children of `pid`, across its threads; [] once it has exited. */
async function childrenOf(procDir: string, pid: number): Promise<number[]> {
  let tids: string[];
  try {
    tids = await readdir(`${procDir}/${pid}/task`);
  } catch (err) {
    if (isGone(err)) return [];
    throw err;
  }
  const lists = await Promise.all(
    tids.map(async (tid) => {
      const task = `${procDir}/${pid}/task/${tid}`;
      try {
        return await readFile(`${task}/children`, "utf-8");
      } catch (err) {
        if (!isGone(err)) throw err;
        // A thread that exited, or a kernel without CONFIG_PROC_CHILDREN — which
        // would read as "no children" and quietly signal nothing. Tell them apart.
        try {
          await access(`${task}/stat`);
        } catch {
          return "";
        }
        throw new Error(`${task}/children is missing (kernel without CONFIG_PROC_CHILDREN?)`);
      }
    }),
  );
  return lists.flatMap((l) => l.split(" ").filter(Boolean).map(Number));
}

/**
 * The processes in group `pgid` among `roots` and all their descendants, other
 * than `exclude`. Linux only: throws when `/proc` can't be walked.
 */
export async function groupDescendants(
  pgid: number,
  roots: number[],
  opts: { procDir?: string; exclude?: number } = {},
): Promise<Member[]> {
  const procDir = opts.procDir ?? "/proc";
  await access(procDir); // no /proc at all is a failure, not an empty group
  const seen = new Set<number>();
  const members: Member[] = [];
  let frontier = roots;
  while (frontier.length) {
    frontier = frontier.filter((pid) => !seen.has(pid));
    for (const pid of frontier) seen.add(pid);
    const [stats, children] = await Promise.all([
      Promise.all(frontier.map((pid) => readStat(procDir, pid))),
      Promise.all(frontier.map((pid) => childrenOf(procDir, pid))),
    ]);
    frontier.forEach((pid, i) => {
      const stat = stats[i];
      if (stat?.pgrp === pgid && pid !== opts.exclude) members.push({ pid, start: stat.start });
    });
    frontier = children.flat();
  }
  return members;
}

/** Signal each member that is still itself; ESRCH is fine, anything else is logged. */
async function signalMembers(
  pgid: number,
  members: Member[],
  signal: NodeJS.Signals,
  procDir: string,
  kill: Kill,
): Promise<void> {
  for (const member of members) {
    try {
      if (await stillMember(procDir, pgid, member)) kill(member.pid, signal);
    } catch (err) {
      if (!isGone(err)) {
        plog.warn(`${signal} to pid ${member.pid} (group ${pgid}) failed`, log.errorData(err));
      }
    }
  }
}

/**
 * SIGTERM a process group for a graceful stop. `gone` when there was no group left
 * to signal; `members` are the processes signalled past a spared leader, or null
 * when the whole group was signalled. Never throws: a failure is logged, and the
 * caller's SIGKILL deadline is the backstop for it.
 *
 * Without a `/proc` to walk (or with nothing below the leader), the whole group is
 * signalled, which is all a non-spared stop does anyway.
 */
export async function terminateGroup(
  pgid: number,
  opts: GroupOpts & { spareLeader: boolean },
): Promise<{ gone: boolean; members: Member[] | null }> {
  const kill = opts.kill ?? defaultKill;
  const procDir = opts.procDir ?? "/proc";
  if (opts.spareLeader) {
    let members: Member[] | null = null;
    try {
      members = await groupDescendants(pgid, [pgid], { procDir, exclude: pgid });
    } catch (err) {
      plog.warn(`could not walk process group ${pgid}; signalling the whole group`, {
        procDir,
        ...log.errorData(err),
      });
    }
    if (members?.length) {
      await signalMembers(pgid, members, "SIGTERM", procDir, kill);
      return { gone: false, members };
    }
  }
  try {
    kill(-pgid, "SIGTERM");
    return { gone: false, members: null };
  } catch (err) {
    if (isGone(err)) return { gone: true, members: null };
    plog.warn(`SIGTERM to process group ${pgid} failed`, log.errorData(err));
    return { gone: false, members: null };
  }
}

/**
 * SIGKILL what is left of a group at its deadline. While the leader lives its id
 * pins the group, so the group is signalled whole. Once it has exited the id may
 * be reused, so only the processes known from the SIGTERM — and their
 * descendants still in the group, which catches anything they forked since —
 * are signalled, each re-verified by start time. If none remain, nothing is sent.
 */
async function sweepGroup(
  pgid: number,
  opts: GroupOpts & { leaderAlive: boolean; members: Member[] | null },
): Promise<void> {
  const kill = opts.kill ?? defaultKill;
  const procDir = opts.procDir ?? "/proc";
  if (opts.leaderAlive) {
    try {
      kill(-pgid, "SIGKILL");
    } catch (err) {
      if (!isGone(err)) plog.warn(`SIGKILL to process group ${pgid} failed`, log.errorData(err));
    }
    return;
  }
  if (!opts.members?.length) return;
  try {
    const alive = [];
    for (const m of opts.members) if (await stillMember(procDir, pgid, m)) alive.push(m.pid);
    const left = await groupDescendants(pgid, alive, { procDir });
    await signalMembers(pgid, left, "SIGKILL", procDir, kill);
  } catch (err) {
    plog.warn(`could not walk process group ${pgid} to SIGKILL what is left`, log.errorData(err));
  }
}

/**
 * Stop a process group: SIGTERM it ({@link terminateGroup}), wait up to `graceMs`
 * for its leader to exit, and SIGKILL what is left at the deadline
 * ({@link sweepGroup}). Resolves when the leader has exited or the deadline has
 * passed; after a clean exit, the deadline's sweep still runs in the background,
 * for a process (an SDK subprocess still flushing, a straggler forked after the
 * walk) that outlives its leader.
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
  const procDir = opts.procDir ?? "/proc";
  const leaderGone = await leaderExitWatch(leader, procDir, kill);
  const { gone, members } = await terminateGroup(pgid, opts);
  if (gone) return leaderGone.cancel();
  // The grace starts once the SIGTERM is out, not before the walk that sends it.
  const deadlineAt = Date.now() + opts.graceMs;

  let deadline: NodeJS.Timeout | undefined;
  await Promise.race([
    leaderGone.exited,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, opts.graceMs);
    }),
  ]);
  clearTimeout(deadline);
  leaderGone.cancel();
  const sweep = (leaderAlive: boolean) => sweepGroup(pgid, { procDir, kill, members, leaderAlive });
  if (!leaderGone.done()) {
    await sweep(true);
    return;
  }
  if (!members?.length) return;
  const late = setTimeout(() => void sweep(false), Math.max(0, deadlineAt - Date.now()));
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
