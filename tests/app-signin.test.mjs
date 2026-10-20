// Tests for Google Sign-In from the iPhone app (worker/google-auth.js app flow,
// app/ios/App/App/NativeSignInPlugin.swift): ?app=ios&challenge= at the start,
// a one-time code to cybercabhunter:// at the callback, and the verifier
// exchange (POST /oauth/app/exchange). The website's own flow must not change.
// Fake KV and D1 as in tests/google-auth.test.mjs; no network.
// Run: node tests/app-signin.test.mjs

import { webcrypto } from 'node:crypto';
import { googleAuth } from '../worker/google-auth.js';
import worker from '../worker/index.js';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log(`  ok — ${label}`); } else { fail++; console.log(`  FAIL — ${label}`); } };

function fakeKV() {
  const store = new Map();
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, _store: store };
}
function fakeD1() {
  const users = new Map(), conns = new Map();
  const stmt = sql => {
    const s = { _args: [] };
    s.bind = (...a) => { s._args = a; return s; };
    s.run = async () => {
      if (/INSERT INTO users/.test(sql)) users.set(s._args[0], { id: s._args[0] });
      else if (/INSERT INTO google_connections/.test(sql)) conns.set(s._args[2], s._args[1]);
      return { success: true };
    };
    s.first = async () => (/SELECT user_id FROM google_connections WHERE google_sub = \?/.test(sql) && conns.has(s._args[0]) ? { user_id: conns.get(s._args[0]) } : null);
    return s;
  };
  return { prepare: stmt };
}
const makeEnv = () => ({
  TESLA_SESSIONS: fakeKV(), cybercabhunter_db: fakeD1(), FRONTEND_URL: 'https://cybercabhunter.com/',
  GOOGLE_CLIENT_ID: 'test-google-client-id', GOOGLE_CLIENT_SECRET: 'test-google-client-secret', GOOGLE_REDIRECT_URI: 'https://cybercabhunter.com/oauth/google/callback'
});
const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
const CHALLENGE = b64url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))));

