-- Per-(mind, channel) gate state so a mind can explicitly decline an unrouted
-- channel. Absence of a row means "pending" (undecided); the only stored state
-- is "declined". Declined channels are never released and never re-notify.
CREATE TABLE `channel_gates` (
	`mind` text NOT NULL,
	`channel` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`mind`, `channel`)
);
--> statement-breakpoint
-- Backfill: archive stale gated rows so the first routes.json edit on an existing
-- mind with a months-old backlog can't release hundreds of messages at once. The
-- bounded release only ever promotes the newest N per channel anyway; anything
-- older than a week is treated as history and made inert here.
UPDATE `delivery_queue` SET `status` = 'archived'
	WHERE `status` = 'gated' AND `created_at` < datetime('now', '-7 days');
