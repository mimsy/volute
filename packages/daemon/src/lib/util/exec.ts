import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { wrapForIsolation } from "../mind/isolation.js";
import { buildMindBaseEnv } from "./mind-env.js";

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
    /** Milliseconds before the child is killed; the callback then rejects. */
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
  return new Promise((resolve, reject) => {
    const child = execFileCb(
      wrappedCmd,
      wrappedArgs,
      {
        cwd: options?.cwd,
        env,
        maxBuffer: options?.maxBuffer,
        timeout: options?.timeout,
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
