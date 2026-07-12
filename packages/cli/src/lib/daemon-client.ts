import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Agent } from "undici";
import { detectSystemInstallHint } from "./system-install.js";

// Long-running daemon operations (upgrade, create, import) run `npm install`
// synchronously before responding, which can exceed undici's default 5-minute
// `headersTimeout` and abort the CLI's fetch with UND_ERR_HEADERS_TIMEOUT. The
// daemon is a trusted process on localhost, so disable the headers/body timeouts
// for CLI→daemon calls (a hung request can still be interrupted with Ctrl-C).
export const daemonDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

function voluteUserHome(): string {
  return process.env.VOLUTE_USER_HOME ?? resolve(homedir(), ".volute");
}

function voluteSystemDir(): string {
  const home = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  return resolve(home, "system");
}

/** Read session from a mind's current-session file. */
export function readSessionFile(mindDir: string): string | undefined {
  try {
    const p = resolve(mindDir, ".mind", "current-session");
    if (existsSync(p)) return readFileSync(p, "utf-8").trim() || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[volute] failed to read session file: ${code ?? err}`);
    }
  }
  return undefined;
}

/** Read session from file (fallback for sandbox where env vars don't propagate). */
function readMindSessionFile(): string | undefined {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) return undefined;
  return readSessionFile(mindDir);
}

type CliSession = { sessionId: string; username: string; daemonUrl?: string };

function readCliSession(): CliSession | null {
  const sessionPath = resolve(voluteUserHome(), "cli-session.json");
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, "utf-8"));
  } catch {
    return null;
  }
}

type DaemonConfig = {
  port: number;
  internalPort?: number;
  hostname?: string;
  token?: string;
  tls?: boolean;
};

// This module is CLI-only (imported by src/commands/). process.exit() is intentional —
// CLI commands should terminate immediately with a clear error when the daemon is unreachable.
function readDaemonConfig(): DaemonConfig {
  const configPath = resolve(voluteSystemDir(), "daemon.json");
  if (!existsSync(configPath)) {
    // If a system service is installed, the issue is likely VOLUTE_HOME not being set
    const hint = detectSystemInstallHint();
    if (hint) {
      console.error(hint);
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

export function resolveDaemonUrl(): string {
  if (process.env.VOLUTE_DAEMON_URL) return process.env.VOLUTE_DAEMON_URL;
  const session = readCliSession();
  if (session?.daemonUrl) return session.daemonUrl;
  return buildUrl(readDaemonConfig());
}

/** Browser-facing dashboard URL (public port, https when TLS is enabled). */
export function resolveWebUrl(): string {
  if (process.env.VOLUTE_DAEMON_URL) return process.env.VOLUTE_DAEMON_URL;
  const session = readCliSession();
  if (session?.daemonUrl) return session.daemonUrl;
  const config = readDaemonConfig();
  const url = new URL(config.tls ? "https://localhost" : "http://localhost");
  url.port = String(config.port);
  let hostname = config.hostname || "localhost";
  if (hostname === "0.0.0.0") hostname = "localhost";
  if (hostname === "::") hostname = "localhost";
  url.hostname = hostname;
  return url.origin;
}

/** The bearer token daemonFetch would use: mind token (in a mind) or CLI session (host). */
export function getAuthToken(): string | undefined {
  return process.env.VOLUTE_MIND_TOKEN ?? readCliSession()?.sessionId;
}

export async function daemonFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = resolveDaemonUrl();
  const headers = new Headers(options?.headers);

  // Authenticate: mind token (VOLUTE_MIND_TOKEN) > CLI session
  const daemonToken = process.env.VOLUTE_MIND_TOKEN;
  const cliSession = daemonToken ? null : readCliSession();
  if (daemonToken) {
    headers.set("Authorization", `Bearer ${daemonToken}`);
  } else if (cliSession?.sessionId) {
    headers.set("Authorization", `Bearer ${cliSession.sessionId}`);
  }

  // Set origin to pass CSRF checks on mutation requests
  headers.set("Origin", url);

  // Pass session context for turn resolution (env var or file fallback for sandbox)
  const voluteSession = process.env.VOLUTE_SESSION ?? readMindSessionFile();
  if (voluteSession) {
    headers.set("X-Volute-Thread", voluteSession);
  }

  try {
    // `dispatcher` is a valid Node fetch option but missing from the DOM RequestInit type.
    const res = await fetch(`${url}${path}`, {
      ...options,
      headers,
      dispatcher: daemonDispatcher,
    } as RequestInit & { dispatcher: Agent });
    // /api/auth/ and /api/setup/ are public endpoints — a 401 from them is not
    // a session problem, and "run `volute login`" would be nonsense mid-login.
    if (res.status === 401 && !path.startsWith("/api/auth/") && !path.startsWith("/api/setup/")) {
      if (cliSession) {
        console.error("Session expired. Run `volute login` again.");
      } else {
        console.error("Not logged in. Run `volute login` first.");
      }
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
