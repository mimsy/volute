import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { resolveVoluteBin } from "../lib/exec.js";
import { ensureVoluteGroup } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";
import { SYSTEM_SERVICE_PATH } from "../lib/service-mode.js";

const SERVICE_NAME = "volute.service";
const PROFILE_PATH = "/etc/profile.d/volute.sh";
const WRAPPER_PATH = "/usr/local/bin/volute";
const DATA_DIR = "/var/lib/volute";
const MINDS_DIR = "/minds";
const LEGACY_AGENTS_DIR = "/agents";
const HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function validateHost(host: string): void {
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
}

function buildServicePath(voluteBin: string): string {
  // Include the volute binary's directory (which for nvm installs won't be on the
  // default system PATH) plus standard paths for system tools (useradd, groupadd, etc.)
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

function generateUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  // ProtectHome=yes makes /home and /root inaccessible to the service.
  // Skip it if the volute binary lives under the home directory (e.g. nvm installs).
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
    `Environment=VOLUTE_HOME=${DATA_DIR}`,
    `Environment=VOLUTE_MINDS_DIR=${MINDS_DIR}`,
    "Environment=VOLUTE_ISOLATION=user",
    "Restart=on-failure",
    "RestartSec=5",
    "ProtectSystem=true",
    `ReadWritePaths=${DATA_DIR} ${MINDS_DIR}`,
    "PrivateTmp=yes",
  ];

  if (!binUnderHome) {
    lines.push("ProtectHome=yes");
  } else {
    console.warn(`Warning: ProtectHome=yes omitted because volute binary is under ${home}.`);
    console.warn("Consider installing Node.js system-wide for stronger sandboxing.");
  }

  lines.push("RestrictSUIDSGID=yes", "", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

export function install(port?: number, host?: string): void {
  if (host) validateHost(host);
  if (process.getuid?.() !== 0) {
    console.error("Error: volute service install --system must be run as root (use sudo).");
    process.exit(1);
  }

  if (process.platform !== "linux") {
    console.error("Error: volute service install --system is only supported on Linux.");
    console.error("On macOS, use `volute service install` for user-level service management.");
    process.exit(1);
  }

  const voluteBin = resolveVoluteBin();

  // Create data directory
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Created ${DATA_DIR}`);

  // Create minds directory
  mkdirSync(MINDS_DIR, { recursive: true });
  console.log(`Created ${MINDS_DIR}`);

  // Create volute group (idempotent)
  ensureVoluteGroup({ force: true });
  console.log("Ensured volute group exists");

  // Set system-wide git identity for daemon commits if not already configured
  try {
    execFileSync("git", ["config", "--system", "user.name"]);
    console.log("System git identity already configured, skipping");
  } catch {
    try {
      execFileSync("git", ["config", "--system", "user.name", "Volute"]);
      execFileSync("git", ["config", "--system", "user.email", "volute@localhost"]);
      console.log("Configured system git identity");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Warning: failed to set system git config: ${msg}`);
      console.warn("Git commits by the daemon may fail. You can set this manually with:");
      console.warn('  git config --system user.name "Volute"');
      console.warn('  git config --system user.email "volute@localhost"');
    }
  }

  // Set permissions on data and minds directories
  execFileSync("chmod", ["755", DATA_DIR]);
  execFileSync("chmod", ["755", MINDS_DIR]);
  console.log("Set permissions on directories");

  // Write environment for CLI users so they can find the daemon
  writeFileSync(
    PROFILE_PATH,
    `export VOLUTE_HOME=${DATA_DIR}\nexport VOLUTE_MINDS_DIR=${MINDS_DIR}\n`,
  );
  console.log(`Wrote ${PROFILE_PATH}`);

  // If the binary is under a home directory (nvm), create a wrapper at /usr/local/bin
  // so `sudo volute` works (sudo resets PATH and won't find nvm binaries)
  const binDir = dirname(voluteBin);
  if (voluteBin !== WRAPPER_PATH && !voluteBin.startsWith("/usr/bin")) {
    const wrapper = `#!/bin/sh\nexport PATH="${binDir}:$PATH"\nexport VOLUTE_HOME="${DATA_DIR}"\nexport VOLUTE_MINDS_DIR="${MINDS_DIR}"\nexec "${voluteBin}" "$@"\n`;
    writeFileSync(WRAPPER_PATH, wrapper, { mode: 0o755 });
    console.log(`Wrote ${WRAPPER_PATH} (wrapper for ${voluteBin})`);
  }

  // Install systemd service
  writeFileSync(SYSTEM_SERVICE_PATH, generateUnit(voluteBin, port, host ?? "0.0.0.0"));
  console.log(`Wrote ${SYSTEM_SERVICE_PATH}`);

  try {
    execFileSync("systemctl", ["daemon-reload"]);
  } catch (err) {
    const e = err as { stderr?: string };
    console.error(`Failed to reload systemd after writing ${SYSTEM_SERVICE_PATH}.`);
    if (e.stderr) console.error(e.stderr.toString().trim());
    console.error(
      "Try running `systemctl daemon-reload` manually, then `systemctl enable --now volute`.",
    );
    process.exit(1);
  }
  try {
    execFileSync("systemctl", ["enable", "--now", SERVICE_NAME]);
    console.log("Service installed, enabled, and started.");
    console.log(
      "Run `source /etc/profile.d/volute.sh` or start a new shell to use volute CLI commands.",
    );
    console.log(`\nVolute daemon is running. Data directory: ${DATA_DIR}`);
    console.log("Use `systemctl status volute` to check status.");
  } catch (err) {
    const e = err as { stderr?: string };
    console.error("Service installed but failed to start.");
    if (e.stderr) console.error(e.stderr.toString().trim());
    console.error("Check `journalctl -xeu volute.service` for details.");
    process.exit(1);
  }
}

