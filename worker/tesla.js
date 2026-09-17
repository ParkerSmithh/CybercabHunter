// Tesla Fleet API OAuth — server-side only. The client ID/secret and Tesla's
// access/refresh tokens never reach the browser; the frontend only ever
// learns booleans/safe summaries. See developer.tesla.com/docs/fleet-api
// for the authorization code flow this implements (no PKCE required).
//
// Session model: the browser holds only an opaque session ID (bearer token,
// stored client-side in localStorage since cross-site cookies get blocked —
// see readBearerToken below). That ID maps in TESLA_SESSIONS (KV) to a
// Cybercab Hunter `user_id`. Tesla's actual tokens live encrypted in D1
// (tesla_connections), looked up by that user_id — KV never holds tokens.

import { tokenCrypto } from './crypto.js';
import { db } from './db.js';

const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FLEET_API_AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com'; // North America region
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location';

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Tesla login
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // ~3 months
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh a minute before actual expiry

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function redirectUriFor(request) {
  return new URL('/oauth/tesla/callback', request.url).toString();
}

// The frontend (github.io) and this Worker (workers.dev) are different sites,
// so a cookie the Worker sets is a third-party cookie from the frontend's
// point of view — Chrome and Safari both block those by default. Instead,
// the callback hands the frontend a one-time, opaque session ID via the URL
// fragment (never sent to any server) and the frontend re-sends it
// explicitly as an `Authorization: Bearer <id>` header.
function readBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Resolves the calling browser to a Cybercab Hunter user_id, or null.
// Every private endpoint must go through this — never trust a user_id
// supplied by the request itself.
async function requireUserId(request, env) {
  const sessionId = readBearerToken(request);
  if (!sessionId) return null;
  const raw = await env.TESLA_SESSIONS.get(`session:${sessionId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed.user_id || null;
  } catch (err) {
    return null;
  }
}

// Best-effort decode of the OIDC id_token's `sub` claim, used only to
// recognize the same Tesla account across separate link attempts (dedupe),
// never for authorization. Not signature-verified — it comes straight from
// Tesla's own token endpoint over HTTPS in the same request we trust for the
// access/refresh tokens themselves, not from anything client-supplied.
function decodeTeslaAccountIdentifier(idToken) {
  if (!idToken) return null;
  try {
    const payload = idToken.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json);
    return parsed.sub || null;
  } catch (err) {
    return null;
  }
}

async function startOAuth(request, env) {
  const state = randomToken();
  await env.TESLA_SESSIONS.put(`state:${state}`, '1', { expirationTtl: STATE_TTL_SECONDS });

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', env.TESLA_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUriFor(request));
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('state', state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

async function exchangeCodeForTokens(code, redirectUri, env) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    audience: FLEET_API_AUDIENCE,
    redirect_uri: redirectUri
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`Tesla token exchange failed: ${resp.status}`);
  return resp.json(); // { access_token, refresh_token, expires_in, id_token, ... }
}

async function refreshTokens(refreshToken, env) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.TESLA_CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    refresh_token: refreshToken
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`Tesla token refresh failed: ${resp.status}`);
  return resp.json();
}

async function fetchTeslaVehicles(accessToken) {
  let resp;
  try {
    resp = await fetch(`${FLEET_API_AUDIENCE}/api/1/vehicles`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (err) {
    const netErr = new Error('network_error');
    netErr.diagnosticCategory = 'network_error';
    throw netErr;
  }
  if (!resp.ok) {
    const err = new Error(`Tesla vehicle list failed: ${resp.status}`);
    err.diagnosticStatus = resp.status;
    err.diagnosticCategory =
      resp.status === 401 ? 'unauthorized' :
      resp.status === 403 ? 'forbidden_or_unregistered_partner' :
      resp.status === 404 ? 'not_found' :
      resp.status === 429 ? 'rate_limited' :
      resp.status >= 500 ? 'tesla_server_error' : 'unknown_error';
    throw err;
  }
  const data = await resp.json();
  return data.response || [];
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const frontend = env.FRONTEND_URL;

  if (error) {
    return Response.redirect(`${frontend}?tesla=cancelled`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${frontend}?tesla=error`, 302);
  }

  // A callback is only trusted if it carries a state value THIS worker issued
  // and hasn't already consumed — never trust a callback on `code` alone.
  const stateKey = `state:${state}`;
  const stateSeen = await env.TESLA_SESSIONS.get(stateKey);
  if (!stateSeen) {
    return Response.redirect(`${frontend}?tesla=invalid_state`, 302);
  }
  await env.TESLA_SESSIONS.delete(stateKey); // single-use

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForTokens(code, redirectUriFor(request), env);
  } catch (err) {
    return Response.redirect(`${frontend}?tesla=token_exchange_failed`, 302);
  }

  const sql = env.cybercabhunter_db;
  const teslaAccountIdentifier = decodeTeslaAccountIdentifier(tokenResponse.id_token);
  const userId = await db.findOrCreateUserByTeslaIdentifier(sql, teslaAccountIdentifier);

  const encryptedAccessToken = await tokenCrypto.encrypt(tokenResponse.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await tokenCrypto.encrypt(tokenResponse.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const accessTokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();

  await db.upsertTeslaConnection(sql, {
    userId, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt, teslaAccountIdentifier
  });

  // Vehicle discovery is best-effort here — a transient Tesla API hiccup
  // shouldn't fail the linking itself; /api/tesla/sync can retry later.
  try {
    const vehicles = await fetchTeslaVehicles(tokenResponse.access_token);
    await db.upsertVehicles(sql, userId, vehicles);
  } catch (err) {
    // Swallowed intentionally — see comment above. Nothing token-related is logged.
  }

  const sessionId = randomToken();
  await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: userId }), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  // The fragment (#...) is never transmitted to any server — only this
  // browser ever sees the session ID, and only for the instant it takes the
  // frontend's own script to read it out of location.hash and store it.
  const headers = new Headers({ Location: `${frontend}?tesla=linked#tesla_session=${sessionId}` });
  return new Response(null, { status: 302, headers });
}

