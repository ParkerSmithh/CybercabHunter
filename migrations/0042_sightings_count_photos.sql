-- Sightings totals = approved PHOTO sightings by people (owner, Oct 2026).
-- The lifetime counter also counted the Muse connector's registry imports
-- (vehicle_sighting rows with no photo, linked to registry vehicles) and the
-- automated camera-watch captures. Those entries leave the ledger; from now on
-- only approved photo sightings count, globally and per city
-- ('sightings_all_time:<city>', the city part of the observation's service
-- area, lowercased). The ledger stays lifetime: a photo that later expires or
-- a sighting later deleted keeps its count.
DELETE FROM site_stat_events WHERE counter_key = 'sightings_all_time' AND event_key LIKE 'camera:%';
DELETE FROM site_stat_events WHERE counter_key = 'sightings_all_time' AND event_key LIKE 'submission:%'
  AND substr(event_key, 12) IN (SELECT id FROM submissions WHERE evidence_type IS NULL OR evidence_type <> 'photo');
UPDATE site_stat_counters SET value = (SELECT COUNT(*) FROM site_stat_events WHERE counter_key = 'sightings_all_time'), updated_at = datetime('now')
  WHERE key = 'sightings_all_time';
-- Per-city lifetime counters for every approved photo sighting still on record
-- (the insert trigger on site_stat_events creates and counts each one).
INSERT INTO site_stat_events(counter_key, event_key)
  SELECT 'sightings_all_time:' || lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)), 'submission:' || s.id
  FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id
  WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND s.evidence_type = 'photo' AND lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)) <> ''
  ON CONFLICT DO NOTHING;
-- Camera-watch captures no longer feed the sightings total.
DROP TRIGGER IF EXISTS site_stat_camera_detections_insert;
DROP TRIGGER IF EXISTS site_stat_submissions_insert;
CREATE TRIGGER site_stat_submissions_insert AFTER INSERT ON submissions BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' AND s.evidence_type='photo' ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time:' || lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)), 'submission:' || s.id FROM submissions s JOIN vehicle_observations o ON o.submission_id=s.id WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' AND s.evidence_type='photo' AND lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)) <> '' ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id IN (SELECT robotaxi_vehicle_id FROM trips WHERE submission_id=NEW.id)) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (t.submission_id=NEW.id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
DROP TRIGGER IF EXISTS site_stat_submissions_update;
CREATE TRIGGER site_stat_submissions_update AFTER UPDATE OF status, submission_type ON submissions BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' AND s.evidence_type='photo' ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time:' || lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)), 'submission:' || s.id FROM submissions s JOIN vehicle_observations o ON o.submission_id=s.id WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' AND s.evidence_type='photo' AND lower(trim(CASE WHEN instr(o.service_area, ',') > 0 THEN substr(o.service_area, 1, instr(o.service_area, ',') - 1) ELSE o.service_area END)) <> '' ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id IN (SELECT robotaxi_vehicle_id FROM trips WHERE submission_id=NEW.id)) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (t.submission_id=NEW.id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
