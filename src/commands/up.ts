import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";
import { voluteHome } from "../lib/registry.js";
import { getServiceMode, modeLabel, pollHealth, startService } from "../lib/service-mode.js";

type GlobalConfig = { hostname?: string; port?: number };

export function readGlobalConfig(): GlobalConfig {
  const configPath = resolve(voluteHome(), "config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Invalid config file ${configPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
    host: { type: "string" },
    foreground: { type: "boolean" },
  });

  const mode = getServiceMode();
  if (!flags.foreground && mode !== "manual") {
    console.log(`Starting volute (${modeLabel(mode)})...`);
    try {
      await startService(mode);
    } catch (err) {
      console.error(`Failed to start service: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    const config = readGlobalConfig();
    const h = flags.host ?? config.hostname ?? "127.0.0.1";
    const p = flags.port ?? config.port ?? 4200;
    if (await pollHealth(h, p)) {
      console.log(`Volute daemon running on ${h}:${p}`);
    } else {
      console.error("Service started but daemon did not become healthy within 30s.");
      process.exit(1);
    }
    return;
  }

  // Read defaults from config file, CLI flags override
  const config = readGlobalConfig();
  const port = flags.port ?? config.port ?? 4200;
  const hostname = flags.host ?? config.hostname ?? "127.0.0.1";
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

  // For health polling, use localhost when binding to all interfaces
  const pollHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;

  // Check if port is already responding (catches orphaned daemons with missing PID files)
  try {
    const res = await fetch(`http://${pollHost}:${port}/api/health`);
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && (body as { ok?: boolean }).ok) {
        console.error(
          `Port ${port} is already in use by a Volute daemon. Use 'volute down' first, or kill the process on that port.`,
        );
        process.exit(1);
      }
    }
  } catch {
    // Port not responding — good, we can proceed
  }

  if (flags.foreground) {
    const { startDaemon } = await import("../daemon.js");
    await startDaemon({ port, hostname, foreground: true });
    return;
  }

  // Find compiled daemon.js next to cli.js in dist/
  const daemonModule = resolve(dirname(new URL(import.meta.url).pathname), "daemon.js");
  if (!existsSync(daemonModule)) {
    console.error("Could not find daemon module. Run `npm run build` first.");
    process.exit(1);
  }

  // Spawn daemon as detached child process (daemon manages its own log rotation)
  mkdirSync(home, { recursive: true });
  const logFile = resolve(home, "daemon.log");
  const logFd = openSync(logFile, "a");

  const child = spawn(
    process.execPath,
    [daemonModule, "--port", String(port), "--host", hostname],
    {
      stdio: ["ignore", "ignore", logFd],
      detached: true,
    },
  );
  child.unref();

  // Poll health endpoint to confirm startup
  const url = `http://${pollHost}:${port}/api/health`;
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
