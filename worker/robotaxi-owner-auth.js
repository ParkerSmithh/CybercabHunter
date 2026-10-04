// Robotaxi ride-history authentication — Tesla's private, undocumented
// `ownerapi` OAuth client (the same first-party login Tesla's own mobile
// app uses), NOT the Fleet API. Kept entirely separate from
// worker/tesla.js and tesla_connections — different client, different
// token issuance (PKCE public client, no client_secret, no `audience`),
// and an independent expiry/refresh/revocation lifecycle.
//
// Technical approach (client_id, scopes, endpoints, fixed redirect_uri,
// PKCE flow shape) is derived from Ethan McKanna's MIT-licensed
// robotaxi-history-exporter:
// https://github.com/EthanMcKanna/robotaxi-history-exporter
//
//   MIT License
//
//   Copyright (c) 2026 Ethan McKanna
//
//   Permission is hereby granted, free of charge, to any person obtaining
//   a copy of this software and associated documentation files (the
//   "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish,
//   distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to
//   the following conditions:
//
//   The above copyright notice and this permission notice shall be
//   included in all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//
// This is Tesla's private mobile-app authentication, not a documented or
// partner-authorized API — see the project's architecture-audit
// discussion for the full risk assessment. Access/refresh tokens are
// never logged and never returned to the frontend; only booleans and
// timestamps are.

import { tokenCrypto } from './crypto.js';
import { db } from './db.js';
import { tesla } from './tesla.js';

const AUTH_BASE_URL = 'https://auth.tesla.com/oauth2/v3';
const CLIENT_ID = 'ownerapi';
// Fixed by Tesla for this client — we do not control it and cannot point
// it at our own domain. The user's browser lands on this Tesla-hosted
// blank page after login and must hand the resulting URL back to
// /oauth/robotaxi/callback (see extractCodeAndState below).
const REDIRECT_URI = 'https://auth.tesla.com/void/callback';
const SCOPES = 'openid email offline_access phone';

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Tesla login
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

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

// Authenticated (same bearer session as every other private endpoint) —
// returns the Tesla authorize URL for the CALLER to navigate to, rather
// than redirecting itself, since we need to know which Cybercab Hunter
// user is linking before ever leaving our own domain. A plain <a href>
// navigation can't carry an Authorization header, so this is a fetch()
// call, not a link click.
async function startOAuth(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomState();

  await env.TESLA_SESSIONS.put(
    `robotaxi_state:${state}`,
    JSON.stringify({ user_id: userId, code_verifier: codeVerifier }),
    { expirationTtl: STATE_TTL_SECONDS }
  );

  const authorizeUrl = new URL(`${AUTH_BASE_URL}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('Robotaxi OAuth state created');
  return Response.json({ authorize_url: authorizeUrl.toString() });
}

// Tesla's void-callback page is not on our domain, so the user must hand
// us its URL manually. Accepts either the pasted full URL (`callback_url`)
// or `code`/`state` directly. Never logs either input — both can carry an
// authorization code.
function extractCodeAndState(request) {
  const url = new URL(request.url);
  const pasted = url.searchParams.get('callback_url');
  if (pasted) {
    try {
      const parsed = new URL(pasted);
      return { code: parsed.searchParams.get('code'), state: parsed.searchParams.get('state') };
    } catch (err) {
      return { code: null, state: null };
    }
  }
  return { code: url.searchParams.get('code'), state: url.searchParams.get('state') };
}

async function handleCallback(request, env) {
  console.log('Robotaxi OAuth callback received');
  const { code, state } = extractCodeAndState(request);
  if (!code || !state) {
    return Response.json({ success: false, error: 'missing_code_or_state' }, { status: 400 });
  }

  const stateKey = `robotaxi_state:${state}`;
  const stored = await env.TESLA_SESSIONS.get(stateKey);
  if (!stored) {
    return Response.json({ success: false, error: 'invalid_or_expired_state' }, { status: 400 });
  }
  await env.TESLA_SESSIONS.delete(stateKey); // single-use

  let userId, codeVerifier;
  try {
    ({ user_id: userId, code_verifier: codeVerifier } = JSON.parse(stored));
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_state_payload' }, { status: 400 });
  }
  if (!userId || !codeVerifier) {
    return Response.json({ success: false, error: 'invalid_state_payload' }, { status: 400 });
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI
  });

  let tokenResponse;
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    if (!resp.ok) throw new Error(`token exchange failed: ${resp.status}`);
    tokenResponse = await resp.json();
  } catch (err) {
    return Response.json({ success: false, error: 'token_exchange_failed' }, { status: 502 });
  }

  const encryptedAccessToken = await tokenCrypto.encrypt(tokenResponse.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const encryptedRefreshToken = await tokenCrypto.encrypt(tokenResponse.refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  const accessTokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();

  await db.upsertRobotaxiOwnerConnection(env.cybercabhunter_db, {
    userId, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt
  });

  console.log('Robotaxi OAuth token exchange succeeded');
  return Response.json({ success: true, connected: true });
}

async function refreshTokens(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken
  });
  const resp = await fetch(`${AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`Robotaxi ownerapi token refresh failed: ${resp.status}`);
  return resp.json();
}

// Returns a valid, decrypted ownerapi access token for server-side use
// only — refreshing (and re-encrypting + persisting the rotated tokens)
// first if the stored one is stale. Returns null if there's no active,
// usable connection. Mirrors tesla.js's getValidAccessToken for the
// separate connection; not used by anything yet — the ride-sync module
// (next step) will call this. Never expose this return value to a
// response.
async function getValidAccessToken(env, userId) {
  const sql = env.cybercabhunter_db;
  const connection = await db.getRobotaxiOwnerConnectionByUserId(sql, userId);
  if (!connection || connection.status !== 'active') return null;

  const expiresAtMs = new Date(connection.access_token_expires_at).getTime();
  if (Date.now() <= expiresAtMs - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return tokenCrypto.decrypt(connection.encrypted_access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
  }

  try {
    const refreshToken = await tokenCrypto.decrypt(connection.encrypted_refresh_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const refreshed = await refreshTokens(refreshToken);
    const encryptedAccessToken = await tokenCrypto.encrypt(refreshed.access_token, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const encryptedRefreshToken = await tokenCrypto.encrypt(refreshed.refresh_token || refreshToken, env.TESLA_TOKEN_ENCRYPTION_KEY);
    const accessTokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await db.updateRobotaxiOwnerConnectionTokens(sql, userId, { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt });
    return refreshed.access_token;
  } catch (err) {
    // Refresh token expired/revoked on Tesla's side — the connection is
    // dead until the user relinks. Mark it so, rather than retrying forever.
    await db.markRobotaxiOwnerConnectionRevoked(sql, userId);
    return null;
  }
}

async function apiStatus(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ connected: false }, { status: 401 });

  const connection = await db.getRobotaxiOwnerConnectionByUserId(env.cybercabhunter_db, userId);
  return Response.json({
    connected: !!connection && connection.status === 'active',
    status: connection ? connection.status : 'never_connected',
    access_token_expires_at: connection ? connection.access_token_expires_at : null
  });
}

// Soft revoke only — flips status so it can no longer be used to call
// Tesla's API. Never touches tesla_connections or the Fleet API link.
async function apiDisconnect(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });

  await db.markRobotaxiOwnerConnectionRevoked(env.cybercabhunter_db, userId);
  return Response.json({ success: true, connected: false });
}

export const robotaxiOwnerAuth = {
  startOAuth,
  handleCallback,
  apiStatus,
  apiDisconnect,
  getValidAccessToken
};
