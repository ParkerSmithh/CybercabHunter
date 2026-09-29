-- Public Cybercab Sightings gallery (worker/sightings-public.js).
--
-- public_id is the ONLY identifier the public gallery ever shows for a
-- photo sighting (in its image URL, /api/sightings/<public_id>/photo): a
-- random 32-hex-character value, unrelated to any internal id or R2 key.
-- It is assigned when a moderator APPROVES a photo sighting
-- (db.reviewVehicleSighting) and is NULL otherwise, so a pending or rejected
-- sighting has no public identifier at all.
--
-- Additive only: one nullable column and a partial unique index. No
-- existing row is changed.
ALTER TABLE vehicle_observations ADD COLUMN public_id TEXT;
CREATE UNIQUE INDEX idx_vehicle_observations_public_id ON vehicle_observations(public_id) WHERE public_id IS NOT NULL;
