import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { voluteSystemDir } from "../mind/registry.js";
import { exec, execInherit } from "../util/exec.js";
import { readLogTail } from "../util/log-tail.js";

// --- Constants ---

export const SYSTEM_SERVICE_PATH = "/etc/systemd/system/volute.service";
export const USER_SYSTEMD_UNIT = resolve(homedir(), ".config", "systemd", "user", "volute.service");
export const LAUNCHD_PLIST_LABEL = "com.volute.daemon";
export const LAUNCHD_PLIST_PATH = resolve(
  homedir(),
  "Library",
  "LaunchAgents",
  `${LAUNCHD_PLIST_LABEL}.plist`,
);
export const SYSTEM_LAUNCHD_PLIST_PATH = "/Library/LaunchDaemons/com.volute.daemon.plist";

export const HEALTH_POLL_TIMEOUT = 30_000;
export const STOP_GRACE_TIMEOUT = 10_000;
export const POLL_INTERVAL = 500;

// --- Types ---

export type ServiceMode = "manual" | "system" | "system-launchd" | "user-systemd" | "user-launchd";
export type ManagedServiceMode = Exclude<ServiceMode, "manual">;

// --- Detection ---

/** Probes injected into `resolveServiceMode` so the decision logic can be tested without a real host. */
export interface ServiceModeProbes {
  fileExists: (path: string) => boolean;
  /**
   * Whether the systemd unit is a managed install — enabled *or* active. A
   * disabled-but-running service (e.g. started once without `enable`) is still a
   * real install; gating on `is-enabled` alone misclassifies it as manual (#826).
   */
  systemdManaged: (scope: "system" | "user") => boolean;
  platform: NodeJS.Platform;
}

