-- Squashed baseline: the full schema as of schema.ts (see #713).
-- Every statement uses IF NOT EXISTS so existing installs already at this
-- schema (e.g. bardo) run it as a no-op instead of failing on CREATE.
CREATE TABLE IF NOT EXISTS `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`mind` text NOT NULL,
	`summary` text NOT NULL,
	`metadata` text,
	`turn_id` text,
	`source_event_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_created_at` ON `activity` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_mind` ON `activity` (`mind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_turn_id` ON `activity` (`turn_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_type` ON `activity` (`type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_tokens_hash` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_tokens_user` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channel_gates` (
	`mind` text NOT NULL,
	`channel` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`mind`, `channel`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `channels` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`rules` text,
	`char_limit` integer,
	`private` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_channels_name` ON `channels` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversation_participants` (
	`conversation_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cp_unique` ON `conversation_participants` (`conversation_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cp_user_id` ON `conversation_participants` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversation_reads` (
	`user_id` integer NOT NULL,
	`conversation_id` text NOT NULL,
	`last_read_message_id` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_conversation_reads_unique` ON `conversation_reads` (`user_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text DEFAULT 'dm' NOT NULL,
	`user_id` integer,
	`private` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_user_id` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_conversations_updated_at` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `delivery_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`target_mind` text,
	`thread` text NOT NULL,
	`channel` text,
	`sender` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_mind_thread` ON `delivery_queue` (`mind`,`thread`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_mind_status` ON `delivery_queue` (`mind`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_status` ON `delivery_queue` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_status_next` ON `delivery_queue` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`sender_name` text,
	`content` text NOT NULL,
	`source_event_id` integer,
	`turn_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_conversation_id` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_turn_id` ON `messages` (`turn_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mind_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`channel` text,
	`thread` text,
	`sender` text,
	`message_id` text,
	`type` text NOT NULL,
	`content` text,
	`metadata` text,
	`turn_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind` ON `mind_history` (`mind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_channel` ON `mind_history` (`mind`,`channel`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_type` ON `mind_history` (`mind`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_turn_id` ON `mind_history` (`turn_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_thread` ON `mind_history` (`thread`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_created_at` ON `mind_history` (`mind`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `minds` (
	`name` text PRIMARY KEY NOT NULL,
	`port` integer NOT NULL,
	`parent` text,
	`dir` text,
	`branch` text,
	`stage` text,
	`purpose` text,
	`template` text,
	`template_hash` text,
	`running` integer DEFAULT 0 NOT NULL,
	`mind_type` text DEFAULT 'mind' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent`) REFERENCES `minds`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `minds_port_unique` ON `minds` (`port`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_minds_parent` ON `minds` (`parent`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_minds_mind_type` ON `minds` (`mind_type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shared_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`author` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`period` text NOT NULL,
	`period_key` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_summaries_unique` ON `summaries` (`mind`,`period`,`period_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_summaries_mind_period` ON `summaries` (`mind`,`period`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_summaries_mind_period_key` ON `summaries` (`mind`,`period_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`meta` text,
	`delivery` text DEFAULT 'immediate' NOT NULL,
	`thread` text DEFAULT 'main' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`delivered_at` text,
	`reflection` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind` ON `system_events` (`mind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind_delivery` ON `system_events` (`mind`,`delivery`,`delivered_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind_type` ON `system_events` (`mind`,`type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_prompts` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`mind` text NOT NULL,
	`thread` text,
	`trigger_event_id` integer,
	`summary_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_mind` ON `turns` (`mind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_mind_status` ON `turns` (`mind`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_mind_created_at` ON `turns` (`mind`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'pending' NOT NULL,
	`user_type` text DEFAULT 'human' NOT NULL,
	`display_name` text,
	`description` text,
	`avatar` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);