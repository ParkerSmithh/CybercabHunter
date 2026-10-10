-- /news Major scoring (worker/news.js clusterAndScore). ai_major: the Workers
-- AI significance verdict for a story whose rules score was exactly 1 when it
-- was collected (1 = major, 0 = not major, NULL = never asked); it stays a +1
-- signal on every later rescoring, which never asks the model again.
-- ai_reason: the model's one line of reasoning.
ALTER TABLE news_articles ADD COLUMN ai_major INTEGER;
ALTER TABLE news_articles ADD COLUMN ai_reason TEXT;

-- The Major keyword list, a JSON array (edited from /moderation). Matched
-- case-insensitively at the start of a word, in the headline and excerpt.
INSERT OR IGNORE INTO news_config (key, value) VALUES ('major_keywords', '["launch","expansion","expands","expanded","expanding","crash","recall","nhtsa","investigation","investigates","investigated","lawsuit","sues","sued","new city","new cities","safety","price","pricing","fleet","deploys","deployment","rolls out","rollout","adds","dozens","hundreds","dmv","registry","registered","registration","certification","self-certification","new market","service area","service zone","expands to","launch in","arrives in"]');
