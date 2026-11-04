-- Following on the service-area maps: where an approved photo sighting goes on
-- the map. Additive and nullable. Until now a sighting kept only its place label;
-- the coordinates of the place the rider picked were checked and thrown away.
--
-- These hold that same verified place, rounded to 3 decimals (about 110 m), at
-- the street-or-place precision the public label already shows and never a
-- house-level point or anyone's live location. NULL means no known position:
-- older sightings, and those submitted without a place. They are listed, never
-- placed on the map at a guess. No index: the only reader walks one rider's
-- followed accounts through the existing indexes on user_id.
ALTER TABLE vehicle_observations ADD COLUMN map_lat REAL;
ALTER TABLE vehicle_observations ADD COLUMN map_lng REAL;
