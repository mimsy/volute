import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "../lib/parse-args.js";

const SERVICE_NAME = "volute.service";
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const DATA_DIR = "/var/lib/volute";

function resolveVoluteBin(): string {
  try {
    return execFileSync("which", ["volute"], { encoding: "utf-8" }).trim();
  } catch {
    return "volute";
  }
}

function generateUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port) args.push("--port", String(port));
  if (host) args.push("--host", host);

  return `[Unit]
Description=Volute Agent Manager
After=network.target

[Service]
Type=exec
ExecStart=${voluteBin} ${args.join(" ")}
Environment=VOLUTE_HOME=${DATA_DIR}
Environment=VOLUTE_ISOLATION=user
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

async function install(port?: number, host?: string): Promise<void> {
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

  // Create volute group (idempotent)
  try {
    execFileSync("getent", ["group", "volute"], { stdio: "ignore" });
  } catch {
    execFileSync("groupadd", ["volute"]);
    console.log("Created volute group");
  }

  // Set permissions on data directory
  execFileSync("chmod", ["755", DATA_DIR]);
  console.log("Set permissions on data directory");

  // Install systemd service
  writeFileSync(SERVICE_PATH, generateUnit(voluteBin, port, host ?? "0.0.0.0"));
  console.log(`Wrote ${SERVICE_PATH}`);

  execFileSync("systemctl", ["daemon-reload"]);
  execFileSync("systemctl", ["enable", "--now", SERVICE_NAME]);
  console.log("Service installed, enabled, and started.");
  console.log(`\nVolute daemon is running. Data directory: ${DATA_DIR}`);
  console.log("Use `systemctl status volute` to check status.");
}

async function uninstall(force: boolean): Promise<void> {
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
  } catch {}
  unlinkSync(SERVICE_PATH);
  try {
    execFileSync("systemctl", ["daemon-reload"]);
  } catch {}
  console.log("Service stopped and removed.");

  if (force) {
    // Remove agent users
    try {
      const output = execFileSync("getent", ["group", "volute"], { encoding: "utf-8" });
      const members = output.split(":")[3]?.trim();
      if (members) {
        for (const user of members.split(",")) {
          try {
            execFileSync("userdel", [user.trim()], { stdio: "ignore" });
          } catch {}
        }
      }
    } catch {}

    // Remove data directory
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log(`Deleted ${DATA_DIR}`);
    }

    // Remove group
    try {
      execFileSync("groupdel", ["volute"], { stdio: "ignore" });
      console.log("Removed volute group");
    } catch {}
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
      await uninstall(!!flags.force);
      break;
    case undefined:
      await install(flags.port, flags.host);
      break;
    default:
      console.log(`Usage:
  volute setup [--port N] [--host H]     Install system-level service with user isolation
  volute setup uninstall [--force]        Remove service (--force removes data + users)`);
      if (subcommand) {
        console.error(`\nUnknown subcommand: ${subcommand}`);
        process.exit(1);
      }
  }
}
