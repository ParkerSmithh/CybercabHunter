// THE definition of which rides count toward a rider's statistics. Every
// statistic and the ride-history list are built from these fragments, so
// there is exactly one place to change the rule.
//
// Trust model:
//  - 'pending' / 'approved' submissions COUNT. A receipt the classifier
//    accepted starts as 'pending' (accepted, awaiting optional moderation);
//    a moderator approving it makes it 'approved'.
//  - 'needs_review' rides are kept and shown in ride history, clearly
//    labelled, but are NOT counted — they hold a partial or ambiguous
//    receipt that the classifier would not vouch for. Re-sending a clearer
//    copy of the same ride upgrades it (see ride-ingest.js).
//  - 'rejected' rides never count.
//  - A trip marked superseded_by is a legacy duplicate of another trip and
//    never counts and never appears.
//
// Nothing here is stored as a counter; statistics are always computed live.

export const COUNTED_SUBMISSION_STATUSES = ['pending', 'approved'];

// `trips t` joined to its submission `s`. Alias names are part of the
// contract: callers write `t.` / `s.` columns against these fragments.
export const RIDES_FROM = 'trips t JOIN submissions s ON s.id = t.submission_id';

// Rides that exist as the rider's history (everything except superseded duplicates).
export const LIVE_RIDES_WHERE = 't.superseded_by IS NULL';

// Rides that count toward statistics.
export const COUNTED_RIDES_WHERE =
  `t.superseded_by IS NULL AND s.status IN (${COUNTED_SUBMISSION_STATUSES.map(s => `'${s}'`).join(', ')})`;

// What the UI is told about a single ride, derived from its submission status.
export function rideReviewState(submissionStatus) {
  if (COUNTED_SUBMISSION_STATUSES.includes(submissionStatus)) return 'counted';
  if (submissionStatus === 'rejected') return 'rejected';
  return 'under_review';
}

// THE definition of "at least one counted, non-superseded ride exists for
// this vehicle" — reused everywhere a caller needs to know a vehicle has ride
// activity backing it (public eligibility below, the moderator approval
// guard in worker/db.js). Lives here rather than in worker/db.js so
// worker/db-rides.js can reuse the exact same predicate too, without a
// circular import (worker/db.js already imports worker/db-rides.js).
// `alias` is the robotaxi_vehicles alias in the caller's query; the inner
// t/s aliases come from RIDES_FROM and deliberately shadow any outer ones.
export function countedRideExistsSql(alias) {
  return `EXISTS (
    SELECT 1 FROM ${RIDES_FROM}
    WHERE t.robotaxi_vehicle_id = ${alias}.id AND ${COUNTED_RIDES_WHERE}
  )`;
}

// THE definition of what backs a registry vehicle. A receipt-origin vehicle
// (every vehicle created by the receipt pipeline) needs a counted ride. A
// sighting-origin vehicle — added by a moderator from a reviewed sighting —
// has no ride by construction, so a moderator-entered VIN stands in for it:
// the VIN is only ever written by a moderator, only while the vehicle is
// private, and is never overwritten (worker/moderation.js).
export function registryEvidenceSql(alias) {
  return `(${countedRideExistsSql(alias)}
    OR (${alias}.origin = 'sighting' AND ${alias}.vin IS NOT NULL AND ${alias}.vin <> ''))`;
}

// THE definition of public eligibility: a moderator has made the vehicle
// public AND it is backed (registryEvidenceSql above — for a receipt vehicle,
// at least one counted, non-superseded ride). Every public-facing surface
// (the registry list/detail pages, the homepage stats, and any other caller)
// must reuse this exact function — never a hand-derived equivalent — so
// eligibility can't quietly drift into a second, weaker definition.
export function publicVehicleEligibleSql(alias) {
  return `${alias}.visibility = 'public' AND ${registryEvidenceSql(alias)}`;
}
