-- Cybercab Hunter — ride-submission foundation: submissions, trips,
-- robotaxi_vehicles, vehicle_observations. Additive only — does not touch
-- users, tesla_connections, or vehicles from 0001_initial.sql.

-- A contribution from a logged-in user: a ride, a receipt, a vehicle
-- sighting, a photo, or a future evidence type. Everything else (trips,
-- observations) traces back to one of these so the link between a
-- contributor and the evidence they gave is never lost.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_type TEXT NOT NULL,       -- e.g. 'ride_receipt' | 'vehicle_sighting' | 'photo_evidence' — open-ended, not constrained here
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'needs_review')),
  evidence_type TEXT,                  -- e.g. 'email_receipt' | 'screenshot' | 'pdf' | 'manual_entry'
  evidence_ref TEXT,                   -- pointer to stored evidence (e.g. an R2 key); no binary lives in D1
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_submissions_user ON submissions(user_id);
CREATE INDEX idx_submissions_status ON submissions(status);

-- The public registry of physical robotaxis. Deliberately has no owner —
-- unlike the private, Tesla-OAuth-discovered `vehicles` table, this is
-- built from community evidence and is public by default. No column here
-- implies a vehicle is a robotaxi merely because a row exists for it —
-- that judgment lives in verification_status, set by review, not by
-- insertion. VIN/Tesla vehicle ID are intentionally absent: this registry
-- is plate/model/color based, since that's what's actually observable.
CREATE TABLE robotaxi_vehicles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'tesla',
  license_plate TEXT,
  model TEXT,
  color TEXT,
  service_area TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Not unique: the same plate may legitimately get more than one row before
-- a moderator merges/matches them. Duplicate resolution is a human review
-- decision (per Cybercab Hunter's own duplicate-handling policy), not
-- something a database constraint should silently enforce or block.
CREATE INDEX idx_robotaxi_vehicles_plate ON robotaxi_vehicles(license_plate);
CREATE INDEX idx_robotaxi_vehicles_service_area ON robotaxi_vehicles(service_area);

-- An actual ride. A trip is proven by a submission (receipt), not by
-- identifying the vehicle — robotaxi_vehicle_id stays nullable forever if
-- the rider never establishes which physical car it was.
CREATE TABLE trips (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'tesla',
  service_area TEXT,
  ride_date TEXT,
  start_time TEXT,
  end_time TEXT,
  pickup_description TEXT,
  dropoff_description TEXT,
  distance REAL,
  distance_unit TEXT DEFAULT 'mi',
  fare_amount_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  ride_identifier TEXT,                -- receipt/ride ID from the provider, if the receipt has one
  robotaxi_vehicle_id TEXT REFERENCES robotaxi_vehicles(id) ON DELETE SET NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_trips_user ON trips(user_id);
CREATE INDEX idx_trips_submission ON trips(submission_id);
CREATE INDEX idx_trips_vehicle ON trips(robotaxi_vehicle_id);

-- A sighting of a physical robotaxi. Does NOT imply the observer rode in
-- it — that's a `trips` row, a separate and unrelated claim.
-- robotaxi_vehicle_id starts NULL until a moderator matches this sighting
-- to an existing registry row or creates a new one; multiple observations
-- can point at the same vehicle over time.
CREATE TABLE vehicle_observations (
  id TEXT PRIMARY KEY,
  robotaxi_vehicle_id TEXT REFERENCES robotaxi_vehicles(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  service_area TEXT,
  approx_location TEXT,
  license_plate TEXT,                  -- as observed — may differ from the matched vehicle row until reconciled
  model TEXT,
  color TEXT,
  evidence_ref TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vehicle_observations_vehicle ON vehicle_observations(robotaxi_vehicle_id);
CREATE INDEX idx_vehicle_observations_user ON vehicle_observations(user_id);
CREATE INDEX idx_vehicle_observations_submission ON vehicle_observations(submission_id);
