-- Vehicle timelines (/vehicle/<id>): precomputed once a day by FLEET_STATS_CRON
-- (worker/vehicle-timeline.js) from records that are already public, so a page
-- reads one summary row and one indexed page of events — never a scan of the
-- sightings or rides tables. Numbered 0061 (earlier numbers are reserved by other
-- branches). Only public registry vehicles have rows; a vehicle that leaves
-- public view loses them on the next rebuild (and its page 404s at once).
--
-- vehicle_history_events: one row per event.
--   kind       'first_seen' | 'added' | 'approved' | 'sighting' | 'rides'
--   event_date YYYY-MM-DD as recorded; date_kind 'event' or 'submitted' (only a
--              submission date is known — the page says "submitted <date>")
--   data       JSON, public fields only (never ids of people, addresses, times)
--   sort_key   newest-first order within a vehicle
--   stamp      the rebuild that wrote it (older stamps are deleted after a rebuild)
CREATE TABLE vehicle_history_events (
  vehicle_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_date TEXT,
  date_kind TEXT NOT NULL DEFAULT 'event',
  data TEXT NOT NULL DEFAULT '{}',
  sort_key TEXT NOT NULL,
  stamp TEXT NOT NULL,
  PRIMARY KEY (vehicle_id, event_key)
);
CREATE INDEX idx_vehicle_history_order ON vehicle_history_events(vehicle_id, sort_key DESC);
CREATE INDEX idx_vehicle_history_kind ON vehicle_history_events(vehicle_id, kind, sort_key DESC);

-- One row per public vehicle: the counts the page shows (no COUNT(*) on a
-- pageview) and its previous/next vehicle in the same city (by plate).
CREATE TABLE vehicle_history_summary (
  vehicle_id TEXT PRIMARY KEY,
  city TEXT,
  sightings INTEGER NOT NULL DEFAULT 0,
  rides INTEGER NOT NULL DEFAULT 0,
  registry_events INTEGER NOT NULL DEFAULT 0,
  history TEXT NOT NULL DEFAULT '{}',
  prev_id TEXT,
  next_id TEXT,
  stamp TEXT NOT NULL
);
