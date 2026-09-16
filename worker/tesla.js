// Tesla Fleet API OAuth — server-side only. The client ID/secret and Tesla's
// access/refresh tokens never reach the browser; the frontend only ever
// learns a boolean "linked" state. See developer.tesla.com/docs/fleet-api
// for the authorization code flow this implements (no PKCE required).

const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FLEET_API_AUDIENCE = 'https://fleet-api.prd.na.vn.cloud.tesla.com'; // North America region
const SCOPES = 'openid offline_access vehicle_device_data vehicle_location';

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Tesla login
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // ~3 months, matching Tesla's refresh token lifetime
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh a minute before actual expiry

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function redirectUriFor(request) {
  return new URL('/oauth/tesla/callback', request.url).toString();
}

// The frontend (github.io) and this Worker (workers.dev) are different sites,
// so a cookie the Worker sets is a third-party cookie from the frontend's
// point of view — Chrome and Safari both block those by default, which
// silently broke the original cookie-based session. Instead, the callback
// hands the frontend a one-time, opaque session ID via the URL fragment
// (never sent to any server) and the frontend re-sends it explicitly as an
// `Authorization: Bearer <id>` header — a normal header isn't subject to
// third-party cookie policy at all. This ID is not a Tesla token; it's just
// a pointer to the token record this Worker keeps server-side in KV.
function readBearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
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
  return resp.json(); // { access_token, refresh_token, expires_in, ... }
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

async function saveSession(env, sessionId, tokenResponse) {
  const record = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: Date.now() + tokenResponse.expires_in * 1000
  };
  await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS
  });
  return record;
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

  const sessionId = randomToken();
  await saveSession(env, sessionId, tokenResponse);

  // The fragment (#...) is never transmitted to any server — only this
  // browser ever sees the session ID, and only for the instant it takes the
  // frontend's own script to read it out of location.hash and store it.
  const headers = new Headers({ Location: `${frontend}?tesla=linked#tesla_session=${sessionId}` });
  return new Response(null, { status: 302, headers });
}

// Reads the session for this request, refreshing the Tesla access token
// server-side (and rotating the single-use refresh token) if it's stale.
// Returns null if there's no valid linked session. Nothing this returns is
// ever forwarded to the browser — callers only expose a linked boolean.
async function getSession(request, env) {
  const sessionId = readBearerToken(request);
  if (!sessionId) return null;

  const raw = await env.TESLA_SESSIONS.get(`session:${sessionId}`);
  if (!raw) return null;

  let record = JSON.parse(raw);
  if (Date.now() > record.expires_at - ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    try {
      const refreshed = await refreshTokens(record.refresh_token, env);
      record = await saveSession(env, sessionId, refreshed);
    } catch (err) {
      // Refresh token expired/revoked — the session is no longer usable.
      await env.TESLA_SESSIONS.delete(`session:${sessionId}`);
      return null;
    }
  }
  return { sessionId, ...record };
}

async function handleStatus(request, env) {
  const session = await getSession(request, env);
  return Response.json({ linked: !!session });
}

async function handleDisconnect(request, env) {
  const sessionId = readBearerToken(request);
  if (sessionId) {
    await env.TESLA_SESSIONS.delete(`session:${sessionId}`);
  }
  return Response.json({ linked: false });
}

export const tesla = { startOAuth, handleCallback, handleStatus, handleDisconnect };
