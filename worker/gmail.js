// Optional direct Gmail receipt import — a SECOND source for the existing
// receipt pipeline, alongside (never replacing) the forwarding address in
// worker/receipt-ingestion.js:
//
//   Tesla → rider's Gmail → Gmail API (this file) → parseRawEmail →
//   processReceiptMessage(…, 'gmail_api', …) → the same extraction,
//   classification, dedupe, vehicle lookup and ride creation as every other
//   receipt.
//
// Authorization is a separate Google OAuth flow run by an already signed-in
// rider ("Connect Gmail" on Rider Data). Normal Google sign-in
// (worker/google-auth.js) is untouched and never asks for Gmail access. It
// uses its own OAuth client (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) and its
// own encryption key (GMAIL_TOKEN_ENCRYPTION_KEY); until all three are set,
// every entry point reports "not configured" and the scheduled sync does
// nothing.
//
// Scope: gmail.readonly — Google classifies it as RESTRICTED. Production use
// beyond Google's testing limits requires Google's restricted-scope
// verification and security assessment; nothing here implies that approval.
//
// What is stored: an AES-256-GCM-encrypted refresh token, the rider's Gmail
// address, Gmail's opaque history position, and opaque ids of messages
// already processed. Access tokens live only in memory for one operation.
// Message bodies are parsed in memory and discarded, exactly as for
// forwarded mail; only the structured ride fields the pipeline extracts are
// kept. Nothing token- or content-bearing is ever logged or returned.
//
// Sync strategy (polling, every ~10 minutes via the scheduled handler):
//   1. First time: a bounded search for receipts from the last 90 days.
//   2. After that: users.history.list(messageAdded) since the stored
//      history position — used only to learn THAT new mail arrived; the
//      receipts themselves are found with a subject search, so unrelated
//      mail is never downloaded.
//   3. If Gmail no longer has that history (404), a bounded search covering
//      the time since the last successful sync.
//   4. Each matching message not yet processed is fetched once (raw MIME)
//      and run through the pipeline; the message id is then recorded.
//   5. The history position advances only when a sync completes; any
//      temporary failure leaves it where it was, so the next run retries.
// Structured so Gmail push notifications (watch + Pub/Sub) could later call
// syncUser() directly instead of waiting for the schedule.

import { tokenCrypto } from './crypto.js';
import { db } from './db.js';
import { parseRawEmail } from './receipt-parser.js';
import { processReceiptMessage, newCounts, addToCounts, runStatusFor } from './receipt-process.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPES = `openid email ${GMAIL_SCOPE}`;

// Real Tesla Robotaxi receipts are titled "Robotaxi Ride Receipt on <date>".
// The subject, not the sender, is searched: relays such as DuckDuckGo Email
// Protection rewrite the sender but not the subject. The receipt classifier
// still decides whether each match really is a Tesla receipt.
export const RECEIPT_QUERY = 'subject:"Robotaxi Ride Receipt"';

const STATE_TTL_SECONDS = 600;          // 10 minutes to finish Google's consent screen
const BACKFILL_DAYS = 90;               // the one-time search for existing receipts
const MIN_SEARCH_DAYS = 2;              // a recurring search always overlaps the last one
const MAX_MESSAGES_PER_SYNC = 50;       // per rider per run; the rest continue next run
const MAX_LIST_PAGES = 5;               // messages.list pages per search (100 ids each)
const MAX_HISTORY_PAGES = 10;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024; // same cap as the forwarding path
const LOCK_MINUTES = 10;
const DUE_AFTER_MINUTES = 9;
const RIDERS_PER_RUN = 25;
const RUN_BUDGET_MS = 25 * 1000;
const PROCESSED_RETENTION_DAYS = 120;   // > BACKFILL_DAYS, so a search never re-finds a pruned id

function config(env) {
  return {
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    key: env.GMAIL_TOKEN_ENCRYPTION_KEY,
    redirectUri: env.GMAIL_REDIRECT_URI || 'https://cybercabhunter.com/api/gmail/callback'
  };
}

