import { spawn, type ChildProcess } from "child_process";

/** Spawn `bun run src/server.ts --port <port>` in the given path and wait for it to be listening. */
export function spawnServer(
  cwd: string,
  port: number,
): Promise<{ child: ChildProcess; actualPort: number } | null> {
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
