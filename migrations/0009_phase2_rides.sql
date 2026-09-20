-- Cybercab Hunter — Phase 2: canonical ride identity, receipt revisions,
-- honest currency/timezone provenance, and receipt-sync bookkeeping.
--
-- Additive except for one index swap (see "Index swap" below) — no table is
-- dropped, no row is deleted, no column is removed or retyped. Existing
-- rows keep every value they had.
--
-- Run order matters: columns are added first, legacy rows are backfilled
-- and de-duplicated next, and only THEN are the new unique indexes
-- created (creating one first would fail on the legacy duplicate rides
-- described below).

-- ---- trips: stable identity, revisions, provenance ----

-- Stable identity of a ride, independent of receipt content:
--   v1|<ride_date>|<pickup_time HH:MM>|<normalized plate or empty>
-- NULL when the receipt lacked a date or pickup time (identity then falls
-- back to receipt_hash only). Deliberately a readable composite rather
-- than a hash so it can be inspected and matched with a missing plate.
ALTER TABLE trips ADD COLUMN ride_key TEXT;

-- Bumped each time a corrected/updated receipt changes an existing ride in
-- place. The values a revision replaced are kept in trip_revisions.
ALTER TABLE trips ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- Set on a trip that is a duplicate representation of another trip (same
-- ride_key). The row is kept — nothing is deleted — but it never counts
-- toward statistics, never appears in ride history, and is excluded from
-- the ride_key unique index.
ALTER TABLE trips ADD COLUMN superseded_by TEXT REFERENCES trips(id) ON DELETE SET NULL;

-- 'extracted' = the receipt stated a currency code; 'assumed' = it showed a
-- bare currency symbol (Tesla receipts show only "$") and USD was assumed.
-- NULL when the trip has no fare at all.
ALTER TABLE trips ADD COLUMN currency_source TEXT;

-- Normalized start instant (UTC) and the IANA zone it was computed with.
-- Receipts contain a local wall-clock time and NO timezone; the zone is
-- inferred from the service area/state (timezone_source says so).
ALTER TABLE trips ADD COLUMN started_at_utc TEXT;
ALTER TABLE trips ADD COLUMN timezone TEXT;
ALTER TABLE trips ADD COLUMN timezone_source TEXT;

-- ---- Backfill existing rows (values that already exist, no invention) ----

-- ride_key from columns already stored; the plate comes from the linked
-- registry vehicle. Rows without a date or pickup time keep NULL.
UPDATE trips
SET ride_key = 'v1|' || ride_date || '|' || pickup_time || '|' ||
  COALESCE((SELECT UPPER(REPLACE(REPLACE(v.license_plate, '-', ''), ' ', ''))
            FROM robotaxi_vehicles v WHERE v.id = trips.robotaxi_vehicle_id), '')
WHERE ride_date IS NOT NULL AND pickup_time IS NOT NULL;

-- Legacy duplicate rides: the same receipt was ingested more than once
-- under the old content-hash-only dedupe. Keep the earliest row of each
-- (user, ride_key) group as canonical and point the rest at it.
UPDATE trips
SET superseded_by = (
  SELECT t2.id FROM trips t2
  WHERE t2.user_id = trips.user_id AND t2.ride_key = trips.ride_key
  ORDER BY t2.created_at ASC, t2.id ASC LIMIT 1
)
WHERE ride_key IS NOT NULL
  AND id <> (
    SELECT t2.id FROM trips t2
    WHERE t2.user_id = trips.user_id AND t2.ride_key = trips.ride_key
    ORDER BY t2.created_at ASC, t2.id ASC LIMIT 1
  );

-- Every stored fare so far was a bare "$" defaulted to USD.
UPDATE trips SET currency_source = 'assumed' WHERE fare_amount_cents IS NOT NULL;

