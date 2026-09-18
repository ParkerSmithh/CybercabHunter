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

// Soft revoke: used by /api/tesla/disconnect. Keeps the row (with its
// history) and the user's vehicles intact — only flips status so it's no
// longer usable to call Tesla's API.
async function markConnectionRevoked(sql, userId) {
  await sql.prepare(`UPDATE tesla_connections SET status = 'revoked', updated_at = datetime('now') WHERE user_id = ?`).bind(userId).run();
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
  if (existing) return existing.id;

  const id = newId();
  await sql.prepare(`
    INSERT INTO robotaxi_vehicles (id, license_plate, first_seen_at, last_seen_at)
    VALUES (?, ?, datetime('now'), datetime('now'))
  `).bind(id, plate).run();
  return id;
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

export const db = {
  findOrCreateUserByTeslaIdentifier,
  upsertTeslaConnection,
  getTeslaConnectionByUserId,
  updateConnectionTokens,
  markConnectionRevoked,
  deleteConnectionAndVehicles,
  upsertVehicles,
  getVehiclesByOwner,
  countVehiclesByOwner,
  getUserById,
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
  createTripFromReceipt,
  upsertRobotaxiOwnerConnection,
  getRobotaxiOwnerConnectionByUserId,
  updateRobotaxiOwnerConnectionTokens,
  markRobotaxiOwnerConnectionRevoked
};
