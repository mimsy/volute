import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoluteBin } from "../lib/exec.js";
import { ensureVoluteGroup } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";
import { promptLine } from "../lib/prompt.js";
import {
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "../lib/service-mode.js";
import {
  type GlobalConfig,
  type IsolationMode,
  readGlobalConfig,
  type SetupConfig,
  type SetupType,
  writeGlobalConfig,
} from "../lib/setup.js";

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

// --- Service installation helpers ---

function generatePlist(
  voluteBin: string,
  opts: { port?: number; host?: string; system?: boolean },
): string {
  const args = ["up", "--foreground"];
  if (opts.port != null) args.push("--port", String(opts.port));
  if (opts.host) args.push("--host", opts.host);

  const logPath = opts.system
    ? "/var/lib/volute/system/daemon.log"
    : resolve(homedir(), ".volute", "system", "daemon.log");

  const envEntries: string[] = [
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    `    <key>PATH</key>`,
    `    <string>${escapeXml(buildServicePath(voluteBin))}</string>`,
  ];
  if (opts.system) {
    envEntries.push(
      "    <key>VOLUTE_HOME</key>",
      "    <string>/var/lib/volute</string>",
      "    <key>VOLUTE_MINDS_DIR</key>",
      "    <string>/minds</string>",
      "    <key>VOLUTE_ISOLATION</key>",
      "    <string>user</string>",
    );
  }
  envEntries.push("  </dict>");

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
${envEntries.join("\n")}
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

function generateUserUnit(voluteBin: string, port?: number, host?: string): string {
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

function generateSystemUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  const home = homedir();
  const binUnderHome = voluteBin.startsWith(`${home}/`);
  const lines = [
    "[Unit]",
    "Description=Volute Mind Manager",
    "After=network.target",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${voluteBin} ${args.join(" ")}`,
    `Environment=PATH=${buildServicePath(voluteBin)}`,
    "Environment=VOLUTE_HOME=/var/lib/volute",
    "Environment=VOLUTE_MINDS_DIR=/minds",
    "Environment=VOLUTE_ISOLATION=user",
    "Restart=on-failure",
    "RestartSec=5",
    "ProtectSystem=true",
    "ReadWritePaths=/var/lib/volute /minds",
    "PrivateTmp=yes",
  ];

  if (!binUnderHome) {
    lines.push("ProtectHome=yes");
  }

  lines.push("RestrictSUIDSGID=yes", "", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

// --- Setup steps ---

const DATA_DIR = "/var/lib/volute";
const MINDS_DIR = "/minds";
const PROFILE_PATH = "/etc/profile.d/volute.sh";
const WRAPPER_PATH = "/usr/local/bin/volute";

async function installUserService(
  voluteBin: string,
  port?: number,
  host?: string,
): Promise<boolean> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      mkdirSync(resolve(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(LAUNCHD_PLIST_PATH, generatePlist(voluteBin, { port, host }));
      console.log(`  Wrote ${LAUNCHD_PLIST_PATH}`);
      await execFileAsync("launchctl", ["load", LAUNCHD_PLIST_PATH]);
      console.log("  Service installed (launchd)");
      return true;
    } else if (platform === "linux") {
      mkdirSync(resolve(homedir(), ".config", "systemd", "user"), { recursive: true });
      writeFileSync(USER_SYSTEMD_UNIT, generateUserUnit(voluteBin, port, host));
      console.log(`  Wrote ${USER_SYSTEMD_UNIT}`);
      await execFileAsync("systemctl", ["--user", "enable", "--now", "volute"]);
      console.log("  Service installed (systemd user)");
      return true;
    }
  } catch (err) {
    console.warn(
      `  Warning: failed to install service: ${err instanceof Error ? err.message : err}`,
    );
  }
  return false;
}

function installSystemService(voluteBin: string, port?: number, host?: string): boolean {
  const platform = process.platform;
  if (platform === "darwin") {
    writeFileSync(
      SYSTEM_LAUNCHD_PLIST_PATH,
      generatePlist(voluteBin, { port, host: host ?? "0.0.0.0", system: true }),
    );
    console.log(`  Wrote ${SYSTEM_LAUNCHD_PLIST_PATH}`);
    try {
      execFileSync("launchctl", ["load", SYSTEM_LAUNCHD_PLIST_PATH]);
      console.log("  Service installed (LaunchDaemon)");
      return true;
    } catch (err) {
      console.warn(
        `  Warning: failed to load LaunchDaemon: ${err instanceof Error ? err.message : err}`,
      );
      console.warn("  Try: sudo launchctl load /Library/LaunchDaemons/com.volute.daemon.plist");
      return false;
    }
  } else if (platform === "linux") {
    writeFileSync(SYSTEM_SERVICE_PATH, generateSystemUnit(voluteBin, port, host ?? "0.0.0.0"));
    console.log(`  Wrote ${SYSTEM_SERVICE_PATH}`);
    try {
      execFileSync("systemctl", ["daemon-reload"]);
      execFileSync("systemctl", ["enable", "--now", "volute"]);
      console.log("  Service installed (systemd)");
      return true;
    } catch (err) {
      console.warn(
        `  Warning: failed to enable service: ${err instanceof Error ? err.message : err}`,
      );
      console.warn("  Try: systemctl daemon-reload && systemctl enable --now volute");
      return false;
    }
  }
  return false;
}

function setupSystemDirectories(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`  Created ${DATA_DIR}`);
  mkdirSync(MINDS_DIR, { recursive: true });
  console.log(`  Created ${MINDS_DIR}`);

  execFileSync("chmod", ["755", DATA_DIR]);
  execFileSync("chmod", ["755", MINDS_DIR]);
}

function setupSystemGitIdentity(): void {
  try {
    execFileSync("git", ["config", "--system", "user.name"]);
    console.log("  System git identity already configured");
  } catch {
    try {
      execFileSync("git", ["config", "--system", "user.name", "Volute"]);
      execFileSync("git", ["config", "--system", "user.email", "volute@localhost"]);
      console.log("  Configured system git identity");
    } catch (err) {
      console.warn(
        `  Warning: failed to set system git config: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

function setupSystemWrapper(voluteBin: string): void {
  const binDir = dirname(voluteBin);
  if (voluteBin !== WRAPPER_PATH && !voluteBin.startsWith("/usr/bin")) {
    const wrapper = `#!/bin/sh\nexport PATH="${binDir}:$PATH"\nexport VOLUTE_HOME="${DATA_DIR}"\nexport VOLUTE_MINDS_DIR="${MINDS_DIR}"\nexec "${voluteBin}" "$@"\n`;
    writeFileSync(WRAPPER_PATH, wrapper, { mode: 0o755 });
    console.log(`  Wrote ${WRAPPER_PATH}`);
  }
}

function setupSystemEnvProfile(): void {
  if (process.platform === "linux") {
    writeFileSync(
      PROFILE_PATH,
      `export VOLUTE_HOME=${DATA_DIR}\nexport VOLUTE_MINDS_DIR=${MINDS_DIR}\n`,
    );
    console.log(`  Wrote ${PROFILE_PATH}`);
  }
}

// --- Main ---

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    name: { type: "string" },
    system: { type: "boolean" },
    service: { type: "boolean" },
    dir: { type: "string" },
    port: { type: "number" },
    host: { type: "string" },
  });

  // Determine interactive vs non-interactive
  const isInteractive = !flags.name && process.stdin.isTTY;

  let systemName: string;
  let setupType: SetupType;
  let wantService: boolean;
  const port = flags.port;
  const host = flags.host;

  if (isInteractive) {
    console.log("Welcome to Volute!\n");

    systemName = await promptLine("System name: ");
    if (!systemName.trim()) {
      console.error("System name is required.");
      process.exit(1);
    }
    systemName = systemName.trim();

    console.log("\nInstall type:");
    console.log("  1. Local (minds in ~/.volute/minds/, sandbox isolation)");
    console.log("  2. System (minds in /minds, per-user isolation, requires sudo)");
    const typeChoice = await promptLine("> ");
    setupType = typeChoice.trim() === "2" ? "system" : "local";

    if (setupType === "system" && process.getuid?.() !== 0) {
      console.error("\nSystem install requires root. Re-run with sudo.");
      process.exit(1);
    }

    const serviceDefault = setupType === "system" ? "Y/n" : "y/N";
    const servicePrompt = `\nInstall as a service (auto-start on boot)? [${serviceDefault}]: `;
    const serviceAnswer = (await promptLine(servicePrompt)).trim().toLowerCase();
    if (setupType === "system") {
      wantService = serviceAnswer !== "n";
    } else {
      wantService = serviceAnswer === "y" || serviceAnswer === "yes";
    }
  } else {
    // Non-interactive mode
    if (!flags.name) {
      console.error("Error: --name is required in non-interactive mode.");
      console.error("Usage: volute setup --name <name> [--system] [--service] [--dir <path>]");
      process.exit(1);
    }
    systemName = flags.name;
    setupType = flags.system ? "system" : "local";
    wantService = flags.service ?? setupType === "system";

    if (setupType === "system" && process.getuid?.() !== 0) {
      console.error("Error: system install requires root (use sudo).");
      process.exit(1);
    }
  }

  if (host) validateHost(host);

  console.log("\nSetting up...");

  let isolation: IsolationMode;
  let mindsDir: string;
  let configHome: string;

  if (setupType === "system") {
    configHome = DATA_DIR;
    mindsDir = MINDS_DIR;
    isolation = "user";

    // Set VOLUTE_HOME for system installs
    process.env.VOLUTE_HOME = DATA_DIR;
    process.env.VOLUTE_MINDS_DIR = MINDS_DIR;

    setupSystemDirectories();
    ensureVoluteGroup({ force: true });
    console.log("  Ensured volute group exists");
    setupSystemGitIdentity();

    const voluteBin = resolveVoluteBin();
    setupSystemWrapper(voluteBin);
    setupSystemEnvProfile();

    if (wantService) {
      if (!installSystemService(voluteBin, port, host)) wantService = false;
    }
  } else {
    // Local setup
    configHome = flags.dir ? resolve(flags.dir) : resolve(homedir(), ".volute");
    if (flags.dir) {
      process.env.VOLUTE_HOME = configHome;
    }
    mindsDir = resolve(configHome, "minds");
    isolation = "sandbox";

    mkdirSync(configHome, { recursive: true });
    console.log(`  Created ${configHome}`);
    mkdirSync(mindsDir, { recursive: true });
    console.log("  Sandbox enabled for mind isolation");

    if (wantService) {
      const voluteBin = resolveVoluteBin();
      if (!(await installUserService(voluteBin, port, host))) wantService = false;
    }
  }

  // Write config
  const existingConfig = readGlobalConfig();
  const setup: SetupConfig = {
    type: setupType,
    mindsDir,
    isolation,
    service: wantService,
  };

  const config: GlobalConfig = {
    ...existingConfig,
    name: systemName,
    setup,
  };
  if (port != null) config.port = port;
  if (host) config.hostname = host;

  writeGlobalConfig(config);

  console.log(`\nDone! Use \`volute mind create <name>\` to create your first mind.`);
}
