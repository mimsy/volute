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

export type Mind = {
  name: string;
  port: number;
  created: string;
  status: "running" | "stopped" | "starting";
  stage?: "seed" | "sprouted";
  channels: Channel[];
  hasPages?: boolean;
  lastActiveAt?: string | null;
};

export type RecentPage = {
  mind: string;
  file: string;
  modified: string;
  url: string;
};

export type VoluteEvent =
  | { type: "meta"; conversationId: string; senderName?: string }
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

export async function fetchMinds(): Promise<Mind[]> {
  const res = await client.api.minds.$get();
  if (!res.ok) throw new Error("Failed to fetch minds");
  return res.json();
}

export async function fetchMind(name: string): Promise<Mind> {
  const res = await client.api.minds[":name"].$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch mind");
  return res.json();
}

export async function startMind(name: string): Promise<void> {
  const res = await client.api.minds[":name"].start.$post({ param: { name } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to start");
  }
}

export async function stopMind(name: string): Promise<void> {
  const res = await client.api.minds[":name"].stop.$post({ param: { name } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to stop");
  }
}

export async function fetchVariants(name: string): Promise<Variant[]> {
  const res = await client.api.minds[":name"].variants.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch variants");
  return res.json();
}

export async function fetchFiles(name: string): Promise<string[]> {
  const res = await client.api.minds[":name"].files.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch files");
  return res.json();
}

export async function fetchFile(name: string, filename: string): Promise<FileContent> {
  const res = await client.api.minds[":name"].files[":filename"].$get({
    param: { name, filename },
  });
  if (!res.ok) throw new Error("Failed to fetch file");
  return res.json();
}

export type Participant = {
  userId: number;
  username: string;
  userType: string;
  role: string;
};

export type Conversation = {
  id: string;
  mind_name: string;
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
  const res = await client.api.minds[":name"].conversations.$get({ param: { name } });
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function fetchConversationMessages(
  name: string,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const res = await client.api.minds[":name"].conversations[":id"].messages.$get({
    param: { name, id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export type HistoryMessage = {
  id: number;
  mind: string;
  channel: string;
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
  const res = await fetch(`/api/minds/${encodeURIComponent(name)}/history${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch history");
  return res.json();
}

export async function fetchHistoryChannels(name: string): Promise<string[]> {
  const res = await fetch(`/api/minds/${encodeURIComponent(name)}/history/channels`);
  if (!res.ok) throw new Error("Failed to fetch channels");
  return res.json();
}

export async function deleteConversation(name: string, conversationId: string): Promise<void> {
  const res = await client.api.minds[":name"].conversations[":id"].$delete({
    param: { name, id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}

export async function createGroupConversation(
  name: string,
  participantIds: number[],
  title?: string,
): Promise<Conversation> {
  const res = await client.api.minds[":name"].conversations.$post({
    param: { name },
    json: { participantIds, title },
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to create conversation");
  }
  return res.json();
}

export type AvailableUser = {
  id: number;
  username: string;
  role: string;
  user_type: string;
};

export async function fetchAvailableUsers(type?: string): Promise<AvailableUser[]> {
  const params = type ? `?type=${type}` : "";
  const res = await fetch(`/api/auth/users${params}`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export type LastMessageSummary = {
  role: string;
  senderName: string | null;
  text: string;
  createdAt: string;
};

export async function fetchAllConversations(): Promise<
  (Conversation & { participants: Participant[]; lastMessage?: LastMessageSummary })[]
> {
  const res = await client.api.conversations.$get();
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function fetchConversationMessagesById(
  conversationId: string,
): Promise<ConversationMessage[]> {
  const res = await client.api.conversations[":id"].messages.$get({
    param: { id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export async function deleteConversationById(conversationId: string): Promise<void> {
  const res = await client.api.conversations[":id"].$delete({
    param: { id: conversationId },
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}

export async function createConversationWithParticipants(
  participantNames: string[],
  title?: string,
): Promise<Conversation> {
  const res = await client.api.conversations.$post({
    json: { participantNames, title },
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to create conversation");
  }
  return res.json();
}

export async function fetchRecentPages(): Promise<RecentPage[]> {
  const res = await client.api.minds.pages.recent.$get();
  if (!res.ok) throw new Error("Failed to fetch recent pages");
  return res.json();
}

export function reportTyping(
  mindName: string,
  channel: string,
  sender: string,
  active: boolean,
): void {
  fetch(`/api/minds/${encodeURIComponent(mindName)}/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, sender, active }),
  }).catch(() => {});
}

export async function fetchTyping(mindName: string, channel: string): Promise<string[]> {
  const res = await fetch(
    `/api/minds/${encodeURIComponent(mindName)}/typing?channel=${encodeURIComponent(channel)}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch typing (${res.status})`);
  const data = (await res.json()) as { typing: string[] };
  return data.typing;
}

export async function fetchSystemInfo(): Promise<{ system: string | null }> {
  try {
    const res = await fetch("/api/system/info", { credentials: "include" });
    if (!res.ok) return { system: null };
    return await res.json();
  } catch {
    return { system: null };
  }
}

export async function createSeedMind(
  name: string,
  opts?: { description?: string; template?: string; model?: string },
): Promise<{ name: string; port: number }> {
  const res = await client.api.minds.$post({
    json: {
      name,
      stage: "seed" as const,
      description: opts?.description,
      template: opts?.template,
      model: opts?.model,
    },
  });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Failed to create mind");
  }
  return res.json() as Promise<{ name: string; port: number }>;
}
