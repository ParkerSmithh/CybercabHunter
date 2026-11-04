-- Cybercab Hunter — Followers & Following (worker/follows.js).
-- Additive only: three new tables and their indexes. Nothing existing is changed
-- or removed, and no row is written here.
--
--   user_follows          one row per follower + followed pair. 'accepted' is a
--                         follow; 'pending' is a request to a private account
--                         (users.leaderboard_opt_in = 0) and grants nothing.
--                         Counts are read from here, so they can't drift.
--   follow_notifications  new follower / follow request / request accepted. A
--                         companion to social_notifications, whose post_id is
--                         required and whose types are fixed; the same
--                         /api/social/notifications serves both.
--   follow_actions        recent follow attempts, for the rate limits (kept two
--                         days; pruned as riders write).

CREATE TABLE user_follows (
  id TEXT PRIMARY KEY,                                                     -- opaque; what the owner's accept/decline/remove name
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX idx_user_follows_followed ON user_follows(followed_id, status, updated_at DESC, id DESC);
CREATE INDEX idx_user_follows_follower ON user_follows(follower_id, status, updated_at DESC, id DESC);

CREATE TABLE follow_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,            -- who it is for
  type TEXT NOT NULL CHECK (type IN ('follower', 'follow_request', 'follow_accepted')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,      -- who did it
  dedupe_key TEXT NOT NULL UNIQUE,                                         -- one per pair and type
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_follow_notifications_user ON follow_notifications(user_id, created_at DESC);
CREATE INDEX idx_follow_notifications_unread ON follow_notifications(user_id, read_at);
CREATE INDEX idx_follow_notifications_actor ON follow_notifications(actor_user_id);

CREATE TABLE follow_actions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_follow_actions_user ON follow_actions(user_id, created_at);
CREATE INDEX idx_follow_actions_pair ON follow_actions(user_id, target_user_id, created_at);
CREATE INDEX idx_follow_actions_target ON follow_actions(target_user_id);
