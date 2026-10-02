-- Cybercab reviews on the Community page (worker/reviews.js).
--
-- A signed-in rider reviews one Cybercab (a public registry vehicle): 1–5
-- stars, text, up to 3 photos. Others like and comment on reviews. Reviews are
-- visible at once (no moderation queue); a moderator can delete any review or
-- comment, and each author their own.
--
-- Additive: four new tables and their indexes. No existing table, column or
-- row is touched.
--
-- Design notes:
--  * ONE review per rider per vehicle: the unique index below, so a second
--    review of the same Cybercab is impossible even under a race; the rider
--    edits the one they have.
--  * Photos are their own rows (at most 3 per review, enforced by the Worker;
--    position 0–2 here). r2_key is private: photos are served only by their
--    random public id, and only while the review's vehicle is public.
--  * Likes are one row per (review, rider): the primary key makes liking
--    idempotent. Who liked is never served — only the count.
--  * Author privacy reuses users.leaderboard_opt_in (the Profile page's
--    "Community leaderboard & public profile" switch): off = "Anonymous".
--    Nothing new is added to users.
--  * Account deletion (worker/account.js) removes a rider's reviews (with
--    their photos, likes and comments), likes and comments explicitly.
CREATE TABLE cybercab_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  robotaxi_vehicle_id TEXT NOT NULL REFERENCES robotaxi_vehicles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ux_cybercab_reviews_user_vehicle ON cybercab_reviews(user_id, robotaxi_vehicle_id);
CREATE INDEX idx_cybercab_reviews_created ON cybercab_reviews(created_at);
CREATE INDEX idx_cybercab_reviews_vehicle ON cybercab_reviews(robotaxi_vehicle_id);

CREATE TABLE cybercab_review_photos (
  id TEXT PRIMARY KEY,                      -- random public id (32 hex)
  review_id TEXT NOT NULL REFERENCES cybercab_reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cybercab_review_photos_review ON cybercab_review_photos(review_id, position);

CREATE TABLE cybercab_review_likes (
  review_id TEXT NOT NULL REFERENCES cybercab_reviews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, user_id)
);
CREATE INDEX idx_cybercab_review_likes_user ON cybercab_review_likes(user_id);

CREATE TABLE cybercab_review_comments (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES cybercab_reviews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cybercab_review_comments_review ON cybercab_review_comments(review_id, created_at);
CREATE INDEX idx_cybercab_review_comments_user ON cybercab_review_comments(user_id);
