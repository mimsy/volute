-- Drop the dead turns.summary_event_id column (superseded by summary_id, never written).

ALTER TABLE `turns` DROP COLUMN `summary_event_id`;