export function isGmailConfigured(env) {
  const cfg = config(env);
  return !!(cfg.clientId && cfg.clientSecret && cfg.key);
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

// A Gmail/Google failure, classified so the sync knows what to do with it:
// `reauth` — the stored authorization is no longer usable (the rider must
// reconnect); otherwise temporary, and the next run simply retries. `code`
// is a short internal string — the only thing ever recorded in last_error.
class GmailError extends Error {
  constructor(code, { reauth = false } = {}) {
    super(code);
    this.code = code;
    this.reauth = reauth;
  }
}

function riderDataRedirect(env, result) {
  const target = new URL('rider-data', env.FRONTEND_URL || 'https://cybercabhunter.com/');
  target.searchParams.set('gmail', result);
  return Response.redirect(target.toString(), 302);
}

// Best-effort revocation: a failure here must never block disconnecting.
async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token })
    });
  } catch (err) { /* ignore */ }
}

// ---------------------------------------------------------------- connect

// POST /api/gmail/connect (signed in). Returns Google's authorization URL;
// the browser then navigates there. A plain JSON call (not a link) so the
// bearer session identifies the rider without ever appearing in a URL.
export async function apiConnect(request, env, userId) {
  if (!isGmailConfigured(env)) {
    return Response.json({ success: false, error: 'gmail_not_configured' }, { status: 503 });
  }
  const identity = await db.getGoogleIdentityForUser(env.cybercabhunter_db, userId);
  if (!identity) {
    // The connected Gmail must be verifiably the rider's own Google account,
    // which is only possible for a rider who signed in with Google.
    return Response.json({ success: false, error: 'google_signin_required' }, { status: 409 });
  }

  const cfg = config(env);
  const state = randomToken();
  await env.TESLA_SESSIONS.put(`gmail_state:${state}`, JSON.stringify({
    user_id: userId, google_sub: identity.google_sub, exp: Date.now() + STATE_TTL_SECONDS * 1000
  }), { expirationTtl: STATE_TTL_SECONDS });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');   // a refresh token, for syncing later
  url.searchParams.set('prompt', 'consent');        // Google re-issues the refresh token on reconnect
  if (identity.email) url.searchParams.set('login_hint', identity.email);
  return Response.json({ success: true, authorize_url: url.toString() });
}

// GET /api/gmail/callback — reached by Google's redirect (a full page
// navigation, so there is no bearer session here; the rider is identified
// ONLY by the single-use state created in apiConnect).
export async function handleCallback(request, env, ctx) {
  if (!isGmailConfigured(env)) return riderDataRedirect(env, 'unavailable');
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return riderDataRedirect(env, 'cancelled');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return riderDataRedirect(env, 'error');

  const stateKey = `gmail_state:${state}`;
  const raw = await env.TESLA_SESSIONS.get(stateKey);
  if (!raw) return riderDataRedirect(env, 'invalid_state');
  await env.TESLA_SESSIONS.delete(stateKey); // single use
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { return riderDataRedirect(env, 'invalid_state'); }
  if (!saved || !saved.user_id || !saved.google_sub) return riderDataRedirect(env, 'invalid_state');
  if (!(saved.exp > Date.now())) return riderDataRedirect(env, 'expired_state');

  const cfg = config(env);
  let tokens;
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri
      })
    });
    if (!resp.ok) throw new Error('token_exchange_failed');
    tokens = await resp.json();
  } catch (err) {
    return riderDataRedirect(env, 'token_exchange_failed');
  }

  // From here on, any refusal revokes what Google just issued, so no
  // unwanted grant is left behind on the rider's Google account.
  const refuse = async result => { await revokeToken(tokens.refresh_token || tokens.access_token); return riderDataRedirect(env, result); };

  // Google's consent screen lets the rider untick individual permissions.
  const granted = String(tokens.scope || '').split(/\s+/);
  if (!granted.includes(GMAIL_SCOPE)) return refuse('missing_permission');
  if (!tokens.refresh_token || !tokens.access_token) return refuse('error');

  let profile;
  try {
    const resp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!resp.ok) throw new Error('userinfo_failed');
    profile = await resp.json();
  } catch (err) {
    return refuse('error');
  }
  // The Gmail being connected must be the Google account this rider signed
  // in with — checked against both the state and the current record.
  const current = await db.getGoogleIdentityForUser(env.cybercabhunter_db, saved.user_id);
  if (!profile.sub || profile.sub !== saved.google_sub || !current || current.google_sub !== profile.sub) {
    return refuse('wrong_account');
  }

  // Record where the mailbox is now, so later syncs only look at new mail.
  let historyId;
  try {
    historyId = (await gmailJson(tokens.access_token, '/profile')).historyId || null;
  } catch (err) {
    return refuse('error');
  }

  const encryptedRefreshToken = await tokenCrypto.encrypt(tokens.refresh_token, cfg.key);
  await db.upsertGmailConnection(env.cybercabhunter_db, {
    userId: saved.user_id, googleSub: profile.sub, email: profile.email || null,
    encryptedRefreshToken, historyId: historyId ? String(historyId) : null
  });

  // Start the one-time search for existing receipts right away rather than
  // waiting for the next scheduled run.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(syncUser(env, saved.user_id).catch(() => {}));
  }
  return riderDataRedirect(env, 'connected');
}

