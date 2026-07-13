-- Rename the routing "session" column to "thread" on turns, mind_history,
-- delivery_queue, and system_events. The routing sense of "session" is renamed
-- to "thread" (issue #493); auth sessions and SDK transcript files keep "session".
ALTER TABLE `turns` RENAME COLUMN `session` TO `thread`;--> statement-breakpoint
ALTER TABLE `mind_history` RENAME COLUMN `session` TO `thread`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mind_history_session`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mind_history_thread` ON `mind_history` (`thread`);--> statement-breakpoint
ALTER TABLE `delivery_queue` RENAME COLUMN `session` TO `thread`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_delivery_queue_mind_session`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_mind_thread` ON `delivery_queue` (`mind`, `thread`);--> statement-breakpoint
-- system_events is created by 0014 on this same train, so the rename is always valid.
ALTER TABLE `system_events` RENAME COLUMN `session` TO `thread`;
