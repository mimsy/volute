-- System events are not messages. They were recorded in mind_history as `inbound` rows,
-- so every history surface rendered them as chat with a phantom sender ("user"), and minds
-- read them as messages they were expected to reply to. Retype the delivered-event rows so
-- the timeline and `volute mind history` can render them as system markers instead.
--
-- The `event:<type>:<id>` channel is written only by recordEventRow, so it identifies
-- these rows exactly. Turn linkage (turn_id / trigger_event_id) is untouched — the linkers
-- match both types, so reflection capture keeps working for historical turns.
UPDATE `mind_history` SET `type` = 'event' WHERE `type` = 'inbound' AND `channel` LIKE 'event:%';
