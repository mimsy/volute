CREATE INDEX IF NOT EXISTS `idx_turns_mind_created_at` ON `turns` (`mind`,`created_at`);
CREATE INDEX IF NOT EXISTS `idx_mind_history_session` ON `mind_history` (`session`);
CREATE INDEX IF NOT EXISTS `idx_mind_history_mind_created_at` ON `mind_history` (`mind`,`created_at`);
CREATE INDEX IF NOT EXISTS `idx_summaries_mind_period_key` ON `summaries` (`mind`,`period_key`);
CREATE INDEX IF NOT EXISTS `idx_activity_type` ON `activity` (`type`);
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_status` ON `delivery_queue` (`status`);
