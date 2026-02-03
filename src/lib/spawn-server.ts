import { spawn, type ChildProcess } from "child_process";

type SpawnResult = { child: ChildProcess; actualPort: number } | null;

/**
 * Spawn `bun run src/server.ts --port <port>` in the given path and wait for it to be listening.
 *
 * In detached mode: spawns with stdio ignored and polls /health to detect readiness.
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
  const child = spawn("bun", ["run", "src/server.ts", "--port", String(port)], {
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

function spawnDetached(cwd: string, port: number): Promise<SpawnResult> {
  const child = spawn("bun", ["run", "src/server.ts", "--port", String(port)], {
    cwd,
    stdio: "ignore",
    detached: true,
  });

  child.unref();

  // If port is 0, we need a way to discover the actual port.
  // We'll try a range of health checks. But with port=0, Bun picks a random port
  // that we can't know without output. For detached mode, require a specific port
  // or scan /health on probable ports.
  //
  // For simplicity: if port=0, we start with pipes temporarily to capture the port,
  // then accept that the child will get EPIPE on stderr after parent exits.
  // This is fine because the server catches write errors in its log function.
  if (port === 0) {
    // Fall back to attached mode — we need to discover the actual port
    child.kill();
    return spawnAttachedDetach(cwd, port);
  }

  // Poll /health until the server is ready
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 30000);

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve({ child, actualPort: port });
        }
      } catch {
        // Not ready yet
      }
    }, 500);

    child.on("error", () => {
      clearTimeout(timeout);
      clearInterval(interval);
      resolve(null);
    });
  });
}

/**
 * Spawn with pipes to discover the port, then let the child survive.
 * The child may get EPIPE on stderr after parent exits — the server
 * log function handles this gracefully.
 */
function spawnAttachedDetach(cwd: string, port: number): Promise<SpawnResult> {
  const child = spawn("bun", ["run", "src/server.ts", "--port", String(port)], {
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
