-- Cybercab Hunter — Tesla Ride Sync: importing ride history (worker/tesla-rides.js).
-- Additive only.
--
-- 1. tesla_ride_sync_connections.auto_sync_after: background sync's cutoff.
--    NULL until the rider confirms their first import from the preview — no
--    ride is ever imported without that consent. Then it holds the start time
--    (UTC ISO) of the newest ride the rider has already been shown, so the
--    scheduled sync imports only rides that started LATER (a ride the rider
--    left unticked in the preview is never imported behind their back).
ALTER TABLE tesla_ride_sync_connections ADD COLUMN auto_sync_after TEXT;
ALTER TABLE tesla_ride_sync_connections ADD COLUMN last_sync_result TEXT;

-- 2. robotaxi_vehicles.reported_vin: the VIN Tesla's ride history reported
--    for this plate, kept for a moderator to verify later. Deliberately a
--    SEPARATE column from `vin` (0013): `vin` is a moderator's manual
--    confirmation and is what Approve Cybercab requires, so a synced VIN must
--    never land there. Writing reported_vin never changes visibility,
--    verification_status or vin.
ALTER TABLE robotaxi_vehicles ADD COLUMN reported_vin TEXT;
ALTER TABLE robotaxi_vehicles ADD COLUMN reported_vin_source TEXT;
ALTER TABLE robotaxi_vehicles ADD COLUMN reported_vin_at TEXT;
