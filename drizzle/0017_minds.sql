CREATE TABLE `minds` (
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
CREATE UNIQUE INDEX `idx_minds_port` ON `minds` (`port`);
--> statement-breakpoint
CREATE INDEX `idx_minds_parent` ON `minds` (`parent`);
