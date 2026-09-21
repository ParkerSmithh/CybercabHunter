-- Cybercab Hunter — registry vehicle review history (Phase 3H).
--
-- Until now nothing recorded WHO made a registry vehicle public or private, or
-- when: robotaxi_vehicles.updated_at only says that "something changed". This
-- adds an append-only history so a moderator's decision, and the facts it was
-- made on, can always be looked up later.
--
-- Additive and non-destructive: one new table and two indexes. No existing
-- table, column, or row is touched, and nothing is backfilled — the earlier
-- legacy cleanup (a bulk visibility change made by the operator, not by a
-- moderator) is deliberately NOT represented as a review.
--
-- Design notes:
--  * Append-only BY CONVENTION: the application only ever INSERTs into this
--    table (a test asserts the source never issues an UPDATE or DELETE
--    against it). SQLite triggers could enforce it in the database too, but
--    multi-statement triggers are a known rough edge of D1 migrations, so that
--    hardening is left as a separate, deliberate step.
--  * There are intentionally NO foreign keys. A history row must survive the
--    later deletion of the vehicle (e.g. resolving a duplicate plate) or of a
--    user, so the ids and a snapshot of the plate are stored as plain values.
--  * action is exactly what the moderator did: 'approved_public' (made a
--    vehicle publicly visible) or 'returned_private' (took it out of public
--    view). It does NOT assert anything about Tesla or about a receipt's origin.
--  * counted_ride_count / plate_vehicle_count are the facts as they stood at
--    the moment of the decision (how many counted rides backed the vehicle,
--    and how many registry rows shared its normalized plate), so a later
--    audit can see what the moderator was looking at.
CREATE TABLE robotaxi_vehicle_reviews (
  id TEXT PRIMARY KEY,
  robotaxi_vehicle_id TEXT NOT NULL,
  license_plate TEXT,
  moderator_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved_public', 'returned_private')),
  previous_visibility TEXT NOT NULL,
  reason TEXT,
  counted_ride_count INTEGER NOT NULL,
  plate_vehicle_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_robotaxi_vehicle_reviews_vehicle ON robotaxi_vehicle_reviews(robotaxi_vehicle_id, created_at);
CREATE INDEX idx_robotaxi_vehicle_reviews_moderator ON robotaxi_vehicle_reviews(moderator_user_id);
