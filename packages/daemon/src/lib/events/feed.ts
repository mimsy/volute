import type { FeedChatEvent, FeedDigest, FeedLifecycleEvent, Participant } from "@volute/api";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { aiCompleteUtility } from "../ai-service.js";
import { SYSTEM_MIND } from "../daemon/summarizer.js";
import { getDb } from "../db.js";
import { getPrompt } from "../prompts.js";
import {
  activity,
  channels,
  conversationParticipants,
  conversations,
  messages,
  summaries,
  users,
} from "../schema.js";
import { getPeriodKey, parseUtcDateTime, utcDateTimeStr } from "../util/period-keys.js";

/** Gap between consecutive messages that splits one conversation burst from the next. */
export const BURST_GAP_MS = 45 * 60_000;

/** How far back the feed reaches. */
const FEED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Lifecycle activity types surfaced as feed rows. */
const LIFECYCLE_TYPES = [
  "mind_started",
  "mind_stopped",
  "mind_sleeping",
  "mind_waking",
  "mind_error",
  "backup_failed",
] as const;

/** Max snippet lines carried per chat card. */
const SNIPPET_MESSAGES = 3;
/** Max chars per snippet line. */
const SNIPPET_CHARS = 280;

/** The cache mind for the AI daily digest — distinct from the summarizer's `_system` rows. */
const DIGEST_MIND = "system";

type MessageLike = { id: number; conversation_id: string; created_at: string };

export type Burst<T extends MessageLike> = {
  conversationId: string;
  messages: T[];
  startedAt: string;
  endedAt: string;
  messageCount: number;
};

/**
 * Split messages into conversation bursts. Rows are grouped by conversation
 * (preserving their ascending-by-id order within each conversation) and a new
 * burst begins whenever the gap between two consecutive messages exceeds
 * `gapMs`. A gap of exactly `gapMs` stays in one burst. Pure — no DB access.
 */
export function splitIntoBursts<T extends MessageLike>(
  rows: T[],
  gapMs = BURST_GAP_MS,
): Burst<T>[] {
  const byConv = new Map<string, T[]>();
  for (const row of rows) {
    let arr = byConv.get(row.conversation_id);
    if (!arr) {
      arr = [];
      byConv.set(row.conversation_id, arr);
    }
    arr.push(row);
  }

  const bursts: Burst<T>[] = [];
  for (const [conversationId, msgs] of byConv) {
    let current: T[] = [];
    let prevTime = 0;
    for (const msg of msgs) {
      const t = parseUtcDateTime(msg.created_at).getTime();
      if (current.length > 0 && t - prevTime > gapMs) {
        bursts.push(makeBurst(conversationId, current));
        current = [];
      }
      current.push(msg);
      prevTime = t;
    }
    if (current.length > 0) bursts.push(makeBurst(conversationId, current));
  }
  return bursts;
}

function makeBurst<T extends MessageLike>(conversationId: string, msgs: T[]): Burst<T> {
  return {
    conversationId,
    messages: msgs,
    startedAt: msgs[0].created_at,
    endedAt: msgs[msgs.length - 1].created_at,
    messageCount: msgs.length,
  };
}

/** Extract the first text block from a message's stored content JSON. */
function extractText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const block = parsed.find((b) => b?.type === "text");
      return block && typeof block.text === "string" ? block.text : "";
    }
    return raw;
  } catch {
    return raw;
  }
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

type ChatMessageRow = MessageLike & {
  role: string;
  sender_name: string | null;
  content: string;
  conversation_type: string;
};

/**
 * Recent conversation bursts across all NON-private conversations, newest first.
 * Bursts are derived from the `messages` table at read time (no dedicated table).
 */
