-- The latest daily snapshot packs each city's public buckets into one indexed row.
CREATE TABLE fare_history_summary (
  city TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;
