-- D1 read budget (Nov 2026: the free tier's 5M rows/day was exceeded). Indexes
-- only; no table, column or row changes. Every query works without them (same
-- results), only reading more rows.
--
-- Public photo sightings: the gallery, its counts and hour buckets, the
-- homepage's sighting numbers and top spots (worker/db.js PUBLIC_SIGHTINGS_FROM)
-- scanned every submission on every request (~1.5-2k rows each, ~2.4k runs a
-- day). Partial on exactly the rows that can be public (a gallery id and a
-- stored photo: PUBLIC_PHOTO_SIGHTING_SQL), so it holds the last 30 days'
-- public photos only; the newest page walks it in order (no sort) and stops
-- after one page. Counts and hour buckets read it too (PUBLIC_SIGHTINGS_FROM's
-- `o.observed_at >= ''` steers them here, not to idx_vehicle_observations_public_id,
-- which keeps every approved photo ever).
CREATE INDEX idx_vehicle_observations_public_time
  ON vehicle_observations(observed_at, public_id)
  WHERE public_id IS NOT NULL AND evidence_ref IS NOT NULL;

-- The scheduled photo-retention cleanup (every 10 minutes,
-- db.listExpiredSightingPhotos) scanned all submissions each run. Partial on
-- photo sightings that still hold a photo: usually none are past 30 days.
CREATE INDEX idx_submissions_photo_retention
  ON submissions(submitted_at)
  WHERE submission_type = 'vehicle_sighting' AND evidence_type = 'photo' AND evidence_ref IS NOT NULL;

-- Moderation's "recently approved" photo list (db.getRecentApprovedPhotoSightings)
-- sorted every approved sighting by review time to show the newest 50. In
-- review-time order, so the newest 50 are read directly. Partial on photo
-- sightings that still hold a photo (the list's own condition).
CREATE INDEX idx_submissions_approved_photo_review
  ON submissions(submission_type, status, reviewed_at, id)
  WHERE evidence_type = 'photo' AND evidence_ref IS NOT NULL;
