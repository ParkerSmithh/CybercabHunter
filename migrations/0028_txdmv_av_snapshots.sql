-- Texas DMV automated-vehicle roster (worker/txdmv.js), polled once a day.
--
-- Source: TxDMV's public TxMCCS lookup (txmccs.txdmv.gov "Truck Stop" →
-- company → Automated Motor Vehicles), the roster of every vehicle a company
-- lists under its SB 2807 automated-vehicle authorization. For Tesla Robotaxi,
-- LLC (authorization AV8313426653583) each row is { vin, make, model,
-- modelYear } — the source publishes nothing else (no dates, no owners).
--
-- dmv_snapshots: ONE row per day (America/Chicago date), written once and never
-- overwritten; a failed poll writes nothing. raw_json is that day's full
-- roster exactly as normalised from the source, so any figure can be re-derived.
CREATE TABLE dmv_snapshots (
  snapshot_date TEXT PRIMARY KEY,              -- YYYY-MM-DD, America/Chicago
  total INTEGER NOT NULL,
  cybercab_count INTEGER NOT NULL,
  model_y_count INTEGER NOT NULL,
  other_count INTEGER NOT NULL DEFAULT 0,      -- any model that is neither (none so far)
  authorization_number TEXT NOT NULL,
  raw_json TEXT NOT NULL,                      -- [{ vin, make, model, model_year }], sorted by VIN
  polled_at TEXT NOT NULL                      -- ISO 8601 UTC, when the poll finished
);

-- One row per VIN ever seen on the roster. first_seen_date is the first
-- snapshot that listed it — when Cybercab Hunter first saw it, NOT a TxDMV
-- registration date (the source publishes none). in_baseline = 1 for VINs
-- already on the roster at the very first snapshot: their real registration
-- dates are unknown, so they never count as "new".
CREATE TABLE dmv_av_vehicles (
  vin TEXT PRIMARY KEY,
  make TEXT,
  model TEXT,
  model_year INTEGER,
  first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  in_baseline INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_dmv_av_vehicles_first_seen ON dmv_av_vehicles(first_seen_date);
