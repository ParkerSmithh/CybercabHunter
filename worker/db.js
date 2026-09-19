// D1 queries for Cybercab Hunter's users / Tesla connections / vehicles.
// Every query touching tesla_connections or vehicles is scoped by user_id —
// callers must resolve that from the session first; never from request input.

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
  await sql.prepare(`INSERT INTO users (id) VALUES (?)`).bind(id).run();
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
    `INSERT INTO users (id, display_name, avatar_url) VALUES (?, ?, ?)`
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
async function deleteSubmission(sql, submissionId, userId) {
  if (userId) {
    await sql.prepare(`DELETE FROM submissions WHERE id = ? AND user_id = ?`).bind(submissionId, userId).run();
  } else {
    await sql.prepare(`DELETE FROM submissions WHERE id = ?`).bind(submissionId).run();
  }
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

async function touchIngestionAddressReceived(sql, userId) {
  await sql.prepare(
    `UPDATE receipt_ingestion_addresses SET last_received_at = datetime('now') WHERE user_id = ?`
  ).bind(userId).run();
}

// Only matches a PRIOR successful (accepted/needs_review) ingestion — a
// rejected/parse_error/duplicate row must never itself count as "already
// processed," or a genuine retry of a real receipt could get silently
// swallowed as a false duplicate.
async function findIngestionByMessageId(sql, messageId) {
  return sql.prepare(`
    SELECT submission_id, trip_id, receipt_hash, parser_version
    FROM receipt_ingestions
    WHERE message_id = ? AND status IN ('accepted', 'needs_review')
    ORDER BY created_at DESC LIMIT 1
  `).bind(messageId).first();
}

async function findIngestionByHash(sql, receiptHash) {
  return sql.prepare(`
    SELECT submission_id, trip_id
    FROM receipt_ingestions
    WHERE receipt_hash = ? AND status IN ('accepted', 'needs_review')
    ORDER BY created_at DESC LIMIT 1
  `).bind(receiptHash).first();
}

async function createReceiptIngestion(sql, {
  id, userId, messageId, receiptHash, parserVersion, status,
  errorCode, errorMessage, submissionId, tripId
}) {
  await sql.prepare(`
    INSERT INTO receipt_ingestions
      (id, user_id, message_id, receipt_hash, parser_version, status, error_code, error_message, submission_id, trip_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, userId, messageId || null, receiptHash || null, parserVersion || null,
    status, errorCode || null, errorMessage || null, submissionId || null, tripId || null
  ).run();
}

async function markSubmissionNeedsReview(sql, submissionId) {
  await sql.prepare(
    `UPDATE submissions SET status = 'needs_review', updated_at = datetime('now') WHERE id = ?`
  ).bind(submissionId).run();
}

// Exact-plate match only — no fuzzy merging. A duplicate/near-duplicate
// plate across sources is a human moderation decision, not something this
// query silently resolves.
async function findOrCreateRobotaxiVehicleByPlate(sql, plate) {
  const existing = await sql.prepare(
    `SELECT id FROM robotaxi_vehicles WHERE license_plate = ? LIMIT 1`
  ).bind(plate).first();
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
  `).bind(id, plate).run();
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
      MIN(ride_date) AS first_ride_date,
      MAX(ride_date) AS last_ride_date,
      SUM(distance) AS total_distance,
      SUM(fare_amount_cents) AS total_fare_cents,
      GROUP_CONCAT(DISTINCT service_area) AS service_areas
    FROM trips
    WHERE robotaxi_vehicle_id = ?
  `).bind(vehicleId).first();
}

async function createTripFromReceipt(sql, {
  id, submissionId, userId, serviceArea, rideDate, distance, fareAmountCents,
  externalRideId, robotaxiVehicleId, sourceMessageId, receiptHash,
  pickupDescription, dropoffDescription, pickupTime, dropoffTime,
  durationMinutes, durationMinutesDerived
}) {
  await sql.prepare(`
    INSERT INTO trips
      (id, submission_id, user_id, service_area, ride_date, distance, fare_amount_cents,
       external_ride_id, robotaxi_vehicle_id, source, source_message_id, receipt_hash,
       pickup_description, dropoff_description, pickup_time, dropoff_time,
       duration_minutes, duration_minutes_derived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt_email', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, submissionId, userId, serviceArea || null, rideDate || null,
    distance ?? null, fareAmountCents ?? null, externalRideId || null,
    robotaxiVehicleId || null, sourceMessageId || null, receiptHash || null,
    pickupDescription || null, dropoffDescription || null,
    pickupTime || null, dropoffTime || null,
    durationMinutes ?? null, durationMinutesDerived ? 1 : 0
  ).run();
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

// ---- Rides (trips) — the authenticated user's own ride history ----

// Explicit column whitelist, never `SELECT *` — this is the boundary that
// keeps internal/sensitive columns (user_id itself, source_message_id,
// receipt_hash, evidence_ref, anything from receipt_ingestions) out of
// what the API can possibly return, regardless of what callers do with it.
async function getTripsByUser(sql, userId) {
  const result = await sql.prepare(`
    SELECT
      t.id, t.ride_date, t.service_area, t.distance, t.distance_unit,
      t.duration_minutes, t.duration_minutes_derived,
      t.pickup_description, t.pickup_time, t.dropoff_description, t.dropoff_time,
      t.fare_amount_cents, t.currency, t.external_ride_id, t.source,
      s.status AS submission_status,
      t.robotaxi_vehicle_id, t.created_at
    FROM trips t
    JOIN submissions s ON s.id = t.submission_id
    WHERE t.user_id = ?
    ORDER BY
      CASE WHEN t.ride_date IS NULL THEN 1 ELSE 0 END, t.ride_date DESC,
      CASE WHEN t.pickup_time IS NULL THEN 1 ELSE 0 END, t.pickup_time DESC,
      t.created_at DESC
  `).bind(userId).all();
  return result.results || [];
}

// ---- Rider profile — every figure below is derived live from trips/
// robotaxi_vehicles/submissions; nothing is stored as a counter. The five
// queries are independent of each other, so they run as one D1 batch()
// round-trip rather than five sequential awaits.
//
// "Vehicles discovered by this user" has no dedicated column anywhere —
// robotaxi_vehicles is deliberately ownerless. It's derived instead: the
// user whose trip is the EARLIEST (created_at) trip referencing a given
// vehicle is, by definition, whoever discovered it first.
async function getUserProfile(sql, userId) {
  const rideSummaryStmt = sql.prepare(`
    SELECT
      COUNT(*) AS trip_count,
      MIN(ride_date) AS first_ride_date,
      MAX(ride_date) AS last_ride_date,
      SUM(distance) AS total_distance,
      AVG(distance) AS avg_distance,
      COUNT(distance) AS rides_with_distance,
      MAX(distance) AS longest_ride_distance,
      COUNT(DISTINCT robotaxi_vehicle_id) AS unique_vehicles
    FROM trips WHERE user_id = ?
  `).bind(userId);

  const citiesStmt = sql.prepare(`
    SELECT service_area, COUNT(*) AS ride_count
    FROM trips WHERE user_id = ? AND service_area IS NOT NULL
    GROUP BY service_area ORDER BY ride_count DESC
  `).bind(userId);

  const providersStmt = sql.prepare(`
    SELECT provider, COUNT(*) AS ride_count
    FROM trips WHERE user_id = ?
    GROUP BY provider ORDER BY ride_count DESC
  `).bind(userId);

  const discoveredVehiclesStmt = sql.prepare(`
    SELECT v.id, v.license_plate, v.model, v.color, v.service_area, v.verification_status, v.first_seen_at
    FROM robotaxi_vehicles v
    JOIN (
      SELECT robotaxi_vehicle_id, user_id,
             ROW_NUMBER() OVER (PARTITION BY robotaxi_vehicle_id ORDER BY created_at ASC) AS rn
      FROM trips
      WHERE robotaxi_vehicle_id IS NOT NULL
    ) first_trip ON first_trip.robotaxi_vehicle_id = v.id AND first_trip.rn = 1
    WHERE first_trip.user_id = ?
    ORDER BY v.first_seen_at ASC
  `).bind(userId);

  const contributionsStmt = sql.prepare(
    `SELECT COUNT(*) AS count FROM submissions WHERE user_id = ?`
  ).bind(userId);

  const [rideSummary, cities, providers, discoveredVehicles, contributions] = await sql.batch([
    rideSummaryStmt, citiesStmt, providersStmt, discoveredVehiclesStmt, contributionsStmt
  ]);

  return {
    rideSummary: rideSummary.results?.[0] || null,
    cities: cities.results || [],
    providers: providers.results || [],
    discoveredVehicles: discoveredVehicles.results || [],
    contributionCount: contributions.results?.[0]?.count ?? 0
  };
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
  touchIngestionAddressReceived,
  findIngestionByMessageId,
  findIngestionByHash,
  createReceiptIngestion,
  markSubmissionNeedsReview,
  findOrCreateRobotaxiVehicleByPlate,
  getRobotaxiVehicleHistory,
  createTripFromReceipt,
  upsertRobotaxiOwnerConnection,
  getRobotaxiOwnerConnectionByUserId,
  updateRobotaxiOwnerConnectionTokens,
  markRobotaxiOwnerConnectionRevoked,
  getTripsByUser,
  getUserProfile,
  createTeslaRideSyncConnection,
  getTeslaRideSyncConnectionByUserId,
  touchTeslaRideSyncRefresh,
  markTeslaRideSyncRevoked,
  markTeslaRideSyncError
};
