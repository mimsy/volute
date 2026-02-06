CREATE TABLE `agent_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`channel` text NOT NULL,
	`role` text NOT NULL,
	`sender` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_agent` ON `agent_messages` (`agent`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_channel` ON `agent_messages` (`agent`,`channel`);