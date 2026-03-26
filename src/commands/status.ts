import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { command } from "@volute/cli/lib/command.js";
import {
  getDaemonUrl,
  getServiceMode,
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  modeLabel,
  readDaemonConfig,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "@volute/daemon/lib/config/service-mode.js";
import { checkForUpdate } from "@volute/daemon/lib/update-check.js";

const execFileAsync = promisify(execFile);

const cmd = command({
  name: "volute status",
  description: "Show daemon status, version, and running minds",
  flags: {},
  run: async () => {
    const mode = getServiceMode();
    console.log(`Mode: ${modeLabel(mode)}`);

    const { hostname, port, internalPort, token } = readDaemonConfig();
    // Use internal HTTP port for API calls, user-facing port for display
    const apiPort = internalPort ?? port;
    const baseUrl = getDaemonUrl("127.0.0.1", apiPort);

    // Check health
    let running = false;
    let version: string | undefined;
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; version?: string };
        if (body.ok) {
          running = true;
          version = body.version;
        }
      }
    } catch {
      // Not running
    }

    if (!running) {
      console.log("Status: not running");
      return;
    }

    console.log(`Status: running on ${hostname}:${port}`);
    if (version) console.log(`Version: ${version}`);

    // Check for updates
    const update = await checkForUpdate();
    if (update.updateAvailable) {
      console.log(`Update available: ${update.current} → ${update.latest}`);
    }

    // Service details (for managed installs)
    if (mode !== "manual") {
      const serviceInfo = await getServiceInfo();
      if (serviceInfo) {
        console.log(`\nService:\n${serviceInfo}`);
      }
    }

    // List minds
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    headers.Origin = baseUrl;

    try {
      const res = await fetch(`${baseUrl}/api/minds`, { headers });
      if (res.ok) {
        const minds = (await res.json()) as Array<{
          name: string;
          running: boolean;
          status?: string;
          stage?: string;
        }>;
        if (minds.length > 0) {
          console.log(`\nMinds (${minds.length}):`);
          for (const mind of minds) {
            const status = mind.status ?? (mind.running ? "running" : "stopped");
            const label = mind.stage === "seed" ? " (seed)" : "";
            console.log(`  ${mind.name}: ${status}${label}`);
          }
        } else {
          console.log("\nNo minds configured.");
        }
      }
    } catch {
      // Couldn't fetch minds — not critical
    }
  },
});

export const run = cmd.execute;

async function getServiceInfo(): Promise<string | null> {
  const platform = process.platform;

  if (platform === "darwin") {
    const plistPath = existsSync(SYSTEM_LAUNCHD_PLIST_PATH)
      ? SYSTEM_LAUNCHD_PLIST_PATH
      : existsSync(LAUNCHD_PLIST_PATH)
        ? LAUNCHD_PLIST_PATH
        : null;
    if (!plistPath) return null;
    try {
      const { stdout } = await execFileAsync("launchctl", ["list", LAUNCHD_PLIST_LABEL]);
      return stdout.trim();
    } catch {
      return "Service installed but not currently loaded.";
    }
  }

  if (platform === "linux") {
    const unitPath = existsSync(SYSTEM_SERVICE_PATH)
      ? "system"
      : existsSync(USER_SYSTEMD_UNIT)
        ? "user"
        : null;
    if (!unitPath) return null;
    const args =
      unitPath === "system"
        ? ["status", "volute", "--no-pager"]
        : ["--user", "status", "volute", "--no-pager"];
    try {
      const { stdout } = await execFileAsync("systemctl", args);
      return stdout.trim();
    } catch (err) {
      const e = err as { stdout?: string };
      if (e.stdout) return e.stdout.trim();
      return "Service installed but status unknown.";
    }
  }

  return null;
}
