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
// address, Gmail's opaque history position, opaque ids of messages already
// processed or queued for processing, and the time bounds of the scan in
// progress. Access tokens live only in memory for one operation.
// Message bodies are parsed in memory and discarded, exactly as for
// forwarded mail; only the structured ride fields the pipeline extracts are
// kept. Nothing token- or content-bearing is ever logged or returned.
//
// Sync strategy (polling, every 10 minutes via the scheduled handler), built
// to stay far inside the Cloudflare Workers FREE plan's per-invocation
// limits (50 subrequests — fetch, D1 and KV calls alike — and ~10 ms of
// CPU). Work is done in small, resumable steps: ONE rider and at most ONE
// message per invocation, continued on the next run from saved progress.
//
//   * Progress lives in gmail_connections.sync_cursor (migration 0016). A
//     "scan" covers a time range [lo, hi) of the mailbox and walks it from
//     newest to oldest in windows: each window is listed ONCE with the
//     receipt subject search (after:/before: epoch bounds, at most 50 ids);
//     the ids not yet processed are saved as a queue; each run then
//     downloads and imports one queued message. When the queue is empty the
//     window moves back; a window with more than 50 matches is halved first.
//     No window is ever searched again once its queue has been saved.
//   1. First time: a scan of the last 90 days (the backfill), started right
//      after connecting. backfill_completed_at is set only when it finishes,
//      however many runs that takes.
//   2. After that: users.history.list(messageAdded) since the stored
//      history position — used only to learn THAT new mail arrived. If it
//      did (or Gmail no longer has that history, 404), a small scan covering
//      the time since the previous scan began (plus a day of overlap) finds
//      the receipts, so unrelated mail is never downloaded.
//   3. The history position advances only when a scan completes (or history
//      shows nothing new), never past messages still queued. A temporary
//      failure leaves the queued message at the front, so it is retried.
//   4. Each downloaded message goes through the existing pipeline once, and
//      its id is recorded in gmail_processed_messages.
//   5. Two guards keep one message from wedging a rider's sync: messages
//      over MAX_GMAIL_MESSAGE_BYTES are excluded by the search itself
//      (Gmail's `smaller:`), so they are never downloaded or parsed; and an
//      attempt marker saved in the cursor BEFORE each download lets a
//      message that keeps failing — including one whose run is cut off —
//      be skipped (recorded as 'skipped_repeated_failure') instead of
//      blocking the queue forever.
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

// ---- TEMPORARY — remove after Google OAuth verification completes ----
// Google is verifying the restricted gmail.readonly scope; until it is done
// the scope must not be triggered by production traffic. So only these
// signed-in Google accounts (the email of the Google account the rider signed
// in with, google_connections.email) may start the Gmail connect flow.
// A @gmail.com address can't be claimed by any other Google account.
// The gate is checked in two places: apiConnect (403 for anyone else) and
// apiStatus's connect_allowed (the UI shows "Connect Gmail" only when true:
// public/js/rider-data.js and public/js/main.js's Gmail onboarding).
// To lift it: set GMAIL_CONNECT_GATE_ENABLED = false, or remove these
// constants, gmailConnectAllowed() and its two uses.
export const GMAIL_CONNECT_GATE_ENABLED = true;
export const GMAIL_CONNECT_ALLOWLIST = ['contactjoeclos@gmail.com'];

export function gmailConnectAllowed(identity) {
  if (!GMAIL_CONNECT_GATE_ENABLED) return true;
  const email = identity && identity.email ? String(identity.email).trim().toLowerCase() : '';
  return !!email && GMAIL_CONNECT_ALLOWLIST.some(a => a.trim().toLowerCase() === email);
}
// ---- end TEMPORARY ----

// Real Tesla Robotaxi receipts are titled "Robotaxi Ride Receipt on <date>".
// The subject, not the sender, is searched: relays such as DuckDuckGo Email
// Protection rewrite the sender but not the subject. The receipt classifier
// still decides whether each match really is a Tesla receipt.
export const RECEIPT_QUERY = 'subject:"Robotaxi Ride Receipt"';

