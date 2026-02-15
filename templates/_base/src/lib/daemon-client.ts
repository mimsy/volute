const port = process.env.VOLUTE_DAEMON_PORT;
const agent = process.env.VOLUTE_AGENT;
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
  if (!port || !agent) {
    console.error("[volute] daemonRestart: VOLUTE_DAEMON_PORT or VOLUTE_AGENT not set");
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}/api/agents/${encodeURIComponent(agent)}/restart`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ context }),
    });
  } catch {
    // Daemon may kill us before response arrives — expected
  }
}

export async function daemonSend(channel: string, text: string): Promise<void> {
  if (!port || !agent) {
    console.error("[volute] daemonSend: VOLUTE_DAEMON_PORT or VOLUTE_AGENT not set");
    return;
  }
  const res = await fetch(
    `http://127.0.0.1:${port}/api/agents/${encodeURIComponent(agent)}/message`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: text,
        channel,
        sender: agent,
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`daemonSend failed (${res.status}): ${body}`);
  }
}
