import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { conversationParticipants, conversations, messages, users } from "../schema.js";
import { publish } from "./conversation-events.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string };

export type Conversation = {
  id: string;
  mind_name: string | null;
  channel: string;
  type: "dm" | "group" | "channel";
  name: string | null;
  user_id: number | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type Participant = {
  userId: number;
  username: string;
  userType: "brain" | "mind";
  role: "owner" | "member";
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
  mindName: string | null,
  channel: string,
  opts?: {
    userId?: number;
    title?: string;
    participantIds?: number[];
    type?: "dm" | "group" | "channel";
    name?: string;
  },
): Promise<Conversation> {
  const db = await getDb();
  const id = randomUUID();
  const type = opts?.type ?? "dm";
  const name = opts?.name ?? null;

  await db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id,
      mind_name: mindName,
      channel,
      type,
      name,
      user_id: opts?.userId ?? null,
      title: opts?.title ?? null,
    });

    // Add participants if provided
    if (opts?.participantIds && opts.participantIds.length > 0) {
      await tx.insert(conversationParticipants).values(
        opts.participantIds.map((uid, i) => ({
          conversation_id: id,
          user_id: uid,
          role: i === 0 ? "owner" : "member",
        })),
      );
    }
  });

  return {
    id,
    mind_name: mindName,
    channel,
    type,
    name,
    user_id: opts?.userId ?? null,
    title: opts?.title ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function getOrCreateConversation(
  mindName: string,
  channel: string,
  opts?: { userId?: number },
): Promise<Conversation> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.mind_name, mindName),
        eq(conversations.channel, channel),
        eq(conversations.type, "dm"),
      ),
    )
    .orderBy(desc(conversations.updated_at))
    .limit(1)
    .get();

  if (existing) return existing as Conversation;
  return createConversation(mindName, channel, opts);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  const row = await db.select().from(conversations).where(eq(conversations.id, id)).get();
  return (row as Conversation) ?? null;
}

export async function addParticipant(
  conversationId: string,
  userId: number,
  role = "member",
): Promise<void> {
  const db = await getDb();
  await db.insert(conversationParticipants).values({
    conversation_id: conversationId,
    user_id: userId,
    role,
  });
}

export async function removeParticipant(conversationId: string, userId: number): Promise<void> {
  const db = await getDb();
  await db
    .delete(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversation_id, conversationId),
        eq(conversationParticipants.user_id, userId),
      ),
    );
}

export async function getParticipants(conversationId: string): Promise<Participant[]> {
  const db = await getDb();
  const rows = await db
    .select({
      userId: conversationParticipants.user_id,
      username: users.username,
      userType: users.user_type,
      role: conversationParticipants.role,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(conversationParticipants.user_id, users.id))
    .where(eq(conversationParticipants.conversation_id, conversationId))
    .all();
  return rows as Participant[];
}

export async function isParticipant(conversationId: string, userId: number): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ user_id: conversationParticipants.user_id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversation_id, conversationId),
        eq(conversationParticipants.user_id, userId),
      ),
    )
    .get();
  return row != null;
}

export async function listConversationsForUser(userId: number): Promise<Conversation[]> {
  const db = await getDb();
  // Get conversation IDs this user participates in
  const participantRows = await db
    .select({ conversation_id: conversationParticipants.conversation_id })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.user_id, userId))
    .all();

  if (participantRows.length === 0) return [];

  const convIds = participantRows.map((r) => r.conversation_id);
  return (await db
    .select()
    .from(conversations)
    .where(inArray(conversations.id, convIds))
    .orderBy(desc(conversations.updated_at))
    .all()) as Conversation[];
}

export async function isParticipantOrOwner(
  conversationId: string,
  userId: number,
): Promise<boolean> {
  // Check participant table first
  if (await isParticipant(conversationId, userId)) return true;
  // Fall back to legacy user_id column
  const db = await getDb();
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId)))
    .get();
  return row != null;
}

