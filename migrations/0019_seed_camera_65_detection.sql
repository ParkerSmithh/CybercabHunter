-- One real camera-watch detection, so the Zones map is not empty before the
-- watch's first upload: camera 65, MARTIN LUTHER KING JR BLVD / TRINITY ST,
-- at 2026-09-30T01:24:33Z. Coordinates are the camera's own, from the City
-- of Austin's public traffic-camera inventory (data.austintexas.gov, b4k4-adkb).
--
-- image_r2_key is NULL: no capture of this detection is stored in R2 yet, so
-- the map's popup shows a clearly marked "image pending" placeholder rather
-- than an image (and never the city's live snapshot URL, which changes).
-- The public map shows only the trailing 24 hours, so this marker drops off
-- by itself one day after observed_at.
--
-- Data only: one INSERT into the table created by 0018. INSERT OR IGNORE,
-- so a matching row already sent by the watch is left as it is.
INSERT OR IGNORE INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key)
VALUES ('seed-camera-65-20260930T012433Z', '65', 'MARTIN LUTHER KING JR BLVD / TRINITY ST', 30.279638, -97.734512, '2026-09-30T01:24:33Z', NULL);
