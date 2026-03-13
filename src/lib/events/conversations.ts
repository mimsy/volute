import { randomUUID } from "node:crypto";
import type {
  ContentBlock,
  Conversation,
  LastMessageSummary,
  Message,
  Participant,
} from "@volute/api";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import {
  conversationParticipants,
  conversationReads,
  conversations,
  messages,
  users,
} from "../schema.js";
import { fireWebhook } from "../webhook.js";
import { publish } from "./conversation-events.js";

export type { ContentBlock, Conversation, LastMessageSummary, Message, Participant };

export async function createConversation(
  mindName: string | null,
  channel: string,
  opts?: {
    userId?: number;
    title?: string;
    participantIds?: number[];
    type?: "dm" | "channel";
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

  fireWebhook({
    event: "conversation_created",
    mind: mindName ?? "",
    data: { id, mindName, channel, type, name, title: opts?.title ?? null },
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
      displayName: users.display_name,
      description: users.description,
      avatar: users.avatar,
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
  return isParticipant(conversationId, userId);
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

  const msg: Message = {
    id: result.id,
    conversation_id: conversationId,
    role: role as Message["role"],
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

  // Look up the mind that owns this conversation for the webhook
  const conv = await db
    .select({ mind_name: conversations.mind_name })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();

  fireWebhook({
    event: "message_created",
    mind: conv?.mind_name ?? "",
    data: {
      conversationId,
      messageId: result.id,
      role,
      senderName,
      content: content.filter((b) => b.type !== "image"),
      createdAt: result.created_at,
    },
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

  return rows.map(parseMessageRow);
}

export async function getMessagesPaginated(
  conversationId: string,
  opts?: { before?: number; limit?: number },
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const db = await getDb();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);

  const conditions = [eq(messages.conversation_id, conversationId)];
  if (opts?.before != null) {
    conditions.push(lt(messages.id, opts.before));
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return {
    messages: page.map(parseMessageRow),
    hasMore,
  };
}

function parseMessageRow(row: typeof messages.$inferSelect): Message {
  let content: ContentBlock[];
  try {
    const parsed = JSON.parse(row.content);
    content = Array.isArray(parsed) ? parsed : [{ type: "text", text: row.content }];
  } catch {
    content = [{ type: "text", text: row.content }];
  }
  return { ...row, role: row.role as Message["role"], content };
}

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
      displayName: users.display_name,
      description: users.description,
      avatar: users.avatar,
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
      displayName: r.displayName,
      description: r.description,
      avatar: r.avatar,
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
        role: m.role as Message["role"],
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

export async function listConversationsForMind(
  mindName: string,
): Promise<(Conversation & { participants: Participant[]; lastMessage?: LastMessageSummary })[]> {
  const db = await getDb();

  // Find conversations by mind_name
  const byName = (await db
    .select()
    .from(conversations)
    .where(eq(conversations.mind_name, mindName))
    .orderBy(desc(conversations.updated_at))
    .all()) as Conversation[];

  // Also find conversations where the mind is a participant
  const mindUser = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, mindName), eq(users.user_type, "mind")))
    .get();

  const byNameIds = new Set(byName.map((c) => c.id));
  let byParticipation: Conversation[] = [];
  if (mindUser) {
    const participantRows = await db
      .select({ conversation_id: conversationParticipants.conversation_id })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.user_id, mindUser.id))
      .all();
    const extraIds = participantRows
      .map((r) => r.conversation_id)
      .filter((id) => !byNameIds.has(id));
    if (extraIds.length > 0) {
      byParticipation = (await db
        .select()
        .from(conversations)
        .where(inArray(conversations.id, extraIds))
        .orderBy(desc(conversations.updated_at))
        .all()) as Conversation[];
    }
  }

  const convs = [...byName, ...byParticipation].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );

  if (convs.length === 0) return [];

  const convIds = convs.map((c) => c.id);
  const rows = await db
    .select({
      conversationId: conversationParticipants.conversation_id,
      userId: users.id,
      username: users.username,
      userType: users.user_type,
      role: conversationParticipants.role,
      displayName: users.display_name,
      description: users.description,
      avatar: users.avatar,
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
      displayName: r.displayName,
      description: r.description,
      avatar: r.avatar,
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
        role: m.role as Message["role"],
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

export async function isConversationForMind(
  mindName: string,
  conversationId: string,
): Promise<boolean> {
  const db = await getDb();

  // Check if conversation belongs to mind by mind_name
  const byName = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.mind_name, mindName)))
    .get();
  if (byName) return true;

  // Check if mind is a participant
  const mindUser = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, mindName), eq(users.user_type, "mind")))
    .get();
  if (!mindUser) return false;

  const participant = await db
    .select({ conversation_id: conversationParticipants.conversation_id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversation_id, conversationId),
        eq(conversationParticipants.user_id, mindUser.id),
      ),
    )
    .get();
  return !!participant;
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

// --- Unread tracking ---

export async function getUnreadCounts(
  userId: number,
  conversationIds: string[],
): Promise<Record<string, number>> {
  if (conversationIds.length === 0) return {};
  const db = await getDb();
  const rows = await db
    .select({
      conversationId: messages.conversation_id,
      count: sql<number>`COUNT(*)`,
    })
    .from(messages)
    .leftJoin(
      conversationReads,
      and(
        eq(conversationReads.conversation_id, messages.conversation_id),
        eq(conversationReads.user_id, userId),
      ),
    )
    .where(
      and(
        inArray(messages.conversation_id, conversationIds),
        sql`${messages.id} > COALESCE(${conversationReads.last_read_message_id}, 0)`,
      ),
    )
    .groupBy(messages.conversation_id);

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.conversationId] = row.count;
  }
  return result;
}

export async function markConversationRead(userId: number, conversationId: string): Promise<void> {
  const db = await getDb();
  const maxRow = await db
    .select({ maxId: sql<number>`MAX(${messages.id})` })
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .get();

  const maxId = maxRow?.maxId ?? 0;
  if (maxId === 0) return;

  await db
    .insert(conversationReads)
    .values({ user_id: userId, conversation_id: conversationId, last_read_message_id: maxId })
    .onConflictDoUpdate({
      target: [conversationReads.user_id, conversationReads.conversation_id],
      set: { last_read_message_id: maxId },
    });
}
