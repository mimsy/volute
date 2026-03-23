CREATE TABLE IF NOT EXISTS `meta_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`period` text NOT NULL,
	`period_key` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_meta_summaries_unique` ON `meta_summaries` (`mind`, `period`, `period_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_meta_summaries_mind_period` ON `meta_summaries` (`mind`, `period`);
