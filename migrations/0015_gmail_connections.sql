-- Optional direct Gmail receipt import (worker/gmail.js). Additive only: two
-- new tables; no existing table, column or row is touched. The receipt
-- forwarding address system (receipt_ingestion_addresses) is unchanged and
-- keeps working alongside this.
--
-- gmail_connections — at most one row per rider, created when they connect
-- Gmail (a second, separate Google authorization with the gmail.readonly
-- scope; normal Google sign-in is unchanged).
--   status 'active'  — connected; the scheduled sync imports receipts.
--          'error'   — Google no longer accepts the stored authorization
--                      (revoked in Google, expired, password change): the
--                      token is cleared and the rider must reconnect.
--          'revoked' — the rider disconnected; token and sync state cleared.
--   encrypted_refresh_token — AES-256-GCM (worker/crypto.js) under the
--     dedicated GMAIL_TOKEN_ENCRYPTION_KEY secret, never the Tesla key.
--     NULL whenever the connection is not active. Access tokens are never
--     stored.
--   history_id — Gmail's mailbox history position; only advanced after a
--     sync completes, so a failed sync is simply retried.
--   backfill_completed_at — NULL until the one-time bounded (90-day) search
--     for existing receipts has finished.
--   sync_lock_until — short lease so two overlapping scheduled runs never
--     sync the same mailbox at once.
--   last_error — a short internal code (e.g. 'gmail_api_unavailable'),
--     never a token, message content or Google's raw response.
CREATE TABLE gmail_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_sub TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'revoked')),
  encrypted_refresh_token TEXT,
  history_id TEXT,
  backfill_completed_at TEXT,
  sync_lock_until TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_receipt_at TEXT,
  last_error TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_gmail_connections_user ON gmail_connections(user_id);
CREATE INDEX idx_gmail_connections_status ON gmail_connections(status);

-- One row per Gmail message already run through the receipt pipeline for a
-- rider, so repeated polling never downloads or processes it again. Holds
-- only Gmail's opaque message id and the pipeline outcome — never content.
-- Deleted when the rider disconnects; old rows are pruned by the sync.
CREATE TABLE gmail_processed_messages (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  outcome TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_gmail_processed_user_message ON gmail_processed_messages(user_id, gmail_message_id);
