// Tesla Ride Sync — imports a rider's Robotaxi ride history from Tesla's own
// ride-history endpoint (worker/tesla-ride-provider.js), with their consent.
// A separate subsystem from the Fleet API integration (worker/tesla.js,
// tesla_connections), which has no ride-history capability.
//
// AUTH: the token MUST come from Tesla's first-party `ownerapi` OAuth client —
// the client the ride-history endpoint accepts, used exactly as Ethan
// McKanna's public exporter does (https://github.com/EthanMcKanna/robotaxi-history-exporter):
// auth.tesla.com, client_id "ownerapi", PKCE (S256), no client secret, no
// audience, scopes "openid email offline_access phone", redirect
// tesla://auth/callback. (The exporter's https://auth.tesla.com/void/callback
// was retired by Tesla in 2026: Tesla now answers "The 'redirect_uri' supplied
// is not registered for this 'client_id'". tesla://auth/callback is the only
// redirect registered for ownerapi.) An earlier version of this file
// avoided ownerapi on the (wrong) assumption that the endpoint was broken; the
// separately-registered Fleet client is kept below as a second configuration
// (TESLA_RIDES_CLIENT=fleet), but Ride Sync never uses Fleet credentials.
//
// The rider signs in to Tesla THEMSELVES, in their own browser. Cybercab
// Hunter never sees, asks for or stores their Tesla credentials. Because the
// ownerapi redirect is Tesla's own app scheme (tesla://, which we cannot point
// at our domain and a desktop browser cannot open), the rider copies that
// tesla://auth/callback?code=… address back to us from their browser's
// developer tools; it carries only a one-time authorization code, bound to
// their session by the PKCE verifier and the single-use state.
//
// FLOW
//   1. GET  /api/tesla/rides/connect      -> Tesla authorize URL (PKCE + state in KV)
//   2. POST /api/tesla/rides/callback     { callback_url } -> code exchange at
//      auth.tesla.com, tokens encrypted (tokenCrypto) into the KV blob, then an
//      immediate fetch: the response is the PREVIEW (nothing is imported yet).
//   3. GET  /api/tesla/rides/preview      -> the same preview again.
//   4. POST /api/tesla/rides/import       { ride_ids } -> the rider's ticked rides
//      are re-fetched from Tesla (never taken from the browser) and stored via
//      worker/ride-ingest.js. This consent also starts auto-sync.
//   5. Cron (worker/index.js scheduled): runScheduledSync refreshes the token if
//      needed and imports only rides that started after the newest ride the
//      rider was already shown. Quiet when there is nothing new.
//
// Vehicles: a plate not yet in the registry is created ONLY as a PRIVATE row by
// the existing ride pipeline (db.findOrCreateRobotaxiVehicleByPlateDetailed).
// The VIN Tesla reports is kept as reported_vin for a moderator to verify; the
// sync never approves, publishes or changes any vehicle's visibility, vin or
// verification status.
//
// Tokens are never logged and never returned to the browser.

import { tokenCrypto } from './crypto.js';
import { db } from './db.js';
import { tesla } from './tesla.js';
import { fetchRides, TokenExpiredError, RideHistoryError } from './tesla-ride-provider.js';
import { normalizeRide, TESLA_API_SOURCE } from './ride-canonical.js';
import { ingestRide, findExistingRide } from './ride-ingest.js';
import { newCounts, addToCounts, runStatusFor } from './receipt-process.js';

const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

// Tesla's first-party client (see header). Fixed values, not secrets.
const OWNERAPI = {
  client: 'ownerapi',
  clientId: 'ownerapi',
  clientSecret: null,
  redirectUri: 'tesla://auth/callback',
  audience: null,
  scopes: 'openid email offline_access phone',
  tokenUrl: 'https://auth.tesla.com/oauth2/v3/token',
  // The redirect goes to the tesla:// app scheme; the rider pastes it back.
  callback: 'paste'
};

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Tesla login
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_IMPORT_IDS = 1000;

// Auto-sync: each connected rider at most every 6 hours, two riders per cron run.
export const AUTO_SYNC_EVERY_MINUTES = 6 * 60;
export const AUTO_SYNC_RIDERS_PER_RUN = 2;

