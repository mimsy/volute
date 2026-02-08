import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { conversations, messages } from "./schema.js";

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

export async function createConversation(
  agentName: string,
  channel: string,
  opts?: { userId?: number; title?: string },
): Promise<Conversation> {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(conversations).values({
    id,
    agent_name: agentName,
    channel,
    user_id: opts?.userId ?? null,
    title: opts?.title ?? null,
  });

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

export async function getOrCreateConversation(
  agentName: string,
  channel: string,
  opts?: { userId?: number },
): Promise<Conversation> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.agent_name, agentName), eq(conversations.channel, channel)))
    .orderBy(desc(conversations.updated_at))
    .limit(1)
    .get();

  if (existing) return existing as Conversation;
  return createConversation(agentName, channel, opts);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const row = await db.select().from(conversations).where(eq(conversations.id, id)).get();
  return (row as Conversation) ?? null;
}

export async function getConversationForUser(
  id: string,
  userId: number,
): Promise<Conversation | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
    .get();
  return (row as Conversation) ?? null;
}

export async function deleteConversationForUser(id: string, userId: number): Promise<boolean> {
  const conv = await getConversationForUser(id, userId);
  if (!conv) return false;
  await deleteConversation(id);
  return true;
}

export async function listConversations(
  agentName: string,
  opts?: { userId?: number },
): Promise<Conversation[]> {
  const db = await getDb();
  if (opts?.userId != null) {
    return db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agent_name, agentName), eq(conversations.user_id, opts.userId)))
      .orderBy(desc(conversations.updated_at))
      .all() as Promise<Conversation[]>;
  }
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.agent_name, agentName))
    .orderBy(desc(conversations.updated_at))
    .all() as Promise<Conversation[]>;
}

export async function addMessage(
  conversationId: string,
  role: string,
  senderName: string | null,
  content: ContentBlock[],
): Promise<Message> {
  const db = await getDb();
  const serialized = JSON.stringify(content);
  const [result] = await db
    .insert(messages)
    .values({ conversation_id: conversationId, role, sender_name: senderName, content: serialized })
    .returning({ id: messages.id, created_at: messages.created_at });

  // Update conversation's updated_at
  await db
    .update(conversations)
    .set({ updated_at: sql`datetime('now')` })
    .where(eq(conversations.id, conversationId));

  // Set title from first user text block if unset
  if (role === "user") {
    const firstText = content.find((b) => b.type === "text");
    const title = firstText ? (firstText as { text: string }).text.slice(0, 80) : "";
    if (title) {
      await db
        .update(conversations)
        .set({ title })
        .where(and(eq(conversations.id, conversationId), isNull(conversations.title)));
    }
  }

  return {
    id: result.id,
    conversation_id: conversationId,
    role,
    sender_name: senderName,
    content,
    created_at: result.created_at,
  };
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .orderBy(messages.created_at)
    .all();

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

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(conversations).where(eq(conversations.id, id));
}
