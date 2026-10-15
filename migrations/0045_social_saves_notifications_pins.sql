-- Cybercab Hunter — Community Social, part 2 (worker/social.js, public/js/social.js).
-- Additive only: two new tables, three new columns, indexes. Nothing existing
-- is changed or removed, and no row is written here.
--
--   social_saves          a rider's private bookmarks (one row per rider + post)
--   social_notifications  comments, replies, likes and @mentions on your posts
--                         and comments; one row per event (dedupe_key), gone
--                         with the post / comment it points at (FK cascade)
--   social_notification_state  when a rider last read the notifications,
--                         used only for the optional announcement notice (an
--                         announcement is one row for everyone, never fanned
--                         out into a row per rider)
--   social_posts.pinned_at / pinned_by   community pins (the `pinned` flag
--                         already exists from 0044; at most 3, moderators only)
--   social_announcements.notify   whether the announcement is also a notification

CREATE TABLE social_saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_social_saves_user ON social_saves(user_id, created_at DESC, post_id DESC);
CREATE INDEX idx_social_saves_post ON social_saves(post_id);

CREATE TABLE social_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,          -- who it is for
  type TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'like', 'mention')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,    -- who did it
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES social_comments(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL UNIQUE,                                       -- one row per event, ever
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_social_notifications_user ON social_notifications(user_id, created_at DESC);
CREATE INDEX idx_social_notifications_unread ON social_notifications(user_id, read_at);
CREATE INDEX idx_social_notifications_post ON social_notifications(post_id);
CREATE INDEX idx_social_notifications_comment ON social_notifications(comment_id);
CREATE INDEX idx_social_notifications_actor ON social_notifications(actor_user_id);

CREATE TABLE social_notification_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  announcement_read_at TEXT
);

ALTER TABLE social_posts ADD COLUMN pinned_at TEXT;
ALTER TABLE social_posts ADD COLUMN pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_social_posts_pinned ON social_posts(pinned, pinned_at DESC) WHERE pinned = 1;

ALTER TABLE social_announcements ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
