// DELETE /api/account  { "confirm": "DELETE" }   — the signed-in rider deletes
// their OWN account and all of their data. The account is always the one the
// session belongs to: no user id, handle or email is ever read from the request.
//
//   401 unauthenticated · 400 confirmation_required · 429 rate_limited
//   409 last_moderator (the only moderator can't delete themselves — transfer
//   the role first) · 200 { success: true, deleted: true }
//
// What goes, in this order:
//   1. Gmail: Google's authorization is revoked (best effort) and the token
//      deleted — the same path as Rider Data's Disconnect.
//   2. D1, in ONE batch (a transaction: any failure rolls all of it back):
//      children before parents — receipt ingestions, the rider's trips
//      (superseded duplicates first), their Zones-map copies of approved
//      sightings, sightings, submissions, sync runs and connections (Tesla,
//      Tesla ride sync, Robotaxi owner, Gmail, Google), their own Tesla
//      vehicles (`vehicles` — the rider's private Tesla-account cars, NOT the
//      public registry), receipt addresses, then the users row. Shared records
//      that only NAME them as a moderator keep existing: submissions.reviewed_by
//      and robotaxi_vehicles.vin_set_by_user_id become NULL. The moderator
//      approval history (robotaxi_vehicle_reviews) is append-only by design and
//      deliberately survives a moderator's account (migrations/0012): its
//      moderator_user_id keeps the now-orphaned random id — no name, email or
//      users row behind it. It is the one place a deleted id can remain, and
//      only for moderators.
//      The public registry (robotaxi_vehicles) is never deleted. Discovery
//      credit and the leaderboard are computed live, so they update by
//      themselves (a receipt vehicle backed only by this rider's rides stops
//      being publicly eligible, exactly as when a rider deletes their rides).
//   3. R2: everything under evidence/<id>/, receipts/<id>/ and avatars/<id>/ (photos, receipt
//      files — including any no longer referenced), plus the Zones-map image
//      copies made from their sightings.
//   4. KV: Tesla ride-sync tokens, this session, and a tombstone
//      (deleted_user:<id hash>) that makes every OTHER session of the account
//      stop working at once (sessions are KV entries with no per-user index —
//      see tesla.requireUserId). It expires when the last session could have.
//   5. An audit record with the time and a SHA-256 hash of the id — no email,
//      name or raw id — in KV (account_deleted:<hash>) and the Worker log.

import { tesla } from './tesla.js';
import { gmail } from './gmail.js';

export const ACCOUNT_TOMBSTONE_TTL_SECONDS = 60 * 60 * 24 * 90;   // the longest a session lives
const CONFIRM = 'DELETE';
const USER_PREFIXES = id => [`evidence/${id}/`, `receipts/${id}/`, `avatars/${id}/`];

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Every R2 object under a prefix (paged).
async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of (res && res.objects) || []) keys.push(o.key);
    if (!res || !res.truncated) break;
    cursor = res.cursor;
  }
  return keys;
}

async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    try { await bucket.delete(keys.slice(i, i + 1000)); } catch (e) { /* best effort; the rows are already gone */ }
  }
}

export async function apiDeleteAccount(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || body.confirm !== CONFIRM) {
    return Response.json({ success: false, error: 'confirmation_required' }, { status: 400 });
  }

  const idHash = await sha256Hex(userId);
  if (env.ACCOUNT_DELETE_LIMITER) {
    let allowed = true;
    try { allowed = (await env.ACCOUNT_DELETE_LIMITER.limit({ key: `account-delete:${idHash}` })).success !== false; } catch (e) { /* fail open */ }
    if (!allowed) return Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  }

  const sql = env.cybercabhunter_db;
  const user = await sql.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return Response.json({ authenticated: false }, { status: 401 });
  if (user.role === 'moderator') {
    const mods = await sql.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'moderator'`).first();
    if (!mods || mods.n <= 1) {
      return Response.json({ success: false, error: 'last_moderator', message: 'You are the last moderator — transfer the role before deleting your account.' }, { status: 409 });
    }
  }

  // 1. Gmail: revoke at Google (best effort), then its rows go with the rest.
  try { await gmail.apiDisconnect(request, env, userId); } catch (e) { /* the token row is deleted below regardless */ }

  // What lives outside D1, gathered before the rows that point at it are gone.
  const [mapCopies, rideTokens] = await Promise.all([
    sql.prepare(`SELECT image_r2_key FROM camera_detections WHERE source_submission_id IN (SELECT id FROM submissions WHERE user_id = ?) AND image_r2_key IS NOT NULL`).bind(userId).all(),
    sql.prepare(`SELECT kv_token_key FROM tesla_ride_sync_connections WHERE user_id = ?`).bind(userId).all()
  ]);

  // 2. D1 — one transaction, children before parents.
  const mine = table => sql.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId);
  await sql.batch([
    mine('receipt_ingestions'),
    sql.prepare(`DELETE FROM trips WHERE user_id = ? AND superseded_by IS NOT NULL`).bind(userId),
    mine('trips'),
    sql.prepare(`DELETE FROM camera_detections WHERE source_submission_id IN (SELECT id FROM submissions WHERE user_id = ?)`).bind(userId),
    mine('vehicle_observations'),
    mine('submissions'),
    mine('ride_sync_runs'),
    mine('tesla_ride_sync_connections'),
    mine('robotaxi_owner_connections'),
    mine('gmail_processed_messages'),
    mine('gmail_connections'),
    mine('google_connections'),
    mine('tesla_connections'),
    sql.prepare(`DELETE FROM vehicles WHERE owner_user_id = ?`).bind(userId),
    mine('receipt_ingestion_addresses'),
    sql.prepare(`UPDATE submissions SET reviewed_by = NULL WHERE reviewed_by = ?`).bind(userId),
    sql.prepare(`UPDATE robotaxi_vehicles SET vin_set_by_user_id = NULL WHERE vin_set_by_user_id = ?`).bind(userId),
    sql.prepare(`DELETE FROM users WHERE id = ?`).bind(userId)
  ]);

  // 3. R2 — the rider's own folders, and their Zones-map copies.
  const bucket = env.EVIDENCE_BUCKET;
  if (bucket) {
    const keys = [];
    for (const prefix of USER_PREFIXES(userId)) {
      try { keys.push(...await listKeys(bucket, prefix)); } catch (e) { /* best effort */ }
    }
    for (const r of mapCopies.results || []) keys.push(r.image_r2_key);
    await deleteKeys(bucket, keys);
  }

  // 4. KV — tokens, this session, and the tombstone for every other session.
  const kv = env.TESLA_SESSIONS;
  for (const r of rideTokens.results || []) {
    if (r.kv_token_key) { try { await kv.delete(r.kv_token_key); } catch (e) { /* best effort */ } }
  }
  const sessionId = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (sessionId) { try { await kv.delete(`session:${sessionId}`); } catch (e) { /* best effort */ } }
  await kv.put(`deleted_user:${idHash}`, '1', { expirationTtl: ACCOUNT_TOMBSTONE_TTL_SECONDS });

  // 5. Audit — time and id hash only.
  const at = new Date().toISOString();
  try { await kv.put(`account_deleted:${idHash}`, JSON.stringify({ at })); } catch (e) { /* the log line below still records it */ }
  console.log(JSON.stringify({ event: 'account_deleted', at, user_hash: idHash }));

  return Response.json({ success: true, deleted: true });
}
