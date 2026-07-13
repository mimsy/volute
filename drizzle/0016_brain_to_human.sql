-- Retire the "brain" user_type in favour of "human" (issue #493). Human users
-- were stored as user_type = 'brain'; migrate live rows so prefixes and profile
-- cards render [human]. Mind, system, and puppet types are unchanged.
UPDATE `users` SET `user_type` = 'human' WHERE `user_type` = 'brain';
