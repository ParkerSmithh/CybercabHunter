// D1 queries for Cybercab Hunter's users / Tesla connections / vehicles.
// Every query touching tesla_connections or vehicles is scoped by user_id —
// callers must resolve that from the session first; never from request input.

import { rideQueries } from './db-rides.js';
import { RIDES_FROM, COUNTED_RIDES_WHERE, registryEvidenceSql, publicVehicleEligibleSql } from './ride-status.js';
import { normalizePlate, sqlNormalizedPlate } from './plate.js';

// Registry visibility values. 'private' is the value this schema already
// uses for non-public rows (see the personal `vehicles` table); the column
// has no CHECK constraint, so these two are enforced here and in the
// moderator endpoint, not by the database.
const VEHICLE_VISIBILITY = { PUBLIC: 'public', PRIVATE: 'private' };

// A registry vehicle is publicly eligible only when a moderator has made it
// public AND at least one counted, non-superseded ride backs it.
// countedRideExistsSql / publicVehicleEligibleSql now live in
// worker/ride-status.js (imported above) so worker/db-rides.js can reuse the
// exact same definition — see that file for the full rationale. Query-time
// only: nothing is deleted or rewritten when a vehicle stops being eligible.

// What must be true for a moderator to APPROVE a vehicle for the public
// registry (worker/moderation.js's review action): the evidence requirement of
// the public gate above (registryEvidenceSql — a counted, non-superseded ride,
// or for a sighting-origin vehicle a VIN on file; not a second definition)
// PLUS a usable, UNIQUE plate,
// so approving one of several registry rows for the same plate can never make
// an ambiguous vehicle public. Needs-review-only, rejected-only and orphaned
// vehicles all fail on the ride requirement. `alias` is the robotaxi_vehicles
// name/alias in the caller's statement; the inner v2 alias is private to it.
function vehicleApprovalGuardSql(alias) {
  const plate = sqlNormalizedPlate(`${alias}.license_plate`);
  return `${registryEvidenceSql(alias)}
    AND ${plate} <> ''
    AND (SELECT COUNT(*) FROM robotaxi_vehicles v2
         WHERE ${sqlNormalizedPlate('v2.license_plate')} = ${plate}) = 1`;
}

function newId() {
  return crypto.randomUUID();
}

async function findOrCreateUserByTeslaIdentifier(sql, teslaAccountIdentifier) {
  if (teslaAccountIdentifier) {
    const existing = await sql.prepare(
      `SELECT user_id FROM tesla_connections WHERE provider = 'tesla' AND tesla_account_identifier = ?`
    ).bind(teslaAccountIdentifier).first();
    if (existing) return existing.user_id;
  }
  const id = newId();
  await sql.prepare(`INSERT INTO users (id, profile_visibility) VALUES (?, 'public')`).bind(id).run();
  return id;
}

async function upsertTeslaConnection(sql, { userId, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt, teslaAccountIdentifier }) {
  await sql.prepare(`
    INSERT INTO tesla_connections (id, user_id, tesla_account_identifier, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, status, last_refresh_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      tesla_account_identifier = excluded.tesla_account_identifier,
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      status = 'active',
      updated_at = datetime('now'),
      last_refresh_at = datetime('now')
  `).bind(newId(), userId, teslaAccountIdentifier || null, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt).run();
}

async function getTeslaConnectionByUserId(sql, userId) {
  return sql.prepare(`SELECT * FROM tesla_connections WHERE user_id = ?`).bind(userId).first();
}

async function updateConnectionTokens(sql, userId, { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt }) {
  await sql.prepare(`
    UPDATE tesla_connections SET
      encrypted_access_token = ?,
      encrypted_refresh_token = ?,
      access_token_expires_at = ?,
      status = 'active',
      updated_at = datetime('now'),
      last_refresh_at = datetime('now')
    WHERE user_id = ?
  `).bind(encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt, userId).run();
}

// Soft revoke: used automatically when a stored refresh token turns out to
// be dead (see getValidAccessToken in tesla.js). Deliberately keeps
// tesla_account_identifier so the SAME user can recover simply by
// re-linking, rather than losing the connection to the (provider,
// tesla_account_identifier) unique index the next time they try.
async function markConnectionRevoked(sql, userId) {
  await sql.prepare(`UPDATE tesla_connections SET status = 'revoked', updated_at = datetime('now') WHERE user_id = ?`).bind(userId).run();
}

// User-initiated unlink (POST /api/tesla/disconnect): unlike
// markConnectionRevoked above, this also clears tesla_account_identifier —
// otherwise the (provider, tesla_account_identifier) unique index would
// keep blocking this same Tesla account from ever being linked to a
// different (or the same) Cybercab Hunter user again. Keeps the row's
// history and the user's discovered vehicles intact.
async function unlinkTeslaConnection(sql, userId) {
  await sql.prepare(`
    UPDATE tesla_connections SET status = 'revoked', tesla_account_identifier = NULL, updated_at = datetime('now') WHERE user_id = ?
  `).bind(userId).run();
}

// Hard delete: used only by DELETE /api/tesla/data. Vehicles are removed
// before the connection row since both reference users independently (no FK
// between them), keeping deletion order predictable either way.
async function deleteConnectionAndVehicles(sql, userId) {
  await sql.prepare(`DELETE FROM vehicles WHERE owner_user_id = ?`).bind(userId).run();
  await sql.prepare(`DELETE FROM tesla_connections WHERE user_id = ?`).bind(userId).run();
}

async function upsertVehicles(sql, userId, teslaVehicles) {
  for (const v of teslaVehicles) {
    const teslaVehicleId = String(v.id ?? v.vehicle_id ?? '');
    if (!teslaVehicleId) continue;
    await sql.prepare(`
      INSERT INTO vehicles (id, owner_user_id, source, visibility, provider, tesla_vehicle_id, vin, display_name, active_status, first_known_at, last_known_at, last_synced_at)
      VALUES (?, ?, 'tesla_oauth', 'private', 'tesla', ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(owner_user_id, tesla_vehicle_id) DO UPDATE SET
        vin = excluded.vin,
        display_name = excluded.display_name,
        active_status = excluded.active_status,
        last_known_at = datetime('now'),
        last_synced_at = datetime('now'),
        updated_at = datetime('now')
    `).bind(newId(), userId, teslaVehicleId, v.vin || null, v.display_name || null, v.state || 'unknown').run();
  }
}

async function getVehiclesByOwner(sql, userId) {
  const result = await sql.prepare(
    `SELECT id, tesla_vehicle_id, display_name, model, model_year, active_status, last_synced_at
     FROM vehicles WHERE owner_user_id = ? AND visibility = 'private' ORDER BY created_at`
  ).bind(userId).all();
  return result.results || [];
}

async function countVehiclesByOwner(sql, userId) {
  const row = await sql.prepare(`SELECT COUNT(*) as count FROM vehicles WHERE owner_user_id = ?`).bind(userId).first();
  return row ? row.count : 0;
}

async function getUserById(sql, userId) {
  return sql.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
}

// Google Sign-In identity — a separate account-creation path from
// findOrCreateUserByTeslaIdentifier above, keyed by google_connections
// instead of tesla_connections. name/avatarUrl are only applied when the
// user is first created, so a later Google sign-in never clobbers a
// display_name/avatar_url the user has since customized on Profile.
async function findOrCreateUserByGoogleIdentity(sql, { googleSub, email, name, avatarUrl }) {
  const existing = await sql.prepare(
    `SELECT user_id FROM google_connections WHERE google_sub = ?`
  ).bind(googleSub).first();
  if (existing) return existing.user_id;

  const id = newId();
  await sql.prepare(
    `INSERT INTO users (id, display_name, avatar_url, profile_visibility) VALUES (?, ?, ?, 'public')`
  ).bind(id, name || null, avatarUrl || null).run();
  await sql.prepare(
    `INSERT INTO google_connections (id, user_id, google_sub, email) VALUES (?, ?, ?, ?)`
  ).bind(newId(), id, googleSub, email || null).run();
  return id;
}

