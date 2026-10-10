-- /news thumbnails (worker/news.js makeThumb). thumb_key: the story's R2
-- object (NEWS_THUMBS, "thumbs/<id>.webp", a 400 px WebP), served from
-- /news-img/<id>.webp; image_url stays for feed-provided enclosures (the page
-- prefers thumb_key, then image_url, then the outlet's initial).
-- thumb_status: the 10-minute step's queue — 'pending', 'done', or
-- 'failed:<reason>' / 'skipped:<reason>' (no retry; the badge stays).
ALTER TABLE news_articles ADD COLUMN thumb_key TEXT;
ALTER TABLE news_articles ADD COLUMN thumb_status TEXT;
CREATE INDEX idx_news_thumb_status ON news_articles(thumb_status);

-- Backfill: every stored story with a real article URL is queued. Stories
-- that only have a Google News redirect link have no article page to read.
UPDATE news_articles SET thumb_status = CASE WHEN url LIKE 'https://news.google.com/%' THEN 'skipped:no_article_url' ELSE 'pending' END;

-- Publishers who opt out of thumbnails: domains, as a JSON array (edited from
-- /moderation). Their stories are still listed, with the badge.
INSERT OR IGNORE INTO news_config (key, value) VALUES ('thumb_blocklist', '[]');
