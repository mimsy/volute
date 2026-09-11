import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { wrapForIsolation } from "../mind/isolation.js";
import { buildMindBaseEnv } from "./mind-env.js";

/**
 * Grace between SIGTERM and SIGKILL for a timed-out child's process group —
 * the same 5s the mind and bridge managers give a process they are stopping.
 */
const KILL_GRACE_MS = 5000;

/**
 * How long to wait after a child's `exit` for its stdio pipes to drain before
 * settling anyway. Node emits `close` when they have drained, but a grandchild
 * that escaped the process group can hold them open forever — so `close` is
 * waited for, not required.
 */
const STDIO_DRAIN_MS = 1000;

/** An `exec()` rejection carrying whatever the child managed to produce. */
export type ExecError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  /** True when the child was killed for exceeding `options.timeout`. */
  timedOut?: boolean;
};

/**
 * Human-readable duration for a timeout message: "300ms", "45s", "10 minutes".
 * This text reaches a mind as the reason its own script was killed, so it names
 * the bound that was actually configured — never a rounded-to-zero "0s".
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  // Only say "minutes" when it is exactly that many — rounding 90s up to
  // "2 minutes" would misreport the bound this text promises to name.
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/**
 * Promise wrapper around child_process.execFile. Returns stdout as a string.
 * `stdin`, when given, is written to the child's stdin and the stream closed.
 *
 * The child never inherits the daemon's environment. It gets the mind allowlist
 * from {@link buildMindBaseEnv} with the caller's `env` laid over it, so
 * `VOLUTE_DAEMON_TOKEN` and ambient host secrets are withheld from every child by
 * default — including the git hooks and npm lifecycle scripts a mind can author,
 * which several callers here run in the mind's own repo (#966). The scrub is
 * unconditional: without user isolation those hooks run as the daemon's own user,
 * which is the worse case, not the safer one.
 *
 * A caller adds what its child needs one variable at a time (HOME, npm_config_cache).
 * A caller that may run mind-authored code must never pass `...process.env` — that
 * spread lays the token back over the base that just removed it. The one deliberate
 * exception is `backup/restic.ts`, which runs a host binary on no mind's behalf and
 * needs the host's own store credentials (`AWS_*`, `B2_*`) to reach the repository.
 */
