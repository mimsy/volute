import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";
import { voluteHome } from "../lib/registry.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
    host: { type: "string" },
    foreground: { type: "boolean" },
  });

  const port = flags.port ?? 4200;
  const hostname = flags.host ?? "127.0.0.1";
  const home = voluteHome();
  const pidPath = resolve(home, "daemon.pid");

  // Check for stale PID file
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.error(`Daemon already running (pid ${pid}). Use 'volute down' first.`);
      process.exit(1);
    } catch {
      // PID file is stale, continue
    }
  }

  // Check if port is already responding (catches orphaned daemons with missing PID files)
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    if (res.ok) {
      console.error(
        `Port ${port} is already in use by a Volute daemon. Use 'volute down' first, or kill the process on that port.`,
      );
      process.exit(1);
    }
  } catch {
    // Port not responding — good, we can proceed
  }

  if (flags.foreground) {
    const { startDaemon } = await import("../daemon.js");
    await startDaemon({ port, hostname, foreground: true });
    return;
  }

  // Find tsx from the volute project's own node_modules
  let tsxBin = "";
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) {
      tsxBin = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (!tsxBin) {
    console.error("Could not find tsx binary.");
    process.exit(1);
  }

  // Find daemon.ts source
  let daemonModule = "";
  searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "src", "daemon.ts");
    if (existsSync(candidate)) {
      daemonModule = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (!daemonModule) {
    console.error("Could not find daemon module.");
    process.exit(1);
  }

  // Spawn daemon as detached child process
  mkdirSync(home, { recursive: true });
  const logFile = resolve(home, "daemon.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(tsxBin, [daemonModule, "--port", String(port), "--host", hostname], {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  // Poll health endpoint to confirm startup
  const url = `http://localhost:${port}/api/health`;
  const maxWait = 30_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`Volute daemon running on ${hostname}:${port} (pid ${child.pid})`);
        console.log(`Logs: ${logFile}`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Kill the daemon since it never became healthy
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
  }

  console.error("Daemon started but did not become healthy within 30s.");
  console.error(`Check logs: ${logFile}`);
  process.exit(1);
}
