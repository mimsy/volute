CREATE TABLE IF NOT EXISTS `channels` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`rules` text,
	`char_limit` integer,
	`private` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_channels_name` ON `channels` (`name`);
--> statement-breakpoint
INSERT INTO `channels` (`conversation_id`, `name`, `private`, `created_at`, `updated_at`)
SELECT `id`, `name`, `private`, `created_at`, `updated_at`
FROM `conversations` WHERE `type` = 'channel' AND `name` IS NOT NULL;
