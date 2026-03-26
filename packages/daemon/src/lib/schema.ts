import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const minds = sqliteTable(
  "minds",
  {
    name: text("name").primaryKey(),
    port: integer("port").notNull().unique(),
    parent: text("parent").references((): any => minds.name, { onDelete: "cascade" }),
    dir: text("dir"),
    branch: text("branch"),
    stage: text("stage"),
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
  user_type: text("user_type").notNull().default("brain"),
  display_name: text("display_name"),
  description: text("description"),
  avatar: text("avatar"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    mind_name: text("mind_name"),
    channel: text("channel").notNull(),
    type: text("type").notNull().default("dm"),
    name: text("name"),
    user_id: integer("user_id").references(() => users.id),
    title: text("title"),
    private: integer("private").notNull().default(0),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_conversations_mind_name").on(table.mind_name),
    index("idx_conversations_user_id").on(table.user_id),
    index("idx_conversations_updated_at").on(table.updated_at),
    uniqueIndex("idx_conversations_name").on(table.name),
  ],
);

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    mind: text("mind").notNull(),
    session: text("session"),
    trigger_event_id: integer("trigger_event_id"),
    summary_event_id: integer("summary_event_id"),
    summary_id: integer("summary_id"),
    status: text("status").notNull().default("active"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_turns_mind").on(table.mind),
    index("idx_turns_mind_status").on(table.mind, table.status),
  ],
);

export const mindHistory = sqliteTable(
  "mind_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mind: text("mind").notNull(),
    channel: text("channel"),
    session: text("session"),
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
    mind: text("mind").notNull(),
    session: text("session").notNull(),
    channel: text("channel"),
    sender: text("sender"),
    status: text("status").notNull().default("pending"),
    payload: text("payload").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_delivery_queue_mind_session").on(table.mind, table.session),
    index("idx_delivery_queue_mind_status").on(table.mind, table.status),
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
