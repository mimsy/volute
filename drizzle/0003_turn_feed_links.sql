-- Link feed items (messages, activities) to turns via turn_id

ALTER TABLE `messages` ADD `turn_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_turn_id` ON `messages` (`turn_id`);
--> statement-breakpoint
ALTER TABLE `activity` ADD `turn_id` text;
--> statement-breakpoint
ALTER TABLE `activity` ADD `source_event_id` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_activity_turn_id` ON `activity` (`turn_id`);
