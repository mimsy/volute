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
  /**
   * Its argv. Linux: the elements of `/proc/<pid>/cmdline`. Elsewhere `ps` gives only the
   * joined line, so this is that line split on spaces, and an argument holding a space
   * comes back as several.
   */
  argv: string[];
  /** Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot); elsewhere `ps -o lstart=`, to the second. */
  start: string;
  /** Linux: the kernel's boot_id; elsewhere the second `kern.boottime` names. Null if unreadable. */
  boot: string | null;
};

/** `ps`/`sysctl` output in one fixed format, whatever the host's locale and zone. */
const FIXED_FORMAT = { LC_ALL: "C", TZ: "UTC" };
/** A process stuck in the kernel can block a read of its `/proc` files: give up on it. */
const IDENTITY_TIMEOUT_MS = 5000;

async function readBootId(): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      return (await readFile("/proc/sys/kernel/random/boot_id", "utf-8")).trim() || null;
    }
    // `{ sec = 1777872512, usec = 95602 } ...`: the usec moves when the clock is stepped.
    const out = await exec("sysctl", ["-n", "kern.boottime"], { env: FIXED_FORMAT });
    return out.match(/sec = (\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

let bootId: Promise<string | null> | null = null;

async function readIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    let argv: string[];
    let start: string | undefined;
    if (process.platform === "linux") {
      const [stat, cmdline] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf-8"),
        readFile(`/proc/${pid}/cmdline`, "utf-8"),
      ]);
      // Field 2 (comm) is parenthesised and may hold spaces or parens: count from the last `)`.
      start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      argv = cmdline.replace(/\0$/, "").split("\0");
    } else {
      const ps = (field: string) =>
        exec("ps", ["-o", `${field}=`, "-p", String(pid)], {
          env: FIXED_FORMAT,
          timeout: IDENTITY_TIMEOUT_MS,
        });
      let args: string;
      [start, args] = (await Promise.all([ps("lstart"), ps("args")])).map((s) => s.trim());
      argv = args.split(" ");
    }
    if (!start || !argv.join("")) return null;
    bootId ??= readBootId();
    return { args: argv.join(" "), argv, start, boot: await bootId };
  } catch {
    return null;
  }
}

/**
 * The identity of `pid`, or null if there's no such process, it can't be read, or
 * reading it takes too long.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), IDENTITY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readIdentity(pid), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