// Always sets all four fields at once (rather than a dynamic partial
// UPDATE) so a deliberate "clear this field" (null) can't be confused with
// "field not sent" — the caller (apiUpdateProfile) always resolves the
// full set first. Throws on the existing unique-handle constraint if
// `handle` is already taken by a different user; the caller translates
// that into a clean error rather than a raw D1 message.
async function updateUserSettings(sql, userId, { displayName, handle, bio, profileVisibility }) {
  await sql.prepare(`
    UPDATE users SET
      display_name = ?,
      handle = ?,
      bio = ?,
      profile_visibility = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(displayName, handle, bio, profileVisibility, userId).run();
}

async function touchUserSync(sql, userId) {
  await sql.prepare(`UPDATE users SET last_sync_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(userId).run();
}

// ---- Ride-submission evidence (submissions table) ----

async function createSubmission(sql, { id, userId, submissionType, evidenceType, evidenceRef }) {
  await sql.prepare(`
    INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at)
    VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))
  `).bind(id, userId, submissionType, evidenceType, evidenceRef).run();
}

// rejection_reason is deliberately NOT selected: it is a moderator's private
// note (see worker/moderation.js) and this list is returned to the ordinary
// submitting user. Moderators read it through the moderation queries, which
// select it explicitly.
async function getSubmissionsByUser(sql, userId) {
  const result = await sql.prepare(`
    SELECT id, submission_type, evidence_type, status, submitted_at, reviewed_at
    FROM submissions WHERE user_id = ? ORDER BY submitted_at DESC
  `).bind(userId).all();
  return result.results || [];
}

// Scoped to the owner — returns nothing if the submission exists but
// belongs to a different user, which is what makes this safe to use for
// evidence access without a separate authorization check.
async function getSubmissionForOwner(sql, submissionId, userId) {
  return sql.prepare(`
    SELECT id, user_id, status, evidence_ref, evidence_type FROM submissions WHERE id = ? AND user_id = ?
  `).bind(submissionId, userId).first();
}

// Used both to roll back a submission row if a step after its creation
// fails, and by the authenticated delete endpoint (which always passes
// userId too, scoping the delete to the caller's own rows).
//
// A ride that other trips were marked superseded_by (legacy duplicates of
// the same receipt) takes those duplicates with it: they are only alternate
// representations of that ride, and leaving them behind would re-activate
// them the moment their canonical ride disappeared.
async function deleteSubmission(sql, submissionId, userId) {
  const duplicateSubmissions = sql.prepare(`
    DELETE FROM submissions WHERE id IN (
      SELECT d.submission_id FROM trips d JOIN trips c ON d.superseded_by = c.id
      WHERE c.submission_id = ?1 ${userId ? 'AND c.user_id = ?2' : ''}
    )
  `).bind(...(userId ? [submissionId, userId] : [submissionId]));
  const target = userId
    ? sql.prepare(`DELETE FROM submissions WHERE id = ? AND user_id = ?`).bind(submissionId, userId)
    : sql.prepare(`DELETE FROM submissions WHERE id = ?`).bind(submissionId);
  await sql.batch([duplicateSubmissions, target]);
}

// ---- Receipt-email ingestion ----

async function findOrCreateReceiptIngestionAddress(sql, userId) {
  const existing = await sql.prepare(
    `SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'`
  ).bind(userId).first();
  if (existing) return existing.opaque_token;

  const token = crypto.randomUUID().replace(/-/g, '');
  await sql.prepare(`
    INSERT INTO receipt_ingestion_addresses (id, user_id, opaque_token, status)
    VALUES (?, ?, ?, 'active')
  `).bind(newId(), userId, token).run();
  return token;
}

async function getUserIdByActiveReceiptToken(sql, token) {
  const row = await sql.prepare(
    `SELECT user_id FROM receipt_ingestion_addresses WHERE opaque_token = ? AND status = 'active'`
  ).bind(token).first();
  return row ? row.user_id : null;
}

// Replaces a rider's receipt address with a fresh one, so a leaked address
// (the rider is told to treat it like a password) can be shut off. There is
// a UNIQUE index on user_id alone (one address row per rider, active or
// not — see migrations/0003_receipt_ingestion.sql), so rotation can't be
// "revoke old row, insert a new one" without a schema change; instead the
// SAME row's token is replaced in place. The old token stops resolving
// immediately (nothing in the table holds it any more) while the row's id,
// user_id and created_at — and every receipt_ingestions/trips row, which
// key off user_id, never the token — are untouched. last_received_at and
// any pending Gmail confirmation code described the OLD address, so they're
// cleared; they'll be set again once the new address actually receives mail.
async function rotateReceiptIngestionAddress(sql, userId) {
  const token = crypto.randomUUID().replace(/-/g, '');
  const result = await sql.prepare(`
    UPDATE receipt_ingestion_addresses
    SET opaque_token = ?, last_received_at = NULL, forwarding_code = NULL, forwarding_code_received_at = NULL
    WHERE user_id = ? AND status = 'active'
  `).bind(token, userId).run();
  if (!result || !result.meta || !result.meta.changes) {
    // No address existed yet — rotating one that was never issued is the
    // same as issuing it for the first time.
    return findOrCreateReceiptIngestionAddress(sql, userId);
  }
  return token;
}

// Registry lookup/creation by plate. "Same plate" means the same NORMALIZED
// plate (worker/plate.js): "XJR-2195" and "xjr2195" are one plate, so the
// receipt parser, sighting submission and registry all agree on identity.
//
// Trust boundary: this is the ONLY function that creates registry rows, and
// what it creates is INTERNAL. A receipt is not authenticated (forwarded
// email is not SPF/DKIM-verified and a pasted receipt has no sender at all),
// so a new vehicle starts 'private' and only becomes publicly visible when a
// moderator sets it public (worker/moderation.js) — and even then only while
// it has a counted ride (publicVehicleEligibleSql).

// Every row for a normalized plate, in one fixed order (oldest first, id as
// the final tiebreak) so "first" is never arbitrary. A well-formed registry
// has at most one; more than one is a data problem to be resolved by a human
// (see registry-preflight.js), never guessed at here. LIMIT 2 is enough to
// tell unique from ambiguous.
async function lookupVehiclesByPlate(sql, normalizedPlate) {
  const result = await sql.prepare(`
    SELECT id FROM robotaxi_vehicles
    WHERE ${sqlNormalizedPlate('license_plate')} = ?
    ORDER BY first_seen_at ASC, created_at ASC, id ASC
    LIMIT 2
  `).bind(normalizedPlate).all();
  return (result.results || []).map(r => r.id);
}

// Read-only. { status: 'none' | 'unique' | 'ambiguous', vehicleId } —
// vehicleId is set ONLY for 'unique'. Callers that can act on ambiguity
// (sighting linking, public matching) must not attach to any vehicle when it
// is 'ambiguous'. Internal detail: never returned by a public endpoint.
async function resolveRobotaxiVehicleByPlate(sql, plate) {
  const normalized = normalizePlate(plate);
  if (!normalized) return { status: 'none', vehicleId: null };
  const ids = await lookupVehiclesByPlate(sql, normalized);
  if (ids.length === 0) return { status: 'none', vehicleId: null };
  if (ids.length > 1) return { status: 'ambiguous', vehicleId: null };
  return { status: 'unique', vehicleId: ids[0] };
}

// Read-only counterpart for worker/sightings.js. NEVER creates a row and
// NEVER advances last_seen_at — an unreviewed crowdsourced sighting must not
// create a vehicle or mutate receipt-derived vehicle state (Phase 3D trust
// boundary). Returns an id only for a UNIQUE match: no match and an
// ambiguous match both return null, so a sighting is never linked to an
// arbitrary one of several vehicles.
async function findRobotaxiVehicleByPlate(sql, plate) {
  return (await resolveRobotaxiVehicleByPlate(sql, plate)).vehicleId;
}

// Race-safe find-or-create. The row is inserted by ONE conditional
// statement (INSERT ... SELECT ... WHERE NOT EXISTS), so "no row for this
// plate yet" and "insert it" are evaluated together by the database rather
// than as a separate SELECT followed by an INSERT that another request can
// slip between. Whichever call inserts reports it via meta.changes; every
// other call falls through to the existing row, which is reused unchanged
// except for last_seen_at/updated_at — model, color, service area,
// visibility and verification_status are never overwritten.
//
// If duplicate rows for a plate already exist (legacy data), a ride still
// needs a vehicle to attach to: the oldest row wins, deterministically, and
// nothing is merged, deleted or rewritten. That choice is internal — public
// sighting matching refuses ambiguous plates entirely.
//
// Returns null for a plate with nothing left after normalization.
async function findOrCreateRobotaxiVehicleByPlate(sql, plate) {
  const normalized = normalizePlate(plate);
  if (!normalized) return null;

  const id = newId();
  const inserted = await sql.prepare(`
    INSERT INTO robotaxi_vehicles (id, license_plate, visibility, first_seen_at, last_seen_at)
    SELECT ?, ?, '${VEHICLE_VISIBILITY.PRIVATE}', datetime('now'), datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM robotaxi_vehicles WHERE ${sqlNormalizedPlate('license_plate')} = ?
    )
  `).bind(id, normalized, normalized).run();
  if (inserted && inserted.meta && inserted.meta.changes > 0) return id;

  const [existingId] = await lookupVehiclesByPlate(sql, normalized);
  // Every new ride of an already-known plate advances last_seen_at —
  // otherwise "most recent known ride" can never be answered correctly once
  // a vehicle has more than one trip.
  await sql.prepare(
    `UPDATE robotaxi_vehicles SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(existingId).run();
  return existingId;
}

// An accidental-double-submit guard only — the same rider, the same
// normalized plate, within the last couple of minutes. Not spam/anti-abuse
// protection (deferred to a later Phase 3D step); uses only data this
// endpoint already writes, no new table or index.
async function findRecentDuplicateSighting(sql, userId, normalizedPlate) {
  const row = await sql.prepare(`
    SELECT o.id AS observation_id, o.submission_id
    FROM vehicle_observations o
    WHERE o.user_id = ?
      AND UPPER(REPLACE(REPLACE(o.license_plate, '-', ''), ' ', '')) = ?
      AND o.created_at >= datetime('now', '-2 minutes')
    ORDER BY o.created_at DESC LIMIT 1
  `).bind(userId, normalizedPlate).first();
  return row || null;
}

// Records a rider's vehicle sighting: a submissions row (submission_type
// 'vehicle_sighting', status 'pending' — nothing reviews it yet) and its
// vehicle_observations row, created atomically in one batch (matching
// createRideRecords's pattern below) so the two can never go out of sync.
// robotaxiVehicleId is null when the observed plate didn't match an
// existing registry vehicle — the caller decides that with a read-only
// lookup; this function never creates or mutates a robotaxi_vehicles row.
async function createVehicleSighting(sql, { userId, robotaxiVehicleId, licensePlate, serviceArea, approxLocation, model, color, notes, observedAt }) {
  const submissionId = newId();
  const observationId = newId();

  const submissionStmt = sql.prepare(`
    INSERT INTO submissions (id, user_id, submission_type, status, submitted_at)
    VALUES (?, ?, 'vehicle_sighting', 'pending', datetime('now'))
  `).bind(submissionId, userId);

  // observed_at is only included when the caller supplied one — binding an
  // explicit NULL would violate the column's NOT NULL constraint instead of
  // letting its own datetime('now') default apply.
  const columns = ['id', 'robotaxi_vehicle_id', 'user_id', 'submission_id', 'service_area', 'approx_location', 'license_plate', 'model', 'color', 'verification_status', 'notes'];
  const values = [observationId, robotaxiVehicleId || null, userId, submissionId, serviceArea, approxLocation || null, licensePlate || null, model || null, color || null, 'unverified', notes || null];
  if (observedAt) { columns.push('observed_at'); values.push(observedAt); }

  const observationStmt = sql.prepare(`
    INSERT INTO vehicle_observations (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).bind(...values);

  await sql.batch([submissionStmt, observationStmt]);
  return { submissionId, observationId };
}

// ---- Moderation (Phase 3D-C2) — vehicle-sighting review queue only ----
// Every function here is reached exclusively through worker/moderation.js's
// requireModerator gate; none of it is exposed to an ordinary rider or to
// any public/unauthenticated route.

// The reviewable queue: vehicle_sighting submissions still awaiting a
// decision. needs_review is included alongside pending for completeness —
// nothing currently puts a sighting there (createVehicleSighting always
// inserts 'pending'), but the column's own status model already allows it,
// and treating it as reviewable costs nothing extra here.
async function getPendingVehicleSightings(sql) {
  const result = await sql.prepare(`
    SELECT
      s.id AS submission_id, s.status, s.submitted_at, s.evidence_ref AS submission_evidence_ref,
      o.id AS observation_id, o.robotaxi_vehicle_id, o.observed_at, o.service_area, o.approx_location,
      o.license_plate, o.model, o.color, o.evidence_ref AS observation_evidence_ref, o.verification_status, o.notes
    FROM submissions s
    JOIN vehicle_observations o ON o.submission_id = s.id
    WHERE s.submission_type = 'vehicle_sighting' AND s.status IN ('pending', 'needs_review')
    ORDER BY s.submitted_at ASC
  `).all();
  return result.results || [];
}

// A single submission+observation pair, for the review endpoint to check
// eligibility (type, current status) before attempting the transition —
// the UPDATE's own WHERE clause below is the real race guard; this is what
// lets the caller return an accurate 404 vs 409 rather than a generic
// failure.
async function getVehicleSightingSubmission(sql, submissionId) {
  const row = await sql.prepare(`
    SELECT s.id AS submission_id, s.submission_type, s.status, s.reviewed_at, s.reviewed_by, s.rejection_reason,
           o.id AS observation_id, o.robotaxi_vehicle_id, o.verification_status, o.license_plate
    FROM submissions s
    JOIN vehicle_observations o ON o.submission_id = s.id
    WHERE s.id = ?
  `).bind(submissionId).first();
  return row || null;
}

// Approves or rejects a pending/needs_review vehicle-sighting submission.
// Atomic and race-safe: every statement runs in ONE batch (one transaction),
// and each is independently gated by the submission's status at the START
// of the transaction (the observation update's subquery reads
// submissions.status before the submission update — which comes second —
// has touched it, so a concurrent second reviewer's batch, whichever one
// the database serializes second, sees the ALREADY-transitioned status and
// updates zero rows in every statement). The caller checks
// submissionResult.meta.changes to know whether this call actually won the
// transition; 0 means someone else already reviewed it — a 409, never a
// silently overwritten decision.
//
// This still never CREATES a robotaxi_vehicles row (a new plate is never
// registered from a sighting) and never changes visibility/eligibility —
// that trust boundary is unchanged. Candidate A (Phase 3D-D-lite) adds one
// narrow exception: an APPROVED sighting whose observation is linked to an
// EXISTING registry vehicle (o.robotaxi_vehicle_id already set — see
// worker/sightings.js's read-only plate match) may fill that vehicle's
// currently-blank model/color/service_area. COALESCE keeps whichever value
// is non-null: an existing value always wins, so this can only fill a gap,
// never overwrite or blank out a value the vehicle already has. Gated on
// THIS transaction having actually verified the observation, so the losing
// side of a review race (or a reject, or an unmatched sighting) writes
// nothing to robotaxi_vehicles. last_seen_at, ride/trip data, and every
// other column are untouched.
async function reviewVehicleSighting(sql, { submissionId, decision, reviewerId, rejectionReason }) {
  const observationStatus = decision === 'approved' ? 'verified' : 'rejected';

  const observationStmt = sql.prepare(`
    UPDATE vehicle_observations
    SET verification_status = ?
    WHERE submission_id = ?
      AND EXISTS (
        SELECT 1 FROM submissions
        WHERE id = ? AND submission_type = 'vehicle_sighting' AND status IN ('pending', 'needs_review')
      )
  `).bind(observationStatus, submissionId, submissionId);

  const submissionStmt = sql.prepare(`
    UPDATE submissions
    SET status = ?, reviewed_at = datetime('now'), reviewed_by = ?, rejection_reason = ?
    WHERE id = ? AND submission_type = 'vehicle_sighting' AND status IN ('pending', 'needs_review')
  `).bind(decision, reviewerId, rejectionReason || null, submissionId);

  const statements = [observationStmt, submissionStmt];

  if (decision === 'approved') {
    statements.push(sql.prepare(`
      UPDATE robotaxi_vehicles
      SET model = COALESCE(model, (
            SELECT o.model FROM vehicle_observations o
            WHERE o.submission_id = ? AND o.model IS NOT NULL AND o.model <> ''
          )),
          color = COALESCE(color, (
            SELECT o.color FROM vehicle_observations o
            WHERE o.submission_id = ? AND o.color IS NOT NULL AND o.color <> ''
          )),
          service_area = COALESCE(service_area, (
            SELECT o.service_area FROM vehicle_observations o
            WHERE o.submission_id = ? AND o.service_area IS NOT NULL AND o.service_area <> ''
          ))
      WHERE id = (
        SELECT o.robotaxi_vehicle_id FROM vehicle_observations o
        WHERE o.submission_id = ? AND o.verification_status = 'verified' AND o.robotaxi_vehicle_id IS NOT NULL
      )
    `).bind(submissionId, submissionId, submissionId, submissionId));
  }

  const [, submissionResult] = await sql.batch(statements);
  return { applied: !!(submissionResult && submissionResult.meta && submissionResult.meta.changes) };
}

// Moderator action: turn ONE pending community sighting into a private
// registry vehicle. Sightings otherwise never create registry rows (see
// worker/sightings.js), so this is the only path, and it is deliberately the
// moderator's explicit act. One atomic batch:
//   1. insert the vehicle (private, origin 'sighting') from the observation's
//      plate/model/color/service area — conditional on the sighting still
//      being pending, having a usable plate, and NO registry row already
//      holding that normalized plate (evaluated together with the insert, so
//      two moderators or a racing receipt cannot create a duplicate);
//   2. link the observation to it and mark the observation verified;
//   3. approve the sighting (reviewed_at/by), only if step 1 inserted.
// No ride is created: the vehicle's evidence is the VIN a moderator enters
// later (registryEvidenceSql). Returns { applied, vehicleId }.
//
// auto: true is the Muse connector registering its OWN submission the moment
// it arrives (worker/connector.js), with no moderator involved. The vehicle is
// created identically (private, origin 'sighting'), but no human has looked at
// the sighting, so the observation is left 'unverified' (never asserted
// verified) and the submission is closed with no reviewer (reviewed_by NULL —
// the audit trail shows it was not a moderator's decision).
async function promoteSightingToRegistryVehicle(sql, { submissionId, reviewerId = null, auto = false }) {
  const vehicleId = newId();
  const plateOfObservation = sqlNormalizedPlate('o.license_plate');
  const pending = `EXISTS (SELECT 1 FROM submissions WHERE id = ? AND submission_type = 'vehicle_sighting' AND status IN ('pending', 'needs_review'))`;

  const insertStmt = sql.prepare(`
    INSERT INTO robotaxi_vehicles
      (id, license_plate, model, color, service_area, visibility, origin, first_seen_at, last_seen_at)
    SELECT ?, ${plateOfObservation}, o.model, o.color, o.service_area, '${VEHICLE_VISIBILITY.PRIVATE}', 'sighting',
           o.observed_at, o.observed_at
    FROM vehicle_observations o
    WHERE o.submission_id = ?
      AND ${plateOfObservation} <> ''
      AND ${pending}
      AND NOT EXISTS (
        SELECT 1 FROM robotaxi_vehicles v2 WHERE ${sqlNormalizedPlate('v2.license_plate')} = ${plateOfObservation}
      )
  `).bind(vehicleId, submissionId, submissionId);

  const linkStmt = sql.prepare(`
    UPDATE vehicle_observations
    SET robotaxi_vehicle_id = ?, verification_status = ${auto ? 'verification_status' : "'verified'"}
    WHERE submission_id = ? AND ${pending}
      AND EXISTS (SELECT 1 FROM robotaxi_vehicles WHERE id = ? AND origin = 'sighting')
  `).bind(vehicleId, submissionId, submissionId, vehicleId);

  const approveStmt = sql.prepare(`
    UPDATE submissions
    SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?, rejection_reason = NULL
    WHERE id = ? AND submission_type = 'vehicle_sighting' AND status IN ('pending', 'needs_review')
      AND EXISTS (SELECT 1 FROM robotaxi_vehicles WHERE id = ? AND origin = 'sighting')
  `).bind(reviewerId, submissionId, vehicleId);

  const [inserted] = await sql.batch([insertStmt, linkStmt, approveStmt]);
  const applied = !!(inserted && inserted.meta && inserted.meta.changes > 0);
  return { applied, vehicleId: applied ? vehicleId : null };
}

// Public registry AGGREGATES for the homepage: how many vehicles are publicly
// eligible, and how many counted rides belong to exactly those vehicles. Both
// come from the SAME gate the registry list and the vehicle page use
// (publicVehicleEligibleSql — public AND at least one counted ride) and the
// same counted-ride rule (COUNTED_RIDES_WHERE), so the totals always equal the
// sum of what the public list shows. Only two numbers leave this function: no
// ids, no per-vehicle, per-user, per-submission or moderation data. Sightings
// are deliberately NOT counted here: the public sighting list de-duplicates by
// day and area and caps each vehicle's list, so a raw total would not match
// anything a visitor can verify.
async function getPublicRegistryStats(sql) {
  const row = await sql.prepare(`
    SELECT
      (SELECT COUNT(*) FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}) AS public_vehicles,
      (SELECT COUNT(*) FROM ${RIDES_FROM}
        WHERE ${COUNTED_RIDES_WHERE}
          AND t.robotaxi_vehicle_id IN (SELECT v.id FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')})) AS recorded_rides
  `).first();
  // An aggregate SELECT of COUNT(*)s always yields exactly one row of whole numbers. Anything else (no row,
  // a null result, missing or non-numeric columns) means the query did not really answer, and that must
  // surface as a failure (the caller turns a throw into the generic 503) — never be reported as a zero.
  const whole = n => Number.isInteger(n) && n >= 0;
  if (!row || !whole(row.public_vehicles) || !whole(row.recorded_rides)) {
    throw new Error('registry stats: the aggregate query returned no usable row');
  }
  return { public_vehicles: row.public_vehicles, recorded_rides: row.recorded_rides };
}

// The public registry LIST: exactly the vehicles getPublicRobotaxiVehicle would
// return (same gate, publicVehicleEligibleSql — public AND at least one
// counted ride), with the same public fields plus a small ride summary taken
// from the same counted-ride rule the detail page uses. Nothing private is
// selected: no user/ride/submission ids, no fares, no addresses. Most recently
// seen first, then plate, then id, so the order is stable between pages.
async function getPublicRobotaxiVehicles(sql, { limit = 50, offset = 0 } = {}) {
  const counted = extra => `FROM ${RIDES_FROM} WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}${extra || ''}`;
  const rows = await sql.prepare(`
    SELECT v.id, v.provider, v.license_plate, v.model, v.color, v.service_area,
           v.first_seen_at, v.last_seen_at, v.verification_status, v.vin,
           (SELECT COUNT(*) ${counted()}) AS trip_count,
           (SELECT MIN(t.ride_date) ${counted()}) AS first_ride_date,
           (SELECT MAX(t.ride_date) ${counted()}) AS last_ride_date,
           (SELECT GROUP_CONCAT(DISTINCT t.service_area) ${counted()}) AS service_areas
    FROM robotaxi_vehicles v
    WHERE ${publicVehicleEligibleSql('v')}
    ORDER BY v.last_seen_at DESC, v.license_plate ASC, v.id ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  const total = await sql.prepare(`
    SELECT COUNT(*) AS n FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}
  `).first();
  return { vehicles: rows.results || [], total: total ? total.n : 0 };
}

// The public-facing view of a single registry row, for worker/vehicles.js.
// Selects only vehicle-descriptive columns — never `visibility` itself,
// which is part of the gate this query enforces rather than a fact about the
// car. The gate is publicVehicleEligibleSql: visibility 'public' AND at least
// one counted, non-superseded ride. A vehicle that fails either half comes
// back exactly like a nonexistent one; the caller can't tell the difference,
// which is the point of the column existing. license_plate/model/color/service_area are frequently
// NULL today (receipts only ever fill in the plate — see
// findOrCreateRobotaxiVehicleByPlate above), returned honestly as null
// rather than defaulted to something invented.
async function getPublicRobotaxiVehicle(sql, vehicleId) {
  const row = await sql.prepare(`
    SELECT v.id, v.provider, v.license_plate, v.model, v.color, v.service_area,
           v.first_seen_at, v.last_seen_at, v.verification_status, v.vin
    FROM robotaxi_vehicles v
    WHERE v.id = ? AND ${publicVehicleEligibleSql('v')}
  `).bind(vehicleId).first();
  return row || null;
}

// Public, read-only: approved community sightings for ONE vehicle that the
// caller has already established is a public registry vehicle (the route
// gates on getPublicRobotaxiVehicle first; the query below re-asserts the
// same eligibility so this function is safe on its own).
//
// An observation counts for the vehicle when EITHER its frozen
// robotaxi_vehicle_id points at it, OR that FK is still NULL and the
// observation's normalized plate equals the vehicle's normalized plate AND
// that plate belongs to exactly ONE registry vehicle (of any visibility).
// If two or more registry rows share the plate the match is ambiguous and
// the sighting stays private — it is never shown on several vehicles and
// never assigned to an arbitrary one. The second branch is a read-time match
// only: nothing is ever written back (no relink, no backfill), so an
// unmatched sighting stays private until a receipt independently creates the
// registry vehicle AND a moderator makes it public.
//
// Only trusted server-side data leaves this query: the date is the
// submissions.submitted_at DAY (server-set; the client-controlled
// observed_at is never selected) and the raw service_area, which the caller
// normalizes before publishing. Returned rows are pre-grouped by
// (date, lower/trimmed area) purely to bound the row count; the JS below
// then normalizes the area and re-aggregates, so every published entry is
// one per vehicle + date + normalized area, with no submitter counts.
const PUBLIC_SIGHTING_AREAS = { austin: 'Austin', dallas: 'Dallas', houston: 'Houston', 'san antonio': 'San Antonio' };
const AREA_NOT_SPECIFIED = 'Area not specified';

// Case-insensitive, whitespace-tolerant match against the known launch
// cities; anything else (free text a submitter typed) is never published.
function normalizePublicServiceArea(raw) {
  const key = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').toLowerCase();
  return PUBLIC_SIGHTING_AREAS[key] || AREA_NOT_SPECIFIED;
}

async function getPublicVehicleSightings(sql, vehicleId, limit = 10) {
  const plateOfObservation = sqlNormalizedPlate('o.license_plate');
  const plateOfVehicle = sqlNormalizedPlate('v.license_plate');
  const plateOfAnyVehicle = sqlNormalizedPlate('v2.license_plate');
  const result = await sql.prepare(`
    SELECT substr(s.submitted_at, 1, 10) AS date,
           LOWER(TRIM(o.service_area)) AS area_key,
           MIN(o.service_area) AS raw_service_area
    FROM robotaxi_vehicles v
    JOIN vehicle_observations o
      ON o.robotaxi_vehicle_id = v.id
      OR (o.robotaxi_vehicle_id IS NULL
          AND ${plateOfObservation} <> ''
          AND ${plateOfObservation} = ${plateOfVehicle}
          AND (SELECT COUNT(*) FROM robotaxi_vehicles v2
               WHERE ${plateOfAnyVehicle} = ${plateOfVehicle}) = 1)
    JOIN submissions s ON s.id = o.submission_id
    WHERE v.id = ? AND ${publicVehicleEligibleSql('v')}
      AND s.status = 'approved'
      AND s.submission_type = 'vehicle_sighting'
      AND o.verification_status = 'verified'
    GROUP BY date, area_key
    ORDER BY date DESC
  `).bind(vehicleId).all();

  const seen = new Set();
  const out = [];
  for (const row of result.results || []) {
    const service_area = normalizePublicServiceArea(row.raw_service_area);
    const key = `${row.date}|${service_area}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: row.date, service_area });
  }
  return out.slice(0, limit);
}

