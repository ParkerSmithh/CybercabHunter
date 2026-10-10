-- /news: a publisher blocklist for the ingest (worker/news.js). A JSON array
-- of publisher names, matched case-insensitively against a story's source;
-- a story from a listed publisher is dropped before scoring and storage.
-- Only future ingests are affected: stored stories stay (hide them by hand).
-- Edited from /moderation. Seed: BASENOR (spelling checked against the stored
-- stories, Oct 2026).
INSERT OR IGNORE INTO news_config (key, value) VALUES ('publisher_blocklist', '["BASENOR"]');
