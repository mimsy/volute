-- First-class turns: track turn lifecycle and link events/messages to turns

CREATE TABLE IF NOT EXISTS `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`mind` text NOT NULL,
	`session` text,
	`trigger_event_id` integer,
	`summary_event_id` integer,
	`status` text NOT NULL DEFAULT 'active',
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_mind` ON `turns` (`mind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turns_mind_status` ON `turns` (`mind`, `status`);
--> statement-breakpoint
ALTER TABLE `mind_history` ADD `turn_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_turn_id` ON `mind_history` (`turn_id`);
--> statement-breakpoint
ALTER TABLE `messages` ADD `source_event_id` integer;
