-- Usernames from Google names, for existing accounts (new accounts get one at
-- sign-up, worker/db.js assignHandleFromName). A rider can change it on Profile.
--
-- For every Google-signed-in account with a display name and NO username:
-- the display name lowercased with spaces and common punctuation removed
-- ("Blair Hayes" -> "blairhayes"), used only when the result is plain a-z/0-9
-- and 3-20 characters long. UPDATE OR IGNORE skips any account whose result
-- is already taken (or clashes with another account here) instead of failing;
-- those, and names with accents or other scripts, get a username at their
-- next Google sign-in instead. No existing username is ever changed.
--
-- Data only: no schema change.
UPDATE OR IGNORE users
SET handle = lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(display_name),
      ' ', ''), '.', ''), '-', ''), '''', ''), '’', ''), ',', ''), '(', ''), ')', '')),
    updated_at = datetime('now')
WHERE handle IS NULL
  AND display_name IS NOT NULL
  AND id IN (SELECT user_id FROM google_connections)
  AND length(lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(display_name),
      ' ', ''), '.', ''), '-', ''), '''', ''), '’', ''), ',', ''), '(', ''), ')', ''))) BETWEEN 3 AND 20
  AND NOT (lower(replace(replace(replace(replace(replace(replace(replace(replace(trim(display_name),
      ' ', ''), '.', ''), '-', ''), '''', ''), '’', ''), ',', ''), '(', ''), ')', '')) GLOB '*[^a-z0-9]*');
