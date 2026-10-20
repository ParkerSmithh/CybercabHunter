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
// The iPhone app (app/, Capacitor) signs in through Apple's system sign-in
// sheet, because Google refuses OAuth inside embedded web views. It starts
// with ?app=ios&challenge=<base64url SHA-256 of a secret verifier it keeps>.
// For that flow the callback returns a one-time code to the app's own URL
// scheme instead of the website; the app redeems it with the verifier
// (POST /oauth/app/exchange), so a code intercepted by another app claiming
// the scheme is useless. The website's own flow is unchanged.
const APP_CALLBACK = 'cybercabhunter://oauth/callback';
const APP_CODE_TTL_SECONDS = 120;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;      // base64url of 32 bytes (SHA-256)
const VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/;
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

// Where to send the visitor after a successful sign-in, when they asked for a
// particular page (e.g. /signin?returnTo=/moderation). ONLY a same-site path
// is ever accepted: anything else — an absolute URL, a scheme-relative
// "//host", a backslash form some browsers treat as "//", control characters,
// or an API/OAuth path — returns null and the visitor simply lands on the
// home page as before. Applied when the sign-in starts AND again when the
// callback redirects, so a stored value is never trusted.
export function sanitizeReturnPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  if (raw[0] !== '/' || raw[1] === '/') return null;
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null;
  let parsed;
  try { parsed = new URL(raw, 'https://internal.invalid'); } catch (e) { return null; }
  if (parsed.origin !== 'https://internal.invalid') return null;
  const path = parsed.pathname + parsed.search;   // any #fragment is dropped
  if (path.startsWith('//') || /^\/(api|oauth)(\/|$)/.test(path)) return null;
  return path;
}

async function startOAuth(request, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return Response.json({ error: 'google_signin_not_configured' }, { status: 503 });
  }

  // The requested return page is kept server-side with the single-use state
  // (never sent to Google, never trusted from the callback's own URL).
  const params = new URL(request.url).searchParams;
  const returnTo = sanitizeReturnPath(params.get('returnTo'));
  const app = params.get('app') === 'ios';
  const challenge = params.get('challenge');
  if (app && !CHALLENGE_RE.test(challenge || '')) return Response.json({ error: 'invalid_challenge' }, { status: 400 });
  const state = randomToken();
  // The website's state value stays '1' or the return path; the app's is JSON.
  const stateValue = app ? JSON.stringify({ app: 'ios', challenge, returnTo }) : (returnTo || '1');
  await env.TESLA_SESSIONS.put(`google_state:${state}`, stateValue, { expirationTtl: STATE_TTL_SECONDS });

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

// The home page by default; the requested page when one was stored (and it is
// still on this site's own origin once resolved against FRONTEND_URL).
function successLocation(frontend, returnTo, sessionId) {
  const home = `${frontend}?signin=success#tesla_session=${sessionId}`;
  if (!returnTo) return home;
  let base, target;
  try { base = new URL(frontend); target = new URL(returnTo, base); } catch (e) { return home; }
  if (target.origin !== base.origin) return home;
  target.searchParams.set('signin', 'success');
  target.hash = `tesla_session=${sessionId}`;
  return target.toString();
}

