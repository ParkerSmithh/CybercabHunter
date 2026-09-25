-- Where a registry vehicle came from. Additive: one new column.
--
--   'receipt'  — created by the receipt pipeline (every row that exists today;
--                the default, so existing behavior is unchanged).
--   'sighting' — added by a moderator from a reviewed community sighting.
--                Such a vehicle has no ride, so a moderator-entered VIN
--                (worker/moderation.js, POST .../vin) is what stands in for
--                the counted-ride requirement — see registryEvidenceSql in
--                worker/ride-status.js, the one place that rule lives.
ALTER TABLE robotaxi_vehicles ADD COLUMN origin TEXT NOT NULL DEFAULT 'receipt' CHECK (origin IN ('receipt', 'sighting'));
