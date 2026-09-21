// Read-only diagnostics for the public robotaxi registry (Phase 3E).
//
// Every query here is a plain SELECT. Nothing in this file writes, and nothing
// exposes it: there is no route, it is not imported by the router, and the
// worker/ directory is excluded from the static assets (.assetsignore). It
// exists so an operator can look at REAL data before rolling out the
// Phase 3E rules, and so the queries are tested rather than ad hoc.
//
// Why these matter: before Phase 3E, every registry vehicle a receipt created
// was 'public' by default. Receipts are not authenticated (forwarded email is
// not SPF/DKIM-verified; a pasted receipt has no sender at all), so an
// existing 'public' row is NOT evidence that anyone vetted it. Phase 3E only
// gates public visibility going forward and by counted rides; it does not
// touch existing rows. These reports show what exists so a human can decide
// what to take down (moderation) before or after rollout.
//
// Run against production by printing the SQL and pasting it into
// `wrangler d1 execute <db> --remote --command "<sql>"` — see
// docs/registry-preflight.md. Do not run any of it from application code.

import { RIDES_FROM, COUNTED_RIDES_WHERE } from './ride-status.js';
import { sqlNormalizedPlate } from './plate.js';

const norm = col => sqlNormalizedPlate(col);

// Trips backing a vehicle, by how they count. `v` is the robotaxi_vehicles alias.
const COUNTED = v => `(SELECT COUNT(*) FROM ${RIDES_FROM} WHERE t.robotaxi_vehicle_id = ${v}.id AND ${COUNTED_RIDES_WHERE})`;
const LIVE = v => `(SELECT COUNT(*) FROM trips t WHERE t.robotaxi_vehicle_id = ${v}.id AND t.superseded_by IS NULL)`;
const ALL = v => `(SELECT COUNT(*) FROM trips t WHERE t.robotaxi_vehicle_id = ${v}.id)`;

const APPROVED_UNLINKED_SIGHTINGS = `
  FROM vehicle_observations o
  JOIN submissions s ON s.id = o.submission_id
  WHERE o.robotaxi_vehicle_id IS NULL
    AND s.status = 'approved' AND s.submission_type = 'vehicle_sighting'
    AND o.verification_status = 'verified'
    AND ${norm('o.license_plate')} <> ''`;