function config(env) {
  if (env.TESLA_RIDES_CLIENT === 'fleet') {
    return {
      client: 'fleet',
      clientId: env.TESLA_RIDES_CLIENT_ID,
      clientSecret: env.TESLA_RIDES_CLIENT_SECRET,
      redirectUri: env.TESLA_RIDES_REDIRECT_URI || 'https://cybercabhunter.com/api/tesla/rides/callback',
      audience: env.TESLA_RIDES_AUDIENCE || tesla.FLEET_API_AUDIENCE,
      scopes: env.TESLA_RIDES_SCOPES || 'openid offline_access',
      tokenUrl: 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
      callback: 'redirect'
    };
  }
  return OWNERAPI;
}

// ownerapi is a public PKCE client: nothing to configure. The Fleet client
// needs its registered id and secret.
function isConfigured(cfg) {
  return cfg.client === 'ownerapi' || !!(cfg.clientId && cfg.clientSecret);
}

function base64UrlEncode(bytes) {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

function randomState() {
  return crypto.randomUUID().replace(/-/g, '');
}

function kvTokenKeyFor(userId) {
  return `tesla_rides_tokens:${userId}`;
}

function tokenBodyFor(cfg, fields) {
  const body = new URLSearchParams({ client_id: cfg.clientId, ...fields });
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  if (cfg.audience && fields.grant_type === 'authorization_code') body.set('audience', cfg.audience);
  return body;
}

async function postToken(cfg, fields) {
  const resp = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBodyFor(cfg, fields)
  });
  if (!resp.ok) throw new Error(`token request failed: ${resp.status}`);
  const json = await resp.json();
  if (!json || !json.access_token) throw new Error('token response without an access token');
  return json;
}

