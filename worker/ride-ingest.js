// The one place a canonical ride (worker/ride-canonical.js) is persisted.
// Every ride source — forwarded email, pasted receipt, .eml import, and any
// future source — ends here, so identity, deduplication, revision and the
// review-status rules can only ever be implemented once.
//
// Decision order for an incoming ride:
//   1. Classified 'rejected'       -> recorded in the audit log, no ride created.
//   2. No usable ride identity     -> recorded for review, NO ride created. A
//      receipt without a readable date and pickup time cannot be matched to
//      any other receipt of the same ride, so storing it as a ride would let
//      a later, parseable copy count the same ride twice.
//   3. Same message / same content -> duplicate. Nothing changes.
//   4. Same ride identity (ride_key, or date+pickup time with a compatible
//      plate) -> the EXISTING ride is updated in place, subject to the
//      ordering rule below, otherwise it is a duplicate. The ride is never
//      counted twice.
//   5. Otherwise                   -> a new ride is created.
//
// ORDERING RULE. A value already stored is only replaced by a receipt that
// is CONFIDENTLY newer: both the stored ride and the incoming receipt carry a
// send time (worker/receipt-ordering.js) and the incoming one is strictly
// later. Older, equal, or unknowable means the stored value is kept — so
// neither an updated-before-original arrival nor an older copy re-forwarded
// after a correction can revert a fare, whatever the copy's hash or
// formatting. Absent values are still filled in (nothing is being
// overwritten), and every replaced value is snapshotted in trip_revisions.

import { db } from './db.js';
import { rideKeysCompatible } from './ride-canonical.js';
import { isConfidentlyNewer } from './receipt-ordering.js';

function newId() {
  return crypto.randomUUID();
}

// Columns a corrected receipt may OVERWRITE (a new value replaces the old
// one and counts as a revision). A null in the incoming ride never wipes an
// existing value — absence in a receipt is not a correction.
const OVERWRITE_FIELDS = [
  ['fareAmountCents', 'fare_amount_cents'],
  ['distance', 'distance'],
  ['durationMinutes', 'duration_minutes'],
  ['serviceArea', 'service_area'],
  ['dropoffTime', 'dropoff_time'],
  ['externalRideId', 'external_ride_id']
];

// Columns only FILLED when the stored ride doesn't have them yet. Address
// text is filled but never overwritten: two copies of the same receipt can
// differ in how a forwarding client mangled an address, and that is not a
// correction.
const FILL_ONLY_FIELDS = [
  ['pickupDescription', 'pickup_description'],
  ['dropoffDescription', 'dropoff_description'],
  ['startedAtUtc', 'started_at_utc'],
  ['timezone', 'timezone'],
  ['timezoneSource', 'timezone_source']
];

const isPresent = v => v !== null && v !== undefined;
const isAbsent = v => !isPresent(v);

async function findExistingRide(sql, userId, ride) {
  if (!ride.rideKey) return null;
  const exact = await db.findTripByRideKey(sql, userId, ride.rideKey);
  if (exact) return exact;
  const candidates = await db.findTripCandidatesByTime(sql, userId, ride.rideDate, ride.pickupTime);
  return candidates.find(c => rideKeysCompatible(c.ride_key, ride.rideKey)) || null;
}

function submissionStatusFor(review) {
  return review.status === 'accepted' ? 'pending' : 'needs_review';
}

async function logIngestion(sql, ctx, ride, fields) {
  await db.createReceiptIngestion(sql, {
    id: newId(),
    userId: ctx.userId,
    messageId: ride.messageId,
    receiptHash: ride.receiptHash,
    parserVersion: ride.parserVersion,
    syncRunId: ctx.syncRunId || null,
    ...fields
  });
}

