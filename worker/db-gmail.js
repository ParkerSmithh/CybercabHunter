// D1 queries for the optional direct Gmail receipt import (worker/gmail.js,
// migrations/0015_gmail_connections.sql). Every function is scoped to one
// user_id. Nothing here ever reads, writes or returns message content; the
// only Gmail data stored is the rider's address, an opaque history position
// and opaque message ids. Spread into `db` by worker/db.js.

function newId() {
  return crypto.randomUUID();
}

// The connection row WITHOUT the encrypted token — safe to hand to anything
// that builds a status response.
async function getGmailConnectionStatus(sql, userId) {
  return (await sql.prepare(`
    SELECT user_id, email, status, history_id IS NOT NULL AS has_history,
           backfill_completed_at, sync_lock_until, last_checked_at, last_success_at,
           last_receipt_at, last_error, connected_at, updated_at
    FROM gmail_connections WHERE user_id = ?
  `).bind(userId).first()) || null;
}

// The full row, including the encrypted refresh token. Server-side use only.
async function getGmailConnectionForSync(sql, userId) {
  return (await sql.prepare(`SELECT * FROM gmail_connections WHERE user_id = ?`).bind(userId).first()) || null;
}

// Connect (or reconnect): one row per rider, replaced in place. Resets all
// sync state so a reconnect starts cleanly with a fresh bounded backfill.
async function upsertGmailConnection(sql, { userId, googleSub, email, encryptedRefreshToken, historyId }) {
  await sql.prepare(`
    INSERT INTO gmail_connections (id, user_id, google_sub, email, status, encrypted_refresh_token, history_id)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      google_sub = excluded.google_sub,
      email = excluded.email,
      status = 'active',
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      history_id = excluded.history_id,
      backfill_completed_at = NULL,
      sync_lock_until = NULL,
      last_checked_at = NULL,
      last_success_at = NULL,
      last_receipt_at = NULL,
      last_error = NULL,
      connected_at = datetime('now'),
      updated_at = datetime('now')
  `).bind(newId(), userId, googleSub, email || null, encryptedRefreshToken, historyId || null).run();
}

// Active connections that haven't been checked recently, oldest first.
async function listGmailConnectionsDue(sql, { olderThanMinutes, limit }) {
  const rows = await sql.prepare(`
    SELECT user_id FROM gmail_connections
    WHERE status = 'active' AND encrypted_refresh_token IS NOT NULL
      AND (last_checked_at IS NULL OR last_checked_at <= datetime('now', ?))
    ORDER BY COALESCE(last_checked_at, '') ASC
    LIMIT ?
  `).bind(`-${olderThanMinutes} minutes`, limit).all();
  return (rows.results || []).map(r => r.user_id);
}

// A short lease so two overlapping runs never sync one mailbox at once.
// Returns true only for the caller that obtained it.
async function acquireGmailSyncLock(sql, userId, minutes) {
  const result = await sql.prepare(`
    UPDATE gmail_connections SET sync_lock_until = datetime('now', ?)
    WHERE user_id = ? AND status = 'active' AND encrypted_refresh_token IS NOT NULL
      AND (sync_lock_until IS NULL OR sync_lock_until <= datetime('now'))
  `).bind(`+${minutes} minutes`, userId).run();
  return !!(result && result.meta && result.meta.changes > 0);
}

// A completed sync: the ONLY place history_id advances.
async function finishGmailSyncSuccess(sql, userId, { historyId, backfillDone, foundReceipt }) {
  await sql.prepare(`
    UPDATE gmail_connections SET
      history_id = COALESCE(?, history_id),
      backfill_completed_at = CASE WHEN ? THEN COALESCE(backfill_completed_at, datetime('now')) ELSE backfill_completed_at END,
      last_receipt_at = CASE WHEN ? THEN datetime('now') ELSE last_receipt_at END,
      last_checked_at = datetime('now'),
      last_success_at = datetime('now'),
      last_error = NULL,
      sync_lock_until = NULL,
      updated_at = datetime('now')
    WHERE user_id = ? AND status = 'active'
  `).bind(historyId || null, backfillDone ? 1 : 0, foundReceipt ? 1 : 0, userId).run();
}

