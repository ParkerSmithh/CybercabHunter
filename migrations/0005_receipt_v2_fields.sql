-- Cybercab Hunter — fields needed to fully represent the REAL Tesla
-- Robotaxi receipt format (confirmed against an actual forwarded receipt,
-- see worker/receipt-extraction.js's tesla_robotaxi_v2 parser). Additive
-- only: does not touch any existing column or table, does not delete or
-- modify any existing row. Existing NULLs on old receipt_email trips stay
-- NULL — there is no raw receipt body retained for those rows to
-- reconstruct pickup/dropoff/duration/time data from.

ALTER TABLE trips ADD COLUMN duration_minutes INTEGER;
-- 0 = duration_minutes came directly from the receipt's own "X min" text;
-- 1 = no explicit duration was present and it was computed as
-- (dropoff_time - pickup_time) instead. Kept distinct per the real-format
-- parsing requirement to never conflate extracted vs. derived data.
ALTER TABLE trips ADD COLUMN duration_minutes_derived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN pickup_time TEXT;
ALTER TABLE trips ADD COLUMN dropoff_time TEXT;
