import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolveVoluteBin } from "../lib/exec.js";
import { ensureVoluteGroup } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";

const SERVICE_NAME = "volute.service";
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const DATA_DIR = "/var/lib/volute";
const AGENTS_DIR = "/agents";
const HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function validateHost(host: string): void {
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid host: ${host}`);
  }
}

function generateUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  return `[Unit]
Description=Volute Agent Manager
After=network.target

[Service]
Type=exec
ExecStart=${voluteBin} ${args.join(" ")}
Environment=VOLUTE_HOME=${DATA_DIR}
Environment=VOLUTE_AGENTS_DIR=${AGENTS_DIR}
Environment=VOLUTE_ISOLATION=user
Restart=on-failure
RestartSec=5
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${AGENTS_DIR}
PrivateTmp=yes
ProtectHome=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
`;
}

function install(port?: number, host?: string): void {
  if (host) validateHost(host);
  if (process.getuid?.() !== 0) {
    console.error("Error: volute setup must be run as root (use sudo).");
    process.exit(1);
  }

  if (process.platform !== "linux") {
    console.error("Error: volute setup is only supported on Linux.");
    console.error("On macOS, use `volute service install` for user-level service management.");
    process.exit(1);
  }

  const voluteBin = resolveVoluteBin();

  // Create data directory
  mkdirSync(DATA_DIR, { recursive: true });
  console.log(`Created ${DATA_DIR}`);

  // Create agents directory
  mkdirSync(AGENTS_DIR, { recursive: true });
  console.log(`Created ${AGENTS_DIR}`);

  // Create volute group (idempotent)
  ensureVoluteGroup({ force: true });
  console.log("Ensured volute group exists");

  // Set permissions on data and agents directories
  execFileSync("chmod", ["755", DATA_DIR]);
  execFileSync("chmod", ["755", AGENTS_DIR]);
  console.log("Set permissions on directories");

  // Install systemd service
  writeFileSync(SERVICE_PATH, generateUnit(voluteBin, port, host ?? "0.0.0.0"));
  console.log(`Wrote ${SERVICE_PATH}`);

  execFileSync("systemctl", ["daemon-reload"]);
  execFileSync("systemctl", ["enable", "--now", SERVICE_NAME]);
  console.log("Service installed, enabled, and started.");
  console.log(`\nVolute daemon is running. Data directory: ${DATA_DIR}`);
  console.log("Use `systemctl status volute` to check status.");
}

function uninstall(force: boolean): void {
  if (process.getuid?.() !== 0) {
    console.error("Error: volute setup uninstall must be run as root (use sudo).");
    process.exit(1);
  }

  if (!existsSync(SERVICE_PATH)) {
    console.log("Service not installed.");
    return;
  }

  try {
    execFileSync("systemctl", ["disable", "--now", SERVICE_NAME], { stdio: "ignore" });
  } catch {
    console.warn("Warning: failed to disable service (may already be stopped)");
  }
  unlinkSync(SERVICE_PATH);
  try {
    execFileSync("systemctl", ["daemon-reload"]);
  } catch {
    console.warn("Warning: failed to reload systemd daemon");
  }
  console.log("Service stopped and removed.");

  if (force) {
    // Remove agent users
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

    // Remove data and agents directories
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(`Deleted ${DATA_DIR}`);
    }
    if (existsSync(AGENTS_DIR)) {
      rmSync(AGENTS_DIR, { recursive: true, force: true });
      console.log(`Deleted ${AGENTS_DIR}`);
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
  volute setup [--port N] [--host H]     Install system-level service with user isolation
  volute setup uninstall [--force]        Remove service (--force removes data + users)`);
      console.error(`\nUnknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}
