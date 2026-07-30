-- Rename the stored user_type value "system" -> "spirit" (#819).
-- user_type: "system" never meant infrastructure; it meant the keeper (the
-- spirit). This value migration disambiguates it from the many other "system"
-- identifiers (role: "system", voluteSystemDir(), system_events, #system).
--
-- Safe on live installs: the "exactly one system user" invariant holds
-- (getOrCreateSystemUser), so this touches at most one row. Forward-idempotent
-- -- once no rows hold "system", the UPDATE is a no-op. Leaves role untouched
-- (a separate axis, renamed in a later wave).
UPDATE users SET user_type = 'spirit' WHERE user_type = 'system';