async function applyToExistingRide(sql, ctx, ride, existing) {
  const changes = {};
  const newer = isConfidentlyNewer(ride.receiptSentAt, existing.receipt_sent_at);
  let heldBack = false;   // the receipt disagreed with a stored value that was kept
  let replaced = false;   // a stored value was actually replaced

  for (const [key, column] of OVERWRITE_FIELDS) {
    if (isAbsent(ride[key]) || ride[key] === existing[column]) continue;
    if (isAbsent(existing[column])) changes[column] = ride[key];          // filling a gap
    else if (newer) { changes[column] = ride[key]; replaced = true; }     // confident correction
    else heldBack = true;                                                 // cannot be shown newer
  }
  for (const [key, column] of FILL_ONLY_FIELDS) {
    if (isPresent(ride[key]) && !isPresent(existing[column])) changes[column] = ride[key];
  }

  // A changed fare carries its currency provenance with it; a changed
  // duration carries whether it was derived.
  if (changes.fare_amount_cents !== undefined) {
    changes.currency = ride.currency;
    changes.currency_source = ride.currencySource;
  }
  if (changes.duration_minutes !== undefined) {
    changes.duration_minutes_derived = ride.durationDerived ? 1 : 0;
  }

  // The corrected receipt names the vehicle and the stored ride has none.
  if (!existing.robotaxi_vehicle_id && ride.licensePlate) {
    changes.robotaxi_vehicle_id = await db.findOrCreateRobotaxiVehicleByPlate(sql, ride.licensePlate);
  }
  // The identity gained a plate it didn't have.
  if (ride.rideKey && ride.rideKey !== existing.ride_key && ride.licensePlate) {
    const stored = existing.ride_key || '';
    if (stored.endsWith('|')) changes.ride_key = ride.rideKey;
  }

  const isRevision = Object.keys(changes).length > 0;
  if (isRevision) {
    // The ride now holds values from this receipt only when it replaced
    // something; a pure gap-fill leaves the ride's "as of" time alone.
    if (replaced) changes.receipt_sent_at = ride.receiptSentAt;
    // The stored hash/message id describe the receipt the values came from;
    // if part of this receipt was held back, they still do.
    if (!heldBack) {
      changes.receipt_hash = ride.receiptHash;
      changes.source_message_id = ride.messageId;
    }
    await db.reviseTrip(sql, existing, changes);
  }

  // A clearer copy can lift a ride out of review — never the reverse, and
  // never over a human moderation decision.
  let statusUpgraded = false;
  if (existing.submission_status === 'needs_review' && ride.review.status === 'accepted') {
    await db.setSubmissionStatus(sql, existing.submission_id, 'pending');
    statusUpgraded = true;
  }

  const outcome = isRevision || statusUpgraded ? 'updated' : 'duplicate';
  await logIngestion(sql, ctx, ride, {
    status: outcome === 'duplicate' ? 'duplicate' : ride.review.status === 'accepted' ? 'accepted' : 'needs_review',
    outcome,
    errorCode: heldBack ? 'kept_existing_values' : null,
    submissionId: existing.submission_id,
    tripId: existing.id
  });
  return {
    outcome,
    tripId: existing.id,
    submissionId: existing.submission_id,
    reviewStatus: statusUpgraded ? 'accepted' : ride.review.status,
    // Set when this receipt disagreed with the ride but could not be shown
    // to be newer, so the stored values were kept.
    reason: heldBack ? 'kept_existing_values' : undefined
  };
}

// ctx: { userId, syncRunId, evidenceType, storeEvidence?: async () => evidenceRef }
// storeEvidence runs only when a NEW ride is actually created, so a
// duplicate never leaves an orphaned attachment behind.
export async function ingestRide(env, ride, ctx) {
  const sql = env.cybercabhunter_db;
  const userId = ctx.userId;

  if (ride.review.status === 'rejected') {
    await logIngestion(sql, ctx, ride, { status: 'rejected', outcome: 'rejected', errorCode: ride.review.reason });
    return { outcome: 'rejected', reviewStatus: 'rejected', reason: ride.review.reason };
  }

  // Without a readable date AND pickup time there is no stable identity: the
  // receipt is logged for review but never becomes a ride (see header).
  if (ride.identityIssue) {
    await logIngestion(sql, ctx, ride, { status: 'needs_review', outcome: 'unidentified', errorCode: ride.identityIssue });
    return { outcome: 'unidentified', reviewStatus: 'needs_review', reason: 'missing_ride_identity', identityIssue: ride.identityIssue };
  }

  // Exact same delivery (a retried SMTP message) or exact same content.
  const priorByMessage = ride.messageId ? await db.findIngestionByMessageId(sql, userId, ride.messageId) : null;
  const prior = priorByMessage || await db.findIngestionByHash(sql, userId, ride.receiptHash);
  if (prior) {
    await logIngestion(sql, ctx, ride, {
      status: 'duplicate', outcome: 'duplicate', submissionId: prior.submission_id, tripId: prior.trip_id
    });
    return { outcome: 'duplicate', tripId: prior.trip_id, submissionId: prior.submission_id, reviewStatus: ride.review.status };
  }

  // Same ride, different receipt content (e.g. an updated receipt).
  const existing = await findExistingRide(sql, userId, ride);
  if (existing) return applyToExistingRide(sql, ctx, ride, existing);

  const vehicleId = ride.licensePlate ? await db.findOrCreateRobotaxiVehicleByPlate(sql, ride.licensePlate) : null;
  const evidenceRef = ctx.storeEvidence ? await ctx.storeEvidence() : null;
  const submissionId = newId();
  const tripId = newId();

  try {
    await db.createRideRecords(sql, {
      submissionId, tripId, userId,
      evidenceType: ctx.evidenceType,
      evidenceRef,
      submissionStatus: submissionStatusFor(ride.review),
      ride,
      robotaxiVehicleId: vehicleId
    });
  } catch (err) {
    // Two deliveries of the same ride racing each other: the unique index on
    // (user_id, ride_key) lets exactly one win. The loser becomes an update of
    // (or duplicate of) the winner instead of failing.
    if (String((err && err.message) || '').includes('UNIQUE')) {
      const winner = await findExistingRide(sql, userId, ride);
      if (winner) return applyToExistingRide(sql, ctx, ride, winner);
    }
    throw err;
  }

  await logIngestion(sql, ctx, ride, {
    status: ride.review.status === 'accepted' ? 'accepted' : 'needs_review',
    outcome: 'created', submissionId, tripId
  });
  return { outcome: 'created', tripId, submissionId, reviewStatus: ride.review.status };
}
