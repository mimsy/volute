ALTER TABLE `channels` ADD `is_default` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_channels_default` ON `channels` (`is_default`) WHERE is_default = 1;--> statement-breakpoint
-- Backfill the commons marker onto each install's existing default channel (#819).
-- The default channel used to be found by its magic name ("system"); this marks it
-- so lookups resolve by the is_default flag instead. We do NOT rename the channel —
-- a house may keep an earned proper name (bardo's is "#system"); the marker is what
-- makes identity independent of the string. New installs get a fresh "commons"
-- channel that ensureCommonsChannel marks directly, so this only fires where a
-- legacy channel exists. Forward-idempotent: a no-op once a default is marked.
UPDATE `channels` SET `is_default` = 1
WHERE `conversation_id` = (
  SELECT `conversation_id` FROM `channels`
  WHERE `name` IN ('system', '#system')
  ORDER BY (`name` = 'system') DESC, `created_at` ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM `channels` WHERE `is_default` = 1);