export function uninstall(force: boolean): void {
  if (process.getuid?.() !== 0) {
    console.error("Error: volute service uninstall --system must be run as root (use sudo).");
    process.exit(1);
  }

  if (!existsSync(SYSTEM_SERVICE_PATH)) {
    console.log("Service not installed.");
    return;
  }

  try {
    execFileSync("systemctl", ["disable", "--now", SERVICE_NAME], { stdio: "ignore" });
  } catch {
    console.warn("Warning: failed to disable service (may already be stopped)");
  }
  unlinkSync(SYSTEM_SERVICE_PATH);
  if (existsSync(PROFILE_PATH)) unlinkSync(PROFILE_PATH);
  if (existsSync(WRAPPER_PATH)) unlinkSync(WRAPPER_PATH);
  try {
    execFileSync("systemctl", ["daemon-reload"]);
  } catch {
    console.warn("Warning: failed to reload systemd daemon");
  }
  console.log("Service stopped and removed.");

  if (force) {
    // Remove mind users
    try {
      const output = execFileSync("getent", ["group", "volute"], { encoding: "utf-8" });
      const members = output.split(":")[3]?.trim();
      if (members) {
        for (const user of members.split(",")) {
          const u = user.trim();
          try {
            execFileSync("userdel", [u], { stdio: "ignore" });
          } catch {
            console.warn(`Warning: failed to remove user ${u}`);
          }
          try {
            execFileSync("groupdel", [u], { stdio: "ignore" });
          } catch {
            // Per-user group may not exist — ignore
          }
        }
      }
    } catch {
      // Group may not exist — ignore
    }

    // Remove data and minds directories (also clean up legacy /agents)
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(`Deleted ${DATA_DIR}`);
    }
    if (existsSync(MINDS_DIR)) {
      rmSync(MINDS_DIR, { recursive: true, force: true });
      console.log(`Deleted ${MINDS_DIR}`);
    }
    if (existsSync(LEGACY_AGENTS_DIR)) {
      rmSync(LEGACY_AGENTS_DIR, { recursive: true, force: true });
      console.log(`Deleted ${LEGACY_AGENTS_DIR} (legacy)`);
    }

    // Remove group
    try {
      execFileSync("groupdel", ["volute"], { stdio: "ignore" });
      console.log("Removed volute group");
    } catch {
      // Group may not exist — ignore
    }
  } else {
    console.log(`Data directory preserved: ${DATA_DIR}`);
    console.log("Use --force to also remove data and system users.");
  }
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    port: { type: "number" },
    host: { type: "string" },
    force: { type: "boolean" },
  });

  const subcommand = positional[0];

  switch (subcommand) {
    case "uninstall":
      uninstall(!!flags.force);
      break;
    case undefined:
      install(flags.port, flags.host);
      break;
    default:
      console.log(`Usage:
  volute service install --system [--port N] [--host H]   Install system-level service with user isolation
  volute service uninstall --system [--force]              Remove service (--force removes data + users)`);
      console.error(`\nUnknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}
