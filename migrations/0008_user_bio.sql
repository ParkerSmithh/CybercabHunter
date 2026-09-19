-- Cybercab Hunter — adds a free-text bio for the profile settings panel
-- (display_name, handle, and profile_visibility already exist from
-- 0001_initial.sql). Additive only: does not touch any existing column.

ALTER TABLE users ADD COLUMN bio TEXT;