const realFetch = globalThis.fetch;
const google = ({ tokenOk = true } = {}) => { globalThis.fetch = async url => {
  if (String(url).includes('oauth2.googleapis.com/token')) return tokenOk ? Response.json({ access_token: 'tok' }) : new Response('no', { status: 400 });
  if (String(url).includes('userinfo')) return Response.json({ sub: 'google-sub-1', email: 'rider@example.com', name: 'Ada' });
  throw new Error('unexpected fetch ' + url);
}; };
const start = (env, qs) => googleAuth.startOAuth(new Request(`https://cybercabhunter.contactjoeclos.workers.dev/oauth/google/start${qs}`), env);
const stateOf = resp => new URL(resp.headers.get('Location')).searchParams.get('state');
const callback = (env, qs) => googleAuth.handleCallback(new Request(`https://cybercabhunter.com/oauth/google/callback${qs}`), env);
const exchange = (env, body) => googleAuth.exchangeAppCode(new Request('https://cybercabhunter.com/oauth/app/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
const sessions = env => [...env.TESLA_SESSIONS._store.keys()].filter(k => k.startsWith('session:'));

console.log('1. Starting from the app');
{
  const env = makeEnv();
  check('app=ios without a valid challenge: 400, nothing stored', (await start(env, '?app=ios')).status === 400 && (await start(env, '?app=ios&challenge=short')).status === 400 && env.TESLA_SESSIONS._store.size === 0);
  const r = await start(env, `?returnTo=%2Flink-gmail&app=ios&challenge=${CHALLENGE}`);
  const auth = new URL(r.headers.get('Location'));
  check('same Google authorize URL and pinned redirect URI as the website', r.status === 302 && auth.hostname === 'accounts.google.com' && auth.searchParams.get('redirect_uri') === 'https://cybercabhunter.com/oauth/google/callback');
  check('the challenge is never sent to Google', !r.headers.get('Location').includes(CHALLENGE));
  const stored = JSON.parse(await env.TESLA_SESSIONS.get(`google_state:${stateOf(r)}`));
  check('the state remembers the app, its challenge and the return page', stored.app === 'ios' && stored.challenge === CHALLENGE && stored.returnTo === '/link-gmail');
}

console.log('2. The callback hands the app a one-time code, not a session');
{
  const env = makeEnv(); google();
  const state = stateOf(await start(env, `?returnTo=%2Flink-gmail&app=ios&challenge=${CHALLENGE}`));
  const r = await callback(env, `?code=gcode&state=${state}`);
  const loc = r.headers.get('Location') || '';
  const code = new URL(loc.replace('cybercabhunter://', 'https://x/')).searchParams.get('code');
  check('302 to cybercabhunter://oauth/callback?code=<one-time code>', r.status === 302 && loc.startsWith('cybercabhunter://oauth/callback?code=') && /^[a-f0-9]{64}$/.test(code || ''));
  check('no session exists yet, and none is in the redirect', sessions(env).length === 0 && !/tesla_session/.test(loc));
  check('the state is used up', !(await env.TESLA_SESSIONS.get(`google_state:${state}`)));

  const wrong = await exchange(env, { code, verifier: b64url(webcrypto.getRandomValues(new Uint8Array(32))) });
  check('a wrong verifier: 400 invalid_verifier, no session', wrong.status === 400 && (await wrong.json()).error === 'invalid_verifier' && sessions(env).length === 0);
  const again = await exchange(env, { code, verifier: VERIFIER });
  check('the code is single use even after a wrong verifier (then invalid_code)', again.status === 400 && (await again.json()).error === 'invalid_code');
}

console.log('3. The app redeems the code');
{
  const env = makeEnv(); google();
  const state = stateOf(await start(env, `?returnTo=%2Flink-gmail&app=ios&challenge=${CHALLENGE}`));
  const loc = (await callback(env, `?code=gcode&state=${state}`)).headers.get('Location');
  const code = new URL(loc.replace('cybercabhunter://', 'https://x/')).searchParams.get('code');
  const r = await exchange(env, { code, verifier: VERIFIER });
  const body = await r.json();
  check('200 { session, return_to }, never cached', r.status === 200 && /^[a-f0-9]{64}$/.test(body.session) && body.return_to === '/link-gmail' && r.headers.get('Cache-Control') === 'no-store');
  const stored = JSON.parse(await env.TESLA_SESSIONS.get(`session:${body.session}`));
  check('the session is a normal one for the Google user (the website reads it from #tesla_session=)', !!stored.user_id && sessions(env).length === 1);
  check('redeeming again fails', (await exchange(env, { code, verifier: VERIFIER })).status === 400);
  check('malformed requests: 400', (await exchange(env, { code: 'x', verifier: VERIFIER })).status === 400 && (await exchange(env, {})).status === 400);
}

console.log('4. Cancel and failures inside the app go back to the app (closing the sign-in sheet)');
{
  const env = makeEnv(); google({ tokenOk: false });
  const s1 = stateOf(await start(env, `?app=ios&challenge=${CHALLENGE}`));
  const cancel = await callback(env, `?error=access_denied&state=${s1}`);
  check('cancel: cybercabhunter://oauth/callback?signin=cancelled, state used up', cancel.headers.get('Location') === 'cybercabhunter://oauth/callback?signin=cancelled' && !(await env.TESLA_SESSIONS.get(`google_state:${s1}`)));
  const s2 = stateOf(await start(env, `?app=ios&challenge=${CHALLENGE}`));
  check('token exchange failure: back to the app', (await callback(env, `?code=gcode&state=${s2}`)).headers.get('Location') === 'cybercabhunter://oauth/callback?signin=token_exchange_failed');
}

console.log('5. The website flow is unchanged');
{
  const env = makeEnv(); google();
  const r = await start(env, '?returnTo=%2Flink-gmail');
  check('state is still the plain return path', (await env.TESLA_SESSIONS.get(`google_state:${stateOf(r)}`)) === '/link-gmail');
  const loc = (await callback(env, `?code=gcode&state=${stateOf(r)}`)).headers.get('Location');
  check('callback still lands on the site with #tesla_session=', /^https:\/\/cybercabhunter\.com\/link-gmail\?signin=success#tesla_session=[a-f0-9]{64}$/.test(loc) && sessions(env).length === 1);
  const cancel = await callback(env, '?error=access_denied');
  check('a website cancel still goes to the site', cancel.headers.get('Location') === 'https://cybercabhunter.com/?signin=cancelled');
}

console.log('6. Routed by the Worker');
{
  globalThis.fetch = realFetch;
  const env = makeEnv();
  const r = await worker.fetch(new Request('https://cybercabhunter.com/oauth/app/exchange', { method: 'POST', body: '{}' }), env, {});
  check('POST /oauth/app/exchange reaches the exchange (400 invalid_request)', r.status === 400 && (await r.json()).error === 'invalid_request');
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
