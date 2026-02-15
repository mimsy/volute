import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoluteBin } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";

const execFileAsync = promisify(execFile);

const HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function validateHost(host: string): void {
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// macOS launchd
const PLIST_LABEL = "com.volute.daemon";
const plistPath = () => resolve(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);

function generatePlist(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${[voluteBin, ...args].map((a) => `<string>${escapeXml(a)}</string>`).join("\n    ")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${resolve(homedir(), ".volute", "daemon.log")}</string>
  <key>StandardErrorPath</key>
  <string>${resolve(homedir(), ".volute", "daemon.log")}</string>
</dict>
</plist>`;
}

// Linux systemd
const unitName = "volute.service";
const unitPath = () => resolve(homedir(), ".config", "systemd", "user", unitName);

function generateUnit(voluteBin: string, port?: number, host?: string): string {
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

async function install(port?: number, host?: string): Promise<void> {
  if (host) validateHost(host);
  const voluteBin = resolveVoluteBin();
  const platform = process.platform;

  if (platform === "darwin") {
    const path = plistPath();
    mkdirSync(resolve(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, generatePlist(voluteBin, port, host));
    console.log(`Wrote ${path}`);
    await execFileAsync("launchctl", ["load", path]);
    console.log("Service installed and loaded. Volute daemon will start on login.");
  } else if (platform === "linux") {
    if (process.getuid?.() === 0) {
      console.error(
        "Error: `volute service install` uses systemd user services, which don't work as root.",
      );
      console.error("Use `volute setup` instead to install a system-level service.");
      process.exit(1);
    }
    const path = unitPath();
    mkdirSync(resolve(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(path, generateUnit(voluteBin, port, host));
    console.log(`Wrote ${path}`);
    await execFileAsync("systemctl", ["--user", "enable", "--now", "volute"]);
    console.log("Service installed and enabled. Volute daemon will start on login.");
  } else {
    console.error(`Unsupported platform: ${platform}. Only macOS and Linux are supported.`);
    process.exit(1);
  }
}

async function uninstall(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    const path = plistPath();
    if (existsSync(path)) {
      try {
        await execFileAsync("launchctl", ["unload", path]);
      } catch {
        console.warn("Warning: failed to unload service (may already be unloaded)");
      }
      unlinkSync(path);
      console.log("Service uninstalled.");
    } else {
      console.log("Service not installed.");
    }
  } else if (platform === "linux") {
    const path = unitPath();
    if (existsSync(path)) {
      try {
        await execFileAsync("systemctl", ["--user", "disable", "--now", "volute"]);
      } catch {
        console.warn("Warning: failed to disable service (may already be stopped)");
      }
      unlinkSync(path);
      console.log("Service uninstalled.");
    } else {
      console.log("Service not installed.");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

async function status(): Promise<void> {
  const platform = process.platform;

  if (platform === "darwin") {
    if (!existsSync(plistPath())) {
      console.log("Service not installed.");
      return;
    }
    try {
      const { stdout } = await execFileAsync("launchctl", ["list", PLIST_LABEL]);
      console.log(stdout);
    } catch {
      console.log("Service installed but not currently loaded.");
    }
  } else if (platform === "linux") {
    if (!existsSync(unitPath())) {
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

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    port: { type: "number" },
    host: { type: "string" },
  });

  const subcommand = positional[0];

  switch (subcommand) {
    case "install":
      await install(flags.port, flags.host);
      break;
    case "uninstall":
      await uninstall();
      break;
    case "status":
      await status();
      break;
    default:
      console.log(`Usage:
  volute service install [--port N] [--host H]   Install as system service
  volute service uninstall                        Remove system service
  volute service status                           Check service status`);
      if (subcommand) {
        console.error(`\nUnknown subcommand: ${subcommand}`);
        process.exit(1);
      }
  }
}
