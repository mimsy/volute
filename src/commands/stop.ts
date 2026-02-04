import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export async function run(_args: string[]) {
  const pidPath = resolve(process.cwd(), ".molt", "supervisor.pid");

  if (!existsSync(pidPath)) {
    console.error("No supervisor running (no PID file found).");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0); // Check if alive
  } catch {
    console.error(`Supervisor not running (stale PID file for pid ${pid}).`);
    process.exit(1);
  }

  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to supervisor (pid ${pid})`);

  // Wait for PID file to be removed (supervisor cleans up on exit)
  const maxWait = 10_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    if (!existsSync(pidPath)) {
      console.log("Supervisor stopped.");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
    console.error("Supervisor did not exit cleanly, sent SIGKILL.");
  } catch {
    // Already dead
  }
}
