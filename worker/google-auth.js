// Google Sign-In — primary account creation, alongside (not replacing)
// the Tesla Fleet API OAuth in worker/tesla.js. Uses the same server-side
// authorization-code flow as Tesla (state, redirect, code exchange) rather
// than the client-side Google Identity Services button, so the client
// secret never reaches the browser and the existing session model
// (opaque bearer token in TESLA_SESSIONS -> user_id) can be reused as-is.
//
// Unlike Tesla, no ongoing access token is stored: Google is used only to
// verify identity once at sign-in (openid email profile), never to call
// Google APIs later on the user's behalf. See migrations/0007_google_identity.sql.

import { db } from './db.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPES = 'openid email profile';

const STATE_TTL_SECONDS = 600; // 10 minutes to complete the Google login
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // ~3 months, matching Tesla sessions

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

// Google requires an exact match against the "Authorized redirect URIs"
// configured for this OAuth client in Google Cloud Console — unlike Tesla's
// redirectUriFor, this can't just be derived from the incoming request, so
// it's pinned to the one URI that must be registered there.
function redirectUriFor(env) {
  return env.GOOGLE_REDIRECT_URI || 'https://cybercabhunter.com/oauth/google/callback';
}

async function startOAuth(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return Response.json({ error: 'google_signin_not_configured' }, { status: 503 });
  }

  const state = randomToken();
  await env.TESLA_SESSIONS.put(`google_state:${state}`, '1', { expirationTtl: STATE_TTL_SECONDS });

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUriFor(env));
  authorizeUrl.searchParams.set('scope', SCOPES);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('access_type', 'online');
  authorizeUrl.searchParams.set('prompt', 'select_account');

  return Response.redirect(authorizeUrl.toString(), 302);
}

async function exchangeCodeForTokens(code, env) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUriFor(env)
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!resp.ok) throw new Error(`Google token exchange failed: ${resp.status}`);
  return resp.json(); // { access_token, id_token, expires_in, ... }
}

async function fetchGoogleProfile(accessToken) {
  const resp = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) throw new Error(`Google userinfo failed: ${resp.status}`);
  return resp.json(); // { sub, email, name, picture, ... }
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const frontend = env.FRONTEND_URL;

  if (error) {
    return Response.redirect(`${frontend}?signin=cancelled`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${frontend}?signin=error`, 302);
  }

  // Only trust a callback carrying a state value this worker issued and
  // hasn't already consumed — never trust a callback on `code` alone.
  const stateKey = `google_state:${state}`;
  const stateSeen = await env.TESLA_SESSIONS.get(stateKey);
  if (!stateSeen) {
    return Response.redirect(`${frontend}?signin=invalid_state`, 302);
  }
  await env.TESLA_SESSIONS.delete(stateKey); // single-use

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForTokens(code, env);
  } catch (err) {
    return Response.redirect(`${frontend}?signin=token_exchange_failed`, 302);
  }

  let profile;
  try {
    profile = await fetchGoogleProfile(tokenResponse.access_token);
  } catch (err) {
    return Response.redirect(`${frontend}?signin=error`, 302);
  }
  if (!profile.sub) {
    return Response.redirect(`${frontend}?signin=error`, 302);
  }

  const sql = env.cybercabhunter_db;
  const userId = await db.findOrCreateUserByGoogleIdentity(sql, {
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.picture
  });

  const sessionId = randomToken();
  await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: userId }), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  // Same fragment handoff Tesla's callback uses — never sent to any server,
  // and js/main.js already reads #tesla_session= into the same session
  // store regardless of which provider created it.
  const headers = new Headers({ Location: `${frontend}?signin=success#tesla_session=${sessionId}` });
  return new Response(null, { status: 302, headers });
}

export const googleAuth = { startOAuth, handleCallback };
