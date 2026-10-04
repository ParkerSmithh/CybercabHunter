// Tesla "Ride Sync" — a separate OAuth/token subsystem from the existing
// Fleet API integration (worker/tesla.js, tesla_connections) and from the
// earlier ownerapi experiment (worker/robotaxi-owner-auth.js,
// robotaxi_owner_connections). This is Phase 1 only: authorization and
// encrypted token storage. No ride-history API is called anywhere in this
// file — see worker/tesla-ride-provider.js for why that's deliberately
// unimplemented.
//
// Uses Tesla's real, current, documented OAuth mechanism (the same
// auth.tesla.com / fleet-auth.prd.vn.cloud.tesla.com pair Fleet API
// already uses successfully) under a SEPARATE client_id/secret/redirect
// registered specifically for this purpose — never the existing Fleet API
// client, and never the broken `ownerapi` client.

import { tokenCrypto } from './crypto.js';
import { db } from './db.js';
import { tesla } from './tesla.js';

const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Tesla login
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

function config(env) {
  return {
    clientId: env.TESLA_RIDES_CLIENT_ID,
    clientSecret: env.TESLA_RIDES_CLIENT_SECRET,
    redirectUri: env.TESLA_RIDES_REDIRECT_URI || 'https://cybercabhunter.com/api/tesla/rides/callback',
    audience: env.TESLA_RIDES_AUDIENCE || tesla.FLEET_API_AUDIENCE,
    scopes: env.TESLA_RIDES_SCOPES || 'openid offline_access'
  };
}

// Not yet registered with Tesla in production — every entry point checks
// this before doing anything else, rather than constructing a request
// that would only fail later with a less clear error.
function isConfigured(cfg) {
  return !!(cfg.clientId && cfg.clientSecret);
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

// ---- Authorization start ----
//
// Authenticated the same way every other private endpoint in this
// codebase is (bearer session via fetch(), not a plain link click) —
// we need to know which Cybercab Hunter user is connecting before ever
// redirecting to Tesla. Returns the authorize URL as JSON for the caller
// to navigate to, rather than redirecting itself.
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
  authorizeUrl.searchParams.set('audience', cfg.audience);

  console.log('Tesla Ride Sync: OAuth state created');
  return Response.json({ authorize_url: authorizeUrl.toString() });
}

// ---- Authorization callback ----
//
// Unlike the ownerapi experiment, this uses a redirect_uri Cybercab
// Hunter actually registers, so Tesla redirects the browser directly
// here with ordinary ?code&state query params — no manual paste needed.
async function handleCallback(request, env) {
  console.log('Tesla Ride Sync: OAuth callback received');
  const cfg = config(env);
  if (!isConfigured(cfg)) {
    return Response.json({ success: false, error: 'not_configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const frontend = env.FRONTEND_URL;

  if (error) {
    return Response.redirect(`${frontend}?tesla_rides=cancelled`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${frontend}?tesla_rides=error`, 302);
  }

  const stateKey = `tesla_rides_oauth_state:${state}`;
  const stored = await env.TESLA_SESSIONS.get(stateKey);
  if (!stored) {
    return Response.redirect(`${frontend}?tesla_rides=invalid_state`, 302);
  }
  await env.TESLA_SESSIONS.delete(stateKey); // single-use

  let userId, codeVerifier;
  try {
    ({ user_id: userId, code_verifier: codeVerifier } = JSON.parse(stored));
  } catch (err) {
    return Response.redirect(`${frontend}?tesla_rides=error`, 302);
  }
  if (!userId || !codeVerifier) {
    return Response.redirect(`${frontend}?tesla_rides=error`, 302);
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: cfg.redirectUri,
    audience: cfg.audience
  });

  let tokenResponse;
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    if (!resp.ok) throw new Error(`token exchange failed: ${resp.status}`);
    tokenResponse = await resp.json();
  } catch (err) {
    return Response.redirect(`${frontend}?tesla_rides=token_exchange_failed`, 302);
  }

  const encryptedAccessToken = await tokenCrypto.encrypt(tokenResponse.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await tokenCrypto.encrypt(tokenResponse.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const accessTokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();

  const kvTokenKey = kvTokenKeyFor(userId);
  await env.TESLA_SESSIONS.put(kvTokenKey, JSON.stringify({ encryptedAccessToken, encryptedRefreshToken }));
  await db.createTeslaRideSyncConnection(env.cybercabhunter_db, { userId, kvTokenKey, accessTokenExpiresAt });

  console.log('Tesla Ride Sync: OAuth token exchange succeeded');
  return Response.redirect(`${frontend}?tesla_rides=connected`, 302);
}

async function refreshTokens(refreshToken, cfg) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`Tesla Ride Sync token refresh failed: ${resp.status}`);
  return resp.json();
}

// Returns a valid, decrypted access token for server-side use only —
// refreshing first if stale, rotating the refresh token if Tesla issued a
// new one (keeping the old one if Tesla didn't, per OAuth convention).
// Returns null if there's no active, usable connection. Never expose this
// return value to a response. Not called by anything yet in this phase —
// exists for the future ride-history provider to use.
async function getValidAccessToken(env, userId) {
  const sql = env.cybercabhunter_db;
  const connection = await db.getTeslaRideSyncConnectionByUserId(sql, userId);
  if (!connection || connection.status !== 'active') return null;

  const raw = await env.TESLA_SESSIONS.get(connection.kv_token_key);
  if (!raw) return null;
  const { encryptedAccessToken, encryptedRefreshToken } = JSON.parse(raw);

  const expiresAtMs = new Date(connection.access_token_expires_at).getTime();
  if (Date.now() <= expiresAtMs - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return tokenCrypto.decrypt(encryptedAccessToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
  }

  const cfg = config(env);
  try {
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

async function apiStatus(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ connected: false }, { status: 401 });

  const connection = await db.getTeslaRideSyncConnectionByUserId(env.cybercabhunter_db, userId);
  return Response.json({
    connected: !!connection && connection.status === 'active',
    status: connection ? connection.status : 'never_connected',
    connected_at: connection ? connection.connected_at : null,
    last_sync_at: connection ? connection.last_sync_at : null
  });
}

// Revokes the connection AND deletes the KV token blob outright — unlike
// a soft revoke that only flips a status flag, this ensures no
// decryptable token material remains reachable after disconnect.
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
  apiStatus,
  apiDisconnect,
  getValidAccessToken
};
