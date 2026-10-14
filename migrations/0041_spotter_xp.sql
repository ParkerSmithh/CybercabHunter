-- Spotter XP (worker/progression.js). XP is the only reward; no badges.
--
-- xp_awards: one row per thing that can earn XP (a verified sighting, a first
-- discovery, a completed mission), keyed by a stable award_key, e.g.
-- "sighting:<user>:<plate>:<day>" or "mission:weekly_spotter:<week>:<user>".
-- active = 1 while it counts; seq counts how many times it has been granted
-- (granted -> reversed -> granted again is seq 2). The key is the
-- idempotency guarantee: the same approval can never pay twice.
CREATE TABLE IF NOT EXISTS xp_awards (
  award_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT NOT NULL,          -- 'sighting' | 'discovery' | 'mission'
  ref_id TEXT,                     -- the submission, vehicle or mission id
  period TEXT,                     -- the Monday (YYYY-MM-DD) of its week; 'discovery' for discoveries
  active INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xp_awards_user_period ON xp_awards(user_id, period);

-- xp_ledger: every grant and reversal, append-only (the rider's XP history).
-- tx_key = "<award_key>:<seq>:award" or ":reverse" is UNIQUE, so a retried or
-- repeated write is a no-op.
CREATE TABLE IF NOT EXISTS xp_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_key TEXT NOT NULL UNIQUE,
  award_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user ON xp_ledger(user_id, id);

-- user_xp: each rider's total, kept equal to SUM(xp_ledger.amount) by the
-- trigger below (and re-checked against the ledger by the daily reconcile).
CREATE TABLE IF NOT EXISTS user_xp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE TRIGGER IF NOT EXISTS xp_ledger_total AFTER INSERT ON xp_ledger
BEGIN
  INSERT INTO user_xp (user_id, xp, updated_at) VALUES (NEW.user_id, NEW.amount, datetime('now'))
  ON CONFLICT(user_id) DO UPDATE SET xp = xp + NEW.amount, updated_at = datetime('now');
END;
