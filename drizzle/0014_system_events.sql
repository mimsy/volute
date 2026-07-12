-- System events: environment → mind traffic (replaces mind_notices).
-- No sender, no reply target; a separate stream from chat.

CREATE TABLE IF NOT EXISTS `system_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mind` text NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`meta` text,
	`delivery` text NOT NULL DEFAULT 'immediate',
	`session` text NOT NULL DEFAULT 'main',
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`delivered_at` text,
	`reflection` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind` ON `system_events` (`mind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind_delivery` ON `system_events` (`mind`, `delivery`, `delivered_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_events_mind_type` ON `system_events` (`mind`, `type`);
--> statement-breakpoint
DROP TABLE IF EXISTS `mind_notices`;
