CREATE TABLE `delivery_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`session` text NOT NULL,
	`channel` text,
	`sender` text,
	`status` text NOT NULL DEFAULT 'pending',
	`payload` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_delivery_queue_mind_session` ON `delivery_queue` (`mind`, `session`);--> statement-breakpoint
CREATE INDEX `idx_delivery_queue_mind_status` ON `delivery_queue` (`mind`, `status`);
