-- Lifetime headline totals. No DELETE triggers, no foreign keys to live content.
-- The ledger survives moderation reversals/deletions and deduplicates physical rides.
-- Camera identity is camera + capture time, so job retries keep the same event
-- even if the live detection was deleted and the uploader assigns a new UUID.
-- The ledger guards each row's previous counted state, beyond endpoint/status retries.
-- Eligibility uses the registry's existing public/accepted-ride rules.
CREATE TABLE site_stat_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0 CHECK(typeof(value) = 'integer' AND value >= 0),
  updated_at TEXT
);
CREATE TABLE site_stat_ride_records (
  trip_id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL
);
CREATE TABLE site_stat_events (
  counter_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  PRIMARY KEY(counter_key, event_key)
);
-- Seed the existing headline queries at migration time, never a captured constant.
-- Historical sighting/camera ledger entries prevent recounting pre-migration events;
-- the sightings baseline matches the old homepage gallery count exactly.
INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (1) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
INSERT INTO site_stat_events(counter_key,event_key) SELECT 'rides_total',event_key FROM site_stat_ride_records WHERE 1 ON CONFLICT DO NOTHING;
INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (1) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'submission:' || s.id FROM submissions s WHERE (1) AND s.submission_type='vehicle_sighting' AND s.status='approved' ON CONFLICT DO NOTHING;
INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'camera:' || json_array(c.camera_id, c.observed_at) FROM camera_detections c WHERE (1) AND c.source_submission_id IS NULL ON CONFLICT DO NOTHING;
INSERT INTO site_stat_counters(key,value,updated_at)
SELECT k.key, CASE WHEN k.key='sightings_all_time' THEN (SELECT COUNT(*) FROM submissions s JOIN vehicle_observations o ON o.submission_id=s.id WHERE 
  s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND s.evidence_type = 'photo'
  AND o.evidence_ref IS NOT NULL AND o.public_id IS NOT NULL
  AND s.submitted_at > datetime('now', '-30 days')) ELSE (SELECT COUNT(*) FROM site_stat_events e WHERE e.counter_key=k.key) END, datetime('now')
FROM (SELECT 'cybercabs_spotted' AS key UNION ALL SELECT 'rides_total' UNION ALL SELECT 'sightings_all_time') k;
CREATE TRIGGER site_stat_ride_record_insert AFTER INSERT ON site_stat_ride_records BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) VALUES('rides_total', NEW.event_key) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER site_stat_event_increment AFTER INSERT ON site_stat_events BEGIN
  INSERT INTO site_stat_counters(key,value,updated_at) VALUES(NEW.counter_key,0,datetime('now')) ON CONFLICT DO NOTHING;
  UPDATE site_stat_counters SET value=value+1, updated_at=datetime('now') WHERE key=NEW.counter_key;
END;
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
CREATE TRIGGER site_stat_robotaxi_vehicles_insert AFTER INSERT ON robotaxi_vehicles BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id=NEW.id) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (v.id=NEW.id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER site_stat_robotaxi_vehicles_update AFTER UPDATE OF visibility, origin, vin, approval_basis ON robotaxi_vehicles BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id=NEW.id) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (v.id=NEW.id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER site_stat_trips_insert AFTER INSERT ON trips BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id=NEW.robotaxi_vehicle_id) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (v.id=NEW.robotaxi_vehicle_id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER site_stat_trips_update AFTER UPDATE OF submission_id, robotaxi_vehicle_id, superseded_by, ride_key ON trips BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'cybercabs_spotted', v.id FROM robotaxi_vehicles v WHERE (v.id=NEW.robotaxi_vehicle_id) AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
  INSERT INTO site_stat_ride_records(trip_id,event_key) SELECT t.id, json_array(v.id, COALESCE(t.ride_key, t.id)) FROM trips t JOIN submissions s ON s.id = t.submission_id JOIN robotaxi_vehicles v ON v.id=t.robotaxi_vehicle_id WHERE (v.id=NEW.robotaxi_vehicle_id) AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved') AND v.visibility = 'public' AND (EXISTS (
    SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status IN ('pending', 'approved')
  )
    OR (v.origin = 'sighting' AND ((v.vin IS NOT NULL AND v.vin <> '')
                                          OR v.approval_basis IS NOT NULL))) ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER site_stat_camera_detections_insert AFTER INSERT ON camera_detections BEGIN
  INSERT INTO site_stat_events(counter_key,event_key) SELECT 'sightings_all_time', 'camera:' || json_array(c.camera_id, c.observed_at) FROM camera_detections c WHERE (c.id=NEW.id) AND c.source_submission_id IS NULL ON CONFLICT DO NOTHING;
END;
