import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { VOLUTE_HOME } from "../lib/registry.js";

export async function run(_args: string[]) {
  const pidPath = resolve(VOLUTE_HOME, "daemon.pid");

  if (!existsSync(pidPath)) {
    // Check if a daemon is running without a PID file (orphan)
    const configPath = resolve(VOLUTE_HOME, "daemon.json");
    let port = 4200;
    if (existsSync(configPath)) {
      try {
        port = JSON.parse(readFileSync(configPath, "utf-8")).port ?? 4200;
      } catch {}
    }
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) {
        console.error(`Daemon appears to be running on port ${port} but PID file is missing.`);
        console.error(`Kill the process manually: lsof -ti :${port} | xargs kill`);
        process.exit(1);
      }
    } catch {
      // Not responding either
    }
    console.error("Daemon is not running (no PID file found).");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0); // Check if alive
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {}
    console.log("Daemon was not running (cleaned up stale PID file).");
    return;
  }

  // Kill the process group
  try {
    process.kill(-pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon group (pid ${pid})`);
  } catch {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to daemon (pid ${pid})`);
  }

  // Wait for PID file to be removed (daemon cleans up on exit)
  const maxWait = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (!existsSync(pidPath)) {
      console.log("Daemon stopped.");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Force kill
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
  console.error("Daemon did not exit cleanly, sent SIGKILL.");
}
