-- Texas DMV registration activity (worker/txdmv-activity.js). Additive only:
-- dmv_snapshots and dmv_av_vehicles (0028) are read, never changed.
--
-- Every figure here is derived from Cybercab Hunter's own daily snapshots of
-- TxDMV's TxMCCS roster (dmv_snapshots.raw_json, complete and immutable). The
-- source publishes no registration dates: a VIN's date here is when Cybercab
-- Hunter FIRST DETECTED it on the roster, never a DMV registration date.

-- Workers Free: processing runs in small resumable steps (worker/txdmv-activity.js
-- runDmvStep); these tables are also its progress record.

-- One row per processed snapshot: what changed against the previous accepted
-- snapshot. Written once (snapshot_date is the key), so reprocessing is a no-op.
-- status: 'baseline' (the first snapshot: nothing counts as new), 'ok', or
-- 'held' (an implausible drop, e.g. a truncated roster: no changes recorded,
-- and later snapshots compare against the last accepted one instead).
CREATE TABLE dmv_events (
  snapshot_date TEXT PRIMARY KEY,          -- the snapshot (America/Chicago date of the poll)
  prev_snapshot_date TEXT,                 -- the accepted snapshot it was compared with
  status TEXT NOT NULL CHECK (status IN ('baseline', 'ok', 'held')),
  added INTEGER NOT NULL DEFAULT 0,        -- VINs never seen before
  returned INTEGER NOT NULL DEFAULT 0,     -- seen before, missing last time, listed again
  missing INTEGER NOT NULL DEFAULT 0,      -- listed last time, not in this snapshot
  net INTEGER NOT NULL DEFAULT 0,          -- total - previous total
  total INTEGER NOT NULL,
  processed_at TEXT NOT NULL               -- ISO 8601 UTC
);
-- Recent accepted events, newest first (overview, history, growth).
CREATE INDEX idx_dmv_events_status_date ON dmv_events(status, snapshot_date);

-- Each VIN-level change of an event. source_class is TxDMV's own model label
-- at the time (cybercab / model_y / other); the decoded class lives in
-- dmv_vin_decode and is joined at read time.
CREATE TABLE dmv_changes (
  snapshot_date TEXT NOT NULL,
  vin TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'returned', 'missing')),
  source_class TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, change, vin) -- one update's new / missing / returned VINs
);
CREATE INDEX idx_dmv_changes_vin ON dmv_changes(vin);

-- One decode per VIN: NHTSA vPIC (official) cross-checked with TxDMV's model
-- label. model_class: cybercab | model_y | other_tesla | unknown.
-- status: 'verified' (vPIC and TxDMV agree), 'vpic' (vPIC only), 'source_label'
-- (TxDMV's label only, vPIC not yet reached), 'conflict' (they disagree: shown
-- as unknown), 'unknown'. A row is written (TxDMV's label) as soon as the VIN
-- is first seen; vPIC upgrades it. Not verified -> retried with backoff
-- (next_attempt_at, 1 h doubling to 7 days), at most 10 attempts, then left as is.
CREATE TABLE dmv_vin_decode (
  vin TEXT PRIMARY KEY,
  model_class TEXT NOT NULL,
  status TEXT NOT NULL,
  manufacturer TEXT,
  decoded_model TEXT,
  model_year INTEGER,
  plant_city TEXT,
  plant_state TEXT,
  plant_country TEXT,
  vehicle_type TEXT,
  body_class TEXT,
  check_digit_ok INTEGER,
  source TEXT NOT NULL,                    -- 'vpic' | 'txdmv'
  decoded_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,     -- vPIC attempts so far
  next_attempt_at TEXT                     -- when vPIC is due (NULL: verified, or given up)
);
CREATE INDEX idx_dmv_vin_decode_class ON dmv_vin_decode(model_class);
-- The decode queue: only due rows are read, never the whole roster.
CREATE INDEX idx_dmv_vin_decode_due ON dmv_vin_decode(next_attempt_at) WHERE next_attempt_at IS NOT NULL;

-- Tracked-roster milestones, crossed at a processed (non-baseline) snapshot.
-- Thresholds already passed at the baseline are never invented.
CREATE TABLE dmv_milestones (
  metric TEXT NOT NULL,                    -- 'cybercab_listed' | 'total_listed'
  threshold INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (metric, threshold)
);

-- One precomputed row the read APIs use instead of counting the whole roster
-- on every request (D1 rows-read budget): the latest snapshot's totals by class
-- and its model years, refreshed by each processing step that changed anything.
-- Ignored (live counts instead) whenever it isn't for the latest snapshot.
CREATE TABLE dmv_summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_date TEXT NOT NULL,
  totals TEXT NOT NULL,                    -- JSON {cybercab, model_y, other_tesla, unknown}
  years TEXT NOT NULL,                     -- JSON [2026, ...]
  decode_due INTEGER NOT NULL,             -- VINs still queued for vPIC
  updated_at TEXT NOT NULL
);

-- The VIN detail's registry match (robotaxi_vehicles.vin is stored upper-case).
CREATE INDEX IF NOT EXISTS idx_robotaxi_vehicles_vin ON robotaxi_vehicles(vin);

-- The VIN directory: the current roster (last_seen_date = latest), newest first.
CREATE INDEX idx_dmv_av_vehicles_listed ON dmv_av_vehicles(last_seen_date, first_seen_date);
-- (No model_year index: the daily poll rewrites every roster row, so each index
-- here costs ~one written row per VIN per day; the year filter is rare and the
-- listed-roster index above already narrows it.)