// The stored state: { returnTo, app } for either flow ('1' = website, no page).
function readState(stored) {
  if (typeof stored === 'string' && stored.startsWith('{')) {
    try {
      const v = JSON.parse(stored);
      if (v && v.app === 'ios' && CHALLENGE_RE.test(v.challenge || '')) return { app: true, challenge: v.challenge, returnTo: sanitizeReturnPath(v.returnTo) };
    } catch (e) { /* not ours */ }
    return { app: false, returnTo: null };
  }
  return { app: false, returnTo: sanitizeReturnPath(stored) };   // '1' (no page requested) -> null
}
const appRedirect = query => new Response(null, { status: 302, headers: { Location: `${APP_CALLBACK}?${query}`, 'Cache-Control': 'no-store' } });

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const frontend = env.FRONTEND_URL;

  if (error) {
    // A cancel inside the app's sign-in sheet goes back to the app (closing the sheet).
    if (state && readState(await env.TESLA_SESSIONS.get(`google_state:${state}`)).app) {
      await env.TESLA_SESSIONS.delete(`google_state:${state}`);
      return appRedirect('signin=cancelled');
    }
    return Response.redirect(`${frontend}?signin=cancelled`, 302);
  }
  if (!code || !state) {
    return Response.redirect(`${frontend}?signin=error`, 302);
  }

  // Only trust a callback carrying a state value this worker issued and
  // hasn't already consumed — never trust a callback on `code` alone.
  const stateKey = `google_state:${state}`;
  const stateSeen = await env.TESLA_SESSIONS.get(stateKey);
  const flow = readState(stateSeen);
  const returnTo = flow.returnTo;
  const fail = reason => (flow.app ? appRedirect(`signin=${reason}`) : Response.redirect(`${frontend}?signin=${reason}`, 302));
  if (!stateSeen) {
    return Response.redirect(`${frontend}?signin=invalid_state`, 302);
  }
  await env.TESLA_SESSIONS.delete(stateKey); // single-use

  let tokenResponse;
  try {
    tokenResponse = await exchangeCodeForTokens(code, env);
  } catch (err) {
    return fail('token_exchange_failed');
  }

  let profile;
  try {
    profile = await fetchGoogleProfile(tokenResponse.access_token);
  } catch (err) {
    return fail('error');
  }
  if (!profile.sub) {
    return fail('error');
  }

  const sql = env.cybercabhunter_db;
  const userId = await db.findOrCreateUserByGoogleIdentity(sql, {
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.picture
  });

  // The app: a one-time code for the verifier holder; the session is created
  // only when the code is redeemed (POST /oauth/app/exchange).
  if (flow.app) {
    const appCode = randomToken();
    await env.TESLA_SESSIONS.put(`google_app_code:${appCode}`, JSON.stringify({ user_id: userId, challenge: flow.challenge, returnTo }), { expirationTtl: APP_CODE_TTL_SECONDS });
    return appRedirect(`code=${appCode}`);
  }

  const sessionId = randomToken();
  await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: userId }), {
    expirationTtl: SESSION_TTL_SECONDS
  });

  // Same fragment handoff Tesla's callback uses — never sent to any server,
  // and js/main.js already reads #tesla_session= into the same session
  // store regardless of which provider created it.
  const headers = new Headers({ Location: successLocation(frontend, returnTo, sessionId) });
  return new Response(null, { status: 302, headers });
}

// POST /oauth/app/exchange { code, verifier } -> { session, return_to }.
// Called by the iPhone app (natively, not from a page). The code is single
// use whatever happens, and only the verifier whose SHA-256 is the challenge
// sent at the start redeems it.
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function exchangeAppCode(request, env) {
  const fail = (error, status = 400) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const code = body && typeof body.code === 'string' ? body.code : '';
  const verifier = body && typeof body.verifier === 'string' ? body.verifier : '';
  if (!/^[a-f0-9]{64}$/.test(code) || !VERIFIER_RE.test(verifier)) return fail('invalid_request');
  const key = `google_app_code:${code}`;
  const stored = await env.TESLA_SESSIONS.get(key);
  if (!stored) return fail('invalid_code');
  await env.TESLA_SESSIONS.delete(key);   // single use, even on a wrong verifier
  let record = null;
  try { record = JSON.parse(stored); } catch (e) { record = null; }
  if (!record || !record.user_id) return fail('invalid_code');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  if (base64url(digest) !== record.challenge) return fail('invalid_verifier');
  const sessionId = randomToken();
  await env.TESLA_SESSIONS.put(`session:${sessionId}`, JSON.stringify({ user_id: record.user_id }), { expirationTtl: SESSION_TTL_SECONDS });
  return Response.json({ session: sessionId, return_to: sanitizeReturnPath(record.returnTo) || '/' }, { headers: { 'Cache-Control': 'no-store' } });
}

export const googleAuth = { startOAuth, handleCallback, exchangeAppCode };