// ---- Registry vehicle visibility (Phase 3E) — moderator-only, reached only
// through worker/moderation.js's requireModerator gate. These expose
// registry facts and counts ONLY: never a rider id, receipt content, an
// address, or evidence. ----

// One moderator-facing row per registry vehicle: identity, current
// visibility, how many counted rides back it, how those rides ENTERED the
// system, and whether the plate is shared with another registry row (a
// duplicate a human must resolve).
//
// Provenance is descriptive only. counted_rides_by_source groups the SAME
// counted rides (RIDES_FROM + COUNTED_RIDES_WHERE — there is no second
// definition of "counted") by trips.source, the path the receipt took in:
//   receipt_email  — arrived at the rider's forwarding address
//   receipt_import — pasted text or an uploaded .eml. The stored data does
//                    not distinguish those two, so neither does this.
//   other          — any other value (e.g. the legacy 'manual' default)
// It says how data entered Cybercab Hunter. It does NOT show that a receipt
// was really issued by Tesla, and nothing here scores or ranks it. No rider
// identity, address, or receipt content is selected.
const COUNTED_BY = extra => `(SELECT COUNT(*) FROM ${RIDES_FROM}
           WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}${extra})`;
// Live rides (not superseded) in a given NON-counted submission status. Facts
// about what is attached to the vehicle, so a moderator can see whether a
// vehicle has review/rejected history, not a judgment about it.
const LIVE_STATUS_COUNT = status => `(SELECT COUNT(*) FROM ${RIDES_FROM}
           WHERE t.robotaxi_vehicle_id = v.id AND t.superseded_by IS NULL AND s.status = '${status}')`;
