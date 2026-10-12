-- Rider-confirmed setup completion is separate from evidence of received mail.
ALTER TABLE receipt_ingestion_addresses ADD COLUMN setup_completed_at TEXT;
