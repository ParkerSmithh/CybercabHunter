-- Upgrade the original live-gallery baseline to all known approved events.
-- The persistent ledger includes approved human sightings (including expired
-- photos), independent camera captures, and events whose live rows were deleted.
-- Human sightings copied onto the camera map have only one ledger event.
-- Never lower an existing total. No content rows are changed or restored.
INSERT INTO site_stat_counters(key, value, updated_at)
SELECT 'sightings_all_time', COUNT(*), datetime('now')
FROM site_stat_events WHERE counter_key = 'sightings_all_time'
ON CONFLICT(key) DO UPDATE SET
  value = MAX(site_stat_counters.value, excluded.value),
  updated_at = excluded.updated_at;