-- Receipts store a US city; the timezone follows from the service area.
-- (started_at_utc is left NULL for legacy rows rather than computed here;
-- daylight-saving-aware conversion is done in application code.)
UPDATE trips
SET timezone = 'America/Chicago', timezone_source = 'inferred_from_service_area'
WHERE timezone IS NULL AND service_area IN ('Dallas', 'Austin', 'Houston', 'San Antonio');

-- Re-evaluate review status for receipts that carry a complete set of the
-- real-format fields. The old classifier required the email's From header
-- to be tesla.com, which a forwarded receipt never satisfies, so every
-- forwarded receipt was parked in needs_review no matter how complete.
-- Only rows with fare + distance + date + both stops + both times move,
-- and only from needs_review to pending (accepted). Nothing is rejected.
UPDATE submissions
SET status = 'pending', updated_at = datetime('now')
WHERE status = 'needs_review'
  AND id IN (
    SELECT submission_id FROM trips
    WHERE superseded_by IS NULL
      AND fare_amount_cents IS NOT NULL AND distance IS NOT NULL
      AND ride_date IS NOT NULL
      AND pickup_time IS NOT NULL AND dropoff_time IS NOT NULL
      AND pickup_description IS NOT NULL AND dropoff_description IS NOT NULL
  );

-- ---- Index swap ----

-- One canonical (non-superseded) trip per user per ride identity.
CREATE UNIQUE INDEX idx_trips_user_ride_key ON trips(user_id, ride_key)
  WHERE ride_key IS NOT NULL AND superseded_by IS NULL;

-- The old index made receipt_hash unique across ALL users, so two riders
-- who legitimately hold identical receipt content (a shared ride) could
-- not both record it. Replace it with a per-user constraint. The only
-- thing dropped is that global index — no data.
DROP INDEX idx_trips_receipt_hash;
CREATE UNIQUE INDEX idx_trips_user_receipt_hash ON trips(user_id, receipt_hash)
  WHERE receipt_hash IS NOT NULL;

CREATE INDEX idx_trips_user_date ON trips(user_id, ride_date);

-- ---- Receipt revisions ----

-- What an updated receipt replaced. One row per superseded revision of a
-- trip. Holds only the changeable numeric fields and the old content hash
-- — never addresses or raw receipt text.
CREATE TABLE trip_revisions (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  receipt_hash TEXT,
  fare_amount_cents INTEGER,
  currency TEXT,
  currency_source TEXT,
  distance REAL,
  duration_minutes INTEGER,
  replaced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trip_revisions_trip ON trip_revisions(trip_id);

-- ---- Receipt-sync bookkeeping ----

-- One row per receipt-processing pass: a single inbound email, or one
-- historical-import request that may carry several receipts. Powers the
-- Rider Data "receipt sync" status. Holds counts and short error codes
-- only — never receipt content.
CREATE TABLE ride_sync_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,                 -- 'receipt_email' | 'receipt_import'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed')),
  seen_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE INDEX idx_ride_sync_runs_user ON ride_sync_runs(user_id, started_at);

-- What happened to each ingestion attempt, and which run it belonged to.
-- (receipt_ingestions.status has a CHECK constraint that cannot be
-- widened without rebuilding the table, so the finer-grained outcome —
-- created / updated / duplicate — is a separate column.)
ALTER TABLE receipt_ingestions ADD COLUMN outcome TEXT;
ALTER TABLE receipt_ingestions ADD COLUMN sync_run_id TEXT REFERENCES ride_sync_runs(id) ON DELETE SET NULL;

-- Gmail requires a confirmation code before it will auto-forward to a new
-- address. That confirmation email is delivered to the rider's Cybercab
-- Hunter address, where the rider can never see it, so the code is kept
-- here to be shown to that rider (and only that rider) on Rider Data.
ALTER TABLE receipt_ingestion_addresses ADD COLUMN forwarding_code TEXT;
ALTER TABLE receipt_ingestion_addresses ADD COLUMN forwarding_code_received_at TEXT;
