-- Rebuild conversations table: make mind_name nullable, add type + name columns
CREATE TABLE `conversations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`mind_name` text,
	`channel` text NOT NULL,
	`type` text NOT NULL DEFAULT 'dm',
	`name` text,
	`user_id` integer REFERENCES `users`(`id`),
	`title` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint
INSERT INTO `conversations_new` (`id`, `mind_name`, `channel`, `type`, `name`, `user_id`, `title`, `created_at`, `updated_at`)
	SELECT `id`, `mind_name`, `channel`, 'dm', NULL, `user_id`, `title`, `created_at`, `updated_at` FROM `conversations`;--> statement-breakpoint
DROP TABLE `conversations`;--> statement-breakpoint
ALTER TABLE `conversations_new` RENAME TO `conversations`;--> statement-breakpoint
CREATE INDEX `idx_conversations_mind_name` ON `conversations` (`mind_name`);--> statement-breakpoint
CREATE INDEX `idx_conversations_user_id` ON `conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_updated_at` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conversations_name` ON `conversations` (`name`);--> statement-breakpoint
-- Backfill: mark conversations with 3+ participants as 'group'
UPDATE `conversations` SET `type` = 'group' WHERE `id` IN (
	SELECT `conversation_id` FROM `conversation_participants` GROUP BY `conversation_id` HAVING COUNT(*) > 2
);
