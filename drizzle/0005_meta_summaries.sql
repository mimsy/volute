CREATE TABLE IF NOT EXISTS `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`period` text NOT NULL,
	`period_key` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_summaries_unique` ON `summaries` (`mind`, `period`, `period_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_summaries_mind_period` ON `summaries` (`mind`, `period`);
--> statement-breakpoint
ALTER TABLE `turns` ADD `summary_id` integer REFERENCES `summaries`(`id`);
