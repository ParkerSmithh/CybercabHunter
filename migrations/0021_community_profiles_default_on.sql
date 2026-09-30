-- Community profiles are public by default (worker/community.js; the privacy
-- page's "What is public" states it). New accounts are created with
-- leaderboard_opt_in = 1 (worker/db.js); this turns it on for existing ones.
--
-- Only accounts whose row hasn't been changed since the Community page
-- launched (2026-09-30 18:29:26 UTC) are switched on, so anyone who turns
-- the switch off before this runs stays off. Every rider can turn it off on
-- their Profile page at any time.
--
-- Data only: one UPDATE of one column. No schema change.
UPDATE users SET leaderboard_opt_in = 1
WHERE leaderboard_opt_in = 0 AND updated_at < '2026-09-30 18:29:26';
