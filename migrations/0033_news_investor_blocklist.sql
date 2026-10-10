-- /news: investor commentary is not news (owner, Oct 2026). Adds "investors"
-- and "valuation" to the headline blocklist and Stocktwits to the publisher
-- blocklist, keeping whatever moderators already saved (each is added only
-- when missing). Future ingests only: stored stories stay (hide them by hand).
UPDATE news_config SET value = value || char(10) || 'investors'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'investors' || char(10) || '%';
UPDATE news_config SET value = value || char(10) || 'valuation'
  WHERE key = 'block' AND char(10) || lower(value) || char(10) NOT LIKE '%' || char(10) || 'valuation' || char(10) || '%';
UPDATE news_config SET value = json_insert(value, '$[#]', 'Stocktwits')
  WHERE key = 'publisher_blocklist' AND json_valid(value)
    AND NOT EXISTS (SELECT 1 FROM json_each(news_config.value) WHERE lower(json_each.value) = 'stocktwits');
