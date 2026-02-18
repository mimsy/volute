ALTER TABLE `agent_messages` RENAME TO `mind_messages`;--> statement-breakpoint
ALTER TABLE `mind_messages` RENAME COLUMN `agent` TO `mind`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_messages_agent`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_messages_channel`;--> statement-breakpoint
CREATE INDEX `idx_mind_messages_mind` ON `mind_messages` (`mind`);--> statement-breakpoint
CREATE INDEX `idx_mind_messages_channel` ON `mind_messages` (`mind`, `channel`);--> statement-breakpoint
ALTER TABLE `conversations` RENAME COLUMN `agent_name` TO `mind_name`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_conversations_agent_name`;--> statement-breakpoint
CREATE INDEX `idx_conversations_mind_name` ON `conversations` (`mind_name`);--> statement-breakpoint
UPDATE `users` SET `user_type` = 'mind' WHERE `user_type` = 'agent';
