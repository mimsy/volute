import { readFile } from "node:fs/promises";
import { exec } from "./exec.js";

/**
 * What a process is, as the OS reports it: its command line, when it started, and the
 * boot it started in. A pid alone names whatever holds that number now — after a
 * crash, possibly some unrelated process (#1360).
 */
export type ProcessIdentity = {
  /** Its argv joined with spaces. */
  args: string;
  /** Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot); elsewhere `ps -o lstart=`, to the second. */
  start: string;
  /** Linux: the kernel's boot_id; elsewhere `sysctl kern.boottime`. Null if unreadable. */
  boot: string | null;
};

/** `ps`/`sysctl` output in one fixed format, whatever the host's locale and zone. */
const FIXED_FORMAT = { LC_ALL: "C", TZ: "UTC" };

async function bootId(): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      return (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim() || null;
    }
    return (await exec("sysctl", ["-n", "kern.boottime"], { env: FIXED_FORMAT })).trim() || null;
  } catch {
    return null;
  }
}

/** The identity of `pid`, or null if there's no such process or it can't be read. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    let args: string;
    let start: string | undefined;
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
      // Field 2 (comm) is parenthesised and may hold spaces or parens: count from the last `)`.
      start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8");
      args = cmdline.replace(/\0$/, "").split("\0").join(" ");
    } else {
      const ps = (field: string) =>
        exec("ps", ["-o", `${field}=`, "-p", String(pid)], { env: FIXED_FORMAT });
      start = (await ps("lstart")).trim();
      args = (await ps("args")).trim();
    }
    if (!start || !args) return null;
    return { args, start, boot: await bootId() };
  } catch {
    return null;
  }
}
