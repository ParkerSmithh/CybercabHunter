// D1 queries for the canonical ride system: ingestion bookkeeping, trip
// create/update/revision, ride history, delete, and every rider statistic.
// Merged into the `db` object exported from worker/db.js.
//
// Rules this file holds to:
//  - Every query that touches a user's rides is scoped by a bound user_id
//    supplied by the caller (resolved from the session), never by request input.
//  - Every statistic reads through COUNTED_RIDES_WHERE (worker/ride-status.js)
//    — one definition of "which rides count".
//  - NULL is preserved. SUM/AVG/MAX over a column that is null for every ride
//    is NULL, not 0, and coverage counts say how many rides fed each figure.

import { RIDES_FROM, LIVE_RIDES_WHERE, COUNTED_RIDES_WHERE, rideReviewState } from './ride-status.js';

function newId() {
  return crypto.randomUUID();
}

// ---- Receipt-sync runs and ingestion bookkeeping ----

async function createSyncRun(sql, { id, userId, source }) {
  await sql.prepare(
    `INSERT INTO ride_sync_runs (id, user_id, source) VALUES (?, ?, ?)`
  ).bind(id, userId, source).run();
}

async function finishSyncRun(sql, id, { status, seen, created, updated, duplicates, review, rejected, errors, errorCode }) {
  await sql.prepare(`
    UPDATE ride_sync_runs SET
      finished_at = datetime('now'), status = ?,
      seen_count = ?, created_count = ?, updated_count = ?, duplicate_count = ?,
      review_count = ?, rejected_count = ?, error_count = ?, error_code = ?
    WHERE id = ?
  `).bind(status, seen, created, updated, duplicates, review, rejected, errors, errorCode || null, id).run();
}

// Only a PRIOR ingestion whose trip STILL EXISTS counts as "already
// processed" — a rejected/parse_error row must never itself count as a
// duplicate (a genuine retry would be swallowed), and after a rider deletes
// their rides the same receipt must be able to come back in. Scoped to the
// user: two riders can hold receipts with identical content.
async function findIngestionByMessageId(sql, userId, messageId) {
  return sql.prepare(`
    SELECT ri.submission_id, ri.trip_id, ri.receipt_hash, ri.parser_version
    FROM receipt_ingestions ri JOIN trips t ON t.id = ri.trip_id
    WHERE ri.user_id = ? AND ri.message_id = ? AND ri.status IN ('accepted', 'needs_review')
    ORDER BY ri.created_at DESC LIMIT 1
  `).bind(userId, messageId).first();
}

async function findIngestionByHash(sql, userId, receiptHash) {
  return sql.prepare(`
    SELECT ri.submission_id, ri.trip_id
    FROM receipt_ingestions ri JOIN trips t ON t.id = ri.trip_id
    WHERE ri.user_id = ? AND ri.receipt_hash = ? AND ri.status IN ('accepted', 'needs_review')
    ORDER BY ri.created_at DESC LIMIT 1
  `).bind(userId, receiptHash).first();
}