// The most recent review of this vehicle (append-only history, Phase 3H).
const LAST_REVIEW = col => `(SELECT r.${col} FROM robotaxi_vehicle_reviews r
           WHERE r.robotaxi_vehicle_id = v.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1)`;
const REGISTRY_VEHICLE_MOD_SELECT = `
  SELECT v.id, v.license_plate, v.visibility, v.verification_status, v.origin,
         v.first_seen_at, v.last_seen_at, v.created_at,
         v.vin, v.vin_set_by_user_id, v.vin_set_at,
         ${COUNTED_BY('')} AS counted_ride_count,
         ${COUNTED_BY(` AND t.source = 'receipt_email'`)} AS counted_email,
         ${COUNTED_BY(` AND t.source = 'receipt_import'`)} AS counted_import,
         ${LIVE_STATUS_COUNT('needs_review')} AS needs_review_ride_count,
         ${LIVE_STATUS_COUNT('rejected')} AS rejected_ride_count,
         (SELECT COUNT(*) FROM trips t WHERE t.robotaxi_vehicle_id = v.id) AS total_trip_count,
         (SELECT MIN(t.ride_date) FROM ${RIDES_FROM}
           WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}) AS first_counted_ride_date,
         (SELECT MAX(t.ride_date) FROM ${RIDES_FROM}
           WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}) AS last_counted_ride_date,
         (SELECT COUNT(*) FROM robotaxi_vehicles v2
           WHERE v.license_plate IS NOT NULL
             AND ${sqlNormalizedPlate('v2.license_plate')} = ${sqlNormalizedPlate('v.license_plate')}) AS plate_vehicle_count,
         ${LAST_REVIEW('action')} AS last_review_action,
         ${LAST_REVIEW('created_at')} AS last_review_at,
         ${LAST_REVIEW('moderator_user_id')} AS last_review_moderator_id,
         (SELECT u.display_name FROM users u WHERE u.id = ${LAST_REVIEW('moderator_user_id')}) AS last_review_moderator_name
  FROM robotaxi_vehicles v
`;