// Encrypts and stores a token response for the user (the KV blob scheme:
// D1 holds only a pointer).
async function storeTokens(env, userId, tokenResponse) {
  const encryptedAccessToken = await tokenCrypto.encrypt(tokenResponse.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = tokenResponse.refresh_token
    ? await tokenCrypto.encrypt(tokenResponse.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY)
    : null;
  const accessTokenExpiresAt = new Date(Date.now() + (Number(tokenResponse.expires_in) || 0) * 1000).toISOString();
  const kvTokenKey = kvTokenKeyFor(userId);
  await env.TESLA_SESSIONS.put(kvTokenKey, JSON.stringify({ encryptedAccessToken, encryptedRefreshToken }));
  await db.createTeslaRideSyncConnection(env.cybercabhunter_db, { userId, kvTokenKey, accessTokenExpiresAt });
}

// Reads and consumes a single-use state, returning { userId, codeVerifier } or null.
async function consumeState(env, state) {
  const stateKey = `tesla_rides_oauth_state:${state}`;
  const stored = await env.TESLA_SESSIONS.get(stateKey);
  if (!stored) return null;
  await env.TESLA_SESSIONS.delete(stateKey); // single-use
  try {
    const { user_id: userId, code_verifier: codeVerifier } = JSON.parse(stored);
    return userId && codeVerifier ? { userId, codeVerifier } : null;
  } catch (err) {
    return null;
  }
}

// ---- 1. Authorization start ----
//
// Authenticated with the bearer session (a fetch, not a link click): we must
// know which Cybercab Hunter user is connecting before sending them to Tesla.
async function startAuthorization(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const cfg = config(env);
  if (!isConfigured(cfg)) {
    return Response.json({ success: false, error: 'not_configured' }, { status: 503 });
  }

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomState();

  await env.TESLA_SESSIONS.put(
    `tesla_rides_oauth_state:${state}`,
    JSON.stringify({ user_id: userId, code_verifier: codeVerifier }),
    { expirationTtl: STATE_TTL_SECONDS }
  );

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', cfg.clientId);
  authorizeUrl.searchParams.set('redirect_uri', cfg.redirectUri);
  authorizeUrl.searchParams.set('scope', cfg.scopes);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  if (cfg.audience) authorizeUrl.searchParams.set('audience', cfg.audience);

  console.log('Tesla Ride Sync: OAuth state created');
  return Response.json({ authorize_url: authorizeUrl.toString(), callback: cfg.callback });
}

// ---- 2a. Callback by redirect (Fleet client only) ----
//
// The Fleet client's redirect_uri is ours, so Tesla sends the browser here
// with ?code&state. The ownerapi client never comes here (see 2b).
async function handleCallback(request, env) {
  console.log('Tesla Ride Sync: OAuth callback received');
  const cfg = config(env);
  const frontend = env.FRONTEND_URL;
  if (cfg.callback !== 'redirect') {
    return Response.redirect(`${frontend}rider-data.html?tesla_rides=use_paste`, 302);
  }
  if (!isConfigured(cfg)) {
    return Response.json({ success: false, error: 'not_configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (error) return Response.redirect(`${frontend}?tesla_rides=cancelled`, 302);
  if (!code || !state) return Response.redirect(`${frontend}?tesla_rides=error`, 302);

  const consumed = await consumeState(env, state);
  if (!consumed) return Response.redirect(`${frontend}?tesla_rides=invalid_state`, 302);

  let tokenResponse;
  try {
    tokenResponse = await postToken(cfg, {
      grant_type: 'authorization_code', code, code_verifier: consumed.codeVerifier, redirect_uri: cfg.redirectUri
    });
  } catch (err) {
    return Response.redirect(`${frontend}?tesla_rides=token_exchange_failed`, 302);
  }
  await storeTokens(env, consumed.userId, tokenResponse);

  console.log('Tesla Ride Sync: OAuth token exchange succeeded');
  return Response.redirect(`${frontend}?tesla_rides=connected`, 302);
}

// The code and state from the callback address the rider pastes: Tesla's
// tesla://auth/callback?code=… redirect (copied from the browser's developer
// tools: on its own, inside Chrome's "Failed to launch '…'" Console message,
// or after a "location:" header name), or an auth.tesla.com address. Anything else is refused. Never logged (it carries
// a code).
function parsePastedCallback(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return { error: 'invalid_callback_url' };
  // A pasted Chrome Console line ("Failed to launch 'tesla://auth/callback?…'
  // because the scheme does not have a registered handler.") or a Network-tab
  // "location:" header: take the tesla://auth/callback address out of it.
  const embedded = raw.match(/tesla:\/\/auth\/callback\?[^\s'"<>]+/i);
  let url;
  try { url = new URL(embedded ? embedded[0] : raw.trim().replace(/^location:\s*/i, '')); } catch (err) { return { error: 'invalid_callback_url' }; }
  const appCallback = url.protocol === 'tesla:' && url.hostname === 'auth' && url.pathname === '/callback';
  const teslaWeb = url.protocol === 'https:' && url.hostname === 'auth.tesla.com';
  if (!appCallback && !teslaWeb) return { error: 'invalid_callback_url' };
  if (url.searchParams.get('error')) return { error: 'cancelled' };
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return { error: 'missing_code_or_state' };
  return { code, state };
}

// ---- 2b. Callback by paste (ownerapi, tesla://auth/callback) ----
//
// POST { callback_url }, authenticated. The state must have been issued to
// THIS session's user. On success the rider is connected and the response is
// the preview of their rides (nothing imported yet).
async function completeAuthorization(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const cfg = config(env);
  let body = null;
  try { body = await request.json(); } catch (err) { body = null; }
  const parsed = parsePastedCallback(body && body.callback_url);
  if (parsed.error) return Response.json({ success: false, error: parsed.error }, { status: 400 });

  const consumed = await consumeState(env, parsed.state);
  if (!consumed) return Response.json({ success: false, error: 'invalid_or_expired_state' }, { status: 400 });
  if (consumed.userId !== userId) return Response.json({ success: false, error: 'state_user_mismatch' }, { status: 403 });

  let tokenResponse;
  try {
    tokenResponse = await postToken(cfg, {
      grant_type: 'authorization_code', code: parsed.code, code_verifier: consumed.codeVerifier, redirect_uri: cfg.redirectUri
    });
  } catch (err) {
    return Response.json({ success: false, error: 'token_exchange_failed' }, { status: 502 });
  }
  await storeTokens(env, userId, tokenResponse);
  console.log('Tesla Ride Sync: connected');

  const preview = await buildPreview(env, userId);
  return Response.json({ success: true, connected: true, ...preview });
}

async function refreshTokens(refreshToken, cfg) {
  return postToken(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// Returns a valid, decrypted access token for server-side use only —
// refreshing first if stale (or when `forceRefresh`, after Tesla rejected the
// current one), rotating the refresh token if Tesla issued a new one (keeping
// the old one if Tesla didn't). Returns null if there's no active, usable
// connection. Never expose this return value to a response.
async function getValidAccessToken(env, userId, { forceRefresh = false } = {}) {
  const sql = env.cybercabhunter_db;
  const connection = await db.getTeslaRideSyncConnectionByUserId(sql, userId);
  if (!connection || connection.status !== 'active') return null;

  const raw = await env.TESLA_SESSIONS.get(connection.kv_token_key);
  if (!raw) return null;
  const { encryptedAccessToken, encryptedRefreshToken } = JSON.parse(raw);

  const expiresAtMs = new Date(connection.access_token_expires_at).getTime();
  if (!forceRefresh && Date.now() <= expiresAtMs - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return tokenCrypto.decrypt(encryptedAccessToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
  }

  const cfg = config(env);
  try {
    if (!encryptedRefreshToken) throw new Error('no refresh token');
    const refreshToken = await tokenCrypto.decrypt(encryptedRefreshToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const refreshed = await refreshTokens(refreshToken, cfg);
    const newEncryptedAccessToken = await tokenCrypto.encrypt(refreshed.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    // Tesla doesn't always return a new refresh_token on refresh — keep
    // the existing one (still encrypted, no decrypt/re-encrypt needed) if
    // it didn't, rather than discarding a still-valid credential.
    const newEncryptedRefreshToken = refreshed.refresh_token
      ? await tokenCrypto.encrypt(refreshed.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY)
      : encryptedRefreshToken;
    const accessTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

    await env.TESLA_SESSIONS.put(connection.kv_token_key, JSON.stringify({
      encryptedAccessToken: newEncryptedAccessToken,
      encryptedRefreshToken: newEncryptedRefreshToken
    }));
    await db.touchTeslaRideSyncRefresh(sql, userId, accessTokenExpiresAt);

    return refreshed.access_token;
  } catch (err) {
    await db.markTeslaRideSyncError(sql, userId, 'refresh_failed');
    return null;
  }
}

// ---- Fetching ----

// The rider's raw rides from Tesla. A 401 triggers one forced refresh and a
// retry. Returns { rides } or { error: code } — never throws for an expected
// failure.
async function fetchUserRides(env, userId, { fetchImpl } = {}) {
  let token = await getValidAccessToken(env, userId);
  if (!token) return { error: 'not_connected' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { rides: await fetchRides(token, fetchImpl ? { fetchImpl } : undefined) };
    } catch (err) {
      if (err instanceof TokenExpiredError && attempt === 0) {
        token = await getValidAccessToken(env, userId, { forceRefresh: true });
        if (!token) return { error: 'reconnect_required' };
        continue;
      }
      if (err instanceof TokenExpiredError) {
        await db.markTeslaRideSyncError(env.cybercabhunter_db, userId, 'token_rejected');
        return { error: 'reconnect_required' };
      }
      if (err instanceof RideHistoryError) return { error: 'tesla_unavailable', status: err.status };
      return { error: 'tesla_unavailable', status: null };
    }
  }
  return { error: 'tesla_unavailable', status: null };
}

// Canonical rides, newest first.
function normalizeAll(rawRides) {
  return rawRides
    .map(raw => normalizeRide(raw, TESLA_API_SOURCE))
    .sort((a, b) => String(b.startedAtUtc || '').localeCompare(String(a.startedAtUtc || '')));
}

async function isAlreadyStored(env, userId, ride) {
  const sql = env.cybercabhunter_db;
  if (ride.receiptHash && await db.findIngestionByHash(sql, userId, ride.receiptHash)) return true;
  if (ride.identityIssue) return false;
  return !!(await findExistingRide(sql, userId, ride));
}

// What the preview screen shows for one ride: only what the rider needs to
// decide (date, route, miles, fare, plate) — no VIN, no coordinates.
function previewItem(ride, alreadyImported) {
  return {
    ride_id: ride.externalRideId,
    date: ride.rideDate,
    pickup_time: ride.pickupTime,
    from: ride.pickupDescription,
    to: ride.dropoffDescription,
    miles: ride.distance,
    fare_cents: ride.fareAmountCents,
    currency: ride.currency,
    plate: ride.licensePlate,
    importable: !ride.identityIssue,
    already_imported: alreadyImported,
    needs_review: ride.review.status !== 'accepted'
  };
}

async function buildPreview(env, userId, opts) {
  const fetched = await fetchUserRides(env, userId, opts);
  if (fetched.error) return { preview_error: fetched.error, rides: [] };
  const rides = normalizeAll(fetched.rides);
  const items = [];
  for (const ride of rides) items.push(previewItem(ride, await isAlreadyStored(env, userId, ride)));
  return { rides: items };
}

// ---- Importing (shared by the preview's Import and auto-sync) ----

async function importRides(env, userId, rides, source) {
  const sql = env.cybercabhunter_db;
  const runId = crypto.randomUUID();
  await db.createSyncRun(sql, { id: runId, userId, source });
  const counts = newCounts();
  let vehiclesCreated = 0;
  for (const ride of rides) {
    let result;
    try {
      result = await ingestRide(env, ride, { userId, syncRunId: runId, evidenceType: 'tesla_api' });
      if (result.vehicleCreated) vehiclesCreated++;
      // The VIN Tesla reports, kept for a moderator to verify (reported_vin
      // only — never vin, visibility or verification).
      if (ride.reportedVin && result.tripId) {
        const vehicleId = await db.getTripVehicleId(sql, userId, result.tripId);
        if (vehicleId) await db.recordReportedVin(sql, vehicleId, ride.reportedVin, TESLA_API_SOURCE);
      }
    } catch (err) {
      result = { outcome: 'error' };
    }
    addToCounts(counts, result);
  }
  await db.finishSyncRun(sql, runId, {
    status: runStatusFor(counts), ...counts, errorCode: counts.errors ? 'item_errors' : null
  });
  return { counts, vehiclesCreated };
}

const newestStart = rides => rides.reduce((max, r) => (r.startedAtUtc && r.startedAtUtc > max ? r.startedAtUtc : max), '');

function summary(counts, vehiclesCreated) {
  return {
    processed: counts.seen, added: counts.created, updated: counts.updated,
    duplicates: counts.duplicates, needs_review: counts.review, errors: counts.errors,
    private_vehicles_created: vehiclesCreated
  };
}

// ---- 3. Preview ----
async function apiPreview(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });
  const preview = await buildPreview(env, userId);
  return Response.json(preview, { status: preview.preview_error === 'not_connected' ? 409 : 200 });
}

// ---- 4. Import the rider's ticked rides ----
//
// POST { ride_ids: [...] }. The rides themselves are fetched from Tesla again
// here; the browser only says WHICH of its own rides to import.
async function apiImport(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  let body = null;
  try { body = await request.json(); } catch (err) { body = null; }
  const ids = body && Array.isArray(body.ride_ids) ? body.ride_ids : null;
  if (!ids || ids.length > MAX_IMPORT_IDS || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    return Response.json({ success: false, error: 'invalid_ride_ids' }, { status: 400 });
  }

  const fetched = await fetchUserRides(env, userId);
  if (fetched.error) {
    return Response.json({ success: false, error: fetched.error }, { status: fetched.error === 'not_connected' ? 409 : 502 });
  }
  const all = normalizeAll(fetched.rides);
  const wanted = new Set(ids);
  const selected = all.filter(r => r.externalRideId && wanted.has(r.externalRideId));
  const { counts, vehiclesCreated } = await importRides(env, userId, selected, TESLA_API_SOURCE);

  // Consent given: auto-sync starts, for rides newer than every ride shown.
  const sql = env.cybercabhunter_db;
  const connection = await db.getTeslaRideSyncConnectionByUserId(sql, userId);
  const cutoff = newestStart(all);
  const after = connection && connection.auto_sync_after && connection.auto_sync_after > cutoff ? connection.auto_sync_after : cutoff;
  await db.setTeslaRideSyncAutoAfter(sql, userId, after || new Date().toISOString());
  await db.touchTeslaRideSync(sql, userId, counts.created ? 'imported' : 'no_new_rides');

  return Response.json({ success: true, ...summary(counts, vehiclesCreated) });
}

// ---- 5. Auto-sync ----

// One rider: import rides that started after their cutoff and aren't stored.
async function syncUser(env, userId, opts = {}) {
  const sql = env.cybercabhunter_db;
  const connection = await db.getTeslaRideSyncConnectionByUserId(sql, userId);
  if (!connection || connection.status !== 'active') return { skipped: 'not_connected' };
  if (!connection.auto_sync_after) return { skipped: 'not_consented' };

  const fetched = await fetchUserRides(env, userId, opts);
  if (fetched.error) {
    await db.touchTeslaRideSync(sql, userId, fetched.error);
    return { skipped: fetched.error };
  }
  const all = normalizeAll(fetched.rides);
  const fresh = [];
  for (const ride of all) {
    if (!ride.startedAtUtc || ride.startedAtUtc <= connection.auto_sync_after) continue;
    if (await isAlreadyStored(env, userId, ride)) continue;
    fresh.push(ride);
  }
  const cutoff = newestStart(all);
  if (cutoff > connection.auto_sync_after) await db.setTeslaRideSyncAutoAfter(sql, userId, cutoff);
  if (fresh.length === 0) {
    await db.touchTeslaRideSync(sql, userId, 'no_new_rides');
    return { imported: 0 };
  }
  const { counts, vehiclesCreated } = await importRides(env, userId, fresh, TESLA_API_SOURCE);
  await db.touchTeslaRideSync(sql, userId, 'imported');
  return { imported: counts.created, ...summary(counts, vehiclesCreated) };
}

async function runScheduledSync(env, opts = {}) {
  const sql = env.cybercabhunter_db;
  const due = await db.listTeslaRideSyncDue(sql, { olderThanMinutes: AUTO_SYNC_EVERY_MINUTES, limit: AUTO_SYNC_RIDERS_PER_RUN });
  let synced = 0;
  for (const userId of due) {
    try { await syncUser(env, userId, opts); } catch (err) { /* one rider never stops the rest */ }
    synced++;
  }
  return { due: due.length, synced };
}

// ---- Status and disconnect ----

async function apiStatus(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ connected: false }, { status: 401 });

  const connection = await db.getTeslaRideSyncConnectionByUserId(env.cybercabhunter_db, userId);
  return Response.json({
    configured: isConfigured(config(env)),
    connected: !!connection && connection.status === 'active',
    status: connection ? connection.status : 'never_connected',
    connected_at: connection ? connection.connected_at : null,
    last_sync_at: connection ? connection.last_sync_at : null,
    last_sync_result: connection ? connection.last_sync_result || null : null,
    auto_sync: !!(connection && connection.status === 'active' && connection.auto_sync_after)
  });
}

// Revokes the connection AND deletes the KV token blob outright — unlike
// a soft revoke that only flips a status flag, this ensures no
// decryptable token material remains reachable after disconnect. Rides
// already imported stay.
async function apiDisconnect(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const connection = await db.getTeslaRideSyncConnectionByUserId(env.cybercabhunter_db, userId);
  if (connection) {
    await env.TESLA_SESSIONS.delete(connection.kv_token_key);
  }
  await db.markTeslaRideSyncRevoked(env.cybercabhunter_db, userId);

  return Response.json({ success: true, connected: false });
}

export const teslaRides = {
  startAuthorization,
  handleCallback,
  completeAuthorization,
  apiStatus,
  apiPreview,
  apiImport,
  apiDisconnect,
  getValidAccessToken,
  syncUser,
  runScheduledSync
};
