import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { wrapForIsolation } from "../mind/isolation.js";

/** Promise wrapper around child_process.execFile. Returns stdout as a string.
 * `stdin`, when given, is written to the child's stdin and the stream closed. */
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
  return new Promise((resolve, reject) => {
    const child = execFileCb(
      wrappedCmd,
      wrappedArgs,
      {
        cwd: options?.cwd,
        env: options?.env,
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
 * (install.sh / setup.ts / Dockerfile).
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

/** Promise wrapper around spawn with stdio: "inherit". Resolves when the process exits 0, rejects otherwise. */
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
