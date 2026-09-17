-- Cybercab Hunter — Phase 1: users, Tesla connections, private vehicles.
-- No destructive operations. Additive only.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  handle TEXT,
  profile_visibility TEXT NOT NULL DEFAULT 'private',
  leaderboard_opt_in INTEGER NOT NULL DEFAULT 0,
  auto_sync INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_users_handle ON users(handle) WHERE handle IS NOT NULL;

CREATE TABLE tesla_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'tesla',
  tesla_account_identifier TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_refresh_at TEXT
);

CREATE UNIQUE INDEX idx_tesla_connections_user ON tesla_connections(user_id);
CREATE UNIQUE INDEX idx_tesla_connections_account ON tesla_connections(provider, tesla_account_identifier)
  WHERE tesla_account_identifier IS NOT NULL;

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'tesla_oauth',
  visibility TEXT NOT NULL DEFAULT 'private',
  provider TEXT NOT NULL DEFAULT 'tesla',
  tesla_vehicle_id TEXT,
  vin TEXT,
  license_plate TEXT,
  display_name TEXT,
  make TEXT DEFAULT 'Tesla',
  model TEXT,
  model_year INTEGER,
  vehicle_type TEXT DEFAULT 'unknown',
  active_status TEXT DEFAULT 'unknown',
  supervision_status TEXT DEFAULT 'unknown',
  verification_status TEXT DEFAULT 'unverified',
  first_known_at TEXT,
  last_known_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at TEXT
);

CREATE UNIQUE INDEX idx_vehicles_owner_tesla_id ON vehicles(owner_user_id, tesla_vehicle_id)
  WHERE owner_user_id IS NOT NULL AND tesla_vehicle_id IS NOT NULL;
CREATE INDEX idx_vehicles_owner ON vehicles(owner_user_id);
