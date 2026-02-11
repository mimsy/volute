import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voluteHome } from "../registry.js";

function getDaemonConfig(): { url: string; token?: string } {
  const configPath = resolve(voluteHome(), "daemon.json");
  if (!existsSync(configPath)) {
    throw new Error("Volute daemon is not running");
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err}`);
  }
  if (typeof config.port !== "number") {
    throw new Error(`Invalid or missing port in ${configPath}`);
  }
  const url = new URL("http://localhost");
  url.hostname = (config.hostname as string) || "localhost";
  url.port = String(config.port);
  return { url: url.origin, token: config.token as string | undefined };
}

export async function read(
  env: Record<string, string>,
  conversationId: string,
  limit: number,
): Promise<string> {
  const agentName = env.VOLUTE_AGENT;
  if (!agentName) throw new Error("VOLUTE_AGENT not set");

  const { url, token } = getDaemonConfig();
  const headers: Record<string, string> = { Origin: url };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `${url}/api/agents/${encodeURIComponent(agentName)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers },
  );
  if (!res.ok) {
    throw new Error(`Failed to read conversation: ${res.status} ${res.statusText}`);
  }
  const messages = (await res.json()) as {
    role: string;
    sender_name: string | null;
    content: string | { type: string; text?: string }[];
  }[];
  return messages
    .slice(-limit)
    .map((m) => {
      const text = Array.isArray(m.content)
        ? m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("")
        : m.content;
      return `${m.sender_name ?? m.role}: ${text}`;
    })
    .join("\n");
}

export async function send(
  env: Record<string, string>,
  conversationId: string,
  message: string,
): Promise<void> {
  const agentName = env.VOLUTE_AGENT;
  if (!agentName) throw new Error("VOLUTE_AGENT not set");

  const { url, token } = getDaemonConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: url,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${url}/api/agents/${encodeURIComponent(agentName)}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, conversationId, sender: env.VOLUTE_AGENT }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to send: ${res.status}`);
  }
  // Drain the response body so the request completes
  if (res.body) {
    const reader = res.body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }
}