function systemctlSucceeds(args: string[]): boolean {
  try {
    execFileSync("systemctl", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function systemdManaged(scope: "system" | "user"): boolean {
  const prefix = scope === "user" ? ["--user"] : [];
  return (
    systemctlSucceeds([...prefix, "is-enabled", "--quiet", "volute"]) ||
    systemctlSucceeds([...prefix, "is-active", "--quiet", "volute"])
  );
}

/** Pure service-mode decision; `getServiceMode` supplies the real host probes. */
export function resolveServiceMode(probes: ServiceModeProbes): ServiceMode {
  // System-level systemd service
  if (probes.fileExists(SYSTEM_SERVICE_PATH) && probes.systemdManaged("system")) {
    return "system";
  }

  // User-level systemd service
  if (probes.fileExists(USER_SYSTEMD_UNIT) && probes.systemdManaged("user")) {
    return "user-systemd";
  }

  // System-level macOS LaunchDaemon
  if (probes.platform === "darwin" && probes.fileExists(SYSTEM_LAUNCHD_PLIST_PATH)) {
    return "system-launchd";
  }

  // macOS launchd
  if (probes.platform === "darwin" && probes.fileExists(LAUNCHD_PLIST_PATH)) {
    return "user-launchd";
  }

  return "manual";
}

export function getServiceMode(): ServiceMode {
  return resolveServiceMode({
    fileExists: existsSync,
    systemdManaged,
    platform: process.platform,
  });
}

// --- Helpers ---

export function getDaemonUrl(hostname: string, port: number): string {
  const url = new URL("http://localhost");
  let h = hostname;
  if (h === "0.0.0.0" || h === "::") h = "localhost";
  else if (h.includes(":") && !h.startsWith("[")) h = `[${h}]`;
  url.hostname = h;
  url.port = String(port);
  return url.origin;
}

/**
 * Poll the health endpoint until it responds with `{ ok: true }`.
 * Returns true if healthy within timeout, false otherwise.
 */
export async function pollHealth(
  hostname: string,
  port: number,
  timeout: number = HEALTH_POLL_TIMEOUT,
): Promise<boolean> {
  const url = `${getDaemonUrl(hostname, port)}/api/health`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && (body as { ok?: boolean }).ok) return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}

/**
 * Poll until the health endpoint stops responding.
 * Returns true if down within timeout, false otherwise.
 */
export async function pollHealthDown(
  hostname: string,
  port: number,
  timeout: number = STOP_GRACE_TIMEOUT,
): Promise<boolean> {
  const url = `${getDaemonUrl(hostname, port)}/api/health`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (!res.ok) return true;
      const body = await res.json().catch(() => null);
      if (!body || !(body as { ok?: boolean }).ok) return true;
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  return false;
}

// --- Service control ---

export async function startService(mode: ManagedServiceMode): Promise<void> {
  switch (mode) {
    case "system":
      await execInherit("sudo", ["systemctl", "start", "volute"]);
      break;
    case "user-systemd":
      await execInherit("systemctl", ["--user", "start", "volute"]);
      break;
    case "system-launchd":
      await exec("sudo", ["launchctl", "bootout", `system/${LAUNCHD_PLIST_LABEL}`]).catch((err) =>
        console.warn(
          `Warning: launchctl bootout failed (may not be loaded): ${err instanceof Error ? err.message : err}`,
        ),
      );
      await execInherit("sudo", ["launchctl", "bootstrap", "system", SYSTEM_LAUNCHD_PLIST_PATH]);
      await execInherit("sudo", ["launchctl", "kickstart", `system/${LAUNCHD_PLIST_LABEL}`]);
      break;
    case "user-launchd": {
      const uid = `gui/${process.getuid!()}`;
      await exec("launchctl", ["bootout", `${uid}/${LAUNCHD_PLIST_LABEL}`]).catch((err) =>
        console.warn(
          `Warning: launchctl bootout failed (may not be loaded): ${err instanceof Error ? err.message : err}`,
        ),
      );
      await execInherit("launchctl", ["bootstrap", uid, LAUNCHD_PLIST_PATH]);
      // kickstart ensures the job actually runs (RunAtLoad isn't always honored after bootout/bootstrap)
      await execInherit("launchctl", ["kickstart", `${uid}/${LAUNCHD_PLIST_LABEL}`]);
      break;
    }
  }
}

export async function stopService(mode: ManagedServiceMode): Promise<void> {
  switch (mode) {
    case "system":
      await execInherit("sudo", ["systemctl", "stop", "volute"]);
      break;
    case "user-systemd":
      await execInherit("systemctl", ["--user", "stop", "volute"]);
      break;
    case "system-launchd":
      await execInherit("sudo", ["launchctl", "bootout", `system/${LAUNCHD_PLIST_LABEL}`]);
      break;
    case "user-launchd":
      await execInherit("launchctl", [
        "bootout",
        `gui/${process.getuid!()}/${LAUNCHD_PLIST_LABEL}`,
      ]);
      break;
  }
}

export async function restartService(mode: ManagedServiceMode): Promise<void> {
  switch (mode) {
    case "system":
      await execInherit("sudo", ["systemctl", "restart", "volute"]);
      break;
    case "user-systemd":
      await execInherit("systemctl", ["--user", "restart", "volute"]);
      break;
    case "system-launchd":
      await exec("sudo", ["launchctl", "bootout", `system/${LAUNCHD_PLIST_LABEL}`]).catch((err) =>
        console.warn(
          `Warning: launchctl bootout failed (may not be loaded): ${err instanceof Error ? err.message : err}`,
        ),
      );
      await execInherit("sudo", ["launchctl", "bootstrap", "system", SYSTEM_LAUNCHD_PLIST_PATH]);
      await execInherit("sudo", ["launchctl", "kickstart", `system/${LAUNCHD_PLIST_LABEL}`]);
      break;
    case "user-launchd": {
      const uid = `gui/${process.getuid!()}`;
      await exec("launchctl", ["bootout", `${uid}/${LAUNCHD_PLIST_LABEL}`]).catch((err) =>
        console.warn(
          `Warning: launchctl bootout failed (may not be loaded): ${err instanceof Error ? err.message : err}`,
        ),
      );
      await execInherit("launchctl", ["bootstrap", uid, LAUNCHD_PLIST_PATH]);
      await execInherit("launchctl", ["kickstart", `${uid}/${LAUNCHD_PLIST_LABEL}`]);
      break;
    }
  }
}

export function daemonConfigPath(): string {
  return resolve(voluteSystemDir(), "daemon.json");
}

/**
 * The daemon admin token lives in its own owner-only file, split out from
 * daemon.json so the latter (port/hostname) can stay host-readable (0644)
 * on a system install where the daemon runs as root. Only daemon-side code (also
 * root) needs the token; the host CLI authenticates via cli-session.json.
 */
export function daemonTokenPath(): string {
  return resolve(voluteSystemDir(), "daemon-token");
}

/** Read the daemon admin token; undefined when missing or unreadable (e.g. a non-root caller). */
export function readDaemonToken(): string | undefined {
  const path = daemonTokenPath();
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Read daemon.json for hostname and port. Returns defaults if missing or corrupt. */
export function readDaemonConfig(): {
  hostname: string;
  port: number;
  internalPort?: number;
} {
  const configPath = daemonConfigPath();
  if (!existsSync(configPath)) return { hostname: "127.0.0.1", port: 1618 };
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      hostname: config.hostname || "127.0.0.1",
      port: config.port ?? 1618,
      internalPort: config.internalPort,
    };
  } catch {
    console.error("Warning: could not read daemon config, using defaults.");
    return { hostname: "127.0.0.1", port: 1618 };
  }
}

/**
 * Where the daemon writes its output for a given service mode. Background (`manual`)
 * and both launchd modes redirect stdio to `daemon.log`; Linux systemd modes send it
 * to the journal, so tailing `daemon.log` there would surface stale/unrelated content.
 */
export function daemonLogSource(
  mode: ServiceMode,
): { kind: "file"; path: string } | { kind: "journal"; command: string } {
  switch (mode) {
    case "system":
      return { kind: "journal", command: "journalctl -u volute -n 30 --no-pager" };
    case "user-systemd":
      return { kind: "journal", command: "journalctl --user -u volute -n 30 --no-pager" };
    default:
      return { kind: "file", path: resolve(voluteSystemDir(), "daemon.log") };
  }
}

/**
 * Lines describing where to find the daemon's log (and, for file-backed modes, a
 * tail of it) — used by `volute up`/`volute status` to surface a crash cause inline
 * instead of only printing a path. Each caller prints these on its own stream.
 */
export function daemonLogReport(mode: ServiceMode, maxLines = 20): string[] {
  const src = daemonLogSource(mode);
  if (src.kind === "journal") {
    return ["To see the daemon log:", `  ${src.command}`];
  }
  const tail = readLogTail(src.path, maxLines);
  if (tail.length === 0) return [`Check logs: ${src.path}`];
  return [`Last ${tail.length} lines of ${src.path}:`, ...tail.map((l) => `  ${l}`)];
}

/** Human-readable label for the service mode */
export function modeLabel(mode: ServiceMode): string {
  switch (mode) {
    case "system":
      return "system service (systemd)";
    case "user-systemd":
      return "user service (systemd)";
    case "system-launchd":
      return "system service (launchd)";
    case "user-launchd":
      return "user service (launchd)";
    case "manual":
      return "manual";
  }
}
