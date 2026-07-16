import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const minds = sqliteTable(
  "minds",
  {
    name: text("name").primaryKey(),
    port: integer("port").notNull().unique(),
    parent: text("parent").references((): any => minds.name, { onDelete: "cascade" }),
    dir: text("dir"),
    branch: text("branch"),
    stage: text("stage"),
    purpose: text("purpose"),
    template: text("template"),
    template_hash: text("template_hash"),
    running: integer("running").notNull().default(0),
    mind_type: text("mind_type").notNull().default("mind"),
    created_by: text("created_by"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_minds_parent").on(table.parent),
    index("idx_minds_mind_type").on(table.mind_type),
  ],
);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").unique().notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("pending"),
  user_type: text("user_type").notNull().default("human"),
  display_name: text("display_name"),
  description: text("description"),
  avatar: text("avatar"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// Durable, hashed, revocable per-user API credentials. Keyed to a users row —
// deliberately user_type-agnostic, so the same token type serves external minds
// and (later) external humans. Only the SHA-256 hash is stored; revocation is a
// row DELETE, and the FK cascade drops a user's tokens with the user.
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token_hash: text("token_hash").notNull(),
    label: text("label"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_api_tokens_hash").on(table.token_hash),
    index("idx_api_tokens_user").on(table.user_id),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull().default("dm"),
    user_id: integer("user_id").references(() => users.id),
    private: integer("private").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_conversations_user_id").on(table.user_id),
    index("idx_conversations_updated_at").on(table.updated_at),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    mind: text("mind").notNull(),
    thread: text("thread"),
    trigger_event_id: integer("trigger_event_id"),
    summary_id: integer("summary_id"),
    status: text("status").notNull().default("active"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_turns_mind").on(table.mind),
    index("idx_turns_mind_status").on(table.mind, table.status),
    index("idx_turns_mind_created_at").on(table.mind, table.created_at),
  ],
);

export const mindHistory = sqliteTable(
  "mind_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mind: text("mind").notNull(),
    channel: text("channel"),
    thread: text("thread"),
    sender: text("sender"),
    message_id: text("message_id"),
    type: text("type").notNull(),
    content: text("content"),
    metadata: text("metadata"),
    turn_id: text("turn_id"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_mind_history_mind").on(table.mind),
    index("idx_mind_history_mind_channel").on(table.mind, table.channel),
    index("idx_mind_history_mind_type").on(table.mind, table.type),
    index("idx_mind_history_turn_id").on(table.turn_id),
    index("idx_mind_history_thread").on(table.thread),
    index("idx_mind_history_mind_created_at").on(table.mind, table.created_at),
  ],
);

export const conversationParticipants = sqliteTable(
  "conversation_participants",
  {
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joined_at: text("joined_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_cp_unique").on(table.conversation_id, table.user_id),
    index("idx_cp_user_id").on(table.user_id),
  ],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  createdAt: integer("created_at").notNull(),
});

export const systemPrompts = sqliteTable("system_prompts", {
  key: text("key").primaryKey(),
  content: text("content").notNull(),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const sharedSkills = sqliteTable("shared_skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  author: text("author").notNull(),
  version: integer("version").notNull().default(1),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const deliveryQueue = sqliteTable(
  "delivery_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Keying/cleanup/dedup key: always the base (parent) name, so an insert under a
    // variant name and the id-scoped cleanup share a key.
    mind: text("mind").notNull(),
    // Original delivery target — may be a variant name. Used to resolve the port on
    // redrive so a variant's stranded message is re-delivered to the variant, not the
    // parent. Null on legacy rows → callers fall back to `mind`.
    target_mind: text("target_mind"),
    thread: text("thread").notNull(),
    channel: text("channel"),
    sender: text("sender"),
    status: text("status").notNull().default("pending"),
    payload: text("payload").notNull(),
    // Redrive bookkeeping: how many delivery attempts have been made, and the
    // earliest time the row is eligible for a retry (null = deliver ASAP).
    attempts: integer("attempts").notNull().default(0),
    next_attempt_at: text("next_attempt_at"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_delivery_queue_mind_thread").on(table.mind, table.thread),
    index("idx_delivery_queue_mind_status").on(table.mind, table.status),
    index("idx_delivery_queue_status").on(table.status),
    index("idx_delivery_queue_status_next").on(table.status, table.next_attempt_at),
  ],
);

export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    mind: text("mind").notNull(),
    summary: text("summary").notNull(),
    metadata: text("metadata"),
    turn_id: text("turn_id"),
    source_event_id: integer("source_event_id"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_activity_created_at").on(table.created_at),
    index("idx_activity_mind").on(table.mind),
    index("idx_activity_turn_id").on(table.turn_id),
    index("idx_activity_type").on(table.type),
  ],
);

export const summaries = sqliteTable(
  "summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mind: text("mind").notNull(),
    period: text("period").notNull(),
    period_key: text("period_key").notNull(),
    content: text("content").notNull(),
    metadata: text("metadata"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_summaries_unique").on(table.mind, table.period, table.period_key),
    index("idx_summaries_mind_period").on(table.mind, table.period),
    index("idx_summaries_mind_period_key").on(table.mind, table.period_key),
  ],
);

export const conversationReads = sqliteTable(
  "conversation_reads",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    last_read_message_id: integer("last_read_message_id").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_conversation_reads_unique").on(table.user_id, table.conversation_id),
  ],
);

export const channels = sqliteTable(
  "channels",
  {
    conversation_id: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    rules: text("rules"),
    char_limit: integer("char_limit"),
    private: integer("private").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex("idx_channels_name").on(table.name)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    sender_name: text("sender_name"),
    content: text("content").notNull(),
    source_event_id: integer("source_event_id"),
    turn_id: text("turn_id"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_messages_conversation_id").on(table.conversation_id),
    index("idx_messages_turn_id").on(table.turn_id),
  ],
);

// System events: environment → mind traffic (schedule fires, wake summaries, lifecycle
// context, budget/version/crash notices, invites, file-share offers, …). Distinct from
// chat messages — no sender, no reply target. `delivery: "immediate"` POSTs an event
// envelope to the mind (triggers a turn); `delivery: "next-turn"` is drained as a context
// block on the mind's next turn. `delivered_at` null = pending (sleep queue for immediate;
// undrained for next-turn). `reflection` holds the mind's closing text from the event turn.
export const systemEvents = sqliteTable(
  "system_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mind: text("mind").notNull(),
    type: text("type").notNull(),
    body: text("body").notNull(),
    // JSON: schedule id, sleep duration, variant name, lifecycle subtype, webhook source,
    // notice subtype/reason, etc.
    meta: text("meta"),
    delivery: text("delivery").$type<"immediate" | "next-turn">().notNull().default("immediate"),
    // Routing thread (default "main"). Next-turn notices tied to no thread use the
    // sentinel thread = "" so any thread's drain picks them up.
    thread: text("thread").notNull().default("main"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    delivered_at: text("delivered_at"),
    reflection: text("reflection"),
  },
  (table) => [
    index("idx_system_events_mind").on(table.mind),
    index("idx_system_events_mind_delivery").on(table.mind, table.delivery, table.delivered_at),
    index("idx_system_events_mind_type").on(table.mind, table.type),
  ],
);

// Per-(mind, channel) gate state for unrouted channels. A row exists once a mind
// has taken an explicit position on a gated channel; the only non-default state is
// "declined" (the mind has said it does not want this channel). Absence of a row
// means "pending" — the mind hasn't decided, so invites keep arriving on the
// notify cadence. Declined channels are never released and never re-notify.
export const channelGates = sqliteTable(
  "channel_gates",
  {
    mind: text("mind").notNull(),
    channel: text("channel").notNull(),
    state: text("state").$type<"pending" | "declined">().notNull(),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [primaryKey({ columns: [table.mind, table.channel] })],
);