// Factual approval readiness, computed once on the server so the UI never
// re-derives rules. NOT a score: every entry is a plain fact from the
// database.
//   blocking_reasons  — why a moderator cannot approve it right now
//   notes             — other facts worth seeing (never blocking on their own)
// state: 'public'                 visible on the public site
//        'eligible_for_approval'  private, and approval would be accepted
//        'not_eligible'           private (or public-but-hidden) and NOT
//                                 publicly eligible / approvable, with reasons
function evaluateVehicleApproval(row) {
  const counted = row.counted_ride_count;
  const fromSighting = row.origin === 'sighting';
  const blocking = [];
  const notes = [];

  if (!normalizePlate(row.license_plate)) blocking.push('no_plate');
  // A sighting-origin vehicle has no ride by construction; the VIN requirement
  // that stands in for it is added at the response level by approve_cybercab
  // ('no_vin'), exactly as for every vehicle.
  if (counted === 0 && !fromSighting) blocking.push('no_counted_rides');
  if (row.plate_vehicle_count > 1) blocking.push('duplicate_plate');

  if (counted > 0) notes.push('eligible_counted_ride_present');
  if (fromSighting) notes.push('added_from_sighting');
  if (row.needs_review_ride_count > 0) notes.push('needs_review_ride_present');
  if (counted === 0 && row.needs_review_ride_count === 0 && row.rejected_ride_count > 0) notes.push('rejected_only_history');
  if (row.total_trip_count === 0 && !fromSighting) notes.push('no_rides_on_record');

  const isPublic = row.visibility === VEHICLE_VISIBILITY.PUBLIC;
  const publiclyEligible = isPublic && (counted > 0 || (fromSighting && !!row.vin));
  let state;
  if (isPublic) state = publiclyEligible ? 'public' : 'not_eligible';
  else state = blocking.length === 0 ? 'eligible_for_approval' : 'not_eligible';

  return { state, can_approve: !isPublic && blocking.length === 0, blocking_reasons: blocking, notes };
}

