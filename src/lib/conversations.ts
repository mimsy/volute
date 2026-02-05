import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

export type Conversation = {
  id: string;
  agent_name: string;
  channel: string;
  user_id: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: number;
  conversation_id: string;
  role: string;
  sender_name: string | null;
  content: ContentBlock[];
  created_at: string;
};

export function createConversation(
  agentName: string,
  channel: string,
  opts?: { userId?: number; title?: string },
): Conversation {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO conversations (id, agent_name, channel, user_id, title) VALUES (?, ?, ?, ?, ?)",
  ).run(id, agentName, channel, opts?.userId ?? null, opts?.title ?? null);

  return {
    id,
    agent_name: agentName,
    channel,
    user_id: opts?.userId ?? null,
    title: opts?.title ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function getOrCreateConversation(
  agentName: string,
  channel: string,
  opts?: { userId?: number },
): Conversation {
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM conversations WHERE agent_name = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(agentName, channel) as Conversation | undefined;

  if (existing) return existing;
  return createConversation(agentName, channel, opts);
}

export function getConversation(id: string): Conversation | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Conversation
    | undefined;
  return row ?? null;
}

export function listConversations(agentName: string, opts?: { userId?: number }): Conversation[] {
  const db = getDb();
  if (opts?.userId != null) {
    return db
      .prepare(
        "SELECT * FROM conversations WHERE agent_name = ? AND user_id = ? ORDER BY updated_at DESC",
      )
      .all(agentName, opts.userId) as Conversation[];
  }
  return db
    .prepare("SELECT * FROM conversations WHERE agent_name = ? ORDER BY updated_at DESC")
    .all(agentName) as Conversation[];
}

export function addMessage(
  conversationId: string,
  role: string,
  senderName: string | null,
  content: ContentBlock[],
): Message {
  const db = getDb();
  const serialized = JSON.stringify(content);
  const result = db
    .prepare(
      "INSERT INTO messages (conversation_id, role, sender_name, content) VALUES (?, ?, ?, ?)",
    )
    .run(conversationId, role, senderName, serialized);

  // Update conversation's updated_at and set title from first message if unset
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(
    conversationId,
  );

  if (role === "user") {
    const firstText = content.find((b) => b.type === "text");
    const title = firstText ? (firstText as { text: string }).text.slice(0, 80) : "";
    if (title) {
      db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL").run(
        title,
        conversationId,
      );
    }
  }

  return {
    id: Number(result.lastInsertRowid),
    conversation_id: conversationId,
    role,
    sender_name: senderName,
    content,
    created_at: new Date().toISOString(),
  };
}

export function getMessages(conversationId: string): Message[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .all(conversationId) as Array<Omit<Message, "content"> & { content: string }>;

  return rows.map((row) => {
    let content: ContentBlock[];
    try {
      const parsed = JSON.parse(row.content);
      content = Array.isArray(parsed) ? parsed : [{ type: "text", text: row.content }];
    } catch {
      content = [{ type: "text", text: row.content }];
    }
    return { ...row, content };
  });
}

export function deleteConversation(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}
