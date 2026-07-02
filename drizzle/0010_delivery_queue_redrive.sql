-- Make delivery_queue an at-least-once queue: track attempts and a backoff
-- window so a redrive loop can re-deliver stranded rows without hot-looping.

ALTER TABLE `delivery_queue` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `delivery_queue` ADD `next_attempt_at` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_delivery_queue_status_next` ON `delivery_queue` (`status`, `next_attempt_at`);
