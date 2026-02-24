import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "./registry.js";

type DaemonConfig = { port: number; hostname?: string; token?: string };

// This module is CLI-only (imported by src/commands/). process.exit() is intentional —
// CLI commands should terminate immediately with a clear error when the daemon is unreachable.
function readDaemonConfig(): DaemonConfig {
  const configPath = resolve(voluteHome(), "daemon.json");
  if (!existsSync(configPath)) {
    // If a system service is installed, the issue is likely VOLUTE_HOME not being set
    if (existsSync("/etc/systemd/system/volute.service") && !process.env.VOLUTE_HOME) {
      console.error("Volute is running as a system service but VOLUTE_HOME is not set.");
      console.error("Re-run setup to update the CLI wrapper: sudo volute setup");
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
  let hostname = config.hostname || "localhost";
  // Map bind-all addresses to loopback for connections
  if (hostname === "0.0.0.0") hostname = "127.0.0.1";
  if (hostname === "::") hostname = "[::1]";
  url.hostname = hostname;
  url.port = String(config.port);
  return url.origin;
}

export async function daemonFetch(path: string, options?: RequestInit): Promise<Response> {
  const config = readDaemonConfig();
  const url = buildUrl(config);
  const headers = new Headers(options?.headers);

  // Include internal auth token for CLI-to-daemon requests
  if (config.token) {
    headers.set("Authorization", `Bearer ${config.token}`);
  }

  // Set origin to pass CSRF checks on mutation requests
  headers.set("Origin", url);

  try {
    return await fetch(`${url}${path}`, { ...options, headers });
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
