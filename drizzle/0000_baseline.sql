-- Baseline schema: all tables as of v0.30.x
-- Uses IF NOT EXISTS so existing installs safely skip everything.

CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL DEFAULT 'pending',
	`user_type` text NOT NULL DEFAULT 'brain',
	`display_name` text,
	`description` text,
	`avatar` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `minds` (
	`name` text PRIMARY KEY NOT NULL,
	`port` integer NOT NULL,
	`parent` text REFERENCES `minds`(`name`) ON DELETE CASCADE,
	`dir` text,
	`branch` text,
	`stage` text,
	`template` text,
	`template_hash` text,
	`running` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_minds_port` ON `minds` (`port`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_minds_parent` ON `minds` (`parent`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`mind_name` text,
	`channel` text NOT NULL,
	`type` text NOT NULL DEFAULT 'dm',
	`name` text,
	`user_id` integer REFERENCES `users`(`id`),
	`title` text,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_mind_name` ON `conversations` (`mind_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_user_id` ON `conversations` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_updated_at` ON `conversations` (`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_conversations_name` ON `conversations` (`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL,
	`sender_name` text,
	`content` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_conversation_id` ON `messages` (`conversation_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversation_participants` (
	`conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL DEFAULT 'member',
	`joined_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cp_unique` ON `conversation_participants` (`conversation_id`, `user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cp_user_id` ON `conversation_participants` (`user_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mind_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`channel` text,
	`session` text,
	`sender` text,
	`message_id` text,
	`type` text NOT NULL DEFAULT 'inbound',
	`content` text,
	`metadata` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind` ON `mind_history` (`mind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_channel` ON `mind_history` (`mind`, `channel`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_type` ON `mind_history` (`mind`, `type`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_prompts` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shared_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL DEFAULT '',
	`author` text NOT NULL,
	`version` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`session` text NOT NULL,
	`channel` text,
	`sender` text,
	`status` text NOT NULL DEFAULT 'pending',
	`payload` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_mind_session` ON `delivery_queue` (`mind`, `session`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_mind_status` ON `delivery_queue` (`mind`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`mind` text NOT NULL,
	`summary` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_created_at` ON `activity` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_mind` ON `activity` (`mind`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversation_reads` (
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	`last_read_message_id` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_conversation_reads_unique` ON `conversation_reads` (`user_id`, `conversation_id`);
