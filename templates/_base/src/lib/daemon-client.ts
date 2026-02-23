const port = process.env.VOLUTE_DAEMON_PORT;
const mind = process.env.VOLUTE_MIND;
const token = process.env.VOLUTE_DAEMON_TOKEN;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  // Origin header required for CSRF checks on mutation requests
  if (port) h.Origin = `http://127.0.0.1:${port}`;
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
  | "outbound";

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
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/minds/${encodeURIComponent(mind)}/events`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(event),
      },
    );
    if (!res.ok) {
      console.error(`[volute] event emit failed: ${res.status}`);
    }
  } catch {
    // Best-effort — don't let event emission failures break the mind
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

export async function daemonSend(channel: string, text: string): Promise<void> {
  if (!port || !mind) {
    console.error("[volute] daemonSend: VOLUTE_DAEMON_PORT or VOLUTE_MIND not set");
    return;
  }
  const res = await fetch(
    `http://127.0.0.1:${port}/api/minds/${encodeURIComponent(mind)}/message`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: text,
        channel,
        sender: mind,
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`daemonSend failed (${res.status}): ${body}`);
  }
}