// Returns a valid, decrypted Tesla access token for server-side API calls
// only — refreshing (and re-encrypting + persisting the rotated tokens)
// first if the stored one is stale. Returns null if there's no active,
// usable connection. Never expose this return value to a response.
async function getValidAccessToken(env, userId) {
  const sql = env.cybercabhunter_db;
  const connection = await db.getTeslaConnectionByUserId(sql, userId);
  if (!connection || connection.status !== 'active') return null;

  const expiresAtMs = new Date(connection.access_token_expires_at).getTime();
  if (Date.now() <= expiresAtMs - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return tokenCrypto.decrypt(connection.encrypted_access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  }

  try {
    const refreshToken = await tokenCrypto.decrypt(connection.encrypted_refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const refreshed = await refreshTokens(refreshToken, env);
    const encryptedAccessToken = await tokenCrypto.encrypt(refreshed.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const encryptedRefreshToken = await tokenCrypto.encrypt(refreshed.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const accessTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await db.updateConnectionTokens(sql, userId, { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt });
    return refreshed.access_token;
  } catch (err) {
    // Refresh token expired/revoked on Tesla's side — the connection is dead
    // until the user relinks. Mark it so, rather than retrying forever.
    await db.markConnectionRevoked(sql, userId);
    return null;
  }
}

// ---- Existing OAuth-namespace endpoints (unchanged external behavior) ----

async function handleStatus(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ linked: false });
  const connection = await db.getTeslaConnectionByUserId(env.cybercabhunter_db, userId);
  return Response.json({ linked: !!connection && connection.status === 'active' });
}

// Clears only the browser's session pointer — does not touch D1. Kept as-is
// so nothing that already calls this endpoint changes behavior. The D1-aware
// disconnect/delete actions are the new /api/tesla/* endpoints below.
async function handleDisconnect(request, env) {
  const sessionId = readBearerToken(request);
  if (sessionId) {
    await env.TESLA_SESSIONS.delete(`session:${sessionId}`);
  }
  return Response.json({ linked: false });
}

// ---- New Phase 1 API endpoints ----

async function apiMe(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const user = await db.getUserById(env.cybercabhunter_db, userId);
  if (!user) return Response.json({ authenticated: false }, { status: 401 });

  const connection = await db.getTeslaConnectionByUserId(env.cybercabhunter_db, userId);
  return Response.json({
    authenticated: true,
    user: { id: user.id, created_at: user.created_at },
    tesla: { connected: !!connection && connection.status === 'active' }
  });
}

async function apiTeslaStatus(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ connected: false }, { status: 401 });

  const connection = await db.getTeslaConnectionByUserId(env.cybercabhunter_db, userId);
  const user = await db.getUserById(env.cybercabhunter_db, userId);
  const vehicleCount = await db.countVehiclesByOwner(env.cybercabhunter_db, userId);

  return Response.json({
    connected: !!connection && connection.status === 'active',
    status: connection ? connection.status : 'never_connected',
    last_sync_at: user ? user.last_sync_at : null,
    vehicle_count: vehicleCount,
    access_token_expires_at: connection ? connection.access_token_expires_at : null
  });
}

