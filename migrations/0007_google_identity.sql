-- Cybercab Hunter — Google Sign-In as a primary account-creation path,
-- alongside the existing Tesla-identifier path (findOrCreateUserByTeslaIdentifier
-- in worker/db.js). Additive only: does not touch any existing table's
-- columns or constraints.
--
-- Holds no OAuth tokens — Google is used only to verify identity once at
-- sign-in (openid email profile scopes), never to call Google APIs later
-- on the user's behalf, so there is nothing here to encrypt or refresh.

ALTER TABLE users ADD COLUMN avatar_url TEXT;

CREATE TABLE google_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_google_connections_user ON google_connections(user_id);
CREATE UNIQUE INDEX idx_google_connections_sub ON google_connections(google_sub);
