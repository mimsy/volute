DROP INDEX IF EXISTS `idx_mind_messages_mind`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mind_messages_channel`;--> statement-breakpoint
CREATE TABLE `mind_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`channel` text,
	`session` text,
	`sender` text,
	`message_id` text,
	`type` text NOT NULL DEFAULT 'inbound',
	`content` text,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint
INSERT INTO `mind_history` (`id`, `mind`, `channel`, `sender`, `type`, `content`, `created_at`)
	SELECT `id`, `mind`, `channel`, `sender`, 'inbound', `content`, `created_at` FROM `mind_messages`;--> statement-breakpoint
DROP TABLE `mind_messages`;--> statement-breakpoint
CREATE INDEX `idx_mind_history_mind` ON `mind_history` (`mind`);--> statement-breakpoint
CREATE INDEX `idx_mind_history_mind_channel` ON `mind_history` (`mind`, `channel`);--> statement-breakpoint
CREATE INDEX `idx_mind_history_mind_type` ON `mind_history` (`mind`, `type`);
