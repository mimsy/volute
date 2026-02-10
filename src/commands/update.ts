import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execInherit, resolveVoluteBin } from "../lib/exec.js";
import { voluteHome } from "../lib/registry.js";
import { checkForUpdate } from "../lib/update-check.js";

export async function run(_args: string[]) {
  const result = await checkForUpdate();
  console.log(`Current version: ${result.current}`);
  console.log(`Latest version:  ${result.latest}`);

  if (!result.updateAvailable) {
    console.log("\nAlready up to date.");
    return;
  }

  console.log(`\nUpdating volute ${result.current} → ${result.latest}...`);

  const home = voluteHome();
  const pidPath = resolve(home, "daemon.pid");
  const configPath = resolve(home, "daemon.json");

  // Check if daemon is running
  let daemonWasRunning = false;
  let daemonPort = 4200;
  let daemonHost = "127.0.0.1";

  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // Check if alive
      daemonWasRunning = true;
    } catch {
      // Not running, clean up stale PID
      try {
        unlinkSync(pidPath);
      } catch {}
    }
  }

  // Read daemon config for restart
  if (daemonWasRunning && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      daemonPort = config.port ?? 4200;
      daemonHost = config.hostname || "127.0.0.1";
    } catch {}
  }

  // Stop daemon if running
  if (daemonWasRunning) {
    console.log("Stopping daemon...");
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }

    // Wait for daemon to exit
    const maxWait = 10_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (!existsSync(pidPath)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Force kill if still alive
    if (existsSync(pidPath)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    console.log("Daemon stopped.");
  }

  // Run npm install
  try {
    await execInherit("npm", ["install", "-g", "volute@latest"]);
  } catch (err) {
    console.error(`\nUpdate failed: ${(err as Error).message}`);
    if (daemonWasRunning) {
      console.log("Restarting daemon with current version...");
      try {
        await execInherit(resolveVoluteBin(), [
          "up",
          "--port",
          String(daemonPort),
          "--host",
          daemonHost,
        ]);
      } catch {
        console.error("Failed to restart daemon. Run `volute up` manually.");
      }
    }
    process.exit(1);
  }

  // Restart daemon with new binary
  if (daemonWasRunning) {
    console.log("Restarting daemon...");
    try {
      // Use the newly installed binary
      await execInherit(resolveVoluteBin(), [
        "up",
        "--port",
        String(daemonPort),
        "--host",
        daemonHost,
      ]);
    } catch {
      console.error("Failed to restart daemon. Run `volute up` manually.");
    }
  }

  console.log(`\nUpdated to volute v${result.latest}`);
}
