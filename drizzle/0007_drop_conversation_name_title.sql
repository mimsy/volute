DROP INDEX IF EXISTS idx_conversations_name;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN name;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN title;