// A failed sync: history_id and backfill state are left exactly as they
// were, so the next run retries from the same point.
async function finishGmailSyncFailure(sql, userId, errorCode) {
  await sql.prepare(`
    UPDATE gmail_connections SET
      last_checked_at = datetime('now'), last_error = ?, sync_lock_until = NULL, updated_at = datetime('now')
    WHERE user_id = ?
  `).bind(errorCode, userId).run();
}

// Google no longer accepts the authorization: clear the token (it is
// useless) and ask the rider to reconnect. Existing rides are untouched.
async function markGmailReauthorizationRequired(sql, userId, errorCode) {
  await sql.prepare(`
    UPDATE gmail_connections SET
      status = 'error', encrypted_refresh_token = NULL, sync_lock_until = NULL,
      last_checked_at = datetime('now'), last_error = ?, updated_at = datetime('now')
    WHERE user_id = ?
  `).bind(errorCode, userId).run();
}

// Google rotated the refresh token: store the new one (already encrypted).
async function updateGmailRefreshToken(sql, userId, encryptedRefreshToken) {
  await sql.prepare(`
    UPDATE gmail_connections SET encrypted_refresh_token = ?, updated_at = datetime('now')
    WHERE user_id = ? AND status = 'active'
  `).bind(encryptedRefreshToken, userId).run();
}

// Disconnect: token, history and processed-message records are deleted; the
// row stays (status 'revoked') so the rider's status reads "not connected".
// Rides already imported are NOT deleted — Rider Data's own Remove controls
// that, separately.
async function disconnectGmailConnection(sql, userId) {
  await sql.batch([
    sql.prepare(`
      UPDATE gmail_connections SET
        status = 'revoked', encrypted_refresh_token = NULL, history_id = NULL,
        backfill_completed_at = NULL, sync_lock_until = NULL, last_error = NULL,
        updated_at = datetime('now')
      WHERE user_id = ?
    `).bind(userId),
    sql.prepare(`DELETE FROM gmail_processed_messages WHERE user_id = ?`).bind(userId)
  ]);
}

async function isGmailMessageProcessed(sql, userId, gmailMessageId) {
  return !!(await sql.prepare(
    `SELECT 1 AS ok FROM gmail_processed_messages WHERE user_id = ? AND gmail_message_id = ?`
  ).bind(userId, gmailMessageId).first());
}

// Idempotent: a message recorded twice keeps its first outcome.
async function markGmailMessageProcessed(sql, userId, gmailMessageId, outcome) {
  await sql.prepare(`
    INSERT INTO gmail_processed_messages (user_id, gmail_message_id, outcome) VALUES (?, ?, ?)
    ON CONFLICT(user_id, gmail_message_id) DO NOTHING
  `).bind(userId, gmailMessageId, outcome).run();
}

// Processed-message ids only need to outlive the widest search window; older
// ones are dropped so no long-term list of mailbox ids accumulates.
async function pruneGmailProcessedMessages(sql, olderThanDays) {
  await sql.prepare(
    `DELETE FROM gmail_processed_messages WHERE processed_at < datetime('now', ?)`
  ).bind(`-${olderThanDays} days`).run();
}

// The Google account the rider signed in with, if any — a Gmail connection
// must belong to that same Google account. { google_sub, email } or null.
async function getGoogleIdentityForUser(sql, userId) {
  const row = await sql.prepare(`SELECT google_sub, email FROM google_connections WHERE user_id = ?`).bind(userId).first();
  return row && row.google_sub ? { google_sub: row.google_sub, email: row.email || null } : null;
}

export const gmailQueries = {
  getGmailConnectionStatus,
  getGmailConnectionForSync,
  upsertGmailConnection,
  listGmailConnectionsDue,
  acquireGmailSyncLock,
  finishGmailSyncSuccess,
  finishGmailSyncFailure,
  markGmailReauthorizationRequired,
  updateGmailRefreshToken,
  disconnectGmailConnection,
  isGmailMessageProcessed,
  markGmailMessageProcessed,
  pruneGmailProcessedMessages,
  getGoogleIdentityForUser
};