function toModeratorVehicle(row) {
  const approval = evaluateVehicleApproval(row);
  return {
    id: row.id,
    license_plate: row.license_plate,
    visibility: row.visibility,
    // 'receipt' (created by the receipt pipeline) or 'sighting' (added by a
    // moderator from a reviewed sighting — no ride behind it).
    origin: row.origin,
    // Set only by POST .../vin (a moderator manually entering what Robotaxi
    // Tracker showed them). Cybercab Hunter never derives, decodes, or infers
    // this — see migrations/0013's note.
    vin: row.vin || null,
    // The vehicle record's own status column ('unverified' by default). It is
    // NOT changed by anything in this workflow and says nothing about Tesla.
    verification_status: row.verification_status,
    counted_ride_count: row.counted_ride_count,
    // Facts about the rest of what is attached to the vehicle.
    needs_review_ride_count: row.needs_review_ride_count,
    rejected_ride_count: row.rejected_ride_count,
    total_trip_count: row.total_trip_count,
    // Provenance: how the counted rides entered the system (descriptive
    // counts of the same rides, not a judgment about them).
    counted_rides_by_source: {
      receipt_email: row.counted_email,
      receipt_import: row.counted_import,
      other: row.counted_ride_count - row.counted_email - row.counted_import
    },
    first_counted_ride_date: row.first_counted_ride_date,
    last_counted_ride_date: row.last_counted_ride_date,
    // Registry timestamps: when the ROW was created / last touched by a
    // receipt. Database facts, not evidence the vehicle exists.
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    // The same rule the public endpoints apply: setting visibility public is
    // necessary but NOT sufficient — a counted ride is also required.
    publicly_eligible: row.visibility === VEHICLE_VISIBILITY.PUBLIC
      && (row.counted_ride_count > 0 || (row.origin === 'sighting' && !!row.vin)),
    plate_vehicle_count: row.plate_vehicle_count,
    approval: approval,
    // A SEPARATE gate from approval.can_approve, never a replacement for it:
    // everything approval.can_approve already requires, PLUS a VIN already
    // saved. evaluateVehicleApproval itself is untouched — Cybercab Hunter
    // still does not know or guess whether this vehicle IS a Cybercab; a
    // moderator's own choice to click Approve Cybercab (only enabled once a
    // vin exists) is what asserts that, never anything computed here.
    can_approve_cybercab: approval.can_approve && !!row.vin,
    // Most recent moderator decision on this vehicle, or null if none has
    // ever been recorded (e.g. it was made private by the legacy cleanup).
    latest_review: row.last_review_action ? {
      action: row.last_review_action,
      created_at: row.last_review_at,
      moderator_user_id: row.last_review_moderator_id,
      moderator_display_name: row.last_review_moderator_name || null
    } : null
  };
}

// scope 'awaiting' (default): not public, but has a counted ride — i.e.
// candidates for approval. scope 'private': every non-public vehicle, including
// ones with no counted rides (so nothing hides from review). scope 'public':
// currently public rows, for auditing/takedown. A plate search ignores scope and returns every row
// (any visibility) for that normalized plate, so duplicates are visible.
async function getRegistryVehiclesForModeration(sql, { plate, scope, limit = 50 } = {}) {
  let where; const binds = [];
  const normalized = plate ? normalizePlate(plate) : '';
  if (plate) {
    where = normalized ? `WHERE ${sqlNormalizedPlate('v.license_plate')} = ?` : 'WHERE 0';
    if (normalized) binds.push(normalized);
  } else if (scope === 'public') {
    where = `WHERE v.visibility = '${VEHICLE_VISIBILITY.PUBLIC}'`;
  } else if (scope === 'private') {
    where = `WHERE v.visibility <> '${VEHICLE_VISIBILITY.PUBLIC}'`;
  } else {
    where = `WHERE v.visibility <> '${VEHICLE_VISIBILITY.PUBLIC}' AND (v.origin = 'sighting' OR EXISTS (
      SELECT 1 FROM ${RIDES_FROM} WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}))`;
  }
  const result = await sql.prepare(`
    ${REGISTRY_VEHICLE_MOD_SELECT} ${where}
    ORDER BY v.last_seen_at DESC, v.id ASC LIMIT ?
  `).bind(...binds, limit).all();
  return (result.results || []).map(toModeratorVehicle);
}

async function getRegistryVehicleForModeration(sql, vehicleId) {
  const row = await sql.prepare(`${REGISTRY_VEHICLE_MOD_SELECT} WHERE v.id = ?`).bind(vehicleId).first();
  return row ? toModeratorVehicle(row) : null;
}

