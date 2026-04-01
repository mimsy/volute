import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoluteBin } from "../util/exec.js";
import { LAUNCHD_PLIST_LABEL, LAUNCHD_PLIST_PATH, USER_SYSTEMD_UNIT } from "./service-mode.js";

const execFileAsync = promisify(execFile);

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildServicePath(voluteBin: string): string {
  const binDir = dirname(voluteBin);
  const standardPaths = [
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];
  const parts = standardPaths.includes(binDir) ? standardPaths : [binDir, ...standardPaths];
  return parts.join(":");
}

export function generateUserPlist(
  voluteBin: string,
  opts?: { port?: number; host?: string },
): string {
  const args = ["up", "--foreground"];
  if (opts?.port != null) args.push("--port", String(opts.port));
  if (opts?.host) args.push("--host", opts.host);

  const logPath = resolve(homedir(), ".volute", "system", "daemon.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${[voluteBin, ...args].map((a) => `<string>${escapeXml(a)}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(buildServicePath(voluteBin))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>`;
}

export function generateUserUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  return `[Unit]
Description=Volute Daemon
After=network.target

[Service]
Type=exec
ExecStart=${voluteBin} ${args.join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * Install a user-level service (launchd on macOS, systemd on Linux).
 * Does not require root. Returns true on success.
 */
export async function installUserService(port?: number, host?: string): Promise<boolean> {
  const voluteBin = resolveVoluteBin();
  const platform = process.platform;
  if (platform === "darwin") {
    mkdirSync(resolve(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(LAUNCHD_PLIST_PATH, generateUserPlist(voluteBin, { port, host }));
    const uid = `gui/${process.getuid!()}`;
    try {
      await execFileAsync("launchctl", ["bootout", `${uid}/${LAUNCHD_PLIST_LABEL}`]);
    } catch {
      // May not be loaded — ignore
    }
    await execFileAsync("launchctl", ["bootstrap", uid, LAUNCHD_PLIST_PATH]);
    return true;
  } else if (platform === "linux") {
    mkdirSync(resolve(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(USER_SYSTEMD_UNIT, generateUserUnit(voluteBin, port, host));
    await execFileAsync("systemctl", ["--user", "enable", "--now", "volute"]);
    return true;
  }
  return false;
}