async function apiVehicles(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const vehicles = await db.getVehiclesByOwner(env.cybercabhunter_db, userId);
  return Response.json({
    vehicles: vehicles.map(v => ({
      id: v.id,
      tesla_vehicle_id: v.tesla_vehicle_id,
      display_name: v.display_name,
      model: v.model,
      year: v.model_year,
      state: v.active_status,
      last_synced_at: v.last_synced_at
    }))
  });
}

async function apiSync(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const accessToken = await getValidAccessToken(env, userId);
  if (!accessToken) {
    return Response.json({ success: false, error: 'not_connected' }, { status: 409 });
  }

  let vehicles;
  try {
    vehicles = await fetchTeslaVehicles(accessToken);
  } catch (err) {
    return Response.json({
      success: false,
      error: 'tesla_api_unavailable',
      diagnostic: { status: err.diagnosticStatus ?? null, category: err.diagnosticCategory ?? 'unknown_error' }
    }, { status: 502 });
  }

  await db.upsertVehicles(env.cybercabhunter_db, userId, vehicles);
  await db.touchUserSync(env.cybercabhunter_db, userId);
  const vehicleCount = await db.countVehiclesByOwner(env.cybercabhunter_db, userId);

  return Response.json({ success: true, vehicle_count: vehicleCount });
}

// Soft revoke: disables the connection and invalidates this browser's
// session, but keeps the tesla_connections row (status='revoked') and all
// discovered vehicles. Does not delete the user's account.
async function apiDisconnect(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  await db.markConnectionRevoked(env.cybercabhunter_db, userId);
  const sessionId = readBearerToken(request);
  if (sessionId) await env.TESLA_SESSIONS.delete(`session:${sessionId}`);

  return Response.json({ success: true, connected: false });
}

// Hard, permanent deletion: the connection row and every vehicle this user
// owns are removed outright. Scoped entirely to this user's own user_id.
async function apiDeleteData(request, env) {
  const userId = await requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  await db.deleteConnectionAndVehicles(env.cybercabhunter_db, userId);
  const sessionId = readBearerToken(request);
  if (sessionId) await env.TESLA_SESSIONS.delete(`session:${sessionId}`);

  return Response.json({ success: true, deleted: true });
}

export const tesla = {
  startOAuth,
  handleCallback,
  handleStatus,
  handleDisconnect,
  apiMe,
  apiTeslaStatus,
  apiVehicles,
  apiSync,
  apiDisconnect,
  apiDeleteData,
  requireUserId,
  // Exposed for worker/tesla-debug.js (temporary capability-audit route) so
  // it reuses the exact existing token-refresh logic and API base rather
  // than duplicating them.
  getValidAccessToken,
  FLEET_API_AUDIENCE
};
