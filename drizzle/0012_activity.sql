CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`mind` text NOT NULL,
	`summary` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_created_at` ON `activity` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_activity_mind` ON `activity` (`mind`);