export async function exec(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    mindName?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    stdin?: string;
    /**
     * Milliseconds before the child's whole process group is killed and the
     * promise rejects with `timedOut: true`. See {@link execTimed}.
     */
    timeout?: number;
  },
): Promise<string> {
  const [wrappedCmd, wrappedArgs] = options?.mindName
    ? await wrapForIsolation(cmd, args, options.mindName)
    : [cmd, args];
  const env = { ...buildMindBaseEnv(), ...options?.env };
  // The base already withholds the token, so this only matters when a caller's own
  // env re-admits it — which is exactly the failure this PR is undoing, and a default
  // that a call site can quietly defeat is the shape of the original bug. No child
  // spawned through here has ever needed it (bridges get theirs from BridgeManager's
  // own `spawn`), so drop it unconditionally and the scrub cannot be argued with.
  delete env.VOLUTE_DAEMON_TOKEN;
  // The timed path takes the env that was just scrubbed, never `options.env` — a
  // scheduled mind script is precisely the mind-authored child #966 is about, and
  // it is the one child here that is *always* mind-authored.
  if (options?.timeout) {
    return execTimed(wrappedCmd, wrappedArgs, options.timeout, env, options);
  }
  return new Promise((resolve, reject) => {
    const child = execFileCb(
      wrappedCmd,
      wrappedArgs,
      {
        cwd: options?.cwd,
        env,
        maxBuffer: options?.maxBuffer,
      },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string; stdout?: string }).stderr = stderr;
          (err as Error & { stderr?: string; stdout?: string }).stdout = stdout;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
    if (options?.stdin !== undefined && child.stdin) {
      // Discard stdin stream errors. EPIPE here means the child exited without
      // reading its input, which is legitimate — a hook may not want stdin at all —
      // and an unhandled 'error' event on this stream takes the whole process down
      // (#864: it killed the daemon, every mind with it).
      //
      // Be clear about the cost: this is the ONLY record of the failed write. The
      // execFile callback does not also see it — verified: a write past the pipe
      // buffer to an already-exited child raises EPIPE on the stream while the
      // callback fires with `err: null` and empty stdout. So a write that never
      // landed is indistinguishable here from one that did. That trade is right
      // only because this input is an offer the child may decline; a caller whose
      // child MUST receive its stdin cannot learn otherwise from this wrapper.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}

/**
 * The `timeout` half of {@link exec}, as its own `spawn` rather than `execFile`.
 *
 * Three things `execFile` cannot do here, each of which a timeout needs:
 *
 * 1. **A process group to kill.** `execFile` builds its own spawn options from a
 *    fixed field list and silently drops `detached` (verified on Node v24), so
 *    its child stays in the daemon's group and `process.kill(-pid)` would either
 *    ESRCH or, worse, signal the daemon's own group. Under every isolation mode
 *    the thing that must die is a *tree*, not one process: `bash -c "…"` forks
 *    for any compound script, `sudo`/`runuser` sits in front under `user`
 *    isolation. `detached: true` makes the child a group leader so one
 *    `kill(-pgid)` reaches all of it.
 * 2. **Escalation.** `execFile`'s own timeout sends a single `killSignal`
 *    (SIGTERM) and never follows up, so a script ignoring SIGTERM outlives its
 *    own bound. Here SIGTERM is followed by a group SIGKILL after
 *    {@link KILL_GRACE_MS}.
 * 3. **A bounded wait for stdio.** `execFile` settles on `close`, which waits
 *    for the pipes to drain — and a grandchild that escaped the group (`setsid`,
 *    `nohup … &`) can hold them open forever, reproducing one level down the
 *    never-returning promise a timeout exists to prevent. Here `close` is waited
 *    for but not required: a clean exit gets {@link STDIO_DRAIN_MS} for the
 *    pipes to finish (data legitimately arrives after `exit`, and which of the
 *    two lands first is platform poll ordering, not a Node guarantee), and a
 *    timed-out run settles on `exit` without waiting at all.
 */
function execTimed(
  cmd: string,
  args: string[],
  timeout: number,
  /**
   * The environment {@link exec} already scrubbed. Taken as its own parameter,
   * and deliberately absent from `options` below, so this cannot be handed the
   * caller's raw `env` by a later edit — a timed child is a scheduled mind script
   * or a mind's lifecycle hook, the mind-authored code #966 exists for.
   */
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; maxBuffer?: number; stdin?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let exitResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    // Captured at spawn: `child.pid` reads through the libuv handle, which Node
    // drops on exit — so by the time the escalation runs (deliberately *after*
    // the leader has died, see `settle`) the property is already undefined.
    const pgid = child.pid;

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (pgid) process.kill(-pgid, signal);
        else child.kill(signal);
      } catch {
        // Already gone, or the group outlived its leader — nothing to do.
      }
    };

    const settle = (err: ExecError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Disarm the escalation ONLY when nothing timed out. Once the SIGTERM has
      // gone out, settling means the *leader* is gone — which is not the same as
      // the group being gone, and it is the case the escalation exists for: a
      // `bash -c "trap '' TERM; …" &` member outlives the leader's death and
      // would otherwise keep running forever while the caller has already been
      // told the script was killed. Clearing the timer here was that exact bug.
      // The pgid cannot have been reused underneath a still-armed timer: a pid
      // stays allocated while it is any live process's pgid, so a group with
      // survivors keeps the id, and an empty group makes `kill(-pgid)` an ESRCH
      // the killGroup catch swallows.
      if (killTimer && !timedOut) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      // Nothing reads these streams after this point, and a survivor of the kill
      // would otherwise keep appending to the closure's strings and holding the
      // pipe open. Destroying the read side releases the handles and gives the
      // survivor a SIGPIPE on its next write.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
      if (!err) {
        resolve(stdout);
        return;
      }
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        killGroup("SIGKILL");
        settle(
          Object.assign(new Error(`timed out after ${formatDuration(timeout)} and was killed`), {
            timedOut: true,
          }),
        );
      }, KILL_GRACE_MS);
    }, timeout);

    const collect = (which: "stdout" | "stderr", chunk: string) => {
      if (which === "stdout") stdout += chunk;
      else stderr += chunk;
      // Per-stream, as execFile bounds it, so the untimed and timed paths agree.
      if (options.maxBuffer === undefined || overflowed) return;
      if ((which === "stdout" ? stdout : stderr).length <= options.maxBuffer) return;
      overflowed = true;
      killGroup("SIGKILL");
      settle(new Error(`${which} maxBuffer length exceeded`));
    };

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => collect("stdout", c));
    child.stderr?.on("data", (c: string) => collect("stderr", c));
    // Pipe errors after a kill are expected; an unhandled 'error' event here
    // would take the daemon down with the script (#864).
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    const timeoutError = (code: number | null, signal: NodeJS.Signals | null) =>
      Object.assign(new Error(`timed out after ${formatDuration(timeout)} and was killed`), {
        timedOut: true,
        code,
        signal,
      });

    /** Settle with the recorded exit status — only ever called after `exit`. */
    const settleFromExit = () => {
      if (!exitResult) return;
      const { code, signal } = exitResult;
      if (code === 0) {
        settle(null);
        return;
      }
      settle(
        Object.assign(
          new Error(
            `Command failed: ${cmd} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`.trimEnd(),
          ),
          { code, signal },
        ),
      );
    };

    child.on("error", (err) => settle(err as ExecError));

    child.on("exit", (code, signal) => {
      // A timed-out run settles here and does not wait: the reason it is being
      // killed may well be a grandchild holding stdout open, and waiting on the
      // pipes would be the very hang the bound exists to prevent.
      if (timedOut) {
        settle(timeoutError(code, signal));
        return;
      }
      // Otherwise give the pipes a moment. Node emits `exit` and only then
      // `process.nextTick(flushStdio)`, because pipe data legitimately arrives
      // after the child is gone — whether the readable fd or the SIGCHLD fd is
      // serviced first in a poll iteration is epoll/kqueue ordering, not a Node
      // guarantee, and it differs by platform. Settling straight from `exit`
      // would mean a script that prints one line and exits could return nothing
      // at all on the platform that orders them the other way. `close` is the
      // event that means "drained", and the timer is what keeps waiting for it
      // bounded.
      exitResult = { code, signal };
      drainTimer = setTimeout(settleFromExit, STDIO_DRAIN_MS);
    });

    // Always after `exit` (or `error`), per Node's contract.
    child.on("close", () => {
      if (timedOut) settle(timeoutError(exitResult?.code ?? null, exitResult?.signal ?? null));
      else settleFromExit();
    });

    if (options.stdin !== undefined && child.stdin) {
      // Same trade as the untimed path above: EPIPE from a child that never read
      // its input is legitimate, and an unhandled error event here is fatal.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
  });
}

