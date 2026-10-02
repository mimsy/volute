import { readdir, readFile } from "node:fs/promises";

/**
 * The pids in process group `pgid`, other than `exclude`, read from `/proc`
 * (Linux only — the caller falls back to a group signal when this throws).
 *
 * A pid that exits mid-scan is skipped, not an error.
 */
export async function groupMembersExcept(
  pgid: number,
  exclude: number,
  procDir = "/proc",
): Promise<number[]> {
  const members: number[] = [];
  for (const entry of await readdir(procDir)) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === exclude) continue;
    let stat: string;
    try {
      stat = await readFile(`${procDir}/${entry}/stat`, "utf-8");
    } catch {
      continue;
    }
    // `pid (comm) state ppid pgrp …` — comm may hold spaces and parens, so the
    // fields are counted from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid) members.push(pid);
  }
  return members;
}

/**
 * SIGTERM a process group for a graceful stop.
 *
 * With `spareLeader`, the group's leader — an isolation supervisor such as
 * `runuser` — is left out and every other member is signalled directly. runuser
 * answers a SIGTERM of its own by forwarding it, sleeping 2s and SIGKILLing its
 * child, which capped every mind's shutdown at 2s whatever grace the caller
 * allowed (#1364); spared, it just exits when its child does. A caller's group
 * SIGKILL at its own deadline remains the backstop.
 *
 * Falls back to signalling the whole group when the members can't be listed or
 * there are none left besides the leader. Throws, like `process.kill`, when that
 * group signal finds no group.
 */
export async function terminateGroup(
  pgid: number,
  opts: { spareLeader: boolean; procDir?: string; kill?: (pid: number, sig: string) => void },
): Promise<void> {
  const kill = opts.kill ?? ((pid: number, sig: string) => process.kill(pid, sig));
  if (opts.spareLeader) {
    let members: number[] = [];
    try {
      members = await groupMembersExcept(pgid, pgid, opts.procDir);
    } catch {
      // No /proc — fall through to the group signal.
    }
    if (members.length > 0) {
      for (const pid of members) {
        try {
          kill(pid, "SIGTERM");
        } catch {
          // Exited since the scan.
        }
      }
      return;
    }
  }
  kill(-pgid, "SIGTERM");
}
