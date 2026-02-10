import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";

/** Promise wrapper around child_process.execFile. Returns stdout as a string. */
export function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; stdio?: "pipe" },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { cwd: options?.cwd }, (err, stdout, stderr) => {
      if (err) {
        (err as Error & { stderr?: string }).stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
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
  options?: { cwd?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
