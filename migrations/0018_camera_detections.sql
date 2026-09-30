-- Cybercabs spotted by the hourly traffic-camera watch (worker/camera-sightings.js),
-- shown as markers on the Zones page map.
--
-- One row per capture: which City of Austin traffic camera saw a Cybercab,
-- where that camera is, when (observed_at, ISO 8601 UTC "YYYY-MM-DDTHH:MM:SSZ",
-- always this exact form so it sorts and compares as text), and the R2 key of
-- the still image (NULL until an image is stored).
--
-- Deliberately standalone: camera captures are plateless wide shots of public
-- intersections, so there is no link to robotaxi_vehicles, no plate and no VIN.
--
-- Additive only: one new table and its indexes. No existing table or row is touched.
CREATE TABLE camera_detections (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL,
  camera_name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  observed_at TEXT NOT NULL,
  image_r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- A camera reports one capture per moment: a retried upload is the same row.
CREATE UNIQUE INDEX idx_camera_detections_camera_time ON camera_detections(camera_id, observed_at);
-- The public map reads only the trailing 24 hours.
CREATE INDEX idx_camera_detections_observed_at ON camera_detections(observed_at);
