-- LOCAL ONLY: review separately before any deployment or production migration.
ALTER TABLE push_deliveries ADD COLUMN period_key TEXT;
ALTER TABLE push_deliveries ADD COLUMN summary_start INTEGER;
ALTER TABLE push_deliveries ADD COLUMN summary_end INTEGER;
ALTER TABLE push_deliveries ADD COLUMN summary_initialized INTEGER;
ALTER TABLE push_deliveries ADD COLUMN last_error TEXT;
CREATE UNIQUE INDEX push_one_period ON push_deliveries(user_id,category,period_key) WHERE period_key IS NOT NULL;
CREATE INDEX push_events_category_time ON push_events(category,created_at,id);
CREATE TABLE push_device_outcomes (
 delivery_id TEXT NOT NULL REFERENCES push_deliveries(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 http_status INTEGER, reason TEXT, apns_id TEXT, updated_at INTEGER NOT NULL,
 PRIMARY KEY(delivery_id,device_id)
);
-- Preserve confirmed legacy acceptances and remove unsupported "sent" claims.
INSERT INTO push_device_outcomes(delivery_id,device_id,status,attempts,reason,updated_at)
 SELECT r.delivery_id,r.device_id,'accepted',0,'LegacyAcceptanceReceipt',0 FROM push_receipts r;
UPDATE push_deliveries SET status='accepted' WHERE status='sent'
 AND EXISTS(SELECT 1 FROM push_receipts r WHERE r.delivery_id=push_deliveries.id);
UPDATE push_deliveries SET status='failed',last_error='LegacyUnconfirmedSend'
 WHERE status='sent';
