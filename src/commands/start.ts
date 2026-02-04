import { spawn } from "child_process";
import { existsSync, readFileSync, mkdirSync, openSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    foreground: { type: "boolean" },
    dev: { type: "boolean" },
    port: { type: "number" },
  });

  const supervisorPath = resolve(process.cwd(), "supervisor.ts");

  if (!existsSync(supervisorPath)) {
    console.error("No supervisor.ts found. Are you in an agent project directory?");
    process.exit(1);
  }

  const port = flags.port ?? 4100;

  // Check if already running
  const pidPath = resolve(process.cwd(), ".molt", "supervisor.pid");
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0); // Check if process exists
      console.error(`Supervisor already running (pid ${pid}). Use 'molt stop' first.`);
      process.exit(1);
    } catch {
      // PID file is stale, continue
    }
  }

  const tsxBin = resolve(process.cwd(), "node_modules", ".bin", "tsx");
  const supervisorArgs = flags.dev ? [supervisorPath, "--dev"] : [supervisorPath];
  if (flags.port) {
    supervisorArgs.push("--port", String(flags.port));
  }

  if (flags.foreground) {
    const child = spawn(tsxBin, supervisorArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }

  // Daemon mode: redirect output to log file
  const logsDir = resolve(process.cwd(), ".molt", "logs");
  mkdirSync(logsDir, { recursive: true });

  const logFile = resolve(logsDir, "supervisor.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(tsxBin, supervisorArgs, {
    cwd: process.cwd(),
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
        console.log(`Logs: .molt/logs/supervisor.log`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.error("Supervisor started but server did not become healthy within 30s.");
  console.error(`Check logs: .molt/logs/supervisor.log`);
  process.exit(1);
}
