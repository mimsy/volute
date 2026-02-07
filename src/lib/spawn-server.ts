import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type SpawnResult = { child: ChildProcess; actualPort: number } | null;

function tsxBin(cwd: string): string {
  return resolve(cwd, "node_modules", ".bin", "tsx");
}

/**
 * Spawn `tsx src/server.ts --port <port>` in the given path and wait for it to be listening.
 *
 * In detached mode: spawns with stdout/stderr going to a log file. The child survives parent exit.
 * Use this when the CLI will exit immediately after (e.g. `volute fork`).
 *
 * In attached mode (default): spawns with piped stdio and detects "listening on :PORT" in output.
 * Use this when the parent stays alive (e.g. within another server process).
 */
export function spawnServer(
  cwd: string,
  port: number,
  options?: { detached?: boolean },
): Promise<SpawnResult> {
  if (options?.detached) {
    return spawnDetached(cwd, port);
  }
  return spawnAttached(cwd, port);
}

function spawnAttached(cwd: string, port: number): Promise<SpawnResult> {
  const child = spawn(tsxBin(cwd), ["src/server.ts", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
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
function spawnDetached(cwd: string, port: number): Promise<SpawnResult> {
  const logsDir = resolve(cwd, ".volute", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = resolve(logsDir, "agent.log");
  const logFd = openSync(logPath, "w");

  const child = spawn(tsxBin(cwd), ["src/server.ts", "--port", String(port)], {
    cwd,
    stdio: ["ignore", logFd, logFd],
    detached: true,
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
        const content = readFileSync(logPath, "utf-8");
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
