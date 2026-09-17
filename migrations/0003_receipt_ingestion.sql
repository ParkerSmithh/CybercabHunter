-- Cybercab Hunter — automatic receipt-email ingestion foundation.
-- Additive only: extends `trips` with plain ADD COLUMN statements (no data
-- loss, existing rows get the defaults) and adds two new tables. Does not
-- touch users, tesla_connections, vehicles, submissions, robotaxi_vehicles,
-- or vehicle_observations beyond the new trips columns.

ALTER TABLE trips ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE trips ADD COLUMN source_message_id TEXT;
ALTER TABLE trips ADD COLUMN external_ride_id TEXT;
ALTER TABLE trips ADD COLUMN receipt_hash TEXT;

-- A receipt (or its content-fingerprint) can back at most one trip — this is
-- the actual enforcement point for "duplicate receipts must not create
-- duplicate trips," backed by a real constraint rather than only
-- application-level checking.
CREATE UNIQUE INDEX idx_trips_receipt_hash ON trips(receipt_hash) WHERE receipt_hash IS NOT NULL;

-- One active receipt-ingestion address per user. `opaque_token` is what
-- appears in the actual email local-part (u_<token>@...) — never a raw
-- user_id, email address, or Tesla identifier.
CREATE TABLE receipt_ingestion_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opaque_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_received_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX idx_receipt_addr_user ON receipt_ingestion_addresses(user_id);
CREATE UNIQUE INDEX idx_receipt_addr_token ON receipt_ingestion_addresses(opaque_token);

-- One row per processed inbound email attempt — the audit trail and the
-- idempotency check for retried/duplicate deliveries. Not public.
CREATE TABLE receipt_ingestions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT,
  receipt_hash TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  parser_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'needs_review', 'rejected', 'duplicate', 'parse_error')),
  error_code TEXT,
  error_message TEXT,
  submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL,
  trip_id TEXT REFERENCES trips(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_receipt_ingestions_user ON receipt_ingestions(user_id);
CREATE INDEX idx_receipt_ingestions_message_id ON receipt_ingestions(message_id);
CREATE INDEX idx_receipt_ingestions_hash ON receipt_ingestions(receipt_hash);
