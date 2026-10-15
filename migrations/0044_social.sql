-- Cybercab Hunter — Community Social (worker/social.js, public/js/social.js).
-- Additive only. The Reviews section becomes Social: posts are the main thing,
-- and a ride review is an optional attachment to a post.
--
-- EXISTING REVIEWS ARE PRESERVED, NOT MOVED: cybercab_reviews and its photos,
-- likes and comments are left exactly as they are. At the end of this file
-- each review is COPIED into a post (same id, same author, text, dates,
-- rating, photos — the same stored image files, not copies — likes and
-- comments). Every copy is keyed on the review's id, so running this file
-- again adds nothing twice.
--
-- Counters (like_count, comment_count, has_photos, has_review) are kept on the
-- post by the triggers below, so a feed page never counts rows per post.

CREATE TABLE social_posts (
  id TEXT PRIMARY KEY,                                   -- 32 hex (a migrated post keeps its review's id)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'sighting', 'question', 'news', 'review')),
  link_url TEXT CHECK (link_url IS NULL OR length(link_url) <= 500),
  robotaxi_vehicle_id TEXT REFERENCES robotaxi_vehicles(id) ON DELETE SET NULL,
  legacy_review_id TEXT UNIQUE,                          -- set only on posts copied from cybercab_reviews
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  removed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  removed_at TEXT,
  removed_reason TEXT,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  has_photos INTEGER NOT NULL DEFAULT 0,
  has_review INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);
-- Feeds: newest first, overall and per filter; a rider's own posts (limits, profile).
CREATE INDEX idx_social_posts_feed ON social_posts(status, created_at DESC, id DESC);
CREATE INDEX idx_social_posts_photos ON social_posts(status, has_photos, created_at DESC, id DESC);
CREATE INDEX idx_social_posts_reviews ON social_posts(status, has_review, created_at DESC, id DESC);
CREATE INDEX idx_social_posts_user ON social_posts(user_id, created_at);
CREATE INDEX idx_social_posts_vehicle ON social_posts(robotaxi_vehicle_id);

CREATE TABLE social_post_photos (
  id TEXT PRIMARY KEY,                                   -- random public id (32 hex)
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_social_post_photos_post ON social_post_photos(post_id, position);

-- The optional ride review on a post (at most one per post).
CREATE TABLE social_post_reviews (
  post_id TEXT PRIMARY KEY REFERENCES social_posts(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  vehicle_type TEXT CHECK (vehicle_type IS NULL OR vehicle_type IN ('cybercab', 'model_y')),
  quoted_fare_cents INTEGER CHECK (quoted_fare_cents IS NULL OR quoted_fare_cents BETWEEN 100 AND 25000),
  pickup_wait_minutes INTEGER CHECK (pickup_wait_minutes IS NULL OR pickup_wait_minutes BETWEEN 0 AND 120),
  ride_date TEXT CHECK (ride_date IS NULL OR ride_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  legacy_review_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE social_likes (
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_social_likes_user ON social_likes(user_id);

-- Comments, with ONE level of replies (a reply's parent is always a top-level comment).
CREATE TABLE social_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES social_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'removed')),
  removed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);
CREATE INDEX idx_social_comments_post ON social_comments(post_id, parent_id, created_at, id);
CREATE INDEX idx_social_comments_user ON social_comments(user_id, created_at);

-- Reports of posts or comments; one open report per reporter per item.
CREATE TABLE social_reports (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,   -- the author reported (repeat-offender view)
  reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'off_topic', 'misleading', 'privacy', 'other')),
  details TEXT CHECK (details IS NULL OR length(details) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_social_reports_once ON social_reports(target_type, target_id, reporter_user_id);
CREATE INDEX idx_social_reports_status ON social_reports(status, created_at);
CREATE INDEX idx_social_reports_reporter ON social_reports(reporter_user_id, created_at);

-- Moderator actions, kept after the content is gone (no text copied, only what was done).
CREATE TABLE social_mod_actions (
  id TEXT PRIMARY KEY,
  moderator_user_id TEXT,
  action TEXT NOT NULL,              -- 'remove_post' | 'remove_comment' | 'dismiss_report' | 'announcement'
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_social_mod_actions_target_user ON social_mod_actions(target_user_id, created_at);

-- One optional pinned announcement (moderators set or clear it).
CREATE TABLE social_announcements (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  link_url TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Counters, kept by triggers ----
CREATE TRIGGER social_likes_ins AFTER INSERT ON social_likes BEGIN
  UPDATE social_posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER social_likes_del AFTER DELETE ON social_likes BEGIN
  UPDATE social_posts SET like_count = MAX(0, like_count - 1) WHERE id = OLD.post_id;
END;
CREATE TRIGGER social_comments_ins AFTER INSERT ON social_comments WHEN NEW.status = 'visible' BEGIN
  UPDATE social_posts SET comment_count = comment_count + 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER social_comments_del AFTER DELETE ON social_comments WHEN OLD.status = 'visible' BEGIN
  UPDATE social_posts SET comment_count = MAX(0, comment_count - 1) WHERE id = OLD.post_id;
END;
CREATE TRIGGER social_comments_status AFTER UPDATE OF status ON social_comments WHEN OLD.status <> NEW.status BEGIN
  UPDATE social_posts SET comment_count = MAX(0, comment_count + (CASE WHEN NEW.status = 'visible' THEN 1 ELSE -1 END)) WHERE id = NEW.post_id;
END;
CREATE TRIGGER social_photos_ins AFTER INSERT ON social_post_photos BEGIN
  UPDATE social_posts SET has_photos = 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER social_photos_del AFTER DELETE ON social_post_photos BEGIN
  UPDATE social_posts SET has_photos = EXISTS (SELECT 1 FROM social_post_photos WHERE post_id = OLD.post_id) WHERE id = OLD.post_id;
END;
CREATE TRIGGER social_reviews_ins AFTER INSERT ON social_post_reviews BEGIN
  UPDATE social_posts SET has_review = 1 WHERE id = NEW.post_id;
END;
CREATE TRIGGER social_reviews_del AFTER DELETE ON social_post_reviews BEGIN
  UPDATE social_posts SET has_review = 0 WHERE id = OLD.post_id;
END;

-- ---- Existing reviews -> posts (copies; repeatable) ----
INSERT INTO social_posts (id, user_id, body, category, robotaxi_vehicle_id, legacy_review_id, created_at, updated_at)
SELECT r.id, r.user_id, r.body, 'review', r.robotaxi_vehicle_id, r.id, r.created_at, r.updated_at
FROM cybercab_reviews r
WHERE NOT EXISTS (SELECT 1 FROM social_posts p WHERE p.legacy_review_id = r.id OR p.id = r.id);

INSERT OR IGNORE INTO social_post_reviews (post_id, rating, vehicle_type, legacy_review_id, created_at)
SELECT r.id, r.rating, 'cybercab', r.id, r.created_at
FROM cybercab_reviews r JOIN social_posts p ON p.id = r.id AND p.legacy_review_id = r.id;

INSERT OR IGNORE INTO social_post_photos (id, post_id, position, r2_key, content_type, created_at)
SELECT ph.id, ph.review_id, ph.position, ph.r2_key, ph.content_type, ph.created_at
FROM cybercab_review_photos ph JOIN social_posts p ON p.id = ph.review_id AND p.legacy_review_id = ph.review_id;

INSERT OR IGNORE INTO social_likes (post_id, user_id, created_at)
SELECT l.review_id, l.user_id, l.created_at
FROM cybercab_review_likes l JOIN social_posts p ON p.id = l.review_id AND p.legacy_review_id = l.review_id;

INSERT OR IGNORE INTO social_comments (id, post_id, user_id, body, created_at)
SELECT c.id, c.review_id, c.user_id, c.body, c.created_at
FROM cybercab_review_comments c JOIN social_posts p ON p.id = c.review_id AND p.legacy_review_id = c.review_id;
