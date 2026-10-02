import { readdir, readFile } from "node:fs/promises";
import { exec } from "./exec.js";
import log from "./logger.js";
import { defaultKill, isGone, type Kill, readStat } from "./process-group.js";

/**
 * Sweeping up what a stopped mind left running outside its process group (#1374).
 *
 * The Claude CLI starts each Bash command in its own session, so a `nohup … &` a mind
 * runs that way leaves the mind's group, is reparented to init, and outlives a stop
 * that signals the group. Under user isolation the mind's OS user owns nothing but the
 * mind's own processes, so once the group is stopped, whatever else still runs as that
 * uid is the mind's — except what the daemon itself is running as it right now
 * (scheduled scripts, git, npm), which descends from the daemon and is spared.
 */

const slog = log.child("uid-sweep");

/** A process as the sweep sees it. `start` tells it from a later process on a reused pid. */
type Proc = { pid: number; ppid: number; pgrp: number; uid: number; start: string };

export type SweepOpts = {
  /** Spare this process and its descendants: the daemon's own children. */
  ancestor: number;
  /** Leave this group alone: the stopped mind's own, which its stop's deadline covers. */
  spareGroup?: number;
  /** Asked before each signal pass; false calls the sweep off (a variant came up). */
  proceed?: () => boolean;
  /** How long the SIGTERMed get before the SIGKILL. */
  boundMs: number;
  /** Read processes from this `/proc` instead of the platform's (tests). */
  procDir?: string;
  kill?: Kill;
};

const SCAN_CONCURRENCY = 64;

/** The real uid on the `Uid:` line of `/proc/<pid>/status`; null once it has exited. */
async function readUid(procDir: string, pid: number): Promise<number | null> {
  let status: string;
  try {
    status = await readFile(`${procDir}/${pid}/status`, "utf-8");
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
  const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
  return uid === undefined ? null : Number(uid);
}

async function readProc(procDir: string, pid: number): Promise<Proc | null> {
  const [stat, uid] = await Promise.all([readStat(procDir, pid), readUid(procDir, pid)]);
  return stat && uid !== null ? { pid, uid, ...stat } : null;
}

async function scanProc(procDir: string): Promise<Proc[]> {
  const pids = (await readdir(procDir)).filter((e) => /^\d+$/.test(e)).map(Number);
  const procs: Proc[] = [];
  for (let i = 0; i < pids.length; i += SCAN_CONCURRENCY) {
    const batch = await Promise.all(
      pids.slice(i, i + SCAN_CONCURRENCY).map((pid) => readProc(procDir, pid)),
    );
    for (const p of batch) if (p) procs.push(p);
  }
  return procs;
}

/** Without `/proc` (macOS): one `ps` of every process. `lstart` holds spaces, so it's last. */
async function scanPs(): Promise<Proc[]> {
  const out = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,ruid=,lstart="], {
    env: { LC_ALL: "C", TZ: "UTC" },
  });
  return out.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return [];
    const [pid, ppid, pgrp, uid] = m.slice(1, 5).map(Number);
    return [{ pid, ppid, pgrp, uid, start: m[5] }];
  });
}

/** Whether `p` is `ancestor` or descends from it, by following ppid through `table`. */
function descendsFrom(p: Proc, ancestor: number, table: Map<number, Proc>): boolean {
  const seen = new Set<number>();
  for (let cur: Proc | undefined = p; cur && !seen.has(cur.pid); cur = table.get(cur.ppid)) {
    if (cur.pid === ancestor || cur.ppid === ancestor) return true;
    seen.add(cur.pid);
  }
  return false;
}

/**
 * SIGTERM every process whose real uid is `uid` — other than `ancestor`'s descendants
 * and `spareGroup`'s members — wait up to `boundMs` for them to go, then SIGKILL any
 * still left, along with any started meanwhile. Resolves to how many were SIGTERMed.
 *
 * Only for a uid that belongs to one mind alone (user isolation): it signals whatever
 * runs as that uid. Refuses root and the daemon's own uid outright. Never throws: a
 * failure is logged and leaves things as they were.
 */
export async function sweepUid(uid: number, opts: SweepOpts): Promise<number> {
  if (!(uid > 0) || uid === process.getuid?.()) {
    slog.warn(`refusing to sweep uid ${uid}: it isn't a mind's own`);
    return 0;
  }
  const kill = opts.kill ?? defaultKill;
  const useProc = opts.procDir !== undefined || process.platform === "linux";
  const procDir = opts.procDir ?? "/proc";
  const strays = async (): Promise<Proc[]> => {
    const all = useProc ? await scanProc(procDir) : await scanPs();
    const table = new Map(all.map((p) => [p.pid, p]));
    return all.filter(
      (p) => p.uid === uid && p.pgrp !== opts.spareGroup && !descendsFrom(p, opts.ancestor, table),
    );
  };
  // Signal each only while it is still itself: the same process (start time) of the
  // same uid. `ps` has no cheap per-process re-read, so there the fresh scan stands in.
  const signal = async (procs: Proc[], sig: NodeJS.Signals) => {
    for (const p of procs) {
      try {
        if (useProc) {
          const now = await readProc(procDir, p.pid);
          if (!now || now.start !== p.start || now.uid !== uid) continue;
        }
        kill(p.pid, sig);
      } catch (err) {
        if (!isGone(err)) slog.warn(`${sig} to pid ${p.pid} failed`, log.errorData(err));
      }
    }
  };
  const proceed = opts.proceed ?? (() => true);
  try {
    if (!proceed()) return 0;
    const found = await strays();
    if (!found.length) return 0;
    await signal(found, "SIGTERM");
    const deadline = Date.now() + opts.boundMs;
    let left = found;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      left = await strays();
      if (!left.length) return found.length;
    }
    if (proceed()) await signal(left, "SIGKILL");
    return found.length;
  } catch (err) {
    slog.warn(`could not sweep uid ${uid}`, log.errorData(err));
    return 0;
  }
}
