import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import log from "./logger.js";

const plog = log.child("process-group");

type Kill = (pid: number, signal: NodeJS.Signals) => void;
const defaultKill: Kill = (pid, signal) => process.kill(pid, signal);

function isEsrch(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ESRCH";
}

/** A process's group and start time (clock ticks since boot), from `/proc/<pid>/stat`. */
async function readStat(
  procDir: string,
  pid: number,
): Promise<{ pgrp: number; start: string } | null> {
  let stat: string;
  try {
    stat = await readFile(`${procDir}/${pid}/stat`, "utf-8");
  } catch {
    return null; // exited
  }
  // `pid (comm) state ppid pgrp … starttime …` — comm may hold spaces and parens,
  // so the fields are counted from the last ')': pgrp is field 5, starttime 22.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pgrp: Number(fields[2]), start: fields[19] };
}

/**
 * The members of process group `pgid` other than `exclude`, each with its start
 * time so a later signal can tell it from a process that reused its pid. Read from
 * `/proc` (Linux only); throws when that can't be listed.
 */
export async function groupMembersExcept(
  pgid: number,
  exclude: number,
  procDir = "/proc",
): Promise<{ pid: number; start: string }[]> {
  const pids = (await readdir(procDir))
    .filter((e) => /^\d+$/.test(e))
    .map(Number)
    .filter((pid) => pid !== exclude);
  const stats = await Promise.all(pids.map((pid) => readStat(procDir, pid)));
  return pids.flatMap((pid, i) => {
    const stat = stats[i];
    return stat?.pgrp === pgid ? [{ pid, start: stat.start }] : [];
  });
}

/**
 * SIGTERM a process group for a graceful stop. Resolves `"gone"` when there is
 * no group left to signal, `"signalled"` otherwise; throws any other failure.
 *
 * With `spareLeader`, the group's leader — the `runuser` supervising an isolated
 * mind — is left out and every other member is signalled directly. runuser
 * answers a SIGTERM of its own by forwarding it, sleeping 2s and SIGKILLing its
 * child, which capped every mind's shutdown at 2s whatever grace the caller
 * allowed (#1364); spared, it just exits when its child does. Each member's
 * group and start time are re-read just before it is signalled, so a pid that
 * exited and was reused since the scan is skipped.
 *
 * The members can't be listed without `/proc`; then, or when the leader is all
 * that's left, the whole group is signalled as before.
 */
export async function terminateGroup(
  pgid: number,
  opts: { spareLeader: boolean; procDir?: string; kill?: Kill },
): Promise<"signalled" | "gone"> {
  const kill = opts.kill ?? defaultKill;
  const procDir = opts.procDir ?? "/proc";
  if (opts.spareLeader) {
    let members: { pid: number; start: string }[] | null = null;
    try {
      members = await groupMembersExcept(pgid, pgid, procDir);
    } catch (err) {
      plog.warn(`could not list process group ${pgid}; signalling the whole group`, {
        procDir,
        ...log.errorData(err),
      });
    }
    if (members?.length) {
      let failure: unknown = null;
      for (const { pid, start } of members) {
        const now = await readStat(procDir, pid);
        if (now?.pgrp !== pgid || now.start !== start) continue;
        try {
          kill(pid, "SIGTERM");
        } catch (err) {
          if (!isEsrch(err)) failure ??= err;
        }
      }
      if (failure) throw failure;
      return "signalled";
    }
  }
  try {
    kill(-pgid, "SIGTERM");
    return "signalled";
  } catch (err) {
    if (isEsrch(err)) return "gone";
    throw err;
  }
}

/**
 * Stop a detached child's process group: SIGTERM it ({@link terminateGroup}),
 * wait up to `graceMs` for the leader to exit, then SIGKILL the group.
 *
 * The SIGKILL goes out on a clean exit too, at once: anything the scan couldn't
 * see (forked after it) or the leader left behind would otherwise outlive the
 * stop. Sending it at once is what makes it safe — a pid stays allocated while it
 * is any live process's group id, so the group can't have been reused while it
 * has members, and an empty group is an ESRCH. A delayed timer would not have
 * that guarantee, which is why a clean exit disarms the deadline.
 *
 * A SIGTERM that fails is logged and the deadline still holds, so the group is
 * SIGKILLed rather than reported stopped while it may still be running.
 */
export async function stopGroup(
  child: ChildProcess,
  opts: { spareLeader: boolean; graceMs: number; procDir?: string; kill?: Kill },
): Promise<void> {
  const pgid = child.pid;
  if (!pgid) return;
  const kill = opts.kill ?? defaultKill;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  try {
    if ((await terminateGroup(pgid, opts)) === "gone") return;
  } catch (err) {
    plog.warn(`SIGTERM to process group ${pgid} failed; it is SIGKILLed at the deadline`, {
      ...log.errorData(err),
    });
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.graceMs);
    }),
  ]);
  clearTimeout(timer);
  try {
    kill(-pgid, "SIGKILL");
  } catch (err) {
    if (!isEsrch(err)) {
      plog.warn(`SIGKILL to process group ${pgid} failed`, { ...log.errorData(err) });
    }
  }
}
