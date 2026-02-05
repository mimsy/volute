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

export type MoltEvent =
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
  pid: number | null;
  created: string;
  status: string;
};

export type FileContent = {
  filename: string;
  content: string;
};

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function fetchAgent(name: string): Promise<Agent> {
  const res = await fetch(`/api/agents/${name}`);
  if (!res.ok) throw new Error("Failed to fetch agent");
  return res.json();
}

export async function startAgent(name: string): Promise<void> {
  const res = await fetch(`/api/agents/${name}/start`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to start");
  }
}

export async function stopAgent(name: string): Promise<void> {
  const res = await fetch(`/api/agents/${name}/stop`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to stop");
  }
}

export async function fetchVariants(name: string): Promise<Variant[]> {
  const res = await fetch(`/api/agents/${name}/variants`);
  if (!res.ok) throw new Error("Failed to fetch variants");
  return res.json();
}

export async function fetchFiles(name: string): Promise<string[]> {
  const res = await fetch(`/api/agents/${name}/files`);
  if (!res.ok) throw new Error("Failed to fetch files");
  return res.json();
}

export async function fetchFile(name: string, filename: string): Promise<FileContent> {
  const res = await fetch(`/api/agents/${name}/files/${filename}`);
  if (!res.ok) throw new Error("Failed to fetch file");
  return res.json();
}

export async function saveFile(name: string, filename: string, content: string): Promise<void> {
  const res = await fetch(`/api/agents/${name}/files/${filename}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to save file");
}

export type Conversation = {
  id: string;
  agent_name: string;
  channel: string;
  user_id: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
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
  const res = await fetch(`/api/agents/${name}/conversations`);
  if (!res.ok) throw new Error("Failed to fetch conversations");
  return res.json();
}

export async function fetchConversationMessages(
  name: string,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const res = await fetch(`/api/agents/${name}/conversations/${conversationId}/messages`);
  if (!res.ok) throw new Error("Failed to fetch messages");
  return res.json();
}

export async function deleteConversation(name: string, conversationId: string): Promise<void> {
  const res = await fetch(`/api/agents/${name}/conversations/${conversationId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete conversation");
}