// ----------------------------------------------------------------- status

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// GET /api/gmail/status (signed in) — the rider's own connection only.
export async function apiStatus(request, env, userId) {
  const configured = isGmailConfigured(env);
  // Not configured: answer without touching the database, so this is safe
  // even before migration 0015 has been applied.
  if (!configured) return Response.json({ success: true, configured: false, state: 'not_connected' });
  const row = await db.getGmailConnectionStatus(env.cybercabhunter_db, userId);
  let state = 'not_connected';
  if (row && row.status === 'error') state = 'reconnect_required';
  else if (row && row.status === 'active') {
    // A sync running right now is "syncing"; otherwise a recorded error wins,
    // including during the first import, so a failing first import shows as
    // an error rather than "importing" forever.
    if (row.sync_lock_until && row.sync_lock_until > sqlNow()) state = 'syncing';
    else if (row.last_error) state = 'error';
    else if (!row.backfill_completed_at) state = 'syncing';
    else state = 'connected';
  }
  const connected = !!row && row.status !== 'revoked';
  return Response.json({
    success: true,
    configured,
    state,
    email: connected ? row.email : null,
    connected_at: connected ? row.connected_at : null,
    initial_import_complete: connected ? !!row.backfill_completed_at : false,
    last_checked_at: connected ? row.last_checked_at : null,
    last_success_at: connected ? row.last_success_at : null,
    last_receipt_at: connected ? row.last_receipt_at : null,
    error: connected ? (row.last_error || null) : null
  });
}

// ------------------------------------------------------------- disconnect

// POST /api/gmail/disconnect (signed in). Revokes Google's authorization
// (best effort), then deletes the token, the sync state and the processed-
// message records. Rides already imported stay — Rider Data's Remove is
// how a rider deletes rides. Idempotent.
export async function apiDisconnect(request, env, userId) {
  const sql = env.cybercabhunter_db;
  const row = await db.getGmailConnectionForSync(sql, userId);
  if (row && row.encrypted_refresh_token && env.GMAIL_TOKEN_ENCRYPTION_KEY) {
    try {
      await revokeToken(await tokenCrypto.decrypt(row.encrypted_refresh_token, env.GMAIL_TOKEN_ENCRYPTION_KEY));
    } catch (err) { /* an undecryptable token can't be revoked; it is deleted below either way */ }
  }
  if (row) await db.disconnectGmailConnection(sql, userId);
  return Response.json({ success: true, state: 'not_connected' });
}

// ------------------------------------------------------------- Gmail API

// A fresh access token from the stored refresh token. Kept in memory only.
async function getAccessToken(env, row) {
  const cfg = config(env);
  let refreshToken;
  try {
    refreshToken = await tokenCrypto.decrypt(row.encrypted_refresh_token, cfg.key);
  } catch (err) {
    throw new GmailError('stored_token_unreadable', { reauth: true });
  }
  let resp;
  try {
    resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: cfg.clientId, client_secret: cfg.clientSecret
      })
    });
  } catch (err) {
    throw new GmailError('google_token_unavailable');
  }
  if (!resp.ok) {
    let body = {};
    try { body = await resp.json(); } catch (e) { /* non-JSON */ }
    // invalid_grant: revoked in Google, expired (7 days in Testing mode,
    // 6 months unused), or the rider changed their Google password.
    if (body.error === 'invalid_grant') throw new GmailError('reauthorization_required', { reauth: true });
    throw new GmailError(resp.status >= 500 ? 'google_token_unavailable' : 'google_token_rejected');
  }
  const tokens = await resp.json();
  if (!tokens.access_token) throw new GmailError('google_token_unavailable');
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    await db.updateGmailRefreshToken(env.cybercabhunter_db, row.user_id, await tokenCrypto.encrypt(tokens.refresh_token, cfg.key));
  }
  return tokens.access_token;
}

