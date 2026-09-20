// D1 queries for Cybercab Hunter's users / Tesla connections / vehicles.
// Every query touching tesla_connections or vehicles is scoped by user_id —
// callers must resolve that from the session first; never from request input.

import { rideQueries } from './db-rides.js';
import { RIDES_FROM, COUNTED_RIDES_WHERE } from './ride-status.js';

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

async function getSubmissionsByUser(sql, userId) {
  const result = await sql.prepare(`
    SELECT id, submission_type, evidence_type, status, submitted_at, reviewed_at, rejection_reason
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

// Exact-plate match only — no fuzzy merging. A duplicate/near-duplicate
// plate across sources is a human moderation decision, not something this
// query silently resolves. "Exact" means after normalization (case, spaces
// and hyphens ignored), so "XJR-2195" and "xjr2195" are the same plate —
// the receipt parser and the registry must agree on what a plate is, or
// one physical car would be counted as two vehicles.
async function findOrCreateRobotaxiVehicleByPlate(sql, plate) {
  const existing = await sql.prepare(
    `SELECT id FROM robotaxi_vehicles
     WHERE UPPER(REPLACE(REPLACE(license_plate, '-', ''), ' ', '')) = ? LIMIT 1`
  ).bind(String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '')).first();
  if (existing) {
    // Every new sighting of an already-known plate should advance
    // last_seen_at — otherwise "most recent known ride" can never be
    // answered correctly once a vehicle has more than one trip.
    await sql.prepare(
      `UPDATE robotaxi_vehicles SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).bind(existing.id).run();
    return existing.id;
  }

  const id = newId();
  await sql.prepare(`
    INSERT INTO robotaxi_vehicles (id, license_plate, first_seen_at, last_seen_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `).bind(id, String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '')).run();
  return id;
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
  getUserIdByActiveReceiptToken,
  findOrCreateRobotaxiVehicleByPlate,
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
