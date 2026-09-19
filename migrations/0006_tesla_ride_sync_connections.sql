-- Cybercab Hunter — Tesla "Ride Sync" OAuth foundation. A separate
-- subsystem from the existing Fleet API integration (worker/tesla.js,
-- tesla_connections) and from the earlier ownerapi experiment
-- (worker/robotaxi-owner-auth.js, robotaxi_owner_connections). Additive
-- only: does not touch any existing table.
--
-- Deliberately holds NO token material. The encrypted access/refresh
-- tokens live in the TESLA_SESSIONS KV namespace under the key named by
-- kv_token_key; this table only ever holds a pointer plus non-secret
-- connection metadata. A full dump of this table yields zero usable
-- credential material on its own.

CREATE TABLE tesla_ride_sync_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kv_token_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_sync_at TEXT,
  last_refresh_at TEXT,
  access_token_expires_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_tesla_ride_sync_user ON tesla_ride_sync_connections(user_id);
