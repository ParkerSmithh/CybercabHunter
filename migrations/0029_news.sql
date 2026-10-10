-- /news: automatically collected Tesla Cybercab / robotaxi headlines
-- (worker/news.js). One row per stored item; the canonical URL is UNIQUE so
-- ingest reruns never duplicate. cluster_id groups the same story across
-- outlets (the earliest item's id); importance 2 = major, 1 = notable,
-- 0 = normal. hidden = 1: kept, never served. featured = 1: a moderator
-- forced importance 2 (re-scoring keeps it there).
CREATE TABLE news_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'press',
  published_at TEXT NOT NULL,
  excerpt TEXT,
  image_url TEXT,
  cluster_id TEXT,
  importance INTEGER DEFAULT 0,
  source_count INTEGER DEFAULT 1,
  hidden INTEGER DEFAULT 0,
  featured INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_news_published ON news_articles(published_at DESC);
CREATE INDEX idx_news_cluster ON news_articles(cluster_id);

-- Editable from /moderation without a redeploy: 'allow' and 'block', one rule
-- per line ("a + b" = both words), matched case-insensitively on whole words.
CREATE TABLE news_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO news_config (key, value) VALUES
  ('allow', 'cybercab
robotaxi + tesla'),
  ('block', 'stock
stocks
shares
price target
TSLA
wall street
analyst
analysts');
