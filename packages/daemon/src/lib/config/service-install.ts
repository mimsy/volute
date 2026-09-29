import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveVoluteBin } from "../util/exec.js";
import {
  LAUNCHD_PLIST_LABEL,
  LAUNCHD_PLIST_PATH,
  SYSTEM_LAUNCHD_PLIST_PATH,
  SYSTEM_SERVICE_PATH,
  USER_SYSTEMD_UNIT,
} from "./service-mode.js";

const execFileAsync = promisify(execFile);

export const SYSTEM_DATA_DIR = "/var/lib/volute";
export const SYSTEM_MINDS_DIR = process.platform === "darwin" ? "/var/lib/volute/minds" : "/minds";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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

// --- System service (`volute setup --system`) ---

export function generateSystemPlist(
  voluteBin: string,
  opts?: { port?: number; host?: string },
): string {
  const args = ["up", "--foreground"];
  if (opts?.port != null) args.push("--port", String(opts.port));
  if (opts?.host) args.push("--host", opts.host);

  const logPath = `${SYSTEM_DATA_DIR}/system/daemon.log`;

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
    <string>${SYSTEM_DATA_DIR}</string>
    <key>VOLUTE_MINDS_DIR</key>
    <string>${SYSTEM_MINDS_DIR}</string>
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

/**
 * The directories `ProtectHome=yes` hides from the service. A binary installed under
 * one of them (e.g. an nvm node in a user's home) would be unreachable to its own
 * unit, so the directive is left out for it.
 *
 * Decided from the path, not from `homedir()`: setup and `volute service reconcile`
 * both run under sudo, and whether sudo keeps the caller's HOME varies by host — a
 * `homedir()` check could emit `ProtectHome=yes` on reconcile for a unit setup had
 * written without it, and the daemon could no longer exec itself.
 */
const PROTECT_HOME_DIRS = ["/home/", "/root/", "/run/user/"];

/**
 * The systemd unit for a `--system` install.
 *
 * Deliberately does *not* set `RestrictSUIDSGID=yes`. A system install always runs
 * per-mind user isolation, and the shared pages repo is created `--shared=group` so
 * several mind users can work in it. Git then calls `adjust_shared_perm()`, which
 * chmods the setgid bit onto directories and index/object temp files — exactly the
 * syscall that directive blocks, for root included. With it set, `_system` worktrees
 * never provision and publishing fails with "unable to create temporary file:
 * Operation not permitted" (#832). systemd has no per-path carve-out for it.
 *
 * This is the second feature to hit it, not a one-off: #75 (714cb31d) removed the
 * directive in Feb 2026 because the then-shared CLAUDE_CONFIG_DIR needed the same sgid
 * chmods, and #77 (d4e56003) restored it on a stated precondition — "the sgid chmod
 * that required its removal is no longer needed". Shared pages made that precondition
 * false again.
 *
 * So the bar for restoring it is that precondition, not a judgement call: remove the
 * setgid dependency first (nothing in the system may need a setgid chmod), and only
 * then put the directive back. Restoring it while shared pages still uses
 * `--shared=group` silently re-breaks publishing on every system install, which is
 * exactly how this shipped broken. `test/setup.test.ts` pins its absence.
 *
 * Existing installs pick up changes here through `volute service reconcile`, which
 * `volute update` runs before its restart (#874, #1224).
 */
export function generateSystemUnit(voluteBin: string, port?: number, host?: string): string {
  const args = ["up", "--foreground"];
  if (port != null) args.push("--port", String(port));
  if (host) args.push("--host", host);

  const lines = [
    "[Unit]",
    "Description=Volute Mind Manager",
    "After=network.target",
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${voluteBin} ${args.join(" ")}`,
    `Environment=PATH=${buildServicePath(voluteBin)}`,
    `Environment=VOLUTE_HOME=${SYSTEM_DATA_DIR}`,
    "Environment=VOLUTE_MINDS_DIR=/minds",
    "Environment=VOLUTE_ISOLATION=user",
    "Restart=on-failure",
    "RestartSec=5",
    "ProtectSystem=true",
    `ReadWritePaths=${SYSTEM_DATA_DIR} /minds`,
    "PrivateTmp=yes",
  ];

  if (!PROTECT_HOME_DIRS.some((dir) => voluteBin.startsWith(dir))) {
    lines.push("ProtectHome=yes");
  }

  lines.push("", "[Install]", "WantedBy=multi-user.target", "");
  return lines.join("\n");
}

// --- Reconciling an installed system service file (#874) ---

/**
 * Lines a past release stopped writing, which an existing install should shed.
 * Migrations only ever remove: adding a line to a unit that has run fine without it
 * (a `ProtectHome=yes`, say) risks a daemon that no longer starts, and with it every
 * mind on the host. Anything else that differs from what setup writes now is left
 * for the host to act on — see `planServiceFile`.
 */
const SYSTEMD_MIGRATIONS: { line: RegExp; why: string }[] = [
  {
    line: /^RestrictSUIDSGID=yes$/,
    why: "blocks git's setgid chmods, so shared pages fail under user isolation (#879, #1224)",
  },
  {
    line: /^Environment=CLAUDE_CONFIG_DIR=/,
    why: "minds keep their own Claude config under their own HOME (#77)",
  },
];

/** The host-specific values a system service file was written with. */
type ServiceArgs = { voluteBin: string; port?: number; host?: string };

/**
 * Parse `<bin> up --foreground [--port N] [--host H]`; null for anything else,
 * including a relative or quoted binary path.
 */
function parseUpArgv(argv: string[]): ServiceArgs | null {
  if (argv.some((a) => /["'\\]/.test(a))) return null;
  const [voluteBin, up, foreground, ...rest] = argv;
  if (!voluteBin?.startsWith("/") || up !== "up" || foreground !== "--foreground") return null;
  const parsed: ServiceArgs = { voluteBin };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) return null;
    if (flag === "--port" && /^\d+$/.test(value)) parsed.port = Number(value);
    else if (flag === "--host") parsed.host = value;
    else return null;
  }
  return parsed;
}

function parseSystemUnit(text: string): ServiceArgs | null {
  const execStarts = text.split("\n").filter((l) => l.startsWith("ExecStart="));
  if (execStarts.length !== 1) return null;
  // An ExecStart prefix (`-`, `@`, `+`, `!`) is a hand edit this parse can't carry over.
  return parseUpArgv(execStarts[0].slice("ExecStart=".length).trim().split(/\s+/));
}

function parseSystemPlist(text: string): ServiceArgs | null {
  const m = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return null;
  const argv = [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => unescapeXml(s[1]));
  return parseUpArgv(argv);
}

export type ServiceFileKind = "systemd" | "launchd";

/** Line-level difference between two service files, blank lines ignored. */
export type ServiceFileDiff = { missing: string[]; extra: string[] };

export type ServiceFilePlan =
  /** The file cannot be read back into setup's parameters; it is left alone. */
  | { status: "unrecognised" }
  | {
      status: "reviewed";
      /** The file to write, or null when no migration applies. */
      rewrite: string | null;
      /** Lines the migrations remove, each with the reason. */
      migrated: { line: string; why: string }[];
      /**
       * How the file (after migrations) still differs from what setup writes now, or
       * null when it matches. A difference is the host's customisation — or a change
       * setup made that is not a safe removal — and is reported, never applied.
       */
      customised: ServiceFileDiff | null;
    };

function diffLines(from: string, to: string): ServiceFileDiff | null {
  const have = new Set(from.split("\n"));
  const want = new Set(to.split("\n"));
  const missing = [...want].filter((l) => l.trim() && !have.has(l));
  const extra = [...have].filter((l) => l.trim() && !want.has(l));
  return missing.length || extra.length || from !== to ? { missing, extra } : null;
}

/**
 * Review an installed system service file against what this version of setup would
 * write for the same binary, port and host. Pure: callers do the I/O.
 *
 * Only the known migrations are ever applied. What remains different after them is
 * reported as customised and left in place: a host may have tuned the unit on
 * purpose, and a regenerated unit that fails to start takes every mind down with it.
 */
export function planServiceFile(kind: ServiceFileKind, installed: string): ServiceFilePlan {
  const args = kind === "systemd" ? parseSystemUnit(installed) : parseSystemPlist(installed);
  if (!args) return { status: "unrecognised" };
  const expected =
    kind === "systemd"
      ? generateSystemUnit(args.voluteBin, args.port, args.host)
      : generateSystemPlist(args.voluteBin, { port: args.port, host: args.host });

  const migrated: { line: string; why: string }[] = [];
  const kept: string[] = [];
  for (const line of installed.split("\n")) {
    const migration =
      kind === "systemd" ? SYSTEMD_MIGRATIONS.find((m) => m.line.test(line.trim())) : undefined;
    if (migration) migrated.push({ line: line.trim(), why: migration.why });
    else kept.push(line);
  }
  const after = kept.join("\n");
  return {
    status: "reviewed",
    rewrite: migrated.length ? after : null,
    migrated,
    customised: diffLines(after, expected),
  };
}

export type InstalledServiceFile =
  | { kind: ServiceFileKind; path: string; text: string }
  | { kind: ServiceFileKind; path: string; unreadable: string };

/** The installed system service file on this host, if there is one. */
export function installedSystemServiceFile(): InstalledServiceFile | null {
  return process.platform === "darwin"
    ? readServiceFile("launchd", SYSTEM_LAUNCHD_PLIST_PATH)
    : readServiceFile("systemd", SYSTEM_SERVICE_PATH);
}

/** Read a service file; an unreadable one is its own answer, not "not installed". */
export function readServiceFile(kind: ServiceFileKind, path: string): InstalledServiceFile | null {
  if (!existsSync(path)) return null;
  try {
    return { kind, path, text: readFileSync(path, "utf-8") };
  } catch (err) {
    return { kind, path, unreadable: err instanceof Error ? err.message : String(err) };
  }
}
