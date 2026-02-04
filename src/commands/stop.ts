import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: molt stop <name>");
    process.exit(1);
  }

  const { dir } = resolveAgent(name);
  const pidPath = resolve(dir, ".molt", "supervisor.pid");

  if (!existsSync(pidPath)) {
    console.error(`${name} is not running (no PID file found).`);
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0); // Check if alive
  } catch {
    try { unlinkSync(pidPath); } catch {}
    console.log(`${name} was not running (cleaned up stale PID file).`);
    return;
  }

  // Kill the process group (supervisor + child server) by sending signal to negative PID
  try {
    process.kill(-pid, "SIGTERM");
    console.log(`Sent SIGTERM to supervisor group (pid ${pid})`);
  } catch {
    // If group kill fails, fall back to killing just the supervisor
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to supervisor (pid ${pid})`);
  }

  // Wait for PID file to be removed (supervisor cleans up on exit)
  const maxWait = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (!existsSync(pidPath)) {
      console.log(`${name} stopped.`);
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
  console.error(`${name} did not exit cleanly, sent SIGKILL.`);
}