// GET a Gmail API path. Returns the JSON body, or null for 404 (the caller
// decides what "not found" means). Everything else becomes a GmailError.
async function gmailJson(accessToken, path) {
  let resp;
  try {
    resp = await fetch(GMAIL_API + path, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new GmailError('gmail_api_unavailable');
  }
  if (resp.status === 404) return null;
  if (resp.ok) return resp.json();
  if (resp.status === 401) throw new GmailError('reauthorization_required', { reauth: true });
  if (resp.status === 429) throw new GmailError('gmail_rate_limited');
  if (resp.status === 403) {
    let reason = '';
    try { reason = JSON.stringify(await resp.json()); } catch (e) { /* ignore */ }
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason)) throw new GmailError('gmail_rate_limited');
    // The Gmail API is disabled / not enabled in this app's Google Cloud
    // project: a problem with OUR configuration, not the rider's
    // authorization. Keep their token and retry on a later run.
    if (/accessNotConfigured|SERVICE_DISABLED/.test(reason)) throw new GmailError('gmail_api_disabled');
    throw new GmailError('gmail_permission_missing', { reauth: true });
  }
  throw new GmailError(resp.status >= 500 ? 'gmail_api_unavailable' : 'gmail_api_error');
}

// Ids of messages matching the receipt search within the last `days` days,
// newest first as Gmail returns them.
async function searchReceiptIds(accessToken, days) {
  const ids = [];
  let pageToken = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams({ q: `${RECEIPT_QUERY} newer_than:${days}d`, maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await gmailJson(accessToken, `/messages?${params}`);
    for (const m of (body && body.messages) || []) if (m && m.id) ids.push(m.id);
    pageToken = body && body.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

// Whether any message was added since `startHistoryId`, and the mailbox's
// current history position. `expired: true` when Gmail no longer has that
// history (404) — the caller falls back to a bounded search.
async function readHistory(accessToken, startHistoryId) {
  let pageToken = null;
  let added = false;
  let latest = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await gmailJson(accessToken, `/history?${params}`);
    if (body === null) return { expired: true };
    if ((body.history || []).some(h => (h.messagesAdded || []).length > 0)) added = true;
    if (body.historyId) latest = String(body.historyId);
    pageToken = body.nextPageToken;
    if (!pageToken) break;
    if (added) break; // the answer is already "yes"; the position is still current
  }
  return { expired: false, added, historyId: latest };
}

function base64UrlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Days to search so the window reaches back past the last successful sync.
function searchWindowDays(lastSuccessAt) {
  const t = lastSuccessAt ? Date.parse(String(lastSuccessAt).replace(' ', 'T') + 'Z') : NaN;
  if (!Number.isFinite(t)) return BACKFILL_DAYS;
  const days = Math.ceil((Date.now() - t) / 86400000) + 1;
  return Math.min(BACKFILL_DAYS, Math.max(MIN_SEARCH_DAYS, days));
}

// ------------------------------------------------------------------ sync

// Fetches one message and runs it through the existing pipeline. Returns
// the outcome recorded for it. Throws GmailError only for temporary Gmail
// failures (so the message is NOT marked processed and is retried).
async function processOneMessage(env, userId, accessToken, messageId, syncRunId) {
  const sql = env.cybercabhunter_db;
  const msg = await gmailJson(accessToken, `/messages/${encodeURIComponent(messageId)}?format=raw`);
  if (msg === null) return 'message_gone';                 // deleted since the search
  if (!msg.raw) return 'message_unreadable';
  if ((msg.sizeEstimate || 0) > MAX_MESSAGE_BYTES) return 'message_too_large';

  let parsed;
  try {
    parsed = await parseRawEmail(base64UrlToBytes(msg.raw));
  } catch (err) {
    await db.createReceiptIngestion(sql, {
      id: crypto.randomUUID(), userId, status: 'parse_error', outcome: 'error',
      errorCode: 'mime_parse_failed', syncRunId
    });
    return 'parse_error';
  }

  const result = await processReceiptMessage(env, parsed, 'gmail_api', {
    userId, syncRunId, evidenceType: 'gmail_message'
  });
  return result.outcome || 'error';
}

// One rider's sync. Safe to call at any time: it takes a short lease, and a
// second concurrent call simply returns { skipped: 'locked' }.
export async function syncUser(env, userId) {
  const sql = env.cybercabhunter_db;
  if (!isGmailConfigured(env)) return { skipped: 'not_configured' };
  const row = await db.getGmailConnectionForSync(sql, userId);
  if (!row || row.status !== 'active' || !row.encrypted_refresh_token) return { skipped: 'not_connected' };
  if (!(await db.acquireGmailSyncLock(sql, userId, LOCK_MINUTES))) return { skipped: 'locked' };

  const counts = newCounts();
  let runId = null;
  try {
    const accessToken = await getAccessToken(env, row);
    const backfill = !row.backfill_completed_at;

    // 1. Decide which window to search, and the history position to store
    //    if this sync completes — always read BEFORE searching, so a message
    //    arriving mid-sync is picked up next time rather than missed.
    let nextHistoryId = row.history_id;
    let searchDays = null;
    if (backfill || !row.history_id) {
      if (!row.history_id) {
        const profile = await gmailJson(accessToken, '/profile');
        nextHistoryId = profile && profile.historyId ? String(profile.historyId) : null;
      }
      searchDays = BACKFILL_DAYS;
    } else {
      const history = await readHistory(accessToken, row.history_id);
      if (history.expired) {
        const profile = await gmailJson(accessToken, '/profile');
        nextHistoryId = profile && profile.historyId ? String(profile.historyId) : null;
        searchDays = searchWindowDays(row.last_success_at);
      } else {
        if (history.historyId) nextHistoryId = history.historyId;
        if (history.added) searchDays = searchWindowDays(row.last_success_at);
      }
    }

    // 2. Find matching receipts not yet processed.
    let pending = [];
    if (searchDays !== null) {
      const ids = await searchReceiptIds(accessToken, searchDays);
      for (const id of ids) {
        if (!(await db.isGmailMessageProcessed(sql, userId, id))) pending.push(id);
      }
    }
    const truncated = pending.length > MAX_MESSAGES_PER_SYNC;
    pending = pending.slice(0, MAX_MESSAGES_PER_SYNC).reverse(); // oldest first

    // 3. Run each through the existing pipeline, recording it once done.
    let foundReceipt = false;
    if (pending.length) {
      runId = crypto.randomUUID();
      await db.createSyncRun(sql, { id: runId, userId, source: 'gmail_api' });
      for (const id of pending) {
        const outcome = await processOneMessage(env, userId, accessToken, id, runId);
        await db.markGmailMessageProcessed(sql, userId, id, outcome);
        addToCounts(counts, { outcome: ['message_gone', 'message_unreadable', 'message_too_large', 'parse_error'].includes(outcome) ? 'error' : outcome });
        if (outcome === 'created' || outcome === 'updated') foundReceipt = true;
      }
      await db.finishSyncRun(sql, runId, { status: runStatusFor(counts), ...tally(counts), errorCode: counts.errors ? 'item_errors' : null });
    }

    // 4. Complete. If more matches remain than one run handles, keep the
    //    history position (and backfill flag) so the next run continues.
    if (truncated) {
      await db.finishGmailSyncFailure(sql, userId, null);
    } else {
      await db.finishGmailSyncSuccess(sql, userId, { historyId: nextHistoryId, backfillDone: backfill, foundReceipt });
    }
    return { processed: pending.length, truncated, counts };
  } catch (err) {
    if (runId) {
      await db.finishSyncRun(sql, runId, { status: 'failed', ...tally(counts), errorCode: 'sync_interrupted' }).catch(() => {});
    }
    const code = err instanceof GmailError ? err.code : 'sync_failed';
    if (err instanceof GmailError && err.reauth) await db.markGmailReauthorizationRequired(sql, userId, code);
    else await db.finishGmailSyncFailure(sql, userId, code);
    return { error: code };
  }
}

function tally(counts) {
  return {
    seen: counts.seen, created: counts.created, updated: counts.updated, duplicates: counts.duplicates,
    review: counts.review, rejected: counts.rejected, errors: counts.errors
  };
}

// The scheduled handler's entry point: riders not checked in the last few
// minutes, a bounded number per run, within a time budget.
export async function runScheduledSync(env) {
  if (!isGmailConfigured(env)) return { skipped: 'not_configured' };
  const sql = env.cybercabhunter_db;
  const started = Date.now();
  await db.pruneGmailProcessedMessages(sql, PROCESSED_RETENTION_DAYS);
  const due = await db.listGmailConnectionsDue(sql, { olderThanMinutes: DUE_AFTER_MINUTES, limit: RIDERS_PER_RUN });
  let synced = 0;
  for (const userId of due) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    try { await syncUser(env, userId); } catch (err) { /* one rider never stops the rest */ }
    synced++;
  }
  return { due: due.length, synced };
}

export const gmail = { apiConnect, handleCallback, apiStatus, apiDisconnect, syncUser, runScheduledSync, isGmailConfigured };
