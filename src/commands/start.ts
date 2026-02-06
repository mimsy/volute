import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    foreground: { type: "boolean" },
    dev: { type: "boolean" },
  });

  const name = positional[0];
  if (!name) {
    console.error("Usage: volute start <name> [--foreground] [--dev]");
    process.exit(1);
  }

  const { entry, dir } = resolveAgent(name);
  const port = entry.port;

  // Check if already running
  const pidPath = resolve(dir, ".volute", "supervisor.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.error(`${name} already running (pid ${pid}). Use 'volute stop ${name}' first.`);
      process.exit(1);
    } catch {
      // PID file is stale, continue
    }
  }

  // Check if port is available
  const portFree = await checkPort(port);
  if (!portFree) {
    console.error(`Port ${port} is already in use.`);
    console.error(
      `Another agent or process may be running. Use 'volute stop ${name}' or check with: lsof -i :${port}`,
    );
    process.exit(1);
  }

  // Find the supervisor module — run it via tsx from the volute CLI source
  let supervisorModule = "";
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "src", "lib", "supervisor.ts");
    if (existsSync(candidate)) {
      supervisorModule = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  // Fallback: look relative to current file for built mode
  if (!supervisorModule) {
    // In built mode, supervisor.ts is bundled — we spawn a small inline script
    supervisorModule = resolve(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "lib",
      "supervisor.ts",
    );
  }

  // We spawn a small bootstrap script that imports and runs the supervisor
  const tsxBin = resolve(dir, "node_modules", ".bin", "tsx");
  const bootstrapCode = `
    import { runSupervisor } from ${JSON.stringify(supervisorModule)};
    runSupervisor({
      agentName: ${JSON.stringify(name)},
      agentDir: ${JSON.stringify(dir)},
      port: ${port},
      dev: ${flags.dev ? "true" : "false"},
    });
  `;

  if (flags.foreground) {
    const child = spawn(tsxBin, ["--eval", bootstrapCode], {
      cwd: dir,
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  // Daemon mode: redirect output to log file
  const logsDir = resolve(dir, ".volute", "logs");
  mkdirSync(logsDir, { recursive: true });

  const logFile = resolve(logsDir, "supervisor.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(tsxBin, ["--eval", bootstrapCode], {
    cwd: dir,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  // Poll health endpoint to confirm startup
  const url = `http://localhost:${port}/health`;
  const maxWait = 30_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { name: string; version: string };
        console.log(`${data.name} running on port ${port} (pid ${child.pid})`);
        console.log(`Logs: volute logs ${name}`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Kill the supervisor since the server never became healthy
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
  }

  console.error("Supervisor started but server did not become healthy within 30s.");
  console.error(`Check logs: volute logs ${name}`);
  process.exit(1);
}
