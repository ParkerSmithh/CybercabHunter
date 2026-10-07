-- Cybercab Hunter — camera detections carry their city (Dallas launch).
--
-- Until now every camera_detections row was an Austin capture (the camera
-- watch and the camera list were Austin-only). With Dallas cameras added to
-- public/data/traffic-cameras.json, a detection records which city's camera
-- took it, so the Zones map and the replay can load one city at a time
-- (GET /api/camera-sightings?city=..., /history?city=...).
--
-- The default backfills every existing row as Austin, which is what they all
-- are. New rows take the city from the camera list (worker/camera-sightings.js).

ALTER TABLE camera_detections ADD COLUMN city TEXT NOT NULL DEFAULT 'austin';
CREATE INDEX idx_camera_detections_city_observed_at ON camera_detections(city, observed_at);
