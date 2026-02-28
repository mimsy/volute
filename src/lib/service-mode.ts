import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execInherit } from "@volute/shared/exec";
import { voluteHome } from "@volute/shared/registry";

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

export const HEALTH_POLL_TIMEOUT = 30_000;
export const STOP_GRACE_TIMEOUT = 10_000;
export const POLL_INTERVAL = 500;

// --- Types ---

export type ServiceMode = "manual" | "system" | "user-systemd" | "user-launchd";
export type ManagedServiceMode = Exclude<ServiceMode, "manual">;

// --- Detection ---

export function getServiceMode(): ServiceMode {
  // System-level systemd service
  if (existsSync(SYSTEM_SERVICE_PATH)) {
    try {
      execFileSync("systemctl", ["is-enabled", "--quiet", "volute"]);
      return "system";
    } catch {
      // Unit file exists but not enabled — fall through
    }
  }

  // User-level systemd service
  if (existsSync(USER_SYSTEMD_UNIT)) {
    try {
      execFileSync("systemctl", ["--user", "is-enabled", "--quiet", "volute"]);
      return "user-systemd";
    } catch {
      // Unit file exists but not enabled — fall through
    }
  }

  // macOS launchd
  if (process.platform === "darwin" && existsSync(LAUNCHD_PLIST_PATH)) {
    return "user-launchd";
  }

  return "manual";
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
    case "user-launchd":
      await execInherit("launchctl", ["load", LAUNCHD_PLIST_PATH]);
      break;
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
    case "user-launchd":
      await execInherit("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
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
    case "user-launchd":
      // launchd doesn't have a "restart" — unload then load
      try {
        await execInherit("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
      } catch (err) {
        // May not be loaded — warn but continue to load
        console.warn(
          `Warning: launchctl unload failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      await execInherit("launchctl", ["load", LAUNCHD_PLIST_PATH]);
      break;
  }
}

/** Read daemon.json for hostname, port, and token. Returns defaults if missing or corrupt. */
export function readDaemonConfig(): { hostname: string; port: number; token?: string } {
  const configPath = resolve(voluteHome(), "daemon.json");
  if (!existsSync(configPath)) return { hostname: "127.0.0.1", port: 4200 };
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      hostname: config.hostname || "127.0.0.1",
      port: config.port ?? 4200,
      token: config.token,
    };
  } catch {
    console.error("Warning: could not read daemon config, using defaults.");
    return { hostname: "127.0.0.1", port: 4200 };
  }
}

/** Human-readable label for the service mode */
export function modeLabel(mode: ServiceMode): string {
  switch (mode) {
    case "system":
      return "system service (systemd)";
    case "user-systemd":
      return "user service (systemd)";
    case "user-launchd":
      return "user service (launchd)";
    case "manual":
      return "manual";
  }
}
