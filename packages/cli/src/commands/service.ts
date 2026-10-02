import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import {
  installedSystemServiceFile,
  planServiceFile,
} from "@volute/daemon/lib/config/service-install.js";
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

/**
 * Reload systemd after `reconcile` has rewritten the unit. The file has already
 * changed by then, so a failed reload has to say so: a raw stack left the host unable
 * to tell whether the unit was touched (#1270).
 */
export async function reloadRewrittenUnit(
  path: string,
  run: (cmd: string, args: string[]) => Promise<unknown> = execFileAsync,
): Promise<void> {
  try {
    await run("systemctl", ["daemon-reload"]);
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const reason = (e.stderr || e.message || String(err)).trim();
    console.error(`Rewrote ${path}, but \`systemctl daemon-reload\` failed: ${reason}`);
    console.error(
      "systemd still has the old definition loaded. Reload it by hand: systemctl daemon-reload",
    );
    process.exit(1);
  }
}

/**
 * Bring the installed system service file up to date with what this version's setup
 * writes (#874, #1224). Setup is the only thing that ever writes it, so without this a
 * fix to the unit reaches new installs only.
 *
 * Applies only the known migrations (line removals); anything else that differs is
 * the host's and is shown, not changed. Reloads the definition but never restarts:
 * `volute update` runs this just before its own restart, and a host running it by
 * hand chooses when to interrupt the minds.
 */
async function reconcile(): Promise<void> {
  const installed = installedSystemServiceFile();
  if (!installed) {
    console.log("No system service installed; nothing to reconcile.");
    return;
  }
  if ("unreadable" in installed) {
    console.error(`Could not read ${installed.path} (${installed.unreadable}); left it alone.`);
    process.exit(1);
  }
  const plan = planServiceFile(installed.kind, installed.text);
  if (plan.status === "unrecognised") {
    console.error(
      `${installed.path} does not have the \`<absolute path> up --foreground\` command volute setup writes, so it was left alone.\n` +
        "To regenerate it, rerun `sudo volute setup --system`.",
    );
    process.exit(1);
  }
  if (!plan.rewrite && !plan.customised) {
    console.log(`${installed.path} is up to date.`);
    return;
  }
  if (plan.customised) {
    console.log(`${installed.path} is customised; these differences are not changed:`);
    for (const line of plan.customised.extra) console.log(`  here:        ${line}`);
    for (const line of plan.customised.missing) console.log(`  setup writes: ${line}`);
  }
  if (!plan.rewrite) return;

  console.log(`${installed.path} carries lines this version of volute no longer writes:`);
  for (const { line, why } of plan.migrated) console.log(`  - ${line}  (${why})`);
  if (process.getuid?.() !== 0) {
    console.error("Removing them needs root: sudo volute service reconcile");
    process.exit(1);
  }
  writeFileSync(installed.path, plan.rewrite);
  if (installed.kind === "systemd") await reloadRewrittenUnit(installed.path);
  console.log(
    `Removed them. The change takes effect when the service next restarts: volute restart`,
  );
}

const cmd = subcommands({
  name: "volute service",
  description: "Manage the system service",
  commands: {
    status: {
      description: "Check service status",
      run: async () => status(),
    },
    reconcile: {
      description: "Rewrite the system service file if this version would write it differently",
      run: async () => reconcile(),
    },
  },
});

export const run = cmd.execute;
