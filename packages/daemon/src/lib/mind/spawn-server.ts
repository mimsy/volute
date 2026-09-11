import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildMindBaseEnv } from "../util/mind-env.js";
import { isIsolationEnabled, wrapForIsolation } from "./isolation.js";
import { mindTmpDir } from "./registry.js";
import { isSandboxEnabled, wrapForSandbox } from "./sandbox.js";

type SpawnResult = { child: ChildProcess; actualPort: number } | null;

/**
 * Spawn `node --import tsx src/server.ts --port <port>` in the given path and wait for it to be listening.
 *
 * In detached mode: spawns with stdout/stderr going to a log file. The child survives parent exit.
 * Use this when the CLI will exit immediately after (e.g. `volute fork`).
 *
 * In attached mode (default): spawns with piped stdio and detects "listening on :PORT" in output.
 * Use this when the parent stays alive (e.g. within another server process).
 *
 * When `mindName` is given, the mind-authored server is wrapped with the same
 * isolation/sandbox as `startMind` so it never runs in the daemon's trust domain
 * (`template: "codex"` is excluded from sandbox wrapping, matching startMind).
 *
 * The environment is built the same way `startMind` builds it — the mind allowlist,
 * never the daemon's own `process.env`. `src/server.ts` is a file the mind edits, so
 * inheriting here handed `VOLUTE_DAEMON_TOKEN` to mind-authored code that the mind can
 * reach on demand: `POST /:name/variants/:variant/merge` runs this verify spawn, and
 * verification is on by default (#966). The wrap is not the protection — `runuser`
 * passes the environment through, and under sandbox/none there is no uid change at
 * all — so the env has to be built correctly here rather than assumed away.
 */
export async function spawnServer(
  cwd: string,
  port: number,
  options?: { detached?: boolean; logDir?: string; mindName?: string; template?: string },
): Promise<SpawnResult> {
  // Run node directly with tsx as an import loader rather than the tsx bin
  // shim, which forks a second idle node process (~60MB RSS). The bare `tsx`
  // specifier resolves against the spawn cwd (the mind directory).
  let cmd = process.env.VOLUTE_NODE_PATH ?? process.execPath;
  let args = ["--import", "tsx", "src/server.ts", "--port", String(port)];
  if (options?.mindName) {
    if (isIsolationEnabled()) {
      [cmd, args] = await wrapForIsolation(cmd, args, options.mindName);
    } else if (isSandboxEnabled() && options.template !== "codex") {
      [cmd, args] = await wrapForSandbox(cmd, args, cwd, options.mindName, [cwd, mindTmpDir(cwd)]);
    }
  }
  const env = buildMindBaseEnv();
  // Matches startMind: only under isolation, where the mind runs as its own user
  // and its home/ is that user's home. Without isolation, redirecting HOME would
  // strip the host's ~/.gitconfig and npm config from a process that legitimately
  // runs as the daemon's user.
  if (isIsolationEnabled()) env.HOME = resolve(cwd, "home");
  if (options?.detached) {
    return spawnDetached(cmd, args, cwd, env, options.logDir);
  }
  return spawnAttached(cmd, args, cwd, env);
}

function spawnAttached(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 30000);

    function checkOutput(data: Buffer) {
      const match = data.toString().match(/listening on :(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ child, actualPort: parseInt(match[1], 10) });
      }
    }

    child.stdout?.on("data", checkOutput);
    child.stderr?.on("data", checkOutput);

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

/**
 * Spawn with stdout/stderr redirected to a log file, then detect the port
 * by reading the log. The child survives parent exit and continues logging.
 */
function spawnDetached(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logDir?: string,
): Promise<SpawnResult> {
  const logsDir = logDir ?? resolve(cwd, ".mind", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = resolve(logsDir, "mind.log");
  // The log persists across spawns (append mode), so only match output written
  // by THIS spawn: an earlier attempt's "listening on :PORT" line would
  // otherwise be matched first and the (long-dead) stale port returned (#654).
  let startOffset = 0;
  try {
    startOffset = statSync(logPath).size;
  } catch {}
  const logFd = openSync(logPath, "a");

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env,
  });
  child.unref();
  closeSync(logFd);

  // Detect port by polling the log file for "listening on :PORT"
  return new Promise((res) => {
    let done = false;

    function finish(result: SpawnResult) {
      if (done) return;
      done = true;
      clearInterval(interval);
      clearTimeout(timeout);
      res(result);
    }

    const interval = setInterval(() => {
      try {
        // Byte offset, so slice the raw buffer before decoding.
        const content = readFileSync(logPath).subarray(startOffset).toString("utf-8");
        const match = content.match(/listening on :(\d+)/);
        if (match) {
          finish({ child, actualPort: parseInt(match[1], 10) });
        }
      } catch {
        // File not ready yet
      }
    }, 100);

    const timeout = setTimeout(() => finish(null), 30000);

    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
  });
}