/**
 * Run a git command, adding `-c safe.directory=*` when isolation is enabled
 * so the root-owned daemon can operate on mind-owned repositories and their worktrees.
 * Git identity comes from per-repo config (configureGitIdentity) or system config
 * (install.sh / setup.ts / Dockerfile). Runs with the scrubbed env `exec` applies.
 */
export function gitExec(
  args: string[],
  options: {
    cwd: string;
    mindName?: string;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    stdin?: string;
  },
): Promise<string> {
  const fullArgs =
    process.env.VOLUTE_ISOLATION === "user" ? ["-c", "safe.directory=*", ...args] : args;
  return exec("git", fullArgs, options);
}

/** Resolve the absolute path to the `volute` binary. Throws if not found on PATH. */
export function resolveVoluteBin(): string {
  try {
    return execFileSync("which", ["volute"], { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Could not find volute binary on PATH");
  }
}

/**
 * Promise wrapper around spawn with stdio: "inherit". Resolves when the process exits 0,
 * rejects otherwise.
 *
 * Unlike {@link exec}, this one inherits the ambient environment, and that is deliberate:
 * its callers are host-facing service and CLI commands (`systemctl --user`, `launchctl`,
 * `npm install -g`, `restic restore`) whose children need host state the mind allowlist
 * does not carry — `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` for a user-mode
 * systemd unit, npm's own config for a global install. It runs no mind-authored code
 * today and must not start: a command in a mind's repo (anything git, anything npm in a
 * mind project) belongs on `exec`/`gitExec`, which scrub (#966).
 */
export async function execInherit(
  cmd: string,
  args: string[],
  options?: { cwd?: string; mindName?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const [wrappedCmd, wrappedArgs] = options?.mindName
    ? await wrapForIsolation(cmd, args, options.mindName)
    : [cmd, args];
  return new Promise((resolve, reject) => {
    const child = spawn(wrappedCmd, wrappedArgs, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
