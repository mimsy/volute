import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { VoluteEvent } from "../../types.js";
import type { ChannelConversation, ChannelUser } from "../channels.js";
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

export async function* sendAndStream(
  env: Record<string, string>,
  conversationId: string,
  message: string,
): AsyncGenerator<VoluteEvent> {
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
    body: JSON.stringify({ message, conversationId, sender: env.VOLUTE_SENDER ?? agentName }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to send: ${res.status}`);
  }
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const event = JSON.parse(data) as VoluteEvent;
          yield event;
          if (event.type === "done") return;
        } catch (err) {
          console.error(`[volute] failed to parse SSE data: ${data}`, err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function send(
  env: Record<string, string>,
  conversationId: string,
  message: string,
): Promise<void> {
  for await (const event of sendAndStream(env, conversationId, message)) {
    if (event.type === "done") break;
  }
}

export async function listConversations(
  env: Record<string, string>,
): Promise<ChannelConversation[]> {
  const agentName = env.VOLUTE_AGENT;
  if (!agentName) throw new Error("VOLUTE_AGENT not set");

  const { url, token } = getDaemonConfig();
  const headers: Record<string, string> = { Origin: url };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${url}/api/agents/${encodeURIComponent(agentName)}/conversations`, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`Failed to list conversations: ${res.status} ${res.statusText}`);
  }
  const convs = (await res.json()) as {
    id: string;
    title: string | null;
    participants?: { userId: number }[];
  }[];

  // Fetch participant counts
  const results: ChannelConversation[] = [];
  for (const conv of convs) {
    let participantCount: number | undefined;
    try {
      const pRes = await fetch(
        `${url}/api/agents/${encodeURIComponent(agentName)}/conversations/${encodeURIComponent(conv.id)}/participants`,
        { headers },
      );
      if (pRes.ok) {
        const participants = (await pRes.json()) as unknown[];
        participantCount = participants.length;
      }
    } catch (err) {
      console.error(`[volute] failed to fetch participants for ${conv.id}:`, err);
    }
    results.push({
      id: `volute:${conv.id}`,
      name: conv.title ?? "(untitled)",
      type: participantCount === 2 ? "dm" : "group",
      participantCount,
    });
  }
  return results;
}

export async function listUsers(_env: Record<string, string>): Promise<ChannelUser[]> {
  const { url, token } = getDaemonConfig();
  const headers: Record<string, string> = { Origin: url };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${url}/api/auth/users`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to list users: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    id: number;
    username: string;
    user_type: string;
  }[];
  return data.map((u) => ({
    id: String(u.id),
    username: u.username,
    type: u.user_type,
  }));
}

export async function createConversation(
  env: Record<string, string>,
  participants: string[],
  name?: string,
): Promise<string> {
  const agentName = env.VOLUTE_AGENT;
  if (!agentName) throw new Error("VOLUTE_AGENT not set");

  const { url, token } = getDaemonConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: url,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${url}/api/agents/${encodeURIComponent(agentName)}/conversations`, {
    method: "POST",
    headers,
    body: JSON.stringify({ participantNames: participants, title: name }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to create conversation: ${res.status}`);
  }
  const conv = (await res.json()) as { id: string };
  return conv.id;
}