const STATE_TTL_SECONDS = 600;          // 10 minutes to finish Google's consent screen
const BACKFILL_DAYS = 90;               // the one-time scan for existing receipts
const DAY = 86400;
// Largest Gmail message the sync will download (Gmail's size: headers,
// body and attachments). Enforced in the SEARCH (`smaller:`), so a larger
// match — e.g. a forwarded receipt with photos in Sent — is never listed,
// downloaded or parsed; re-checked after download as defense in depth.
// Measured parse cost (JSON + base64 + MIME + extraction + hash, Node): a
// ~60 KB receipt ~6 ms; 200 KB ~12 ms; 324 KB ~15 ms; 2 MB ~83 ms. 256 KiB
// leaves ~4x headroom over a ~60 KB HTML receipt (room for a small PDF)
// while bounding one step's parse to roughly the Free plan's CPU budget.
// Larger receipts can still arrive through the forwarding address.
const MAX_GMAIL_MESSAGE_BYTES = 256 * 1024;
// A queued message is skipped (outcome SKIPPED_OUTCOME) after this many
// failed attempts that point at the message itself: a non-Gmail error in
// the pipeline, a Gmail error other than the temporary/config ones below,
// or a run that was cut off (e.g. CPU limit) after the attempt was saved.
// So such a failure is retried once.
const MAX_HARD_ATTEMPTS = 2;
// Temporary Gmail errors on the download (5xx, rate limit) don't count as
// hard attempts, but a message that keeps getting them is skipped after
// this many, so it can't block the queue indefinitely either.
const MAX_TEMPORARY_FAILURES = 12;
const TEMPORARY_ERRORS = new Set(['gmail_rate_limited', 'gmail_api_unavailable', 'google_token_unavailable']);
// Not the message's fault at all: never counted against it.
const NOT_MESSAGE_ERRORS = new Set(['gmail_api_disabled', 'invocation_budget_reached']);
const SKIPPED_OUTCOME = 'skipped_repeated_failure';
const LOCK_MINUTES = 5;                 // far longer than one bounded step takes
const DUE_AFTER_MINUTES = 9;            // just under the 10-minute cron interval
const PROCESSED_RETENTION_DAYS = 120;   // > BACKFILL_DAYS, so a scan never re-finds a pruned id

