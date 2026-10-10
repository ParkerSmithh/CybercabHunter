-- /news curation (worker/news.js). The feed list moves into news_config
-- ('feeds', a JSON array of {id, name, url, tier}; tier 1 checked ~every 2 h,
-- tier 2 ~every 6 h), edited from /moderation; seeded with the 25 feeds
-- verified Oct 10, 2026 (DEFAULT_FEEDS). And the headline blocklist gains
-- viral-clip framing and app-version posts (a /pattern/ line is a
-- case-insensitive regular expression); each line is added only when missing,
-- keeping whatever moderators saved. Incident reporting is not blocked.
INSERT OR IGNORE INTO news_config (key, value) VALUES ('feeds', '[{"id":"electrek","tier":1,"name":"Electrek","url":"https://electrek.co/feed/"},{"id":"teslarati","tier":1,"name":"Teslarati","url":"https://www.teslarati.com/feed/"},{"id":"insideevs","tier":1,"name":"InsideEVs","url":"https://insideevs.com/rss/articles/all/"},{"id":"notateslaapp","tier":1,"name":"Not a Tesla App","url":"https://www.notateslaapp.com/rss"},{"id":"teslanorth","tier":1,"name":"Teslanorth","url":"https://teslanorth.com/feed/"},{"id":"driveteslacanada","tier":1,"name":"Drive Tesla Canada","url":"https://driveteslacanada.ca/feed/"},{"id":"teslaoracle","tier":2,"name":"Tesla Oracle","url":"https://www.teslaoracle.com/feed/"},{"id":"techcrunch","tier":2,"name":"TechCrunch","url":"https://techcrunch.com/category/transportation/feed/"},{"id":"theverge","tier":2,"name":"The Verge","url":"https://www.theverge.com/rss/tesla/index.xml"},{"id":"arstechnica","tier":2,"name":"Ars Technica","url":"https://feeds.arstechnica.com/arstechnica/cars"},{"id":"electrive","tier":2,"name":"Electrive","url":"https://www.electrive.com/feed/"},{"id":"cnbc-autos","tier":2,"name":"CNBC","url":"https://www.cnbc.com/id/10000101/device/rss/rss.html"},{"id":"cnbc-tech","tier":2,"name":"CNBC","url":"https://www.cnbc.com/id/19854910/device/rss/rss.html"},{"id":"bloomberg-tech","tier":2,"name":"Bloomberg","url":"https://www.bloomberg.com/feeds/technology/news.rss"},{"id":"businessinsider","tier":2,"name":"Business Insider","url":"https://feeds.businessinsider.com/custom/all"},{"id":"fortune","tier":2,"name":"Fortune","url":"https://fortune.com/feed/fortune-feeds/?id=3230629"},{"id":"nytimes-tech","tier":2,"name":"The New York Times","url":"https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"},{"id":"thedriven","tier":2,"name":"The Driven","url":"https://thedriven.io/feed/"},{"id":"therobotreport","tier":2,"name":"The Robot Report","url":"https://www.therobotreport.com/feed/"},{"id":"carscoops","tier":2,"name":"Carscoops","url":"https://www.carscoops.com/feed/"},{"id":"jalopnik","tier":2,"name":"Jalopnik","url":"https://www.jalopnik.com/feed/"},{"id":"kxan","tier":2,"name":"KXAN","url":"https://www.kxan.com/feed/"},{"id":"kvue","tier":2,"name":"KVUE","url":"https://www.kvue.com/feeds/syndication/rss/news"},{"id":"communityimpact","tier":2,"name":"Community Impact","url":"https://communityimpact.com/rss/"},{"id":"lvrj","tier":2,"name":"Las Vegas Review-Journal","url":"https://www.reviewjournal.com/feed/"}]');
UPDATE news_config SET value = value || char(10) || 'video shows'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'video shows' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'watch:'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'watch:' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'shocking'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'shocking' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'you won''t believe'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'you won''t believe' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'goes viral'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'goes viral' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'caught on camera'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'caught on camera' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'leaked video'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'leaked video' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || '/app\s+\d+\.\d+/'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || '/app\s+\d+\.\d+/' || char(10) || '%';
