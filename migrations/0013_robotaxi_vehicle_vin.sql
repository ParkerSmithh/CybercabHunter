-- Cybercab Hunter — adds a moderator-entered VIN to the registry vehicle row.
--
-- Cybercab Hunter cannot tell a Cybercab from a Model Y from anything it
-- already knows about a vehicle (plate/model/color are all self-reported —
-- see 0002_ride_submissions.sql's own note on why VIN was originally left
-- out). This column exists for a narrower purpose: after a moderator
-- manually looks a plate up on Robotaxi Tracker (an external site, outside
-- this app) and sees for themselves that the vehicle is a Cybercab, they
-- copy the VIN it shows and enter it here by hand. Cybercab Hunter never
-- looks the VIN up, decodes it, or infers a vehicle type from it — a
-- non-null vin is simply the record of that manual confirmation, and is
-- what the Approve Cybercab action requires before it will run.
--
-- Additive only: does not touch any existing column, and does not touch
-- robotaxi_vehicle_reviews (0012) — that table keeps recording the
-- visibility DECISION; vin_set_by_user_id/vin_set_at record the separate
-- fact of who entered the VIN and when, since a VIN can be saved without
-- ever approving the vehicle (and vice versa is impossible: approval
-- requires a VIN already be present).
ALTER TABLE robotaxi_vehicles ADD COLUMN vin TEXT;
ALTER TABLE robotaxi_vehicles ADD COLUMN vin_set_by_user_id TEXT;
ALTER TABLE robotaxi_vehicles ADD COLUMN vin_set_at TEXT;
