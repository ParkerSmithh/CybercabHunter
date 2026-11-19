ALTER TABLE users ADD COLUMN preferred_city TEXT;
ALTER TABLE news_articles ADD COLUMN city TEXT;
CREATE INDEX idx_city_news ON news_articles(city, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_city_vehicle_created ON robotaxi_vehicles(created_at);
CREATE INDEX IF NOT EXISTS idx_city_first_approval ON robotaxi_vehicle_reviews(created_at, robotaxi_vehicle_id) WHERE action = 'approved_public';

CREATE TABLE city_daily_summary (
  city TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  registry INTEGER NOT NULL,
  homepage_payload TEXT NOT NULL,
  fleet_payload TEXT NOT NULL,
  cybercab_since TEXT
);

CREATE TABLE city_event_deltas (
  city TEXT NOT NULL,
  day TEXT NOT NULL,
  registry_additions INTEGER NOT NULL,
  approved_sightings INTEGER NOT NULL,
  PRIMARY KEY (city, day)
) WITHOUT ROWID;
