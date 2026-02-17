import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { wrapForIsolation } from "./isolation.js";

/** Promise wrapper around child_process.execFile. Returns stdout as a string. */
export function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; agentName?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const [wrappedCmd, wrappedArgs] = options?.agentName
    ? wrapForIsolation(cmd, args, options.agentName)
    : [cmd, args];
  return new Promise((resolve, reject) => {
    execFileCb(
      wrappedCmd,
      wrappedArgs,
      { cwd: options?.cwd, env: options?.env },
      (err, stdout, stderr) => {
        if (err) {
          (err as Error & { stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Run a git command, adding `-c safe.directory=<cwd>` when isolation is enabled
 * so the root-owned daemon can operate on agent-owned repositories.
 */
export function gitExec(
  args: string[],
  options: { cwd: string; agentName?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const fullArgs =
    process.env.VOLUTE_ISOLATION === "user"
      ? ["-c", `safe.directory=${options.cwd}`, ...args]
      : args;
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
export function execInherit(
  cmd: string,
  args: string[],
  options?: { cwd?: string; agentName?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  const [wrappedCmd, wrappedArgs] = options?.agentName
    ? wrapForIsolation(cmd, args, options.agentName)
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