export async function getChatFeedEvents(opts?: { limit?: number }): Promise<FeedChatEvent[]> {
  const db = await getDb();
  const cutoff = utcDateTimeStr(new Date(Date.now() - FEED_WINDOW_MS));

  const rows = await db
    .select({
      id: messages.id,
      conversation_id: messages.conversation_id,
      role: messages.role,
      sender_name: messages.sender_name,
      content: messages.content,
      created_at: messages.created_at,
      conversation_type: conversations.type,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversation_id))
    // Exclude sender-less `event` rows (#system announcements, #687): they're events, not
    // conversation activity, so they must not form "chat burst" cards — that would relocate the
    // exact spirit-misattribution #687 removes (ChatEventCard renders a null sender as "mind"),
    // and a run of them would render as a fake conversation burst. Joins already surface as
    // lifecycle cards; the announcement itself lives in the #system channel.
    .where(
      and(
        gte(messages.created_at, cutoff),
        eq(conversations.private, 0),
        ne(messages.role, "event"),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(5000);

  // Reverse desc(id) → ascending by id (and thus ascending within each conversation).
  const ascending = rows.reverse() as ChatMessageRow[];
  const bursts = splitIntoBursts(ascending);

  // Newest bursts first, tiebreaking on the last message id (created_at is
  // second-resolution, so same-second bursts would otherwise order arbitrarily).
  bursts.sort((a, b) => {
    const at = parseUtcDateTime(a.endedAt).getTime();
    const bt = parseUtcDateTime(b.endedAt).getTime();
    if (bt !== at) return bt - at;
    return lastId(b) - lastId(a);
  });

  const top = bursts.slice(0, opts?.limit ?? 50);
  if (top.length === 0) return [];

  const convIds = [...new Set(top.map((b) => b.conversationId))];
  const { participantsByConv, channelByConv } = await enrichBurstConversations(convIds);

  return top.map((burst) => {
    const snippetMsgs = burst.messages.slice(-SNIPPET_MESSAGES);
    const activeSenders = [
      ...new Set(burst.messages.map((m) => m.sender_name).filter((s): s is string => !!s)),
    ];
    return {
      kind: "chat" as const,
      conversationId: burst.conversationId,
      conversationType: (burst.messages[0].conversation_type === "channel" ? "channel" : "dm") as
        | "dm"
        | "channel",
      channelName: channelByConv.get(burst.conversationId) ?? null,
      participants: participantsByConv.get(burst.conversationId) ?? [],
      activeSenders,
      messageCount: burst.messageCount,
      startedAt: burst.startedAt,
      endedAt: burst.endedAt,
      snippet: snippetMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        senderName: m.sender_name,
        text: truncate(extractText(m.content), SNIPPET_CHARS),
        createdAt: m.created_at,
      })),
    };
  });
}

function lastId<T extends MessageLike>(burst: Burst<T>): number {
  return burst.messages[burst.messages.length - 1].id;
}

/** Batch-load participants and channel names for a set of conversations. */
async function enrichBurstConversations(convIds: string[]): Promise<{
  participantsByConv: Map<string, Participant[]>;
  channelByConv: Map<string, string>;
}> {
  const db = await getDb();
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
      channelName: channels.name,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(conversationParticipants.user_id, users.id))
    .leftJoin(channels, eq(channels.conversation_id, conversationParticipants.conversation_id))
    .where(inArray(conversationParticipants.conversation_id, convIds));

  const participantsByConv = new Map<string, Participant[]>();
  const channelByConv = new Map<string, string>();
  for (const r of rows) {
    let arr = participantsByConv.get(r.conversationId);
    if (!arr) {
      arr = [];
      participantsByConv.set(r.conversationId, arr);
    }
    if (!arr.some((p) => p.userId === r.userId)) {
      arr.push({
        userId: r.userId,
        username: r.username,
        userType: r.userType as Participant["userType"],
        role: r.role as "owner" | "member",
        displayName: r.displayName,
        description: r.description,
        avatar: r.avatar,
      });
    }
    if (r.channelName && !channelByConv.has(r.conversationId)) {
      channelByConv.set(r.conversationId, r.channelName);
    }
  }
  return { participantsByConv, channelByConv };
}

/**
 * Recent lifecycle activity (started/stopped/sleeping/waking/error/backup_failed).
 * `mind_error` and `backup_failed` summaries carry raw error detail (restic/backend
 * errors can embed repo locations or credentials), so they're redacted to a generic
 * message for non-privileged callers (mirrors #503's error-detail redaction).
 */
