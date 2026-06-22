-- Failure notices delivered to minds on their next successful turn

CREATE TABLE IF NOT EXISTS `mind_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`session` text NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`raw` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_notices_mind_session` ON `mind_notices` (`mind`, `session`);
