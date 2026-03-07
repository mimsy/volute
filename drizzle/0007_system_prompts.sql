CREATE TABLE `system_prompts` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
