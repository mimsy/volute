import { readFile } from "node:fs/promises";
import log from "./logger.js";
import {
  type Kill,
  type Member,
  mapBatched,
  type ProcStat,
  readStat,
  scanProcs,
  signalEach,
} from "./process-group.js";

/**
 * Ending what a mind left running outside its process group (#1374).
 *
 * The Claude CLI starts each Bash command in its own session, so a `nohup … &` a mind
 * runs that way leaves the mind's group, is reparented to init, and outlives a stop
 * that signals the group. Under user isolation such a process runs as the mind's own OS
 * user, and it carries the `VOLUTE_MIND=<name>` the daemon gave the mind's server, which
 * every process the mind starts inherits. Both together mark it as the mind's: a host's
 * `sudo -u mind-<name>` shell has the uid but not the marker, and a variant's jobs have
 * the uid but their own name. What the daemon itself is running as the mind (scheduled
 * scripts, git, npm) descends from the daemon and is spared.
 *
 * Linux only: it reads `/proc`. On macOS (`sudo -u` isolation) nothing is swept, and a
 * mind's background jobs outlive its stop there.
 */

const slog = log.child("uid-sweep");

export type SweepOpts = {
  /** Spare this process and its descendants: the daemon and its children. */
  ancestor: number;
  /** When (epoch ms) what was SIGTERMed and is still there gets SIGKILLed. */
  killAt: number;
  /**
   * The `environ` paths among `paths` that hold `entry`, read as the mind's own user, in
   * one go. Root needs CAP_SYS_PTRACE to read another uid's `environ`, and Docker
   * withholds it by default; the process's own uid needs nothing.
   */
  markedAsOwner?: (paths: string[], entry: string) => Promise<string[]>;
  /** Read processes from this `/proc` instead of the real one (tests). */
  procDir?: string;
  kill?: Kill;
};

/**
 * A {@link SweepOpts.markedAsOwner} that asks one `sh`, run through `run` — which the
 * caller wraps as the mind's own user — which of the `environ` files hold the entry.
 * The `exit 0` matters: without it the script exits with its last `grep`'s status, and
 * an unmarked file last would fail the whole read.
 */
export function ownerMarkReader(
  run: (cmd: string, args: string[]) => Promise<string>,
): NonNullable<SweepOpts["markedAsOwner"]> {
  const script =
    'm=$1; shift; for f; do grep -qzxF -e "$m" "$f" 2>/dev/null && echo "$f"; done; exit 0';
  return async (paths, entry) =>
    (await run("sh", ["-c", script, "sh", entry, ...paths])).split("\n").filter(Boolean);
}

/** The real uid on the `Uid:` line of `/proc/<pid>/status`; null if unreadable. */
async function readUid(procDir: string, pid: number): Promise<number | null> {
  try {
    const uid = (await readFile(`${procDir}/${pid}/status`, "utf-8")).match(/^Uid:\s+(\d+)/m);
    return uid ? Number(uid[1]) : null;
  } catch {
    return null;
  }
}

/** Whether the `environ` at `path` holds exactly `entry`; "refused" if root may not read it. */
async function hasEnv(path: string, entry: string): Promise<boolean | "refused"> {
  try {
    return (await readFile(path, "utf-8")).split("\0").includes(entry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM" ? "refused" : false;
  }
}

/** Whether `p` is `ancestor` or descends from it, by following ppid through `table`. */
function descendsFrom(p: ProcStat, ancestor: number, table: Map<number, ProcStat>): boolean {
  const seen = new Set<number>();
  for (let cur: ProcStat | undefined = p; cur && !seen.has(cur.pid); cur = table.get(cur.ppid)) {
    if (cur.pid === ancestor || cur.ppid === ancestor) return true;
    seen.add(cur.pid);
  }
  return false;
}

/**
 * SIGTERM every process the mind `name` started that still runs as its `uid` — other
 * than the descendants of `ancestor` — then SIGKILL, at `killAt`, any of them still
 * there. Resolves to how many were SIGTERMed.
 *
 * Only for a uid that belongs to one mind alone (user isolation). Refuses root and the
 * daemon's own uid outright. Never throws: a failure is logged and leaves things as
 * they were.
 */
export async function sweepMindProcesses(
  uid: number,
  name: string,
  opts: SweepOpts,
): Promise<number> {
  if (!(uid > 0) || uid === process.getuid?.()) {
    slog.warn(`refusing to sweep uid ${uid}: it isn't a mind's own`);
    return 0;
  }
  if (opts.procDir === undefined && process.platform !== "linux") return 0;
  const procDir = opts.procDir ?? "/proc";
  const marker = `VOLUTE_MIND=${name}`;
  const environ = (pid: number) => `${procDir}/${pid}/environ`;
  try {
    const all = await scanProcs(procDir);
    const table = new Map(all.map((p) => [p.pid, p]));
    const outside = all.filter((p) => !descendsFrom(p, opts.ancestor, table));
    const uids = await mapBatched(outside, (p) => readUid(procDir, p.pid));
    const owned = outside.filter((_, i) => uids[i] === uid);
    const marks = await mapBatched(owned, (p) => hasEnv(environ(p.pid), marker));
    const refused = owned.filter((_, i) => marks[i] === "refused").map((p) => environ(p.pid));
    // A failed read loses only what it would have found, not what root could read.
    const viaOwner = new Set(
      refused.length && opts.markedAsOwner
        ? await opts.markedAsOwner(refused, marker).catch((err) => {
            slog.warn(`could not read ${name}'s processes as its own user`, log.errorData(err));
            return [];
          })
        : [],
    );
    const strays: Member[] = owned
      .filter((p, i) => marks[i] === true || viaOwner.has(environ(p.pid)))
      .map(({ pid, start }) => ({ pid, start }));
    if (!strays.length) return 0;
    // Re-checked just before each signal: the start time (in signalEach) says it is the
    // process the scan found, so its marker still stands; the uid, that it still runs as
    // the mind.
    const signal = {
      procDir,
      kill: opts.kill,
      verify: async (pid: number) => (await readUid(procDir, pid)) === uid,
    };
    await signalEach(strays, "SIGTERM", signal);
    // Watch only what was signalled: the same process (start time) still there.
    let left = strays;
    while (left.length && Date.now() < opts.killAt) {
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, opts.killAt - Date.now()))));
      const now = await Promise.all(left.map((m) => readStat(procDir, m.pid)));
      left = left.filter((m, i) => now[i]?.start === m.start);
    }
    if (left.length) await signalEach(left, "SIGKILL", signal);
    return strays.length;
  } catch (err) {
    slog.warn(`could not sweep ${name}'s processes`, log.errorData(err));
    return 0;
  }
}
