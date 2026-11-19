CREATE TABLE fleet_history_snapshots (
  city TEXT NOT NULL,
  day TEXT NOT NULL,
  registry_count INTEGER,
  cumulative_sightings INTEGER,
  sightings_that_day INTEGER,
  detections_that_day INTEGER,
  dmv_cybercabs INTEGER,
  PRIMARY KEY (city, day)
) WITHOUT ROWID;

-- A packed copy keeps an uncached chart load at one row, even for All time.
CREATE TABLE fleet_history_series (
  city TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;