// Companion to deleteRegistryVehicle, always run alongside it. Removes every
// trip currently linked to this vehicle — ANY rider's, not just one — along
// with the submissions, receipt_ingestions log rows and superseded
// duplicates behind them (same shape as db-rides.js's deleteRideForUser,
// generalized from "one rider's one trip" to "every trip on this vehicle").
// This is what actually frees a receipt to be resent and reprocessed from
// scratch: the dedupe in worker/ride-ingest.js checks whether a trip with
// the same receipt_hash OR the same ride_key (date+time+plate) still exists,
// and neither check cares whether that trip's robotaxi_vehicle_id is set —
// only deleting the trip itself clears both.
//
// This deletes a RIDER's own private ride data (fare, pickup/dropoff
// descriptions) — not just a registry row — for whichever rider(s) logged a
// ride on this vehicle, which may not be the moderator performing the
// delete. Deliberate product decision: deleting a vehicle from the registry
// means deleting everything that made it exist.
async function purgeVehicleRides(sql, vehicleId) {
  const primary = await sql.prepare(`
    SELECT t.id, t.submission_id, s.evidence_ref
    FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.robotaxi_vehicle_id = ?
  `).bind(vehicleId).all();
  const primaryRows = primary.results || [];
  if (primaryRows.length === 0) return { deletedTrips: 0, evidenceRefs: [] };

  const placeholders = primaryRows.map(() => '?').join(',');
  const dupes = await sql.prepare(`
    SELECT t.id, t.submission_id, s.evidence_ref
    FROM trips t JOIN submissions s ON s.id = t.submission_id
    WHERE t.superseded_by IN (${placeholders})
  `).bind(...primaryRows.map(r => r.id)).all();
  const dupeRows = dupes.results || [];

  // Duplicates deleted before the primaries they point at (superseded_by is
  // ON DELETE SET NULL — see deleteRideForUser's identical comment).
  const allRows = [...dupeRows, ...primaryRows];
  const evidenceRefs = allRows.filter(r => r.evidence_ref).map(r => r.evidence_ref);
  const submissionIds = [...new Set(allRows.map(r => r.submission_id))];

  const statements = allRows.map(r => sql.prepare(`DELETE FROM receipt_ingestions WHERE trip_id = ?`).bind(r.id));
  for (const r of dupeRows) statements.push(sql.prepare(`DELETE FROM trips WHERE id = ?`).bind(r.id));
  for (const r of primaryRows) statements.push(sql.prepare(`DELETE FROM trips WHERE id = ?`).bind(r.id));
  for (const sid of submissionIds) statements.push(sql.prepare(`DELETE FROM submissions WHERE id = ? AND submission_type = 'ride_receipt'`).bind(sid));

  await sql.batch(statements);
  return { deletedTrips: allRows.length, evidenceRefs };
}

// Hard delete of a registry vehicle (e.g. resolving a duplicate plate, or
// removing a row created in error). Always takes every trip logged against
// it with it (purgeVehicleRides — see its own comment for why: only that
// actually frees the underlying receipt to be resent). Review-history rows
// (robotaxi_vehicle_reviews) intentionally have no foreign key and are left
// in place regardless, as a record of what a moderator once decided (see
// migrations/0012's design notes) — this is the one place a
// robotaxi_vehicle_id in that table can point at a vehicle that no longer
// exists, by design.
// Returns { deleted, evidenceRefs } — evidenceRefs is any receipt evidence
// the caller must also delete from R2.
async function deleteRegistryVehicle(sql, vehicleId) {
  const purge = await purgeVehicleRides(sql, vehicleId);
  const result = await sql.prepare(`DELETE FROM robotaxi_vehicles WHERE id = ?`).bind(vehicleId).run();
  return { deleted: !!(result && result.meta && result.meta.changes > 0), evidenceRefs: purge.evidenceRefs };
}