export async function getLifecycleFeedEvents(opts: {
  privileged: boolean;
  limit?: number;
}): Promise<FeedLifecycleEvent[]> {
  const db = await getDb();
  const cutoff = utcDateTimeStr(new Date(Date.now() - FEED_WINDOW_MS));

  const rows = await db
    .select({
      id: activity.id,
      type: activity.type,
      mind: activity.mind,
      summary: activity.summary,
      created_at: activity.created_at,
    })
    .from(activity)
    .where(and(inArray(activity.type, [...LIFECYCLE_TYPES]), gte(activity.created_at, cutoff)))
    .orderBy(desc(activity.created_at), desc(activity.id))
    .limit(opts.limit ?? 100);

  return rows.map((r) => ({
    kind: "lifecycle" as const,
    id: r.id,
    type: r.type as FeedLifecycleEvent["type"],
    mind: r.mind,
    summary: redactLifecycleSummary(r.type, r.summary, opts.privileged),
    createdAt: r.created_at,
  }));
}

/** Redact raw error detail from error/backup summaries for non-privileged callers. */
function redactLifecycleSummary(type: string, summary: string, privileged: boolean): string {
  if (privileged) return summary;
  if (type === "mind_error") return "An error interrupted this mind.";
  if (type === "backup_failed") return "A scheduled backup failed.";
  return summary;
}

/**
 * The AI daily digest for the home feed. Cached under `mind = "system"` (distinct
 * from the summarizer's `mind = "_system"` rollups) keyed on today's day period.
 * Sources the last 24h of `_system` hour summaries; falls back to recent per-mind
 * turn summaries. On AI failure, returns a deterministic one-liner WITHOUT caching
 * so a later request retries the AI. `complete` is injectable for tests.
 */
export async function getDailyDigest(
  complete: typeof aiCompleteUtility = aiCompleteUtility,
): Promise<FeedDigest> {
  const db = await getDb();
  const periodKey = getPeriodKey(new Date(), "day");

  const cached = await db
    .select({ content: summaries.content })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, DIGEST_MIND),
        eq(summaries.period, "day"),
        eq(summaries.period_key, periodKey),
      ),
    )
    .get();
  if (cached) return { content: cached.content };

  const cutoff = utcDateTimeStr(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const hourRows = await db
    .select({ content: summaries.content })
    .from(summaries)
    .where(
      and(
        eq(summaries.mind, SYSTEM_MIND),
        eq(summaries.period, "hour"),
        gte(summaries.created_at, cutoff),
      ),
    )
    .orderBy(summaries.period_key);

  let material = hourRows.map((r) => r.content).join("\n\n");

  if (!material.trim()) {
    // Fallback: recent per-mind turn summaries, truncated so the AI input stays bounded.
    const turnRows = await db
      .select({ mind: summaries.mind, content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.period, "turn"),
          gte(summaries.created_at, cutoff),
          sql`${summaries.mind} != ${SYSTEM_MIND}`,
        ),
      )
      .orderBy(desc(summaries.created_at))
      .limit(40);
    material = turnRows.map((r) => `[${r.mind}] ${truncate(r.content, 300)}`).join("\n");
  }

  if (!material.trim()) return { content: "" };

  const aiResult = await complete(await getPrompt("system_daily_digest"), material);
  if (aiResult) {
    await db
      .insert(summaries)
      .values({ mind: DIGEST_MIND, period: "day", period_key: periodKey, content: aiResult })
      .onConflictDoNothing();
    return { content: aiResult };
  }

  const counts = await digestCounts(cutoff);
  const mindWord = counts.minds === 1 ? "mind was" : "minds were";
  const convWord = counts.conversations === 1 ? "conversation" : "conversations";
  return {
    content: `${counts.minds} ${mindWord} active across ${counts.conversations} ${convWord} today.`,
  };
}

/** Counts for the deterministic digest fallback: active minds and conversations in window. */
async function digestCounts(cutoff: string): Promise<{ minds: number; conversations: number }> {
  const db = await getDb();
  const convRows = await db
    .select({ id: messages.conversation_id })
    .from(messages)
    .where(gte(messages.created_at, cutoff))
    .groupBy(messages.conversation_id);
  const mindRows = await db
    .select({ mind: summaries.mind })
    .from(summaries)
    .where(
      and(
        eq(summaries.period, "turn"),
        gte(summaries.created_at, cutoff),
        sql`${summaries.mind} != ${SYSTEM_MIND}`,
      ),
    )
    .groupBy(summaries.mind);
  return { minds: mindRows.length, conversations: convRows.length };
}
