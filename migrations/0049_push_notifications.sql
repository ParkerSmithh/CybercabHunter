-- LOCAL DRAFT ONLY. 0048 is intentionally reserved; no location features.
CREATE TABLE push_preferences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 settings TEXT NOT NULL, updated_at INTEGER NOT NULL, initialized_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE push_devices (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
 authorized INTEGER NOT NULL DEFAULT 0, refreshed_at INTEGER NOT NULL,
 UNIQUE(token, environment)
);
CREATE INDEX push_devices_user ON push_devices(user_id, authorized, refreshed_at);
CREATE TABLE push_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE push_events (
 id TEXT PRIMARY KEY, category TEXT NOT NULL, recipient TEXT, payload TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX push_events_time ON push_events(created_at, category);
CREATE TABLE push_deliveries (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 category TEXT NOT NULL, payload TEXT NOT NULL, event_ids TEXT NOT NULL,
 due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_delivery_due ON push_deliveries(status, due_at);
CREATE TABLE push_receipts (
 delivery_id TEXT NOT NULL REFERENCES push_deliveries(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
 PRIMARY KEY(delivery_id,device_id)
);
CREATE TABLE push_consumed (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES push_events(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,event_id)
);
CREATE TABLE push_daily (date TEXT PRIMARY KEY, metrics TEXT NOT NULL);

-- Cover only the recent discovery windows; no permanent full-history polling.
CREATE INDEX push_news_created ON news_articles(created_at,id);
CREATE INDEX push_vehicle_created ON robotaxi_vehicles(created_at,id);
CREATE INDEX push_sighting_reviewed ON submissions(reviewed_at,id);
CREATE INDEX push_camera_created ON camera_detections(created_at,id);
CREATE INDEX push_social_created ON social_notifications(created_at,id);
CREATE TABLE push_registration_limits (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 window INTEGER NOT NULL, hits INTEGER NOT NULL
);

CREATE INDEX push_vehicle_review_created ON robotaxi_vehicle_reviews(created_at,robotaxi_vehicle_id);
