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
// TODO(#330 follow-up): restore sane timeouts once lifecycle ops are async jobs.
export const daemonDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

function voluteUserHome(): string {
  return process.env.VOLUTE_USER_HOME ?? resolve(homedir(), ".volute");
}

function voluteSystemDir(): string {
  const home = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  return resolve(home, "system");
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
  // A mind runs the CLI inside its sandbox, which denies the whole host home —
  // daemon.json included. It doesn't need the file: the daemon that spawned it
  // passes the same connection details in its env, as it does for the mind server.
  const mindPort = process.env.VOLUTE_MIND_TOKEN && process.env.VOLUTE_DAEMON_PORT;
  if (mindPort) {
    return {
      port: Number(mindPort),
      hostname: process.env.VOLUTE_DAEMON_HOSTNAME || "127.0.0.1",
      token: process.env.VOLUTE_MIND_TOKEN,
    };
  }

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

/**
 * Extract a one-line error message from a failed daemon response. The daemon
 * usually returns `{ error }` JSON, but a route miss (e.g. a wildcard swallowing
 * a more-specific sibling) can return a text/plain body like "Not found".
 * Parsing that as JSON throws SyntaxError; this reads the body once as text,
 * prefers the JSON `error` field when present, and otherwise falls back to the
 * raw text (or `fallback` when the body is empty). Never throws.
 */
export async function daemonErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return fallback;
  try {
    const data = JSON.parse(text) as { error?: string };
    return data.error ?? text;
  } catch {
    return text;
  }
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

  // Pass session context for turn resolution — set per SDK subprocess at spawn,
  // inherited by the shell that runs this CLI, so it names the calling turn's session
  const voluteSession = process.env.VOLUTE_SESSION;
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
    // /api/v1/auth/ and /api/v1/setup/ are public endpoints — a 401 from them is
    // not a session problem, and "run `volute login`" would be nonsense mid-login.
    if (
      res.status === 401 &&
      !path.startsWith("/api/v1/auth/") &&
      !path.startsWith("/api/v1/setup/")
    ) {
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