async function createReceiptIngestion(sql, {
  id, userId, messageId, receiptHash, parserVersion, status,
  errorCode, errorMessage, submissionId, tripId, outcome, syncRunId
}) {
  await sql.prepare(`
    INSERT INTO receipt_ingestions
      (id, user_id, message_id, receipt_hash, parser_version, status, error_code, error_message,
       submission_id, trip_id, outcome, sync_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, userId, messageId || null, receiptHash || null, parserVersion || null,
    status, errorCode || null, errorMessage || null, submissionId || null, tripId || null,
    outcome || null, syncRunId || null
  ).run();
}

async function saveForwardingCode(sql, userId, code) {
  await sql.prepare(`
    UPDATE receipt_ingestion_addresses
    SET forwarding_code = ?, forwarding_code_received_at = datetime('now')
    WHERE user_id = ? AND status = 'active'
  `).bind(code, userId).run();
}

// A real receipt has arrived, so forwarding demonstrably works and the
// one-time confirmation code is no longer needed.
async function markReceiptReceived(sql, userId) {
  await sql.prepare(`
    UPDATE receipt_ingestion_addresses
    SET last_received_at = datetime('now'), forwarding_code = NULL, forwarding_code_received_at = NULL
    WHERE user_id = ?
  `).bind(userId).run();
}

// ---- Trips: identity lookup, create, revise ----

async function findTripByRideKey(sql, userId, rideKey) {
  return sql.prepare(`
    SELECT t.*, s.status AS submission_status
    FROM ${RIDES_FROM}
    WHERE t.user_id = ? AND t.ride_key = ? AND t.superseded_by IS NULL
    LIMIT 1
  `).bind(userId, rideKey).first();
}

// Same user, date and pickup time — candidates whose plate may be missing
// on one side; the caller decides compatibility from the ride_key.
async function findTripCandidatesByTime(sql, userId, rideDate, pickupTime) {
  const result = await sql.prepare(`
    SELECT t.*, s.status AS submission_status
    FROM ${RIDES_FROM}
    WHERE t.user_id = ? AND t.ride_date = ? AND t.pickup_time = ? AND t.superseded_by IS NULL
    ORDER BY t.created_at ASC
  `).bind(userId, rideDate, pickupTime).all();
  return result.results || [];
}

// Submission + trip written together in one atomic batch.
async function createRideRecords(sql, { submissionId, tripId, userId, evidenceType, evidenceRef, submissionStatus, ride, robotaxiVehicleId }) {
  const submissionStmt = sql.prepare(`
    INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at)
    VALUES (?, ?, 'ride_receipt', ?, ?, ?, datetime('now'))
  `).bind(submissionId, userId, submissionStatus, evidenceType, evidenceRef || null);

  const tripStmt = sql.prepare(`
    INSERT INTO trips
      (id, submission_id, user_id, provider, service_area, ride_date, distance, distance_unit,
       fare_amount_cents, currency, currency_source, external_ride_id, robotaxi_vehicle_id,
       source, source_message_id, receipt_hash, pickup_description, dropoff_description,
       pickup_time, dropoff_time, duration_minutes, duration_minutes_derived, ride_key, revision,
       started_at_utc, timezone, timezone_source, receipt_sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).bind(
    tripId, submissionId, userId, ride.provider, ride.serviceArea, ride.rideDate, ride.distance, ride.distanceUnit,
    ride.fareAmountCents, ride.currency, ride.currencySource, ride.externalRideId, robotaxiVehicleId || null,
    ride.source, ride.messageId, ride.receiptHash, ride.pickupDescription, ride.dropoffDescription,
    ride.pickupTime, ride.dropoffTime, ride.durationMinutes, ride.durationDerived ? 1 : 0, ride.rideKey,
    ride.startedAtUtc, ride.timezone, ride.timezoneSource, ride.receiptSentAt
  );

  await sql.batch([submissionStmt, tripStmt]);
}

// Only these columns can be changed by a corrected receipt. Column names
// come from this list, never from request input.
const REVISABLE_COLUMNS = new Set([
  'service_area', 'distance', 'fare_amount_cents', 'currency', 'currency_source',
  'external_ride_id', 'robotaxi_vehicle_id', 'pickup_description', 'dropoff_description',
  'dropoff_time', 'duration_minutes', 'duration_minutes_derived', 'started_at_utc',
  'timezone', 'timezone_source', 'ride_key', 'receipt_hash', 'source_message_id', 'receipt_sent_at'
]);

