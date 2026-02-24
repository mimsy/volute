import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").unique().notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("pending"),
  user_type: text("user_type").notNull().default("brain"),
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
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_mind_history_mind").on(table.mind),
    index("idx_mind_history_mind_channel").on(table.mind, table.channel),
    index("idx_mind_history_mind_type").on(table.mind, table.type),
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
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_activity_created_at").on(table.created_at),
    index("idx_activity_mind").on(table.mind),
  ],
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
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_messages_conversation_id").on(table.conversation_id)],
);
