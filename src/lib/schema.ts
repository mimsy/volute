import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").unique().notNull(),
  password_hash: text("password_hash").notNull(),
  role: text("role").notNull().default("pending"),
  created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    agent_name: text("agent_name").notNull(),
    channel: text("channel").notNull(),
    user_id: integer("user_id").references(() => users.id),
    title: text("title"),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
    updated_at: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_conversations_agent_name").on(table.agent_name),
    index("idx_conversations_user_id").on(table.user_id),
    index("idx_conversations_updated_at").on(table.updated_at),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agent: text("agent").notNull(),
    channel: text("channel").notNull(),
    role: text("role").notNull(),
    sender: text("sender"),
    content: text("content").notNull(),
    created_at: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_agent_messages_agent").on(table.agent),
    index("idx_agent_messages_channel").on(table.agent, table.channel),
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
