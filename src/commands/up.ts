import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { command } from "@volute/cli/lib/command.js";
import {
  daemonLogReport,
  getServiceMode,
  HEALTH_POLL_TIMEOUT,
  modeLabel,
  pollHealth,
  startService,
} from "@volute/daemon/lib/config/service-mode.js";
import { readGlobalConfig } from "@volute/daemon/lib/config/setup.js";
import { voluteHome, voluteSystemDir } from "@volute/daemon/lib/mind/registry.js";

export type { GlobalConfig } from "@volute/daemon/lib/config/setup.js";
export { readGlobalConfig };

export type DaemonExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Build the message shown when the daemon never becomes healthy. When the child
 * process exited early we name the signal/exit code; otherwise it's a timeout.
 */
export function formatStartupFailure(exit: DaemonExit | null, timeoutMs: number): string {
  if (exit) {
    const cause = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
    return `Daemon exited (${cause}) before becoming healthy.`;
  }
  return `Daemon started but did not become healthy within ${Math.round(timeoutMs / 1000)}s.`;
}

const cmd = command({
  name: "volute up",
  description: "Start the daemon",
  flags: {
    port: { type: "number", description: "Port to listen on (default 1618)" },
    host: { type: "string", description: "Host to bind to (default 127.0.0.1)" },
    foreground: { type: "boolean", description: "Run in the foreground" },
    "no-sandbox": { type: "boolean", description: "Disable sandbox mode" },
    tailscale: { type: "boolean", description: "Enable Tailscale TLS" },
  },
  run: async ({ flags }) => {
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
      const p = flags.port ?? config.port ?? 1618;
      if (await pollHealth(h, p)) {
        console.log(`Volute daemon running on ${h}:${p}`);
      } else {
        console.error(
          `Service started but daemon did not become healthy within ${Math.round(
            HEALTH_POLL_TIMEOUT / 1000,
          )}s.`,
        );
        for (const line of daemonLogReport(mode)) console.error(line);
        process.exit(1);
      }
      return;
    }

    // Read defaults from config file, CLI flags override
    const config = readGlobalConfig();
    const port = flags.port ?? config.port ?? 1618;
    const hostname = flags.host ?? config.hostname ?? "127.0.0.1";
    const home = voluteHome();
    const systemDir = voluteSystemDir();
    const pidPath = resolve(systemDir, "daemon.pid");

    // Check for stale PID file
    if (existsSync(pidPath)) {
      try {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        process.kill(pid, 0);
        console.error(`Daemon already running (pid ${pid}). Use 'volute down' first.`);
        process.exit(1);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
          console.error(`Warning: could not check PID file: ${(err as Error).message}`);
        }
        // PID file is stale or unreadable, continue
      }
    }

    // For health polling, use localhost when binding to all interfaces
    const pollHost = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;

    // Resolve Tailscale hostname for display (certs are fetched by the daemon process)
    const useTailscale = flags.tailscale || config.tailscale;
    let tailscaleHostname: string | undefined;
    if (useTailscale) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("tailscale", ["status", "--json"]);
        const status = JSON.parse(stdout);
        tailscaleHostname = status.Self?.DNSName?.replace(/\.$/, "");
      } catch (err) {
        console.error(`Tailscale setup failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }

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

    // Set env var before importing daemon (foreground) or spawning it (background)
    if (flags["no-sandbox"]) {
      process.env.VOLUTE_SANDBOX = "0";
    }

    if (flags.foreground) {
      const { startDaemon } = await import("@volute/daemon");
      await startDaemon({ port, hostname, foreground: true, tailscale: useTailscale });
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
    mkdirSync(systemDir, { recursive: true });
    const logFile = resolve(systemDir, "daemon.log");
    const logFd = openSync(logFile, "a");

    const daemonArgs = [daemonModule, "--port", String(port), "--host", hostname];
    if (useTailscale) daemonArgs.push("--tailscale");
    if (flags["no-sandbox"]) daemonArgs.push("--no-sandbox");

    const child = spawn(process.execPath, daemonArgs, {
      stdio: ["ignore", "ignore", logFd],
      detached: true,
    });
    child.unref();

    // A spawn failure (e.g. the node binary is unlaunchable) emits 'error'; without a
    // listener Node re-throws it as an unhandled crash — the exact ugly first-run
    // failure #575 is about. Surface it cleanly instead.
    child.on("error", (err) => {
      console.error(`Failed to launch daemon: ${err.message}`);
      process.exit(1);
    });

    // Track an early exit so we can report a daemon that dies immediately instead of
    // waiting out the full health-poll timeout.
    let exitInfo: DaemonExit | null = null;
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
    });

    // Poll health endpoint to confirm startup (always HTTP on localhost)
    // When TLS is enabled, the internal HTTP listener is on port + 1
    const pollPort = useTailscale ? port + 1 : port;
    const url = `http://localhost:${pollPort}/api/health`;
    const maxWait = 30_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (exitInfo) break; // daemon died before becoming healthy — stop waiting
      try {
        const res = await fetch(url);
        if (res.ok) {
          const displayHost = tailscaleHostname ?? hostname;
          const displayProto = useTailscale ? "https" : "http";
          console.log(
            `Volute daemon running on ${displayProto}://${displayHost}:${port} (pid ${child.pid})`,
          );
          console.log(`Logs: ${logFile}`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Kill the daemon if it's still alive but never became healthy.
    if (!exitInfo && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {}
      }
    }

    // exitInfo is only ever assigned inside the child's `exit` callback, which
    // TypeScript's control-flow analysis can't track — hence the explicit read.
    const exited = exitInfo as DaemonExit | null;
    console.error(formatStartupFailure(exited, maxWait));

    // Surface the actual failure (npm/permission/port errors) inline instead of only a path.
    // This path only runs in `manual` mode, so the log is always daemon.log (== logFile).
    for (const line of daemonLogReport(mode)) console.error(line);
    process.exit(1);
  },
});

export const run = cmd.execute;
