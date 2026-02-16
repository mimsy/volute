import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { voluteHome } from "../lib/registry.js";

function isSystemdServiceEnabled(): boolean {
  try {
    execFileSync("systemctl", ["is-enabled", "--quiet", "volute"]);
    return true;
  } catch {
    return false;
  }
}

export type StopResult =
  | { stopped: true; clean: boolean }
  | { stopped: false; reason: "not-running" | "orphan" | "systemd" | "kill-failed"; port?: number };

/**
 * Attempts to stop the running daemon. Returns a result instead of calling process.exit(),
 * so callers can decide how to handle each case.
 */
export async function stopDaemon(): Promise<StopResult> {
  if (isSystemdServiceEnabled()) {
    return { stopped: false, reason: "systemd" };
  }

  const home = voluteHome();
  const pidPath = resolve(home, "daemon.pid");

  if (!existsSync(pidPath)) {
    // Check if a daemon is running without a PID file (orphan)
    const configPath = resolve(home, "daemon.json");
    let port = 4200;
    let hostname = "localhost";
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        port = config.port ?? 4200;
        hostname = config.hostname || "localhost";
      } catch {}
    }
    try {
      const url = new URL("http://localhost");
      url.hostname = hostname;
      url.port = String(port);
      const res = await fetch(`${url.origin}/api/health`);
      if (res.ok) {
        return { stopped: false, reason: "orphan", port };
      }
    } catch {
      // Not responding either
    }
    return { stopped: false, reason: "not-running" };
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  if (!Number.isInteger(pid) || pid <= 0) {
    console.error(`Stale or corrupt PID file (${pidPath}), removing.`);
    try {
      unlinkSync(pidPath);
    } catch {}
    return { stopped: false, reason: "not-running" };
  }

  try {
    process.kill(pid, 0); // Check if alive
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {}
    console.log("Daemon was not running (cleaned up stale PID file).");
    return { stopped: false, reason: "not-running" };
  }

  // Kill the process group
  try {
    process.kill(-pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon group (pid ${pid})`);
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to daemon (pid ${pid})`);
    } catch (e) {
      console.error(
        `Failed to send SIGTERM to daemon (pid ${pid}): ${e instanceof Error ? e.message : e}`,
      );
      return { stopped: false, reason: "kill-failed", port: pid };
    }
  }

  // Wait for PID file to be removed (daemon cleans up on exit)
  const maxWait = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (!existsSync(pidPath)) {
      console.log("Daemon stopped.");
      return { stopped: true, clean: true };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Force kill
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e) {
      console.error(
        `Failed to force-kill daemon (pid ${pid}): ${e instanceof Error ? e.message : e}`,
      );
      console.error(`The daemon may still be running. Kill it manually: kill -9 ${pid}`);
      return { stopped: false, reason: "kill-failed" };
    }
  }

  // SIGKILL is uncatchable so the daemon's exit handler won't clean up
  try {
    unlinkSync(pidPath);
  } catch {}

  // Brief delay to let the kernel reap the process
  await new Promise((r) => setTimeout(r, 500));

  console.error("Daemon did not exit cleanly, sent SIGKILL.");
  return { stopped: true, clean: false };
}

export async function run(_args: string[]) {
  const result = await stopDaemon();

  if (result.stopped) return;

  if (result.reason === "systemd") {
    const client = getClient();
    await daemonFetch(urlOf(client.api.system.stop.$url()), { method: "POST" });
    console.log("Daemon stopped.");
    return;
  } else if (result.reason === "orphan") {
    console.error(`Daemon appears to be running on port ${result.port} but PID file is missing.`);
    console.error(`Kill the process manually: lsof -ti :${result.port} | xargs kill`);
  } else if (result.reason === "not-running") {
    console.error("Daemon is not running (no PID file found).");
  }
  process.exit(1);
}
