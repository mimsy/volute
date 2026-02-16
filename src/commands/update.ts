import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { exec, execInherit, resolveVoluteBin } from "../lib/exec.js";
import { voluteHome } from "../lib/registry.js";
import {
  getServiceMode,
  modeLabel,
  pollHealth,
  readDaemonConfig,
  restartService,
} from "../lib/service-mode.js";
import { checkForUpdate } from "../lib/update-check.js";

export async function run(_args: string[]) {
  const result = await checkForUpdate(true);
  if (result.checkFailed) {
    console.error("Could not reach npm registry. Check your network connection and try again.");
    process.exit(1);
  }
  console.log(`Current version: ${result.current}`);
  console.log(`Latest version:  ${result.latest}`);

  if (!result.updateAvailable) {
    console.log("\nAlready up to date.");
    return;
  }

  console.log(`\nUpdating volute ${result.current} → ${result.latest}...`);

  const mode = getServiceMode();

  if (mode === "system") {
    // System service: use /usr/bin/npm (fall back to which npm) with sudo
    let npmPath = "/usr/bin/npm";
    if (!existsSync(npmPath)) {
      try {
        npmPath = (await exec("which", ["npm"])).trim();
      } catch {
        console.error("Could not find npm. Install npm and try again.");
        process.exit(1);
      }
    }
    try {
      await execInherit("sudo", [npmPath, "install", "-g", "volute@latest"]);
    } catch (err) {
      console.error(`\nUpdate failed: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log("Restarting service...");
    try {
      await restartService(mode);
    } catch (err) {
      console.error(`Failed to restart: ${err instanceof Error ? err.message : err}`);
      console.error("Try: sudo systemctl restart volute");
      process.exit(1);
    }
    {
      const { hostname, port } = readDaemonConfig();
      if (await pollHealth(hostname, port)) {
        console.log(`\nUpdated to volute v${result.latest}`);
      } else {
        console.error("Service restarted but daemon did not become healthy.");
        process.exit(1);
      }
    }
    return;
  }

  if (mode === "user-systemd" || mode === "user-launchd") {
    // User service: npm install (no sudo), then restart service
    try {
      await execInherit("npm", ["install", "-g", "volute@latest"]);
    } catch (err) {
      console.error(`\nUpdate failed: ${(err as Error).message}`);
      process.exit(1);
    }
    console.log(`Restarting service (${modeLabel(mode)})...`);
    try {
      await restartService(mode);
    } catch (err) {
      console.error(`Failed to restart: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    {
      const { hostname, port } = readDaemonConfig();
      if (await pollHealth(hostname, port)) {
        console.log(`\nUpdated to volute v${result.latest}`);
      } else {
        console.error("Service restarted but daemon did not become healthy.");
        process.exit(1);
      }
    }
    return;
  }

  // Manual mode: stop → install → restart (existing logic)
  const home = voluteHome();
  const pidPath = resolve(home, "daemon.pid");
  const configPath = resolve(home, "daemon.json");

  let daemonWasRunning = false;
  let daemonPort = 4200;
  let daemonHost = "127.0.0.1";

  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      daemonWasRunning = true;
    } catch {
      try {
        unlinkSync(pidPath);
      } catch {}
    }
  }

  if (daemonWasRunning && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      daemonPort = config.port ?? 4200;
      daemonHost = config.hostname || "127.0.0.1";
    } catch {
      console.error("Warning: could not read daemon config, using default port/host");
    }
  }

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

    const maxWait = 10_000;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (!existsSync(pidPath)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (existsSync(pidPath)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }

    if (existsSync(pidPath)) {
      try {
        const stalePid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        process.kill(stalePid, 0);
        console.error("Warning: daemon process may still be running. Aborting update.");
        process.exit(1);
      } catch {
        try {
          unlinkSync(pidPath);
        } catch {}
      }
    }

    console.log("Daemon stopped.");
  }

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

  if (daemonWasRunning) {
    console.log("Restarting daemon...");
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

  console.log(`\nUpdated to volute v${result.latest}`);
}
