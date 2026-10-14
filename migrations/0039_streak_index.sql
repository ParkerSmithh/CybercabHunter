-- Spotting Streaks (worker/streaks.js) read a rider's approved sightings by
-- submission time, and every opted-in rider's for the streak rankings. This
-- index serves both without scanning other submission types or statuses.
-- No new tables: streaks are computed live from submissions, never stored.
CREATE INDEX IF NOT EXISTS idx_submissions_type_status_user_time
  ON submissions(submission_type, status, user_id, submitted_at);