// Re-asserts 'private' on a vehicle that is already private (the idempotent
// no-op of the takedown PATCH, which writes no history). It refuses any other
// value, so it can never be used to grant public visibility.
async function setRobotaxiVehicleVisibility(sql, vehicleId, visibility) {
  if (visibility !== VEHICLE_VISIBILITY.PRIVATE) {
    throw new Error('setRobotaxiVehicleVisibility can only set private; use changeRobotaxiVehicleVisibility for a reviewed change to public');
  }
  const result = await sql.prepare(
    `UPDATE robotaxi_vehicles SET visibility = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(visibility, vehicleId).run();
  return !!(result && result.meta && result.meta.changes > 0);
}

// Records a VIN a moderator read directly off Robotaxi Tracker (worker/moderation.js's
// POST .../vin). Writes ONLY vin/vin_set_by_user_id/vin_set_at — never
// visibility, never a robotaxi_vehicle_reviews row, and (the WHERE clause
// below) never overwrites an existing non-null vin: this statement's own
// changes count is 0 if one is already set, so the caller can tell "no such
// vehicle" and "vin already set" apart with one extra read, exactly like
// changeRobotaxiVehicleVisibility's applied/not-applied pattern.
// Returns whether the write happened.
async function setRegistryVehicleVin(sql, vehicleId, moderatorId, vin) {
  const result = await sql.prepare(`
    UPDATE robotaxi_vehicles
    SET vin = ?, vin_set_by_user_id = ?, vin_set_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND vin IS NULL
  `).bind(vin, moderatorId, vehicleId).run();
  return !!(result && result.meta && result.meta.changes > 0);
}

// The audited, atomic visibility change behind every moderator decision.
//
// One batch (a single transaction) runs two statements with the SAME
// predicate: an INSERT of the review-history row, then the visibility UPDATE.
// Because neither touches what the predicate reads (vehicles/trips/submissions),
// they succeed or skip together — a vehicle never changes visibility without a
// history row, and a history row is never written for a change that did not
// happen. The history row snapshots the facts at decision time (plate, counted
// rides, how many registry rows share the plate) plus who acted and when.
//
// This is the ONLY function that can make a vehicle public, and it can only do
// so through vehicleApprovalGuardSql(): there is deliberately no option to skip
// that guard, so no caller (route, script, or future code) can grant public
// visibility without the approval rules being checked inside the write itself.
// Making a vehicle PRIVATE has no guard (a takedown must always be possible).
//
// History is append-only: nothing in the application UPDATEs or DELETEs
// robotaxi_vehicle_reviews.
// Returns { applied }. Not applied means the vehicle does not exist, is
// already in the target state, or (to public) no longer meets the guard.
// cybercabApproval (only ever passed true for the approve_cybercab action —
// see worker/moderation.js) also sets model/color/service_area in the SAME
// atomic UPDATE, since Approve Cybercab can only ever run once per
// private-to-public transition (the vehicle must already be private, per
// apiReviewRegistryVehicle's own guard) and IS the moderator's deliberate
// assertion that this vehicle is a Cybercab — not an inference from the vin.
// model/color are unconditionally 'Cybercab'/'Gold' (every Cybercab in this
// fleet is that model and color); service_area is fill-only, from the
// vehicle's OWN earliest counted ride (never a community sighting — that
// remains reviewVehicleSighting's separate, untouched fill path).
async function changeRobotaxiVehicleVisibility(sql, { vehicleId, moderatorId, target, reason, cybercabApproval = false }) {
  const action = target === VEHICLE_VISIBILITY.PUBLIC ? 'approved_public' : 'returned_private';
  const guard = target === VEHICLE_VISIBILITY.PUBLIC
    ? vehicleApprovalGuardSql('robotaxi_vehicles')
    : '1 = 1';
  const plateOuter = sqlNormalizedPlate('robotaxi_vehicles.license_plate');
  const cybercabFields = cybercabApproval ? `,
      model = 'Cybercab',
      color = 'Gold',
      service_area = COALESCE(service_area, (
        SELECT t.service_area FROM ${RIDES_FROM}
        WHERE t.robotaxi_vehicle_id = robotaxi_vehicles.id AND ${COUNTED_RIDES_WHERE}
          AND t.service_area IS NOT NULL AND t.service_area <> ''
        ORDER BY t.ride_date ASC, t.rowid ASC LIMIT 1
      ))` : '';

  const insert = sql.prepare(`
    INSERT INTO robotaxi_vehicle_reviews
      (id, robotaxi_vehicle_id, license_plate, moderator_user_id, action, previous_visibility, reason,
       counted_ride_count, plate_vehicle_count)
    SELECT ?, robotaxi_vehicles.id, robotaxi_vehicles.license_plate, ?, ?, robotaxi_vehicles.visibility, ?,
           (SELECT COUNT(*) FROM ${RIDES_FROM}
             WHERE t.robotaxi_vehicle_id = robotaxi_vehicles.id AND ${COUNTED_RIDES_WHERE}),
           (SELECT COUNT(*) FROM robotaxi_vehicles v2
             WHERE ${sqlNormalizedPlate('v2.license_plate')} = ${plateOuter})
    FROM robotaxi_vehicles
    WHERE robotaxi_vehicles.id = ? AND robotaxi_vehicles.visibility <> ? AND ${guard}
  `).bind(newId(), moderatorId, action, reason || null, vehicleId, target);

  const update = sql.prepare(`
    UPDATE robotaxi_vehicles SET visibility = ?, updated_at = datetime('now')${cybercabFields}
    WHERE id = ? AND visibility <> ? AND ${guard}
  `).bind(target, vehicleId, target);

  const results = await sql.batch([insert, update]);
  const updateResult = results[1];
  return { applied: !!(updateResult && updateResult.meta && updateResult.meta.changes > 0) };
}

// A vehicle's review history, newest first. Moderator-only: it names the
// moderator who acted. Never exposed by any public route.
async function getRobotaxiVehicleReviews(sql, vehicleId, limit = 100) {
  const result = await sql.prepare(`
    SELECT r.id, r.action, r.previous_visibility, r.reason, r.counted_ride_count, r.plate_vehicle_count,
           r.license_plate, r.created_at, r.moderator_user_id, u.display_name AS moderator_display_name
    FROM robotaxi_vehicle_reviews r
    LEFT JOIN users u ON u.id = r.moderator_user_id
    WHERE r.robotaxi_vehicle_id = ?
    ORDER BY r.created_at DESC, r.rowid DESC
    LIMIT ?
  `).bind(vehicleId, limit).all();
  return (result.results || []).map(r => ({ ...r, moderator_display_name: r.moderator_display_name || null }));
}

// Pure aggregate over this vehicle's known trips — deliberately excludes
// user_id and any pickup/dropoff text so a vehicle's history can be
// computed without ever exposing which user rode in it or where they
// went. Returns null fields (not zeros) when the vehicle has no trips yet,
// so callers can distinguish "no rides known" from "zero-mile rides."
async function getRobotaxiVehicleHistory(sql, vehicleId) {
  return sql.prepare(`
    SELECT
      COUNT(*) AS trip_count,
      MIN(t.ride_date) AS first_ride_date,
      MAX(t.ride_date) AS last_ride_date,
      SUM(t.distance) AS total_distance,
      SUM(t.fare_amount_cents) AS total_fare_cents,
      GROUP_CONCAT(DISTINCT t.service_area) AS service_areas
    FROM ${RIDES_FROM}
    WHERE t.robotaxi_vehicle_id = ? AND ${COUNTED_RIDES_WHERE}
  `).bind(vehicleId).first();
}

// ---- Robotaxi ride-history (ownerapi) connection — separate from tesla_connections ----

async function upsertRobotaxiOwnerConnection(sql, { userId, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt }) {
  await sql.prepare(`
    INSERT INTO robotaxi_owner_connections (id, user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, status, last_refresh_at)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      encrypted_access_token = excluded.encrypted_access_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      status = 'active',
      updated_at = datetime('now'),
      last_refresh_at = datetime('now')
  `).bind(newId(), userId, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt).run();
}

async function getRobotaxiOwnerConnectionByUserId(sql, userId) {
  return sql.prepare(`SELECT * FROM robotaxi_owner_connections WHERE user_id = ?`).bind(userId).first();
}

async function updateRobotaxiOwnerConnectionTokens(sql, userId, { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt }) {
  await sql.prepare(`
    UPDATE robotaxi_owner_connections SET
      encrypted_access_token = ?,
      encrypted_refresh_token = ?,
      access_token_expires_at = ?,
      status = 'active',
      updated_at = datetime('now'),
      last_refresh_at = datetime('now')
    WHERE user_id = ?
  `).bind(encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt, userId).run();
}

async function markRobotaxiOwnerConnectionRevoked(sql, userId) {
  await sql.prepare(`UPDATE robotaxi_owner_connections SET status = 'revoked', updated_at = datetime('now') WHERE user_id = ?`).bind(userId).run();
}

// ---- Tesla Ride Sync — separate OAuth subsystem from Fleet API and from
// the earlier robotaxi_owner_connections experiment. Holds no token
// material itself; kv_token_key only points at the encrypted blob in
// TESLA_SESSIONS KV. ----

async function createTeslaRideSyncConnection(sql, { userId, kvTokenKey, accessTokenExpiresAt }) {
  await sql.prepare(`
    INSERT INTO tesla_ride_sync_connections (id, user_id, kv_token_key, status, connected_at, access_token_expires_at)
    VALUES (?, ?, ?, 'active', datetime('now'), ?)
    ON CONFLICT(user_id) DO UPDATE SET
      kv_token_key = excluded.kv_token_key,
      status = 'active',
      access_token_expires_at = excluded.access_token_expires_at,
      last_error = NULL,
      updated_at = datetime('now')
  `).bind(newId(), userId, kvTokenKey, accessTokenExpiresAt).run();
}

async function getTeslaRideSyncConnectionByUserId(sql, userId) {
  return sql.prepare(`SELECT * FROM tesla_ride_sync_connections WHERE user_id = ?`).bind(userId).first();
}

async function touchTeslaRideSyncRefresh(sql, userId, accessTokenExpiresAt) {
  await sql.prepare(`
    UPDATE tesla_ride_sync_connections SET
      access_token_expires_at = ?,
      status = 'active',
      last_error = NULL,
      last_refresh_at = datetime('now'),
      updated_at = datetime('now')
    WHERE user_id = ?
  `).bind(accessTokenExpiresAt, userId).run();
}

async function markTeslaRideSyncRevoked(sql, userId) {
  await sql.prepare(`
    UPDATE tesla_ride_sync_connections SET status = 'revoked', updated_at = datetime('now') WHERE user_id = ?
  `).bind(userId).run();
}

// error is a short internal code/message only — never a token, code, or
// raw Tesla response body.
async function markTeslaRideSyncError(sql, userId, error) {
  await sql.prepare(`
    UPDATE tesla_ride_sync_connections SET status = 'error', last_error = ?, updated_at = datetime('now') WHERE user_id = ?
  `).bind(String(error).slice(0, 200), userId).run();
}

export { VEHICLE_VISIBILITY };

export const db = {
  ...rideQueries,
  findOrCreateUserByTeslaIdentifier,
  upsertTeslaConnection,
  getTeslaConnectionByUserId,
  updateConnectionTokens,
  markConnectionRevoked,
  unlinkTeslaConnection,
  deleteConnectionAndVehicles,
  upsertVehicles,
  getVehiclesByOwner,
  countVehiclesByOwner,
  getUserById,
  findOrCreateUserByGoogleIdentity,
  updateUserSettings,
  touchUserSync,
  createSubmission,
  getSubmissionsByUser,
  getSubmissionForOwner,
  deleteSubmission,
  findOrCreateReceiptIngestionAddress,
  rotateReceiptIngestionAddress,
  getUserIdByActiveReceiptToken,
  findOrCreateRobotaxiVehicleByPlate,
  findRobotaxiVehicleByPlate,
  resolveRobotaxiVehicleByPlate,
  findRecentDuplicateSighting,
  createVehicleSighting,
  getPendingVehicleSightings,
  getVehicleSightingSubmission,
  reviewVehicleSighting,
  promoteSightingToRegistryVehicle,
  getPublicRobotaxiVehicle,
  getPublicRobotaxiVehicles,
  getPublicRegistryStats,
  getPublicVehicleSightings,
  getRegistryVehiclesForModeration,
  getRegistryVehicleForModeration,
  deleteRegistryVehicle,
  setRobotaxiVehicleVisibility,
  changeRobotaxiVehicleVisibility,
  setRegistryVehicleVin,
  getRobotaxiVehicleReviews,
  getRobotaxiVehicleHistory,
  upsertRobotaxiOwnerConnection,
  getRobotaxiOwnerConnectionByUserId,
  updateRobotaxiOwnerConnectionTokens,
  markRobotaxiOwnerConnectionRevoked,
  createTeslaRideSyncConnection,
  getTeslaRideSyncConnectionByUserId,
  touchTeslaRideSyncRefresh,
  markTeslaRideSyncRevoked,
  markTeslaRideSyncError
};
