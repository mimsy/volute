CREATE TABLE `note_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL REFERENCES `notes`(`id`) ON DELETE CASCADE,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`emoji` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_note_reactions_unique` ON `note_reactions` (`note_id`, `user_id`, `emoji`);
--> statement-breakpoint
CREATE INDEX `idx_note_reactions_note_id` ON `note_reactions` (`note_id`);
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `reply_to_id` integer REFERENCES `notes`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_notes_reply_to` ON `notes`(`reply_to_id`);