// Applies a corrected receipt to an EXISTING trip in place — the ride is
// never duplicated. What the revision replaces is snapshotted into
// trip_revisions first, in the same atomic batch as the update.
async function reviseTrip(sql, existing, changes) {
  const columns = Object.keys(changes).filter(c => REVISABLE_COLUMNS.has(c));
  if (columns.length === 0) return;

  const snapshotStmt = sql.prepare(`
    INSERT INTO trip_revisions
      (id, trip_id, revision, receipt_hash, fare_amount_cents, currency, currency_source, distance, duration_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    newId(), existing.id, existing.revision, existing.receipt_hash,
    existing.fare_amount_cents, existing.currency, existing.currency_source,
    existing.distance, existing.duration_minutes
  );

  const setClause = columns.map(c => `${c} = ?`).join(', ');
  const updateStmt = sql.prepare(`
    UPDATE trips SET ${setClause}, revision = revision + 1, updated_at = datetime('now') WHERE id = ?
  `).bind(...columns.map(c => changes[c] ?? null), existing.id);

  await sql.batch([snapshotStmt, updateStmt]);
}

async function setSubmissionStatus(sql, submissionId, status) {
  await sql.prepare(
    `UPDATE submissions SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(status, submissionId).run();
}

// ---- Ride history (private, one rider's own rides) ----

// A revision bump can come from filling in a previously-missing field
// (started_at_utc, a plate-key upgrade, ...) as easily as from an actual
// correction to what the ride cost or how far/long it was. Riders should
// only see "Corrected" for the latter. trip_revisions already snapshots the
// fare/currency/distance/duration a trip held at each past revision (see
// reviseTrip above), so the substantive history of a trip is exactly the
// chain of those snapshots followed by its current values — no new storage
// needed. A trip is "corrected" only if some step in that chain replaced a
// non-null value with a different non-null value: a null -> value fill-in
// never counts, matching what reviseTrip already guarantees (a column is
// only ever touched, and thus only ever snapshotted differently, when the
// incoming receipt actually supplied a new value for it).
const SUBSTANTIVE_REVISION_FIELDS = ['fare_amount_cents', 'currency', 'distance', 'duration_minutes'];

function hasSubstantiveCorrection(trip, orderedSnapshots) {
  if (trip.revision <= 1) return false;
  const chain = [...orderedSnapshots, trip];
  for (let i = 1; i < chain.length; i++) {
    for (const field of SUBSTANTIVE_REVISION_FIELDS) {
      const was = chain[i - 1][field], now = chain[i][field];
      if (was != null && now != null && was !== now) return true;
    }
  }
  return false;
}

async function loadRevisionSnapshotsByTrip(sql, tripIds) {
  const byTrip = new Map();
  if (!tripIds.length) return byTrip;
  const placeholders = tripIds.map(() => '?').join(',');
  const result = await sql.prepare(`
    SELECT trip_id, revision, fare_amount_cents, currency, distance, duration_minutes
    FROM trip_revisions WHERE trip_id IN (${placeholders})
    ORDER BY trip_id, revision ASC
  `).bind(...tripIds).all();
  for (const row of (result.results || [])) {
    if (!byTrip.has(row.trip_id)) byTrip.set(row.trip_id, []);
    byTrip.get(row.trip_id).push(row);
  }
  return byTrip;
}

// The whitelist of what ride history can ever expose. Deliberately absent:
// pickup/dropoff addresses, pickup/dropoff times, payment details,
// passenger name, receipt hashes, message ids, raw receipt content.
async function getTripsPage(sql, userId, { limit, offset }) {
  const [rows, total] = await sql.batch([
    sql.prepare(`
      SELECT t.id, t.ride_date, t.service_area, t.distance, t.distance_unit,
             t.duration_minutes, t.duration_minutes_derived,
             t.fare_amount_cents, t.currency, t.currency_source,
             t.source, t.revision, s.status AS submission_status,
             v.license_plate AS vehicle_plate
      FROM ${RIDES_FROM}
      LEFT JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
      WHERE t.user_id = ? AND ${LIVE_RIDES_WHERE}
      ORDER BY (t.ride_date IS NULL), t.ride_date DESC,
               (t.pickup_time IS NULL), t.pickup_time DESC,
               t.created_at DESC, t.rowid DESC
      LIMIT ? OFFSET ?
    `).bind(userId, limit, offset),
    sql.prepare(`
      SELECT COUNT(*) AS n FROM ${RIDES_FROM} WHERE t.user_id = ? AND ${LIVE_RIDES_WHERE}
    `).bind(userId)
  ]);

  const tripRows = rows.results || [];
  const revisedTripIds = tripRows.filter(r => r.revision > 1).map(r => r.id);
  const snapshotsByTrip = await loadRevisionSnapshotsByTrip(sql, revisedTripIds);

  return {
    trips: tripRows.map(r => ({
      id: r.id,
      ride_date: r.ride_date,
      city: r.service_area,
      distance: r.distance,
      distance_unit: r.distance_unit,
      duration_minutes: r.duration_minutes,
      duration_derived: !!r.duration_minutes_derived,
      fare_amount_cents: r.fare_amount_cents,
      currency: r.currency,
      currency_source: r.currency_source,
      vehicle_plate: r.vehicle_plate,
      source: r.source,
      revision: r.revision,
      corrected: hasSubstantiveCorrection(r, snapshotsByTrip.get(r.id) || []),
      status: rideReviewState(r.submission_status)
    })),
    total: total.results?.[0]?.n ?? 0
  };
}

// ---- Deleting a rider's rides ----
//
// Removes ONLY rider-private data: their trips (with revisions), the
// receipt submissions that back them, their ingestion audit rows, and
// sync-run bookkeeping. robotaxi_vehicles (the public, ownerless registry)
// and vehicle sightings are never touched — a vehicle stays known even
// after the rider who first logged it deletes their history.
//
// Superseded duplicates are deleted before the trips they point at,
// because superseded_by is ON DELETE SET NULL and re-activating a
// duplicate mid-delete would collide with the ride_key unique index.

async function getRideEvidenceRefs(sql, userId, tripId) {
  const stmt = tripId
    ? sql.prepare(`
        SELECT s.evidence_ref FROM ${RIDES_FROM}
        WHERE t.user_id = ? AND (t.id = ? OR t.superseded_by = ?) AND s.evidence_ref IS NOT NULL
      `).bind(userId, tripId, tripId)
    : sql.prepare(`
        SELECT evidence_ref FROM submissions
        WHERE user_id = ? AND submission_type = 'ride_receipt' AND evidence_ref IS NOT NULL
      `).bind(userId);
  const result = await stmt.all();
  return (result.results || []).map(r => r.evidence_ref);
}

async function deleteAllRidesForUser(sql, userId) {
  const evidenceRefs = await getRideEvidenceRefs(sql, userId, null);
  const count = await sql.prepare(`SELECT COUNT(*) AS n FROM trips WHERE user_id = ?`).bind(userId).first();

  await sql.batch([
    sql.prepare(`DELETE FROM receipt_ingestions WHERE user_id = ?`).bind(userId),
    sql.prepare(`DELETE FROM trips WHERE user_id = ? AND superseded_by IS NOT NULL`).bind(userId),
    sql.prepare(`DELETE FROM trips WHERE user_id = ?`).bind(userId),
    sql.prepare(`DELETE FROM submissions WHERE user_id = ? AND submission_type = 'ride_receipt'`).bind(userId),
    sql.prepare(`DELETE FROM ride_sync_runs WHERE user_id = ?`).bind(userId)
  ]);
  return { deleted: count ? count.n : 0, evidenceRefs };
}

async function deleteRideForUser(sql, userId, tripId) {
  const trip = await sql.prepare(
    `SELECT id, submission_id FROM trips WHERE id = ? AND user_id = ?`
  ).bind(tripId, userId).first();
  if (!trip) return null;

  const evidenceRefs = await getRideEvidenceRefs(sql, userId, tripId);
  const dupes = await sql.prepare(
    `SELECT id, submission_id FROM trips WHERE superseded_by = ? AND user_id = ?`
  ).bind(tripId, userId).all();
  const dupeRows = dupes.results || [];
  const submissionIds = [trip.submission_id, ...dupeRows.map(d => d.submission_id)];

  const statements = [
    sql.prepare(`DELETE FROM receipt_ingestions WHERE user_id = ? AND (trip_id = ? OR submission_id = ?)`).bind(userId, tripId, trip.submission_id)
  ];
  for (const d of dupeRows) statements.push(sql.prepare(`DELETE FROM trips WHERE id = ? AND user_id = ?`).bind(d.id, userId));
  statements.push(sql.prepare(`DELETE FROM trips WHERE id = ? AND user_id = ?`).bind(tripId, userId));
  for (const sid of submissionIds) {
    statements.push(sql.prepare(`DELETE FROM submissions WHERE id = ? AND user_id = ? AND submission_type = 'ride_receipt'`).bind(sid, userId));
  }
  await sql.batch(statements);
  return { deleted: 1 + dupeRows.length, evidenceRefs };
}

// ---- Receipt-sync status ----

async function getSyncStatus(sql, userId) {
  const [address, totals, lastRun, lastReceived, review, unidentified] = await sql.batch([
    sql.prepare(`
      SELECT opaque_token, created_at, last_received_at, forwarding_code, forwarding_code_received_at
      FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'
    `).bind(userId),
    sql.prepare(`
      SELECT COUNT(*) AS runs,
             COALESCE(SUM(seen_count), 0) AS seen, COALESCE(SUM(created_count), 0) AS created,
             COALESCE(SUM(updated_count), 0) AS updated, COALESCE(SUM(duplicate_count), 0) AS duplicates,
             COALESCE(SUM(review_count), 0) AS review, COALESCE(SUM(rejected_count), 0) AS rejected,
             COALESCE(SUM(error_count), 0) AS errors,
             COALESCE(SUM(CASE WHEN source = 'receipt_email' THEN created_count ELSE 0 END), 0) AS email_created,
             COALESCE(SUM(CASE WHEN source = 'receipt_import' THEN created_count ELSE 0 END), 0) AS import_created,
             COALESCE(SUM(CASE WHEN source = 'receipt_email' THEN created_count + updated_count + duplicate_count ELSE 0 END), 0) AS email_receipts
      FROM ride_sync_runs WHERE user_id = ?
    `).bind(userId),
    sql.prepare(`
      SELECT source, started_at, finished_at, status, seen_count, created_count, updated_count,
             duplicate_count, review_count, rejected_count, error_count, error_code
      FROM ride_sync_runs WHERE user_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).bind(userId),
    sql.prepare(`
      SELECT MAX(finished_at) AS at FROM ride_sync_runs
      WHERE user_id = ? AND (created_count + updated_count) > 0
    `).bind(userId),
    sql.prepare(`
      SELECT COUNT(*) AS n FROM ${RIDES_FROM}
      WHERE t.user_id = ? AND ${LIVE_RIDES_WHERE} AND s.status = 'needs_review'
    `).bind(userId),
    sql.prepare(`
      SELECT COUNT(DISTINCT COALESCE(receipt_hash, id)) AS n FROM receipt_ingestions
      WHERE user_id = ? AND outcome = 'unidentified'
    `).bind(userId)
  ]);

  return {
    address: address.results?.[0] || null,
    totals: totals.results?.[0] || null,
    lastRun: lastRun.results?.[0] || null,
    lastRideReceivedAt: lastReceived.results?.[0]?.at || null,
    underReview: review.results?.[0]?.n ?? 0,
    unidentified: unidentified.results?.[0]?.n ?? 0
  };
}

// ---- Rider statistics — all live, all through COUNTED_RIDES_WHERE ----

function summarizeSpending(fareRows) {
  const byCurrency = new Map();
  for (const row of fareRows) {
    if (!byCurrency.has(row.currency)) byCurrency.set(row.currency, { amounts: [], sources: new Set() });
    const bucket = byCurrency.get(row.currency);
    bucket.amounts.push(row.fare_amount_cents);
    bucket.sources.add(row.currency_source || 'assumed');
  }

  return [...byCurrency.entries()].map(([currency, { amounts, sources }]) => {
    const sorted = [...amounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianCents = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const totalCents = amounts.reduce((sum, c) => sum + c, 0);
    // A fare of exactly 0 is a free ride. It is counted in fareCount (a fare
    // WAS recorded) and in freeCount; a ride with no fare at all is in neither.
    const freeCount = amounts.filter(c => c === 0).length;
    return {
      currency,
      currencySource: sources.size === 1 ? [...sources][0] : 'mixed',
      fareCount: amounts.length,
      freeCount,
      paidCount: amounts.length - freeCount,
      totalCents,
      avgCents: totalCents / amounts.length,
      medianCents
    };
  }).sort((a, b) => b.totalCents - a.totalCents);
}

function summarizeModels(vehicleStats) {
  const known = new Map();
  let unknownVehicles = 0;
  for (const v of vehicleStats) {
    if (!v.model) { unknownVehicles++; continue; }
    if (!known.has(v.model)) known.set(v.model, { model: v.model, vehicle_count: 0, ride_count: 0 });
    const entry = known.get(v.model);
    entry.vehicle_count += 1;
    entry.ride_count += v.ride_count;
  }
  return { models: [...known.values()].sort((a, b) => b.ride_count - a.ride_count), unknownModelVehicles: unknownVehicles };
}

async function getUserProfile(sql, userId) {
  const counted = `FROM ${RIDES_FROM} WHERE t.user_id = ? AND ${COUNTED_RIDES_WHERE}`;

  const [
    rideSummary, cities, providers, discoveredVehicles, contributions,
    fareAmounts, firstVehicleModel, monthly, coverage, vehicleStats, underReview
  ] = await sql.batch([
    sql.prepare(`
      SELECT COUNT(*) AS trip_count,
             MIN(t.ride_date) AS first_ride_date, MAX(t.ride_date) AS last_ride_date,
             SUM(t.distance) AS total_distance, AVG(t.distance) AS avg_distance,
             COUNT(t.distance) AS rides_with_distance, MAX(t.distance) AS longest_ride_distance,
             COUNT(DISTINCT t.robotaxi_vehicle_id) AS unique_vehicles,
             SUM(t.duration_minutes) AS total_duration_minutes, AVG(t.duration_minutes) AS avg_duration_minutes,
             COUNT(t.duration_minutes) AS rides_with_duration,
             -- Some durations are computed from pickup/dropoff timestamps rather
             -- than stated on the receipt (see duration_minutes_derived on trips,
             -- set in worker/receipt-extraction.js). Free to compute in this same
             -- query/round trip, so the distinction isn't lost even though the
             -- SUM/AVG above can't carry it themselves.
             SUM(CASE WHEN t.duration_minutes IS NOT NULL AND t.duration_minutes_derived = 1 THEN 1 ELSE 0 END) AS rides_with_derived_duration
      ${counted}
    `).bind(userId),

    sql.prepare(`
      SELECT t.service_area, COUNT(*) AS ride_count,
             SUM(t.distance) AS total_distance, COUNT(t.distance) AS rides_with_distance,
             MIN(t.ride_date) AS first_ride_date, MAX(t.ride_date) AS last_ride_date
      ${counted} AND t.service_area IS NOT NULL
      GROUP BY t.service_area ORDER BY ride_count DESC, t.service_area
    `).bind(userId),

    sql.prepare(`
      SELECT t.provider AS provider, COUNT(*) AS ride_count
      ${counted} GROUP BY t.provider ORDER BY ride_count DESC
    `).bind(userId),

    // Crowdsourced concept, kept separate from vehicles RIDDEN: vehicles this
    // rider was the FIRST to log a (counted) ride in. Earliest counted trip
    // for a vehicle, across all riders, decides who discovered it.
    sql.prepare(`
      SELECT v.id, v.license_plate, v.model, v.color, v.service_area, v.verification_status, v.first_seen_at
      FROM robotaxi_vehicles v
      JOIN (
        SELECT t.robotaxi_vehicle_id AS robotaxi_vehicle_id, t.user_id AS user_id,
               ROW_NUMBER() OVER (PARTITION BY t.robotaxi_vehicle_id ORDER BY t.created_at ASC, t.rowid ASC) AS rn
        FROM ${RIDES_FROM}
        WHERE t.robotaxi_vehicle_id IS NOT NULL AND ${COUNTED_RIDES_WHERE}
      ) first_trip ON first_trip.robotaxi_vehicle_id = v.id AND first_trip.rn = 1
      WHERE first_trip.user_id = ?
      ORDER BY v.first_seen_at ASC
    `).bind(userId),

    // Contributions: the rider's counted submissions, excluding any that back
    // a superseded duplicate trip.
    sql.prepare(`
      SELECT COUNT(*) AS count FROM submissions
      WHERE user_id = ? AND status IN ('pending', 'approved')
        AND id NOT IN (SELECT submission_id FROM trips WHERE superseded_by IS NOT NULL)
    `).bind(userId),

    sql.prepare(`
      SELECT t.currency AS currency, t.fare_amount_cents AS fare_amount_cents, t.currency_source AS currency_source
      ${counted} AND t.fare_amount_cents IS NOT NULL
    `).bind(userId),

    // Same notion of "first ride" as first_ride_date: earliest ride date,
    // then earliest pickup time, then arrival order.
    sql.prepare(`
      SELECT v.model AS model
      FROM ${RIDES_FROM}
      LEFT JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
      WHERE t.user_id = ? AND ${COUNTED_RIDES_WHERE}
      ORDER BY (t.ride_date IS NULL), t.ride_date ASC, (t.pickup_time IS NULL), t.pickup_time ASC, t.created_at ASC, t.rowid ASC
      LIMIT 1
    `).bind(userId),

    sql.prepare(`
      SELECT substr(t.ride_date, 1, 7) AS month, COUNT(*) AS ride_count,
             SUM(t.distance) AS total_distance, COUNT(t.distance) AS rides_with_distance
      ${counted} AND t.ride_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      GROUP BY month ORDER BY month
    `).bind(userId),

    sql.prepare(`
      SELECT COUNT(*) AS rides, COUNT(t.fare_amount_cents) AS with_fare, COUNT(t.distance) AS with_distance,
             COUNT(t.duration_minutes) AS with_duration, COUNT(t.service_area) AS with_city,
             COUNT(t.ride_date) AS with_date, COUNT(t.robotaxi_vehicle_id) AS with_vehicle
      ${counted}
    `).bind(userId),

    sql.prepare(`
      SELECT v.id AS vehicle_id, v.license_plate, v.model, COUNT(*) AS ride_count,
             SUM(t.distance) AS total_distance, COUNT(t.distance) AS rides_with_distance,
             MIN(t.ride_date) AS first_ride_date, MAX(t.ride_date) AS last_ride_date
      FROM ${RIDES_FROM}
      JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
      WHERE t.user_id = ? AND ${COUNTED_RIDES_WHERE}
      GROUP BY v.id ORDER BY ride_count DESC, v.license_plate
    `).bind(userId),

    sql.prepare(`
      SELECT COUNT(*) AS n FROM ${RIDES_FROM}
      WHERE t.user_id = ? AND ${LIVE_RIDES_WHERE} AND s.status = 'needs_review'
    `).bind(userId)
  ]);

  const vehicles = vehicleStats.results || [];
  const { models, unknownModelVehicles } = summarizeModels(vehicles);
  const cov = coverage.results?.[0] || { rides: 0 };

  return {
    rideSummary: rideSummary.results?.[0] || null,
    cities: cities.results || [],
    providers: providers.results || [],
    discoveredVehicles: discoveredVehicles.results || [],
    contributionCount: contributions.results?.[0]?.count ?? 0,
    spending: summarizeSpending(fareAmounts.results || []),
    firstVehicleModel: firstVehicleModel.results?.[0]?.model || null,
    monthlyActivity: monthly.results || [],
    coverage: {
      rides: cov.rides,
      withFare: cov.with_fare ?? 0,
      withDistance: cov.with_distance ?? 0,
      withDuration: cov.with_duration ?? 0,
      withCity: cov.with_city ?? 0,
      withDate: cov.with_date ?? 0,
      withVehicle: cov.with_vehicle ?? 0
    },
    vehicleStats: vehicles,
    modelBreakdown: models,
    unknownModelVehicles,
    underReview: underReview.results?.[0]?.n ?? 0
  };
}

export const rideQueries = {
  createSyncRun,
  finishSyncRun,
  findIngestionByMessageId,
  findIngestionByHash,
  createReceiptIngestion,
  saveForwardingCode,
  markReceiptReceived,
  findTripByRideKey,
  findTripCandidatesByTime,
  createRideRecords,
  reviseTrip,
  setSubmissionStatus,
  getTripsPage,
  deleteAllRidesForUser,
  deleteRideForUser,
  getSyncStatus,
  getUserProfile
};
