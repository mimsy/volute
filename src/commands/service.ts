import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { subcommands } from "../lib/command.js";
import {
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "../lib/service-mode.js";

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
    install: {
      description: "(deprecated) Use 'volute setup' instead",
      run: async () => {
        console.log("'volute service install' has been replaced by 'volute setup'.");
        console.log("Run `volute setup` to configure your installation.");
      },
    },
    uninstall: {
      description: "(deprecated) Use 'volute setup' instead",
      run: async () => {
        console.log("'volute service uninstall' has been replaced by 'volute setup'.");
        console.log("To uninstall the service, remove the service file manually:");
        if (process.platform === "darwin") {
          console.log("  launchctl unload ~/Library/LaunchAgents/com.volute.daemon.plist");
          console.log("  rm ~/Library/LaunchAgents/com.volute.daemon.plist");
        } else {
          console.log("  systemctl --user disable --now volute");
          console.log("  rm ~/.config/systemd/user/volute.service");
        }
      },
    },
  },
});

export const run = cmd.execute;
