-- Cybercab Hunter — records WHY a registry vehicle was approved for public view.
--
-- Until now a vehicle could only be made public by Approve Cybercab, which
-- required a moderator-entered VIN (0013) already on file. A moderator can
-- now also approve a vehicle with no VIN. Both are still explicit moderator
-- actions; this column only records which kind of approval stands behind a
-- public vehicle, so the public registry never implies a verification that
-- doesn't exist:
--   'vin-verified'  approved with a VIN on file, which a moderator copied off
--                   Robotaxi Tracker after confirming there that the vehicle
--                   is a Cybercab (the same standard as before this change).
--   'manual'        approved by a moderator with no VIN on file.
--   NULL            not approved (private / pending review).
--
-- A 'manual' vehicle becomes 'vin-verified' only through the moderator's
-- explicit verify action once a VIN is on file; changing or clearing the VIN
-- of a 'vin-verified' vehicle drops it back to 'manual'. Cybercab Hunter
-- never derives, guesses, or fills in a VIN.
--
-- approval_basis_set_by_user_id / approval_basis_set_at record who set the
-- current value and when (robotaxi_vehicle_reviews keeps recording the
-- visibility decisions themselves).
ALTER TABLE robotaxi_vehicles ADD COLUMN approval_basis TEXT CHECK (approval_basis IN ('vin-verified', 'manual'));
ALTER TABLE robotaxi_vehicles ADD COLUMN approval_basis_set_by_user_id TEXT;
ALTER TABLE robotaxi_vehicles ADD COLUMN approval_basis_set_at TEXT;

-- Backfill. Only rows that are already public get a value; private / pending
-- vehicles stay NULL. Visibility is not touched, so nothing that is public
-- today becomes private (or the reverse).
--  * Public with a VIN: every one of them went through Approve Cybercab with
--    a VIN on file, so 'vin-verified'.
--  * Public receipt-origin vehicles without a VIN (approved before a VIN was
--    required): 'manual'. Their public eligibility comes from counted rides,
--    which this column does not affect.
--  * A public sighting-origin vehicle without a VIN (not expected to exist,
--    since its approval always required one) is left NULL, so it stays exactly
--    as hidden as it is today.
UPDATE robotaxi_vehicles
SET approval_basis = 'vin-verified', approval_basis_set_at = datetime('now')
WHERE visibility = 'public' AND vin IS NOT NULL AND vin <> '';

UPDATE robotaxi_vehicles
SET approval_basis = 'manual', approval_basis_set_at = datetime('now')
WHERE visibility = 'public' AND (vin IS NULL OR vin = '') AND origin = 'receipt';
