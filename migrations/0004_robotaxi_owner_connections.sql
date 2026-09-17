-- Cybercab Hunter — Robotaxi ride-history sync: separate `ownerapi` OAuth
-- connection (Tesla's private, first-party mobile-app authentication —
-- NOT the Fleet API). Fully independent of tesla_connections. Additive
-- only: does not touch users, tesla_connections, vehicles, submissions,
-- trips, robotaxi_vehicles, vehicle_observations, receipt_ingestion_addresses,
-- or receipt_ingestions.
--
-- Kept as its own table (not merged into tesla_connections) because the
-- two credentials have unrelated lifecycles: different OAuth client
-- (`ownerapi` vs. our registered Fleet API client), different token
-- issuance (PKCE public client, no client_secret, no `audience`), and
-- independent expiry/refresh/revocation.

CREATE TABLE robotaxi_owner_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_refresh_at TEXT
);

CREATE UNIQUE INDEX idx_robotaxi_owner_connections_user ON robotaxi_owner_connections(user_id);
