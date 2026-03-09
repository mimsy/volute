CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notes_author_slug` ON `notes` (`author_id`, `slug`);
--> statement-breakpoint
CREATE INDEX `idx_notes_created_at` ON `notes` (`created_at`);
--> statement-breakpoint
CREATE TABLE `note_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`note_id` integer NOT NULL REFERENCES `notes`(`id`) ON DELETE CASCADE,
	`author_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`content` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `idx_note_comments_note_id` ON `note_comments` (`note_id`);
