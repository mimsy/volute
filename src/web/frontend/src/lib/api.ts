import { hc } from "hono/client";
import type { AppType } from "../../../app.js";

const client = hc<AppType>("/");

export type Channel = {
  name: string;
  displayName: string;
  status: "connected" | "disconnected";
  showToolCalls: boolean;
  username?: string;
  connectedAt?: string;
};

export type Agent = {
  name: string;
  port: number;
  created: string;
  status: "running" | "stopped" | "starting";
  channels: Channel[];
};

export type VoluteEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "meta"; conversationId: string }
  | { type: "done" };

export type Variant = {
  name: string;
  branch: string;
  path: string;
  port: number;
  created: string;
  status: string;
};

export type FileContent = {
  filename: string;
  content: string;
};

export async function fetchAgents(): Promise<Agent[]> {
  const res = await client.api.agents.$get();
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function fetchAgent(name: string): Promise<Agent> {
  const res = await client.api.agents[":name"].$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch agent");
  return res.json();
}

export async function startAgent(name: string): Promise<void> {
  const res = await client.api.agents[":name"].start.$post({ param: { name } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to start");
  }
}

export async function stopAgent(name: string): Promise<void> {
  const res = await client.api.agents[":name"].stop.$post({ param: { name } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to stop");
  }
}

export async function fetchVariants(name: string): Promise<Variant[]> {
  const res = await client.api.agents[":name"].variants.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch variants");
  return res.json();
}

export async function fetchFiles(name: string): Promise<string[]> {
  const res = await client.api.agents[":name"].files.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch files");
  return res.json();
}

export async function fetchFile(name: string, filename: string): Promise<FileContent> {
  const res = await client.api.agents[":name"].files[":filename"].$get({
    param: { name, filename },
  });
  if (!res.ok) throw new Error("Failed to fetch file");
  return res.json();
}

export async function saveFile(name: string, filename: string, content: string): Promise<void> {
  const res = await client.api.agents[":name"].files[":filename"].$put({
    param: { name, filename },
    json: { content },
  });
  if (!res.ok) throw new Error("Failed to save file");
}

export type Participant = {
  userId: number;
  username: string;
  userType: string;
  role: string;
};

export type Conversation = {
  id: string;
  agent_name: string;
  channel: string;
  user_id: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  participants?: Participant[];
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

export type ConversationMessage = {
  id: number;
  conversation_id: string;
  role: string;
  sender_name: string | null;
  content: ContentBlock[] | string;
  created_at: string;
};

export async function fetchConversations(name: string): Promise<Conversation[]> {
  const res = await client.api.agents[":name"].conversations.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function fetchConversationMessages(
  name: string,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const res = await client.api.agents[":name"].conversations[":id"].messages.$get({
    param: { name, id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export type HistoryMessage = {
  id: number;
  agent: string;
  channel: string;
  role: string;
  sender: string | null;
  content: string;
  created_at: string;
};

export async function fetchHistory(
  name: string,
  opts?: { channel?: string; limit?: number; offset?: number },
): Promise<HistoryMessage[]> {
  const params = new URLSearchParams();
  if (opts?.channel) params.set("channel", opts.channel);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}/history${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function fetchHistoryChannels(name: string): Promise<string[]> {
  const res = await fetch(`/api/agents/${encodeURIComponent(name)}/history/channels`);
  if (!res.ok) throw new Error("Failed to fetch channels");
  return res.json();
}

export async function deleteConversation(name: string, conversationId: string): Promise<void> {
  const res = await client.api.agents[":name"].conversations[":id"].$delete({
    param: { name, id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}