// ---- Workers Free plan budget (one invocation) ----
// Hard caps, not timers: CPU time can't be measured from inside a Worker.
// Worst case per scheduled invocation, counting every fetch, D1 statement
// (each statement of a batch) and KV call against ONE pool of 50:
//   scheduled run: prune + pick the rider                          2 D1
//   rider:  lock + read row                                        2 D1
//           token refresh (+ store a rotated refresh token)        1 fetch + 1 D1
//           history page, or profile after a 404 (both at most)    2 fetch
//           one window listed + one processed-ids query            1 fetch + 1 D1
//           one message: already-processed check, save the attempt
//             marker, download, existing pipeline (≤ 18 statements
//             on its rarest path), record it                       1 fetch + 21 D1
//           sync-run open/close + save state                       3 D1
//   total ≤ 35 (70% of 50); ≤ 37 if a D1 write itself fails and the
//   error path runs; a typical step with a receipt is ~22.
// CPU: parsing one ~60 KB receipt (MIME + extraction + hash) measures ~5 ms,
// so ONE message per invocation keeps well inside ~10 ms.
const RIDERS_PER_INVOCATION = 1;        // one rider per cron run, round-robin
const MESSAGES_PER_INVOCATION = 1;      // messages downloaded + imported per run
const GOOGLE_CALLS_PER_INVOCATION = 6;  // backstop: every Google HTTP call counts
const LIST_PAGE_SIZE = 50;              // ids per window listing (one call, one IN query)
const WINDOW_EDGE_SECONDS = 60;         // windows overlap slightly; processed ids are filtered
const MIN_WINDOW_SECONDS = 3600;        // a dense window is halved down to one hour
const INCREMENTAL_OVERLAP_SECONDS = DAY; // a new scan starts a day before the last one began

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

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Counts Google HTTP calls in one Worker invocation. Past the cap the call is
// refused as a TEMPORARY error, so nothing is lost: the step simply ends and
// the next scheduled run continues from the saved state.
function newBudget(limit = GOOGLE_CALLS_PER_INVOCATION) {
  const budget = { limit, used: 0 };
  budget.spend = () => {
    if (budget.used >= budget.limit) throw new GmailError('invocation_budget_reached');
    budget.used += 1;
  };
  return budget;
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
  // TEMPORARY — remove after Google OAuth verification completes (see GMAIL_CONNECT_ALLOWLIST).
  if (!gmailConnectAllowed(identity)) {
    return Response.json({ success: false, error: 'gmail_connect_unavailable' }, { status: 403 });
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
  // This invocation's Google calls: code exchange, userinfo, profile, then
  // the first (discovery-only) sync step below.
  const budget = newBudget();
  let tokens;
  try {
    budget.spend();
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
    budget.spend();
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
    historyId = (await gmailJson(tokens.access_token, '/profile', budget)).historyId || null;
  } catch (err) {
    return refuse('error');
  }

  const encryptedRefreshToken = await tokenCrypto.encrypt(tokens.refresh_token, cfg.key);
  await db.upsertGmailConnection(env.cybercabhunter_db, {
    userId: saved.user_id, googleSub: profile.sub, email: profile.email || null,
    encryptedRefreshToken, historyId: historyId ? String(historyId) : null
  });

  // Start the 90-day import right away: this first step only lists the
  // newest window (and finishes at once if there are no receipts). Messages
  // are imported by the scheduled runs, one per run, so this invocation —
  // which has already spent calls on the OAuth exchange — stays small.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(syncUser(env, saved.user_id, { maxMessages: 0, budget }).catch(() => {}));
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
  if (!configured) return Response.json({ success: true, configured: false, state: 'not_connected', connect_allowed: false });
  const row = await db.getGmailConnectionStatus(env.cybercabhunter_db, userId);
  // TEMPORARY — remove after Google OAuth verification completes (see GMAIL_CONNECT_ALLOWLIST).
  const connectAllowed = gmailConnectAllowed(await db.getGoogleIdentityForUser(env.cybercabhunter_db, userId));
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
    connect_allowed: connectAllowed,   // TEMPORARY (see GMAIL_CONNECT_ALLOWLIST)
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
async function getAccessToken(env, row, budget) {
  const cfg = config(env);
  let refreshToken;
  try {
    refreshToken = await tokenCrypto.decrypt(row.encrypted_refresh_token, cfg.key);
  } catch (err) {
    throw new GmailError('stored_token_unreadable', { reauth: true });
  }
  let resp;
  budget.spend();
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
async function gmailJson(accessToken, path, budget) {
  let resp;
  budget.spend();
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

// One window of the receipt search: ids matching the subject between two
// epoch-second bounds (edges widened slightly; already-processed ids are
// filtered by the caller). One call. `full` means Gmail has more matches than
// one page holds, so the window is too dense and must be narrowed.
async function listWindow(accessToken, fromSec, toSec, budget) {
  const params = new URLSearchParams({
    q: `${RECEIPT_QUERY} smaller:${MAX_GMAIL_MESSAGE_BYTES} after:${fromSec - WINDOW_EDGE_SECONDS} before:${toSec + WINDOW_EDGE_SECONDS}`,
    maxResults: String(LIST_PAGE_SIZE)
  });
  const body = await gmailJson(accessToken, `/messages?${params}`, budget);
  const ids = [];
  for (const m of (body && body.messages) || []) if (m && m.id && !ids.includes(m.id)) ids.push(m.id);
  return { ids, full: !!(body && body.nextPageToken) };
}

// Whether any message was added since `startHistoryId`, and the mailbox's
// current history position. One page only: any record on it — or a further
// page — means "yes". `expired: true` when Gmail no longer has that history
// (404); the caller then falls back to a bounded scan.
async function readHistory(accessToken, startHistoryId, budget) {
  const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', maxResults: '500' });
  const body = await gmailJson(accessToken, `/history?${params}`, budget);
  if (body === null) return { expired: true };
  const added = !!body.nextPageToken || (body.history || []).some(h => (h.messagesAdded || []).length > 0);
  return { expired: false, added, historyId: body.historyId ? String(body.historyId) : null };
}

async function currentHistoryId(accessToken, budget) {
  const profile = await gmailJson(accessToken, '/profile', budget);
  return profile && profile.historyId ? String(profile.historyId) : null;
}

// ------------------------------------------------------------ sync state

// gmail_connections.sync_cursor (migration 0016). Idle: { since } — when the
// last completed scan began. Scanning: see newScan. Anything unreadable is
// treated as idle, which at worst re-lists a window (processed ids are
// filtered), never skips one.
function readCursor(text) {
  let c = null;
  try { c = text ? JSON.parse(text) : null; } catch (e) { c = null; }
  if (!c || c.v !== 1) return { v: 1 };
  if (c.mode === 'backfill' || c.mode === 'incremental') {
    if (!(Number.isFinite(c.lo) && Number.isFinite(c.hi) && Number.isFinite(c.span) && Array.isArray(c.queue))) return { v: 1 };
    const a = c.attempt;
    if (!(a && typeof a.id === 'string' && Number.isFinite(a.n) && Number.isFinite(a.t))) delete c.attempt;
    return c;
  }
  return Number.isFinite(c.since) ? { v: 1, since: c.since } : { v: 1 };
}

// A scan of [lo, hi), walked newest-first in windows of `span` seconds.
// `hist` is the history position to store once the whole scan completes;
// `start` becomes the next scan's reference point.
function newScan(mode, lo, hi, hist) {
  return { v: 1, mode, lo, hi, span: Math.max(MIN_WINDOW_SECONDS, hi - lo), queue: [], hist: hist || null, start: hi };
}

// Where an incremental scan begins: a day before the previous scan began,
// never further back than the backfill horizon.
function incrementalFloor(cursor, row, now) {
  let since = Number.isFinite(cursor.since) ? cursor.since : NaN;
  if (!Number.isFinite(since) && row.last_success_at) {
    since = Math.floor(Date.parse(String(row.last_success_at).replace(' ', 'T') + 'Z') / 1000);
  }
  if (!Number.isFinite(since)) since = now - BACKFILL_DAYS * DAY;
  return Math.max(now - BACKFILL_DAYS * DAY, since - INCREMENTAL_OVERLAP_SECONDS);
}

function base64UrlToBytes(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ------------------------------------------------------------------ sync

// Fetches one message and runs it through the existing pipeline. Returns
// the outcome recorded for it. Throws GmailError only for temporary Gmail
// failures (so the message is NOT marked processed and is retried).
async function processOneMessage(env, userId, accessToken, messageId, syncRunId, budget) {
  const sql = env.cybercabhunter_db;
  const msg = await gmailJson(accessToken, `/messages/${encodeURIComponent(messageId)}?format=raw`, budget);
  if (msg === null) return 'message_gone';                 // deleted since the search
  if (!msg.raw) return 'message_unreadable';
  if ((msg.sizeEstimate || 0) > MAX_GMAIL_MESSAGE_BYTES) return 'message_too_large'; // the search already excludes these

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

// One bounded step of one rider's sync — see the header. Safe to call at
// any time: it takes a short lease, and a second concurrent call simply
// returns { skipped: 'locked' }. `maxMessages` (default 1) caps downloads in
// this step; 0 only lists (used right after connecting). `budget` is the
// invocation's Google-call budget, shared with the caller.
export async function syncUser(env, userId, { maxMessages = MESSAGES_PER_INVOCATION, budget = newBudget() } = {}) {
  const sql = env.cybercabhunter_db;
  if (!isGmailConfigured(env)) return { skipped: 'not_configured' };
  if (!(await db.acquireGmailSyncLock(sql, userId, LOCK_MINUTES))) {
    const row = await db.getGmailConnectionStatus(sql, userId);
    return { skipped: !row || row.status !== 'active' ? 'not_connected' : 'locked' };
  }
  const row = await db.getGmailConnectionForSync(sql, userId);
  if (!row || row.status !== 'active' || !row.encrypted_refresh_token) return { skipped: 'not_connected' };

  const counts = newCounts();
  let runId = null;
  let cursor = readCursor(row.sync_cursor);
  let processed = 0;
  let foundReceipt = false;
  let attempting = null;   // { id, n, t } as they were BEFORE the attempt in progress
  try {
    const accessToken = await getAccessToken(env, row, budget);

    // 1. No scan in progress: decide whether one is needed. A new scan's
    //    upper bound is taken AFTER reading the history position it will
    //    store, so every message that position covers is inside the scan.
    if (!cursor.mode) {
      if (!row.backfill_completed_at) {
        const hist = row.history_id || await currentHistoryId(accessToken, budget);
        const now = nowSeconds();
        cursor = newScan('backfill', now - BACKFILL_DAYS * DAY, now, hist);
      } else {
        const history = row.history_id ? await readHistory(accessToken, row.history_id, budget) : { expired: true };
        if (history.expired) {
          const hist = await currentHistoryId(accessToken, budget);
          const now = nowSeconds();
          cursor = newScan('incremental', incrementalFloor(cursor, row, now), now, hist);
        } else if (history.added) {
          const now = nowSeconds();
          cursor = newScan('incremental', incrementalFloor(cursor, row, now), now, history.historyId || row.history_id);
        } else {
          // Nothing new: move the position forward (nothing is skipped).
          await db.finishGmailSyncSuccess(sql, userId, { historyId: history.historyId, backfillDone: false, foundReceipt: false, cursor });
          return { processed: 0, idle: true };
        }
      }
    }

    // 2. Advance the scan by at most one window listing and `maxMessages`
    //    downloads. Each branch either spends a bounded call or ends the step.
    let listed = false;
    let complete = false;
    for (;;) {
      if (cursor.queue.length === 0) {
        if (cursor.hi <= cursor.lo) { complete = true; break; }
        if (listed || processed > 0) break;            // one listing per step, and never after a download
        const windowLo = Math.max(cursor.lo, cursor.hi - cursor.span);
        const { ids, full } = await listWindow(accessToken, windowLo, cursor.hi, budget);
        listed = true;
        if (full && cursor.span > MIN_WINDOW_SECONDS) {
          cursor.span = Math.max(MIN_WINDOW_SECONDS, Math.floor(cursor.span / 2));
          continue;                                     // narrower window, listed on the next step
        }
        const done = await db.getGmailProcessedIds(sql, userId, ids);
        const pending = ids.filter(id => !done.has(id)).reverse(); // Gmail lists newest first; import oldest first
        cursor.queue = pending;
        // A window is finished once its ids are queued. (Only a one-hour window
        // holding more than 50 receipts would stay put and be re-listed.)
        if (!full || pending.length === 0) cursor.hi = windowLo;
        continue;
      }
      if (processed >= maxMessages) break;
      const id = cursor.queue[0];
      processed += 1;
      const prior = cursor.attempt && cursor.attempt.id === id ? cursor.attempt : { id, n: 0, t: 0 };
      if (await db.isGmailMessageProcessed(sql, userId, id)) { dropHead(cursor); continue; } // finished by an earlier, interrupted step
      if (prior.n >= MAX_HARD_ATTEMPTS || prior.t >= MAX_TEMPORARY_FAILURES) {
        // Failed too often (e.g. its runs keep being cut off): stop retrying it.
        await db.markGmailMessageProcessed(sql, userId, id, SKIPPED_OUTCOME);
        dropHead(cursor);
        continue;
      }
      // Save the attempt BEFORE downloading, so even a run that is cut off
      // mid-message (and never reaches the error handling) counts it.
      const marked = { ...cursor, attempt: { id, n: prior.n + 1, t: prior.t } };
      await db.saveGmailSyncCursor(sql, userId, marked);
      cursor = marked;
      attempting = prior;
      if (!runId) {
        runId = crypto.randomUUID();
        await db.createSyncRun(sql, { id: runId, userId, source: 'gmail_api' });
      }
      const outcome = await processOneMessage(env, userId, accessToken, id, runId, budget);
      await db.markGmailMessageProcessed(sql, userId, id, outcome);
      dropHead(cursor);
      attempting = null;
      addToCounts(counts, { outcome: ['message_gone', 'message_unreadable', 'message_too_large', 'parse_error'].includes(outcome) ? 'error' : outcome });
      if (outcome === 'created' || outcome === 'updated') foundReceipt = true;
    }
    if (runId) await db.finishSyncRun(sql, runId, { status: runStatusFor(counts), ...tally(counts), errorCode: counts.errors ? 'item_errors' : null });

    // 3. Save. Only a completed scan moves the history position (and marks
    //    the backfill done); otherwise the progress is kept for the next run.
    if (complete) {
      await db.finishGmailSyncSuccess(sql, userId, {
        historyId: cursor.hist, backfillDone: cursor.mode === 'backfill', foundReceipt, cursor: { v: 1, since: cursor.start }
      });
    } else {
      await db.finishGmailSyncSuccess(sql, userId, { historyId: null, backfillDone: false, foundReceipt, cursor });
    }
    return { processed, complete, remaining: cursor.queue.length, counts };
  } catch (err) {
    if (runId) {
      await db.finishSyncRun(sql, runId, { status: 'failed', ...tally(counts), errorCode: 'sync_interrupted' }).catch(() => {});
    }
    const code = err instanceof GmailError ? err.code : 'sync_failed';
    if (err instanceof GmailError && err.reauth) {
      await db.markGmailReauthorizationRequired(sql, userId, code);
      return { error: code };
    }
    // The message being attempted failed: classify it (see MAX_HARD_ATTEMPTS).
    let skipped = false;
    if (attempting && cursor.attempt && cursor.attempt.id === attempting.id) {
      if (TEMPORARY_ERRORS.has(code)) cursor.attempt = { id: attempting.id, n: attempting.n, t: attempting.t + 1 };
      else if (NOT_MESSAGE_ERRORS.has(code)) cursor.attempt = { ...attempting };
      // otherwise the incremented hard-attempt count stands
      if (cursor.attempt.n >= MAX_HARD_ATTEMPTS || cursor.attempt.t >= MAX_TEMPORARY_FAILURES) {
        try {
          await db.markGmailMessageProcessed(sql, userId, attempting.id, SKIPPED_OUTCOME);
          dropHead(cursor);
          skipped = true;
        } catch (e) { /* the next run's check skips it instead */ }
      }
    }
    await db.finishGmailSyncFailure(sql, userId, code, cursor.mode ? cursor : null);
    return { error: code, skipped };
  }
}

// The queue's front message is done (imported, deduplicated, skipped or
// already processed): drop it and its attempt marker.
function dropHead(cursor) {
  cursor.queue.shift();
  delete cursor.attempt;
}

function tally(counts) {
  return {
    seen: counts.seen, created: counts.created, updated: counts.updated, duplicates: counts.duplicates,
    review: counts.review, rejected: counts.rejected, errors: counts.errors
  };
}

// The scheduled handler's entry point. Free-plan safe by construction: ONE
// rider per invocation (RIDERS_PER_INVOCATION), one bounded step for it.
// Fairness is a strict round-robin — the connected rider checked least
// recently goes next, and a rider's turn is stamped when its step STARTS,
// so a rider whose step fails (or is cut short) goes to the back of the line
// like everyone else. With N connected riders each gets a step at least
// every N runs (N × 10 minutes); no rider — not even one with a long
// backfill — can hold the front. Riders mid-step (locked) are skipped.
export async function runScheduledSync(env) {
  if (!isGmailConfigured(env)) return { skipped: 'not_configured' };
  const sql = env.cybercabhunter_db;
  const budget = newBudget();
  await db.pruneGmailProcessedMessages(sql, PROCESSED_RETENTION_DAYS);
  const due = await db.listGmailConnectionsDue(sql, { olderThanMinutes: DUE_AFTER_MINUTES, limit: RIDERS_PER_INVOCATION });
  let synced = 0;
  for (const userId of due) {
    try { await syncUser(env, userId, { budget }); } catch (err) { /* one rider never stops the rest */ }
    synced++;
  }
  return { due: due.length, synced };
}

export const gmail = { apiConnect, handleCallback, apiStatus, apiDisconnect, syncUser, runScheduledSync, isGmailConfigured, newBudget };
