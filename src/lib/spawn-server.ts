import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

type SpawnResult = { child: ChildProcess; actualPort: number } | null;

function tsxBin(cwd: string): string {
  return resolve(cwd, "node_modules", ".bin", "tsx");
}

/**
 * Spawn `tsx src/server.ts --port <port>` in the given path and wait for it to be listening.
 *
 * In detached mode: spawns with piped stdio to discover the port, then detaches.
 * The child survives parent exit. Use this when the CLI will exit immediately after.
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
 * Spawn with pipes to discover the port, then let the child survive.
 * The child may get EPIPE on stderr after parent exits — the server
 * log function handles this gracefully.
 */
function spawnDetached(cwd: string, port: number): Promise<SpawnResult> {
  const child = spawn(tsxBin(cwd), ["src/server.ts", "--port", String(port)], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 30000);

    function checkOutput(data: Buffer) {
      const match = data.toString().match(/listening on :(\d+)/);
      if (match) {
        clearTimeout(timeout);
        // Close pipes so parent can exit
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
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
