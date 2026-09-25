const port = process.env.VOLUTE_DAEMON_PORT;
const mind = process.env.VOLUTE_MIND;
const token = process.env.VOLUTE_MIND_TOKEN;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  // Origin header required for CSRF checks on mutation requests
  if (port) h.Origin = `http://127.0.0.1:${port}`;
  // Tag requests with the current session for turn resolution. Set per SDK
  // subprocess at spawn (templates/claude/src/agent.ts createStream), so it is
  // per-turn-truthful — not a process-global.
  const session = process.env.VOLUTE_SESSION;
  if (session) h["X-Volute-Thread"] = session;
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
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/minds/${encodeURIComponent(mind)}/restart`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ context }),
      },
    );
    // A successful restart usually kills us before this runs. If we get here with a
    // non-ok status, the restart didn't happen — surface it instead of silently looping.
    if (!res.ok) {
      console.error(
        `[volute] daemonRestart failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
  } catch (err) {
    // A successful restart usually rejects here — the daemon kills us before the
    // response arrives — so this is expected on the happy path. It's only worth
    // surfacing when a restart *didn't* happen (e.g. the daemon is down / refuses
    // the connection), which leaves the mind stuck on its old identity. Gate it on
    // VOLUTE_DEBUG so normal restarts stay quiet but the failure is diagnosable.
    if (process.env.VOLUTE_DEBUG === "1") {
      console.error(
        "[volute] daemonRestart request errored (expected if the daemon killed us):",
        err,
      );
    }
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
  | "error"
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
  const url = `http://127.0.0.1:${port}/api/v1/minds/${encodeURIComponent(mind)}/events`;
  const body = JSON.stringify(event);
  // Critical events get retries: `done` (else turns stay stuck) and `error` (else the
  // mind never learns a failure happened). The daemon is local, so retrying against it
  // is worthwhile even when the model provider is the thing that's failing.
  const maxAttempts = event.type === "done" || event.type === "error" ? 3 : 1;
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

/** Whether this process has a daemon to talk to (false in tests or a server run by hand). */
export function hasDaemon(): boolean {
  return Boolean(port && mind);
}

/**
 * Record a notice with the daemon — it reaches the mind through the next-turn
 * notices drain (the pre-prompt hook). Use for failures the daemon can't see
 * itself, like context loss inside the mind process. `thread` scopes the notice
 * to one thread's drain; omitted, any thread's next turn picks it up.
 * Best-effort: logs on failure, never throws. Resolves true once the daemon has
 * recorded it.
 */
export async function daemonNotice(input: {
  kind: string;
  message: string;
  thread?: string;
}): Promise<boolean> {
  if (!port || !mind) {
    console.error("[volute] daemonNotice: VOLUTE_DAEMON_PORT or VOLUTE_MIND not set");
    return false;
  }
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/minds/${encodeURIComponent(mind)}/notices`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      console.error(
        `[volute] daemonNotice failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[volute] daemonNotice request errored:", err);
    return false;
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
    `http://127.0.0.1:${port}/api/v1/minds/${encodeURIComponent(mind)}/files/send`,
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

/**
 * How long a seam waits for recollection before seeding the verbatim tail alone. Short,
 * because the mind's first reply after the seam waits on it.
 */
export const RECOLLECTION_TIMEOUT_MS = 8_000;

/**
 * The mind's consolidated recollection for a seam: week/day/hour memories before
 * `before`, stopping where the verbatim tail starts (`tailStartedAt`), oldest → newest.
 * Throws on any failure, including the timeout — the seeders catch it and seed the
 * tail alone.
 */
export async function daemonRecollection(
  query: { before: string; tailStartedAt?: string },
  timeoutMs = RECOLLECTION_TIMEOUT_MS,
): Promise<unknown[]> {
  if (!port || !mind) throw new Error("VOLUTE_DAEMON_PORT or VOLUTE_MIND not set");
  const params = new URLSearchParams({ before: query.before });
  if (query.tailStartedAt) params.set("tailStartedAt", query.tailStartedAt);
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/minds/${encodeURIComponent(mind)}/history/recollection?${params}`,
    { headers: headers(), signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!res.ok) throw new Error(`recollection failed: ${res.status}`);
  const body = (await res.json()) as { entries?: unknown };
  if (!Array.isArray(body.entries)) throw new Error("recollection response has no entries");
  return body.entries;
}
