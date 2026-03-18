ALTER TABLE `minds` ADD `mind_type` text NOT NULL DEFAULT 'mind';
--> statement-breakpoint
ALTER TABLE `minds` ADD `created_by` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_minds_mind_type` ON `minds` (`mind_type`);
