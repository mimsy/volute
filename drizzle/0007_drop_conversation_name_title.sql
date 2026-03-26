DROP INDEX IF EXISTS idx_conversations_name;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_conversations_mind_name;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN name;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN title;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN mind_name;
--> statement-breakpoint
ALTER TABLE conversations DROP COLUMN channel;
