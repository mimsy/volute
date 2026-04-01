import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { command } from "@volute/cli/lib/command.js";
import { promptLine } from "@volute/cli/lib/prompt.js";
import { installUserService } from "@volute/daemon/lib/config/service-install.js";
import {
  LAUNCHD_PLIST_LABEL,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
} from "@volute/daemon/lib/config/service-mode.js";
import {
  type GlobalConfig,
  type IsolationMode,
  readGlobalConfig,
  type SetupConfig,
  type SetupType,
  writeGlobalConfig,
} from "@volute/daemon/lib/config/setup.js";
import { ensureVoluteGroup } from "@volute/daemon/lib/mind/isolation.js";
import { resolveVoluteBin } from "@volute/daemon/lib/util/exec.js";

const HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function validateHost(host: string): void {
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- System service installation helpers (require root) ---

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

function generateSystemPlist(voluteBin: string, opts?: { port?: number; host?: string }): string {
  const args = ["up", "--foreground"];
  if (opts?.port != null) args.push("--port", String(opts.port));
  if (opts?.host) args.push("--host", opts.host);

  const logPath = "/var/lib/volute/system/daemon.log";

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
    <key>VOLUTE_HOME</key>
    <string>/var/lib/volute</string>
    <key>VOLUTE_MINDS_DIR</key>
    <string>${MINDS_DIR}</string>
    <key>VOLUTE_ISOLATION</key>
    <string>user</string>
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
const MINDS_DIR = process.platform === "darwin" ? "/var/lib/volute/minds" : "/minds";
const PROFILE_PATH = "/etc/profile.d/volute.sh";
const WRAPPER_PATH = "/usr/local/bin/volute";

function installSystemService(voluteBin: string, port?: number, host?: string): boolean {
  const platform = process.platform;
  if (platform === "darwin") {
    writeFileSync(
      SYSTEM_LAUNCHD_PLIST_PATH,
      generateSystemPlist(voluteBin, { port, host: host ?? "0.0.0.0" }),
    );
    console.log(`  Wrote ${SYSTEM_LAUNCHD_PLIST_PATH}`);
    try {
      try {
        execFileSync("launchctl", ["bootout", `system/${LAUNCHD_PLIST_LABEL}`]);
      } catch {
        // May not be loaded — ignore
      }
      execFileSync("launchctl", ["bootstrap", "system", SYSTEM_LAUNCHD_PLIST_PATH]);
      console.log("  Service installed (LaunchDaemon)");
      return true;
    } catch (err) {
      console.warn(
        `  Warning: failed to load LaunchDaemon: ${err instanceof Error ? err.message : err}`,
      );
      console.warn(
        "  Try: sudo launchctl bootstrap system /Library/LaunchDaemons/com.volute.daemon.plist",
      );
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

// --- Shared helpers ---

async function startDaemonAndOpenBrowser(port?: number, host?: string): Promise<void> {
  const displayPort = port ?? 1618;
  const displayHost = host ?? "127.0.0.1";
  const url = `http://${displayHost === "0.0.0.0" || displayHost === "::" ? "localhost" : displayHost}:${displayPort}`;

  console.log("\nStarting daemon...");
  try {
    const { run: runUp } = await import("./up.js");
    await runUp([
      ...(port != null ? ["--port", String(port)] : []),
      ...(host ? ["--host", host] : []),
    ]);

    // Open browser (best-effort)
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(openCmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch (err) {
    console.error(`\nFailed to start daemon: ${err instanceof Error ? err.message : err}`);
    console.error("You can start it manually with: volute up");
  }

  console.log(`\nOpen ${url} to continue setup.`);
}

// --- Command ---

const cmd = command({
  name: "volute setup",
  description: "First-time Volute setup",
  flags: {
    cli: { type: "boolean", description: "Use interactive CLI setup" },
    name: { type: "string", description: "System name (implies --cli)" },
    system: { type: "boolean", description: "System-level install (requires sudo)" },
    service: { type: "boolean", description: "Install as service" },
    remote: { type: "boolean", description: "Allow access from other devices" },
    dir: { type: "string", description: "Data directory" },
    port: { type: "number", description: "Daemon port" },
    host: { type: "string", description: "Daemon host" },
  },
  run: async ({ flags }) => {
    const port = flags.port;
    let host = flags.host;

    // --system without --cli: do privileged setup, then open browser for the rest
    if (flags.system && !flags.cli && !flags.name) {
      if (process.getuid?.() !== 0) {
        console.error("System install requires root. Re-run with sudo.");
        process.exit(1);
      }

      if (host) validateHost(host);
      host = host ?? "0.0.0.0";

      console.log("Setting up system directories...");

      process.env.VOLUTE_HOME = DATA_DIR;
      process.env.VOLUTE_MINDS_DIR = MINDS_DIR;

      setupSystemDirectories();
      ensureVoluteGroup({ force: true });
      console.log("  Ensured volute group exists");
      setupSystemGitIdentity();

      const voluteBin = resolveVoluteBin();
      setupSystemWrapper(voluteBin);
      setupSystemEnvProfile();

      let wantService = flags.service ?? true;
      let serviceStartedDaemon = false;
      if (wantService) {
        if (installSystemService(voluteBin, port, host)) {
          serviceStartedDaemon = true;
        } else {
          wantService = false;
        }
      }

      // Write minimal config — web UI will collect system name, account, models
      const existingConfig = readGlobalConfig();
      const setup: SetupConfig = {
        type: "system",
        mindsDir: MINDS_DIR,
        isolation: "user",
        service: wantService,
      };
      const config: GlobalConfig = { ...existingConfig, setup, setupCompleted: false };
      if (port != null) config.port = port;
      config.hostname = host;
      writeGlobalConfig(config);

      if (serviceStartedDaemon) {
        // Service already started the daemon — just open the browser
        const displayPort = port ?? 1618;
        const url = `http://localhost:${displayPort}`;
        const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(openCmd, [url], { stdio: "ignore", detached: true }).unref();
        console.log(`\nOpen ${url} to continue setup.`);
      } else {
        await startDaemonAndOpenBrowser(port, host);
      }
      return;
    }

    // --cli or --name: interactive/non-interactive CLI setup (original flow)
    if (flags.cli || flags.name) {
      const isInteractive = !flags.name && process.stdin.isTTY;

      let systemName: string;
      let setupType: SetupType;
      let wantService: boolean;
      let wantRemote = flags.remote ?? false;

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
        console.log(`  2. System (minds in ${MINDS_DIR}, per-user isolation, requires sudo)`);
        const typeChoice = await promptLine("> ");
        setupType = typeChoice.trim() === "2" ? "system" : "local";

        if (setupType === "system" && process.getuid?.() !== 0) {
          console.error("\nSystem install requires root. Re-run with sudo.");
          process.exit(1);
        }

        // Remote access
        if (!host) {
          const remoteAnswer = (
            await promptLine("\nAllow access from other devices on the network? [y/N]: ")
          )
            .trim()
            .toLowerCase();
          if (remoteAnswer === "y" || remoteAnswer === "yes") {
            wantRemote = true;
            host = "0.0.0.0";
          }
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
          console.error(
            "Usage: volute setup --name <name> [--system] [--service] [--remote] [--dir <path>]",
          );
          process.exit(1);
        }
        systemName = flags.name;
        setupType = flags.system ? "system" : "local";
        wantService = flags.service ?? setupType === "system";

        // --remote implies --host 0.0.0.0 unless --host is explicitly set
        if (wantRemote && !host) {
          host = "0.0.0.0";
        }

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
          try {
            await installUserService(port, host);
          } catch (err) {
            console.warn(
              `  Warning: failed to install service: ${err instanceof Error ? err.message : err}`,
            );
            console.warn("  You can start Volute manually with: volute up");
            wantService = false;
          }
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
        setupCompleted: false,
      };
      if (port != null) config.port = port;
      if (host) config.hostname = host;

      writeGlobalConfig(config);
      await startDaemonAndOpenBrowser(port, host);
      return;
    }

    // Default: local setup, start daemon, open browser
    if (host) validateHost(host);

    const configHome = flags.dir ? resolve(flags.dir) : resolve(homedir(), ".volute");
    if (flags.dir) {
      process.env.VOLUTE_HOME = configHome;
    }
    const mindsDir = resolve(configHome, "minds");

    mkdirSync(configHome, { recursive: true });
    mkdirSync(mindsDir, { recursive: true });

    // Write minimal config — web UI will collect system name, account, models
    const existingConfig = readGlobalConfig();
    if (!existingConfig.setup) {
      const setup: SetupConfig = {
        type: "local",
        mindsDir,
        isolation: "sandbox",
        service: false,
      };
      const config: GlobalConfig = { ...existingConfig, setup, setupCompleted: false };
      if (port != null) config.port = port;
      if (host) config.hostname = host;
      writeGlobalConfig(config);
    }

    await startDaemonAndOpenBrowser(port, host);
  },
});

export const run = cmd.execute;
