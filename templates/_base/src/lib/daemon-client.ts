import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.VOLUTE_DAEMON_PORT;
const mind = process.env.VOLUTE_MIND;
const token = process.env.VOLUTE_DAEMON_TOKEN;

/** Read session from file (fallback for sandbox where env vars don't propagate). */
function readSessionFile(): string | undefined {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) return undefined;
  try {
    const p = resolve(mindDir, ".mind", "current-session");
    if (existsSync(p)) return readFileSync(p, "utf-8").trim() || undefined;
  } catch (err) {
    console.warn(`[volute] failed to read session file: ${err}`);
  }
  return undefined;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  // Origin header required for CSRF checks on mutation requests
  if (port) h.Origin = `http://127.0.0.1:${port}`;
  // Tag requests with the current session for turn resolution
  const session = process.env.VOLUTE_SESSION ?? readSessionFile();
  if (session) h["X-Volute-Session"] = session;
  return h;
}

export async function daemonRestart(context?: {
  type: string;
  [k: string]: unknown;
}): Promise<void> {
  if (!port || !mind) {
    console.error("[volute] daemonRestart: VOLUTE_DAEMON_PORT or VOLUTE_MIND not set");
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/api/minds/${encodeURIComponent(mind)}/restart`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ context }),
    });
  } catch {
    // Daemon may kill us before response arrives — expected
  }
}

export type EventType =
  | "thinking"
  | "text"
  | "tool_use"
  | "tool_result"
  | "log"
  | "usage"
  | "session_start"
  | "done"
  | "inbound"
  | "outbound"
  | "context";

export type DaemonEvent = {
  type: EventType;
  session?: string;
  channel?: string;
  messageId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

export async function daemonEmit(event: DaemonEvent): Promise<void> {
  if (!port || !mind) {
    if (process.env.VOLUTE_DEBUG === "1") {
      console.error("[volute] daemonEmit: missing VOLUTE_DAEMON_PORT or VOLUTE_MIND");
    }
    return;
  }
  const url = `http://127.0.0.1:${port}/api/minds/${encodeURIComponent(mind)}/events`;
  const body = JSON.stringify(event);
  // Critical events (done) get retries — if lost, turns stay stuck until daemon restart
  const maxAttempts = event.type === "done" ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: headers(), body });
      if (res.ok) return;
      console.error(`[volute] event emit failed: ${res.status}`);
      // Don't retry client errors — they won't succeed on retry
      if (res.status >= 400 && res.status < 500) return;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    } catch (err) {
      if (attempt >= maxAttempts) {
        console.error(`[volute] event emit failed after ${maxAttempts} attempts:`, err);
      } else {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
}

export async function daemonSendFile(
  targetMind: string,
  filePath: string,
): Promise<{ status: string; id?: string; destPath?: string }> {
  if (!port || !mind) {
    throw new Error("[volute] daemonSendFile: VOLUTE_DAEMON_PORT or VOLUTE_MIND not set");
  }
  const res = await fetch(
    `http://127.0.0.1:${port}/api/minds/${encodeURIComponent(mind)}/files/send`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ targetMind, filePath }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`daemonSendFile failed (${res.status}): ${body}`);
  }
  return (await res.json()) as { status: string; id?: string; destPath?: string };
}
