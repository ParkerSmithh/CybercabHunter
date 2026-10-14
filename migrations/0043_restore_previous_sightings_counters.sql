-- Undo 0042 at the owner's request: restore the previous all-city sightings ledger.
-- Only counter metadata and counting triggers change; content is untouched.
DROP TRIGGER IF EXISTS site_stat_submissions_insert;
CREATE TRIGGER site_stat_submissions_insert AFTER INSERT ON submissions BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' ON CONFLICT DO NOTHING;
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
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s WHERE (s.id=NEW.id) AND s.submission_type='vehicle_sighting' AND s.status='approved' ON CONFLICT DO NOTHING;
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
DROP TRIGGER IF EXISTS site_stat_camera_detections_insert;
CREATE TRIGGER site_stat_camera_detections_insert AFTER INSERT ON camera_detections BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'camera:' || json_array(c.camera_id, c.observed_at) FROM camera_detections c WHERE (c.id=NEW.id) AND c.source_submission_id IS NULL ON CONFLICT DO NOTHING;
END;
DELETE FROM site_stat_events WHERE counter_key LIKE 'sightings_all_time:%';
DELETE FROM site_stat_counters WHERE key LIKE 'sightings_all_time:%';
INSERT INTO site_stat_events(counter_key,event_key)
  SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s
  WHERE s.submission_type='vehicle_sighting' AND s.status='approved'
  ON CONFLICT DO NOTHING;
INSERT INTO site_stat_events(counter_key,event_key)
  SELECT 'sightings_all_time', 'camera:' || json_array(c.camera_id,c.observed_at)
  FROM camera_detections c WHERE c.source_submission_id IS NULL
  ON CONFLICT DO NOTHING;
