CREATE TABLE `conversation_reads` (
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
	`last_read_message_id` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conversation_reads_unique` ON `conversation_reads` (`user_id`, `conversation_id`);
