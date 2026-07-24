import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "@volute/daemon/lib/config/service-mode.js";
import { subcommands } from "../lib/command.js";

const execFileAsync = promisify(execFile);

async function status(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    // Check system-level LaunchDaemon first
    if (existsSync(SYSTEM_LAUNCHD_PLIST_PATH)) {
      try {
        const { stdout } = await execFileAsync("launchctl", ["list", LAUNCHD_PLIST_LABEL]);
        console.log("System service (LaunchDaemon):");
        console.log(stdout);
      } catch {
        console.log("System service installed but not currently loaded.");
      }
      return;
    }
    if (!existsSync(LAUNCHD_PLIST_PATH)) {
      console.log("Service not installed.");
      return;
    }
    try {
      const { stdout } = await execFileAsync("launchctl", ["list", LAUNCHD_PLIST_LABEL]);
      console.log(stdout);
    } catch {
      console.log("Service installed but not currently loaded.");
    }
  } else if (platform === "linux") {
    // Check for system-level service first
    if (existsSync(SYSTEM_SERVICE_PATH)) {
      try {
        const { stdout } = await execFileAsync("systemctl", ["status", "volute", "--no-pager"]);
        console.log(stdout);
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        if (e.stdout) {
          console.log(e.stdout);
        } else {
          console.error("System service installed but could not retrieve status.");
          if (e.stderr) console.error(e.stderr);
          else if (e.message) console.error(e.message);
          console.error("Try running: systemctl status volute");
        }
      }
      return;
    }
    if (!existsSync(USER_SYSTEMD_UNIT)) {
      console.log("Service not installed.");
      return;
    }
    try {
      const { stdout } = await execFileAsync("systemctl", [
        "--user",
        "status",
        "volute",
        "--no-pager",
      ]);
      console.log(stdout);
    } catch (err) {
      const e = err as { stdout?: string };
      // systemctl status exits non-zero when service is inactive
      if (e.stdout) console.log(e.stdout);
      else console.log("Service installed but status unknown.");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

const cmd = subcommands({
  name: "volute service",
  description: "Manage the system service",
  commands: {
    status: {
      description: "Check service status",
      run: async () => status(),
    },
  },
});

export const run = cmd.execute;
