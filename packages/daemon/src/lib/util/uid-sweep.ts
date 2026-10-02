import { readFile } from "node:fs/promises";
import log from "./logger.js";
import {
  type Kill,
  type Member,
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

/** How many processes' `status` and `environ` are read at once. */
const SCAN_CONCURRENCY = 64;

export type SweepOpts = {
  /** Spare this process and its descendants: the daemon and its children. */
  ancestor: number;
  /** How long the SIGTERMed get before the SIGKILL. */
  boundMs: number;
  /**
   * Read a file as the mind's own user. Root needs CAP_SYS_PTRACE to read another
   * uid's `environ`, and Docker withholds it by default; the process's own uid needs
   * nothing.
   */
  readAsOwner?: (path: string) => Promise<string>;
  /** Read processes from this `/proc` instead of the real one (tests). */
  procDir?: string;
  kill?: Kill;
};

/** The real uid on the `Uid:` line of `/proc/<pid>/status`; null if unreadable. */
async function readUid(procDir: string, pid: number): Promise<number | null> {
  try {
    const uid = (await readFile(`${procDir}/${pid}/status`, "utf-8")).match(/^Uid:\s+(\d+)/m);
    return uid ? Number(uid[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `/proc/<pid>/environ` holds exactly `entry`: read directly, or as the owner
 * when that is refused. False if it can't be read either way.
 */
async function hasEnv(
  procDir: string,
  pid: number,
  entry: string,
  readAsOwner?: (path: string) => Promise<string>,
): Promise<boolean> {
  const path = `${procDir}/${pid}/environ`;
  let environ: string;
  try {
    environ = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!readAsOwner || (code !== "EACCES" && code !== "EPERM")) return false;
    try {
      environ = await readAsOwner(path);
    } catch {
      return false;
    }
  }
  return environ.split("\0").includes(entry);
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
 * than the descendants of `ancestor` — wait up to `boundMs` for them to go, then SIGKILL
 * any still there. Resolves to how many were SIGTERMed.
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
  const isMinds = async (pid: number) =>
    (await readUid(procDir, pid)) === uid && (await hasEnv(procDir, pid, marker, opts.readAsOwner));
  try {
    const all = await scanProcs(procDir);
    const table = new Map(all.map((p) => [p.pid, p]));
    const candidates = all.filter((p) => !descendsFrom(p, opts.ancestor, table));
    const strays: Member[] = [];
    for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
      const batch = candidates.slice(i, i + SCAN_CONCURRENCY);
      const marked = await Promise.all(batch.map((p) => isMinds(p.pid)));
      for (const [j, { pid, start }] of batch.entries()) if (marked[j]) strays.push({ pid, start });
    }
    if (!strays.length) return 0;
    const signal = { procDir, kill: opts.kill, verify: isMinds };
    await signalEach(strays, "SIGTERM", signal);
    // Watch only what was signalled: the same process (start time) still there.
    const deadline = Date.now() + opts.boundMs;
    let left = strays;
    while (left.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
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
