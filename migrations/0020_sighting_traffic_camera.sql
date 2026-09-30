-- Traffic-camera sightings on the Zones map (worker/camera-sightings.js
-- placeSightingOnMap, worker/moderation.js).
--
-- vehicle_observations.camera_id — the City of Austin traffic camera a photo
-- sighting was captured from, when the submitter picked one on the Submit
-- form (public/data/traffic-cameras.json). NULL for ordinary phone photos,
-- which is almost all of them; a NULL camera changes nothing anywhere.
--
-- camera_detections.source_submission_id — the approved photo sighting a map
-- detection was made from (NULL for the camera watch's own uploads). At most
-- one map detection per sighting, so re-approving or retrying "Add to map"
-- never adds a second marker. Used to remove the map copy when the
-- sighting's photo is deleted or expires.
--
-- Additive only: two nullable columns and one partial unique index. No
-- existing row is changed.
ALTER TABLE vehicle_observations ADD COLUMN camera_id TEXT;
ALTER TABLE camera_detections ADD COLUMN source_submission_id TEXT;
CREATE UNIQUE INDEX idx_camera_detections_source_submission ON camera_detections(source_submission_id) WHERE source_submission_id IS NOT NULL;