export const REGISTRY_PREFLIGHT = [
  {
    id: 'duplicate_plates',
    title: 'Normalized plates shared by more than one registry vehicle',
    why: 'Public sighting matching refuses these plates; a human must decide which row is real. Nothing merges or deletes them automatically.',
    sql: `
SELECT plate_key AS normalized_plate, COUNT(*) AS vehicle_count,
       GROUP_CONCAT(id) AS vehicle_ids, GROUP_CONCAT(visibility) AS visibilities
FROM (SELECT id, visibility, ${norm('license_plate')} AS plate_key
      FROM robotaxi_vehicles WHERE license_plate IS NOT NULL)
WHERE plate_key <> ''
GROUP BY plate_key HAVING COUNT(*) > 1
ORDER BY vehicle_count DESC, plate_key`
  },
  {
    id: 'non_normalized_plates',
    title: 'Stored plates that are not already in normalized form (or are blank)',
    why: 'The SQL comparison only strips hyphens and spaces, so a row like "ABC.123" or "abc123" would not match the normalized lookup.',
    sql: `
SELECT id, license_plate, visibility
FROM robotaxi_vehicles
WHERE license_plate IS NULL OR license_plate = '' OR license_plate GLOB '*[^A-Z0-9]*'
ORDER BY id`
  },
  {
    id: 'public_vehicles',
    title: 'Every currently public vehicle, with how many rides back it',
    why: 'These are public by the OLD default, not by moderator approval. After rollout, rows with counted_rides > 0 stay publicly visible until a moderator makes them private — review this list first.',
    sql: `
SELECT v.id, v.license_plate, v.first_seen_at, v.last_seen_at,
       ${COUNTED('v')} AS counted_rides, ${LIVE('v')} AS live_rides, ${ALL('v')} AS all_trips
FROM robotaxi_vehicles v
WHERE v.visibility = 'public'
ORDER BY counted_rides DESC, v.last_seen_at DESC`
  },
  {
    id: 'public_zero_counted_rides',
    title: 'Public vehicles with no counted, non-superseded ride',
    why: 'These stop being publicly retrievable under Phase 3E (they return 404) but are not deleted.',
    sql: `
SELECT v.id, v.license_plate, ${LIVE('v')} AS live_rides, ${ALL('v')} AS all_trips
FROM robotaxi_vehicles v
WHERE v.visibility = 'public' AND ${COUNTED('v')} = 0
ORDER BY v.last_seen_at DESC`
  },
  {
    id: 'public_review_or_rejected_only',
    title: 'Public vehicles whose only live rides are needs_review or rejected',
    why: 'A receipt the classifier would not vouch for still created the vehicle. Breakdown by submission status.',
    sql: `
SELECT v.id, v.license_plate,
       (SELECT COUNT(*) FROM ${RIDES_FROM} WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status = 'needs_review') AS needs_review_rides,
       (SELECT COUNT(*) FROM ${RIDES_FROM} WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status = 'rejected') AS rejected_rides
FROM robotaxi_vehicles v
WHERE v.visibility = 'public' AND ${COUNTED('v')} = 0 AND ${LIVE('v')} > 0
ORDER BY v.last_seen_at DESC`
  },
  {
    id: 'public_orphaned',
    title: 'Public vehicles with no trip rows at all (e.g. the rider deleted the trip)',
    why: 'Deleting a trip never deleted its vehicle; these have nothing behind them.',
    sql: `
SELECT v.id, v.license_plate, v.first_seen_at, v.last_seen_at
FROM robotaxi_vehicles v
WHERE v.visibility = 'public' AND ${ALL('v')} = 0
ORDER BY v.first_seen_at`
  },
  {
    id: 'ambiguous_sighting_matches',
    title: 'Approved, unlinked sightings whose plate matches 2+ registry vehicles',
    why: 'These are exactly the sightings the Phase 3E fallback refuses to show on any vehicle.',
    sql: `
SELECT ${norm('o.license_plate')} AS normalized_plate, COUNT(DISTINCT o.id) AS sightings,
       m.vehicle_count, m.vehicle_ids
${APPROVED_UNLINKED_SIGHTINGS.replace('WHERE', `JOIN (SELECT ${norm('license_plate')} AS plate_key, COUNT(*) AS vehicle_count, GROUP_CONCAT(id) AS vehicle_ids
                  FROM robotaxi_vehicles GROUP BY plate_key) m ON m.plate_key = ${norm('o.license_plate')}
  WHERE m.vehicle_count > 1 AND`)}
GROUP BY normalized_plate, m.vehicle_count, m.vehicle_ids
ORDER BY sightings DESC`
  },
  {
    id: 'unlinked_sightings_matching_one_vehicle',
    title: 'Approved, unlinked sightings whose plate matches exactly one registry vehicle',
    why: 'These would appear on that vehicle at read time IF it is publicly eligible (public + a counted ride). Shows current visibility and counted rides.',
    sql: `
SELECT ${norm('o.license_plate')} AS normalized_plate, COUNT(DISTINCT o.id) AS sightings,
       m.vehicle_id, m.visibility, m.counted_rides
${APPROVED_UNLINKED_SIGHTINGS.replace('WHERE', `JOIN (SELECT ${norm('v.license_plate')} AS plate_key, COUNT(*) AS vehicle_count, MIN(v.id) AS vehicle_id,
                         MIN(v.visibility) AS visibility, SUM(${COUNTED('v')}) AS counted_rides
                  FROM robotaxi_vehicles v GROUP BY plate_key) m ON m.plate_key = ${norm('o.license_plate')}
  WHERE m.vehicle_count = 1 AND`)}
GROUP BY normalized_plate, m.vehicle_id, m.visibility, m.counted_rides
ORDER BY sightings DESC`
  }
];

// Convenience for tests and local diagnostics only: runs every report against
// a D1-shaped handle and returns { id: rows }. Read-only by construction.
export async function runRegistryPreflight(sql) {
  const out = {};
  for (const q of REGISTRY_PREFLIGHT) {
    const result = await sql.prepare(q.sql).all();
    out[q.id] = result.results || [];
  }
  return out;
}
