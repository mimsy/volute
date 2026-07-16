-- Durable, hashed, revocable per-user API credentials.
--
-- Keyed to a `users` row rather than a mind name, so the same token type serves
-- external minds (users rows with user_type "mind" and no minds registry row)
-- and, later, external humans. Only the SHA-256 hash is stored; revocation is a
-- row DELETE, and the FK cascade drops a user's tokens along with the user.
--
-- Orthogonal to the in-memory native-mind token map: these survive a restart.

CREATE TABLE IF NOT EXISTS `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`token_hash` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_api_tokens_hash` ON `api_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_tokens_user` ON `api_tokens` (`user_id`);
