-- The Community page's precomputed numbers (worker/community-summary.js): one
-- small JSON row per key, rewritten once a day by the daily cron, so a pageview
-- reads one row instead of aggregating sightings (D1 read budget).
CREATE TABLE IF NOT EXISTS community_summary (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
