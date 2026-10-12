-- Cybercab Hunter — Fleet ETA accuracy: rider-reported fares and waits, and
-- the once-a-day precomputed estimate summary (worker/fleet-eta.js).
-- Additive only: two new tables, no existing table or trigger is touched.

-- What a rider saw in Tesla's app, or paid, for one ride. Voluntary and
-- UNVERIFIED until a moderator approves it; only 'approved' rows feed the
-- estimates. Deliberately coarse so no precise trip history is stored:
-- areas (not addresses), the hour (not the minute), and no route.
--   kind                 'quote'     = the app's quote before booking
--                        'completed' = a ride the rider actually took
--   vehicle_type         'cybercab' | 'model_y' | 'unknown'
--   quoted_fare_cents    the price shown/paid (NULL when the app showed no car)
--   quoted_wait_minutes  the pickup ETA the app showed
--   actual_wait_minutes  request -> car arrived, when the rider timed it
--   no_cars_available    1 when the app said no cars were available (a
--                        demand signal; fare and wait are then NULL)
--   observed_hour_utc    'YYYY-MM-DDTHH:00:00Z' (rounded down to the hour)
--   local_dow/local_hour the same moment in the city's time zone (0 = Sunday)
--   ip_day_hash          sha256(ip | UTC date): the per-IP daily limit,
--                        unlinkable across days; never the address itself
--   dedupe_key           one report per rider per city, hour, kind, vehicle
--                        type, fare and distance
CREATE TABLE fare_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  city TEXT NOT NULL CHECK (city IN ('austin', 'dallas')),
  pickup_area TEXT,
  dropoff_area TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('quote', 'completed')),
  vehicle_type TEXT NOT NULL DEFAULT 'unknown' CHECK (vehicle_type IN ('cybercab', 'model_y', 'unknown')),
  distance_miles REAL,
  duration_minutes INTEGER,
  quoted_fare_cents INTEGER,
  quoted_wait_minutes INTEGER,
  actual_wait_minutes INTEGER,
  no_cars_available INTEGER NOT NULL DEFAULT 0 CHECK (no_cars_available IN (0, 1)),
  observed_hour_utc TEXT NOT NULL,
  local_dow INTEGER NOT NULL CHECK (local_dow BETWEEN 0 AND 6),
  local_hour INTEGER NOT NULL CHECK (local_hour BETWEEN 0 AND 23),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  ip_day_hash TEXT,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE UNIQUE INDEX idx_fare_reports_dedupe ON fare_reports(dedupe_key);
-- The daily job reads approved reports per city, newest first (bounded).
CREATE INDEX idx_fare_reports_city_status_time ON fare_reports(city, status, observed_hour_utc);
-- The moderation queue (pending, oldest first) and the two daily limits.
CREATE INDEX idx_fare_reports_status_created ON fare_reports(status, created_at);
CREATE INDEX idx_fare_reports_ip_day ON fare_reports(ip_day_hash, created_at);
CREATE INDEX idx_fare_reports_user_created ON fare_reports(user_id, created_at);

-- One current row per city, rewritten by the daily cron (FLEET_STATS_CRON).
-- Pages and APIs read ONLY this row, never the history tables.
CREATE TABLE fleet_eta_stats (
  city TEXT PRIMARY KEY CHECK (city IN ('austin', 'dallas')),
  model_version INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

-- Index-bounded reads for the daily job (worker/fleet-eta.js dailyReads): a
-- city's newest rides, and the last 30 days of sightings, without scanning
-- either table. (One extra index entry per new ride / sighting.)
CREATE INDEX idx_trips_area_date ON trips(lower(trim(service_area)), ride_date);
CREATE INDEX idx_vehicle_observations_observed_at ON vehicle_observations(observed_at);
