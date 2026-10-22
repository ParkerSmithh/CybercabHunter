-- Profile pictures: keep the Google account picture apart from the one a
-- rider uploads (worker/avatars.js, worker/db.js findOrCreateUserByGoogleIdentity).
--
--   users.avatar_url         the picture shown everywhere (unchanged meaning,
--                            so every existing reader keeps working):
--                            a custom upload ("/api/avatars/<key>") if there
--                            is one, else the Google picture, else NULL
--                            (initials).
--   users.google_avatar_url  NEW: the Google account's picture, as Google last
--                            sent it at sign-in. Never shown on its own; it is
--                            what avatar_url falls back to when a custom
--                            upload is removed.
--
-- Backfill: a rider whose shown picture is still an https URL has never
-- uploaded one (uploads are always "/api/avatars/..."), and Google sign-in is
-- the only writer of https pictures, so that URL IS their Google picture.
-- Copied only into the new column, only where it is empty: no existing
-- avatar_url (custom or not) is read-modified or cleared. Riders with a
-- custom upload or no picture get theirs at their next Google sign-in.
ALTER TABLE users ADD COLUMN google_avatar_url TEXT;

UPDATE users SET google_avatar_url = avatar_url
WHERE google_avatar_url IS NULL AND avatar_url LIKE 'https://%';
