import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

type CliSession = { sessionId: string; username: string };

function readCliSession(): CliSession | null {
  const sessionPath = resolve(voluteHome(), "cli-session.json");
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, "utf-8"));
  } catch {
    return null;
  }
}

type DaemonConfig = { port: number; internalPort?: number; hostname?: string; token?: string };

// This module is CLI-only (imported by src/commands/). process.exit() is intentional —
// CLI commands should terminate immediately with a clear error when the daemon is unreachable.
function readDaemonConfig(): DaemonConfig {
  const configPath = resolve(voluteHome(), "daemon.json");
  if (!existsSync(configPath)) {
    // If a system service is installed, the issue is likely VOLUTE_HOME not being set
    if (existsSync("/etc/systemd/system/volute.service") && !process.env.VOLUTE_HOME) {
      console.error("Volute is running as a system service but VOLUTE_HOME is not set.");
      console.error("Re-run setup to update the CLI wrapper: sudo volute service install --system");
      console.error("Then start a new shell or run: source /etc/profile.d/volute.sh");
    } else {
      console.error("Volute is not running. Start with: volute up");
    }
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      console.error(`Permission denied reading ${configPath}. Try: sudo volute ...`);
    } else {
      console.error("Volute is not running. Start with: volute up");
    }
    process.exit(1);
  }
}

function buildUrl(config: DaemonConfig): string {
  const url = new URL("http://localhost");
  // When TLS is enabled, use the internal HTTP port for CLI communication
  url.port = String(config.internalPort ?? config.port);
  // Internal port always binds to localhost
  if (config.internalPort) {
    url.hostname = "127.0.0.1";
  } else {
    let hostname = config.hostname || "localhost";
    if (hostname === "0.0.0.0") hostname = "127.0.0.1";
    if (hostname === "::") hostname = "[::1]";
    url.hostname = hostname;
  }
  return url.origin;
}

export async function daemonFetch(path: string, options?: RequestInit): Promise<Response> {
  const config = readDaemonConfig();
  const url = buildUrl(config);
  const headers = new Headers(options?.headers);

  // Use CLI session token if available
  const cliSession = readCliSession();
  if (cliSession?.sessionId) {
    headers.set("Authorization", `Bearer ${cliSession.sessionId}`);
  }

  // Set origin to pass CSRF checks on mutation requests
  headers.set("Origin", url);

  try {
    const res = await fetch(`${url}${path}`, { ...options, headers });
    if (res.status === 401 && !cliSession) {
      console.error("Not logged in. Run `volute login` first.");
      process.exit(1);
    }
    return res;
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as TypeError & { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
    ) {
      console.error("Volute is not running. Start with: volute up");
      process.exit(1);
    }
    throw err;
  }
}
