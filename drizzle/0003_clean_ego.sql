CREATE TABLE `conversation_participants` (
	`conversation_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cp_conversation_id` ON `conversation_participants` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_cp_user_id` ON `conversation_participants` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `user_type` text DEFAULT 'human' NOT NULL;