export async function deleteConversationForUser(id: string, userId: number): Promise<boolean> {
  if (!(await isParticipantOrOwner(id, userId))) return false;
  await deleteConversation(id);
  return true;
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

  const msg = {
    id: result.id,
    conversation_id: conversationId,
    role,
    sender_name: senderName,
    content,
    created_at: result.created_at,
  };

  publish(conversationId, {
    type: "message",
    id: msg.id,
    role: msg.role as "user" | "assistant",
    senderName: msg.sender_name,
    content: msg.content,
    createdAt: msg.created_at,
  });

  return msg;
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

export type LastMessageSummary = {
  role: string;
  senderName: string | null;
  text: string;
  createdAt: string;
};

export async function listConversationsWithParticipants(
  userId: number,
): Promise<(Conversation & { participants: Participant[]; lastMessage?: LastMessageSummary })[]> {
  const convs = await listConversationsForUser(userId);
  if (convs.length === 0) return [];
  const db = await getDb();
  const convIds = convs.map((c) => c.id);
  const rows = await db
    .select({
      conversationId: conversationParticipants.conversation_id,
      userId: users.id,
      username: users.username,
      userType: users.user_type,
      role: conversationParticipants.role,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(conversationParticipants.user_id, users.id))
    .where(inArray(conversationParticipants.conversation_id, convIds));
  const byConv = new Map<string, Participant[]>();
  for (const r of rows) {
    let arr = byConv.get(r.conversationId);
    if (!arr) {
      arr = [];
      byConv.set(r.conversationId, arr);
    }
    arr.push({
      userId: r.userId,
      username: r.username,
      userType: r.userType as "brain" | "mind",
      role: r.role as "owner" | "member",
    });
  }

  // Fetch last message per conversation
  const lastMsgIds = await db
    .select({
      conversationId: messages.conversation_id,
      maxId: sql<number>`MAX(${messages.id})`,
    })
    .from(messages)
    .where(inArray(messages.conversation_id, convIds))
    .groupBy(messages.conversation_id);

  const byLastMsg = new Map<string, LastMessageSummary>();
  if (lastMsgIds.length > 0) {
    const msgRows = await db
      .select()
      .from(messages)
      .where(
        inArray(
          messages.id,
          lastMsgIds.map((r) => r.maxId),
        ),
      );
    for (const m of msgRows) {
      let text = "";
      try {
        const parsed = JSON.parse(m.content);
        const blocks: ContentBlock[] = Array.isArray(parsed) ? parsed : [];
        const textBlock = blocks.find((b) => b.type === "text");
        if (textBlock && "text" in textBlock) text = textBlock.text;
      } catch {
        text = m.content;
      }
      byLastMsg.set(m.conversation_id, {
        role: m.role,
        senderName: m.sender_name,
        text,
        createdAt: m.created_at,
      });
    }
  }

  return convs.map((c) => ({
    ...c,
    participants: byConv.get(c.id) ?? [],
    lastMessage: byLastMsg.get(c.id),
  }));
}

export async function findDMConversation(
  mindName: string,
  participantIds: [number, number],
): Promise<string | null> {
  const db = await getDb();
  // Find DM conversations for this mind with exactly these two participants
  const mindConvs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.mind_name, mindName), eq(conversations.type, "dm")))
    .all();

  for (const conv of mindConvs) {
    const rows = await db
      .select({ user_id: conversationParticipants.user_id })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversation_id, conv.id))
      .all();

    if (rows.length !== 2) continue;
    const ids = new Set(rows.map((r) => r.user_id));
    if (ids.has(participantIds[0]) && ids.has(participantIds[1])) {
      return conv.id;
    }
  }
  return null;
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(conversations).where(eq(conversations.id, id));
}

// --- Channel CRUD ---

export async function createChannel(name: string, creatorId?: number): Promise<Conversation> {
  const participantIds = creatorId ? [creatorId] : [];
  return createConversation(null, "volute", {
    type: "channel",
    name,
    title: name,
    participantIds,
  });
}

export async function getChannelByName(name: string): Promise<Conversation | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.name, name), eq(conversations.type, "channel")))
    .get();
  return (row as Conversation) ?? null;
}

export async function listChannels(): Promise<Conversation[]> {
  const db = await getDb();
  return (await db
    .select()
    .from(conversations)
    .where(eq(conversations.type, "channel"))
    .orderBy(conversations.name)
    .all()) as Conversation[];
}

export async function joinChannel(conversationId: string, userId: number): Promise<void> {
  if (await isParticipant(conversationId, userId)) return;
  await addParticipant(conversationId, userId);
}

export async function leaveChannel(conversationId: string, userId: number): Promise<void> {
  await removeParticipant(conversationId, userId);
}
