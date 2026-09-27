// Optional direct Gmail receipt import (worker/gmail.js + migration 0015):
// the connect/callback OAuth flow, token encryption, the polling sync
// (backfill, history, expired-history fallback, failures), dedupe against
// the forwarding path, disconnect, the status API and the Rider Data card.
// Google (token, userinfo, revoke, Gmail API) is a local fake installed as
// globalThis.fetch; everything else is the REAL Worker, real SQL (every
// migration) and the real receipt pipeline.
// Run: node tests/gmail-sync.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { seedUser } from './helpers/d1-sqlite.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { tokenCrypto } from '../worker/crypto.js';
import { db } from '../worker/db.js';
import { syncUser, runScheduledSync, GMAIL_SCOPE, RECEIPT_QUERY } from '../worker/gmail.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 7)).toString('base64');
const TESLA_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');
const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------- fake Google
function fakeGoogle() {
  const g = {
    accounts: {},          // sub -> { email }
    codes: {},             // auth code -> { sub, scope }
    refresh: {},           // refresh token -> { sub, revoked }
    access: {},            // access token -> sub
    messages: [],          // { id, raw, subject, ageDays, historyId, deleted }
    historyId: 1000,
    minHistoryId: 0,       // history before this is "expired" (404)
    fail: {},              // message id -> HTTP status to return for messages.get
    failAll: null,         // HTTP status for every Gmail API call
    rotateRefresh: false,
    revoked: [],           // tokens posted to /revoke
    fetched: [],           // message ids downloaded with format=raw
    calls: { token: 0, refresh: 0, list: 0, history: 0, profile: 0 },
    queries: [],
    seq: 0
  };
  g.addAccount = (sub, email) => { g.accounts[sub] = { email }; };
  g.issueCode = (code, sub, scope = `openid email ${GMAIL_SCOPE}`) => { g.codes[code] = { sub, scope }; };
  g.addMessage = ({ subject = 'Robotaxi Ride Receipt on June 9, 2026', body = receiptBody(), from = 'Tesla <noreply@tesla.com>', ageDays = 1, messageId } = {}) => {
    g.historyId += 1;
    const id = 'gm' + (++g.seq);
    const raw = eml({ from, subject, body, messageId: messageId || `<${id}@tesla.com>` });
    g.messages.push({ id, raw, subject, ageDays, historyId: g.historyId });
    return id;
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  g.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const auth = ((init.headers || {}).Authorization || '').replace('Bearer ', '');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(init.body);
      g.calls.token++;
      if (p.get('grant_type') === 'authorization_code') {
        const c = g.codes[p.get('code')];
        if (!c) return json({ error: 'invalid_grant' }, 400);
        delete g.codes[p.get('code')];
        const rt = 'rt-' + Math.random().toString(36).slice(2), at = 'at-' + Math.random().toString(36).slice(2);
        g.refresh[rt] = { sub: c.sub }; g.access[at] = c.sub;
        return json({ access_token: at, refresh_token: rt, scope: c.scope, expires_in: 3599 });
      }
      g.calls.refresh++;
      const r = g.refresh[p.get('refresh_token')];
      if (!r || r.revoked) return json({ error: 'invalid_grant' }, 400);
      const at = 'at-' + Math.random().toString(36).slice(2); g.access[at] = r.sub;
      const out = { access_token: at, expires_in: 3599, scope: GMAIL_SCOPE };
      if (g.rotateRefresh) { const nrt = 'rt-rot-' + Math.random().toString(36).slice(2); g.refresh[nrt] = { sub: r.sub }; out.refresh_token = nrt; }
      return json(out);
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      const token = new URLSearchParams(init.body).get('token');
      g.revoked.push(token);
      if (g.refresh[token]) g.refresh[token].revoked = true;
      return new Response('', { status: 200 });
    }
    if (url.href === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      const sub = g.access[auth];
      return sub ? json({ sub, email: g.accounts[sub].email }) : json({}, 401);
    }
    if (url.origin === 'https://gmail.googleapis.com') {
      if (!g.access[auth]) return json({ error: { code: 401 } }, 401);
      if (g.failAll) return json(g.failAllBody || { error: { message: 'fail' } }, g.failAll);
      const path = url.pathname.replace('/gmail/v1/users/me', '');
      if (path === '/profile') { g.calls.profile++; return json({ emailAddress: 'x', historyId: String(g.historyId) }); }
      if (path === '/history') {
        g.calls.history++;
        const start = Number(url.searchParams.get('startHistoryId'));
        if (start < g.minHistoryId) return json({ error: { code: 404 } }, 404);
        const added = g.messages.filter(m => m.historyId > start).map(m => ({ id: 'h' + m.historyId, messagesAdded: [{ message: { id: m.id } }] }));
        return json({ history: added, historyId: String(g.historyId) });
      }
      if (path === '/messages') {
        g.calls.list++;
        const q = url.searchParams.get('q') || '';
        g.queries.push(q);
        const days = Number((q.match(/newer_than:(\d+)d/) || [])[1] || 99999);
        const hits = q.includes(RECEIPT_QUERY) ? g.messages.filter(m => !m.deleted && m.subject.includes('Robotaxi Ride Receipt') && m.ageDays <= days) : [];
        return json({ messages: hits.slice().reverse().map(m => ({ id: m.id, threadId: m.id })), resultSizeEstimate: hits.length });
      }
      const m = path.match(/^\/messages\/([^/]+)$/);
      if (m) {
        const msg = g.messages.find(x => x.id === decodeURIComponent(m[1]));
        if (g.fail[m[1]]) return json({ error: { message: 'fail' } }, g.fail[m[1]]);
        if (!msg || msg.deleted) return json({ error: { code: 404 } }, 404);
        g.fetched.push(msg.id);
        return json({ id: msg.id, raw: b64url(msg.raw), sizeEstimate: msg.raw.length });
      }
    }
    throw new Error('unexpected fetch ' + url.href);
  };
  return g;
}

// --------------------------------------------------------------- app harness
async function makeApp({ configured = true } = {}) {
  const ctx = await makeEnv({ users: ['alice', 'bob'], domain: 'cybercabhunter.com' });
  seedUser(ctx.d1, 'tessa'); // a Tesla-only account: no Google sign-in
  const g = fakeGoogle();
  g.addAccount('sub-alice', 'alice@gmail.com');
  g.addAccount('sub-bob', 'bob@gmail.com');
  g.addAccount('sub-other', 'someone.else@gmail.com');
  ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc1','alice','sub-alice','alice@gmail.com')`)._exec();
  ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc2','bob','sub-bob','bob@gmail.com')`)._exec();
  for (const u of ['alice', 'bob', 'tessa']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  if (configured) Object.assign(ctx.env, { GMAIL_CLIENT_ID: 'gmail-client', GMAIL_CLIENT_SECRET: 'gmail-secret', GMAIL_TOKEN_ENCRYPTION_KEY: KEY });
  ctx.env.TESLA_TOKEN_ENCRYPTION_KEY = TESLA_KEY;
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  globalThis.fetch = g.fetch;
  ctx.g = g;
  return ctx;
}
const call = (ctx, method, path, user, extra = {}) => worker.fetch(new Request(`https://x${path}`, {
  method, headers: { Origin: 'https://cybercabhunter.com', ...(user ? { Authorization: `Bearer session-${user}` } : {}) }, ...extra
}), ctx.env, extra.execCtx || {});
const json = async r => r.json();
const status = async (ctx, user) => json(await call(ctx, 'GET', '/api/gmail/status', user));
const conn = (ctx, user) => ctx.d1.query('SELECT * FROM gmail_connections WHERE user_id = ?', user)[0];
const trips = (ctx, user) => ctx.d1.query('SELECT * FROM trips WHERE user_id = ?', user);
const processed = (ctx, user) => ctx.d1.query('SELECT * FROM gmail_processed_messages WHERE user_id = ?', user);

// Runs connect + callback for `user`; `authAs` is the Google account that approves.
async function connect(ctx, user, { authAs, scope, waitUntil } = {}) {
  const r = await json(await call(ctx, 'POST', '/api/gmail/connect', user));
  const state = new URL(r.authorize_url).searchParams.get('state');
  const code = 'code-' + Math.random().toString(36).slice(2);
  ctx.g.issueCode(code, authAs || `sub-${user}`, scope);
  const pending = [];
  const resp = await call(ctx, 'GET', `/api/gmail/callback?code=${code}&state=${state}`, null, { execCtx: { waitUntil: p => pending.push(p) } });
  if (waitUntil !== false) await Promise.all(pending);
  return { location: resp.headers.get('Location'), status: resp.status, pending };
}
const result = loc => new URL(loc).searchParams.get('gmail');

async function run() {
  console.log('1. Not configured: everything is a harmless no-op');
  {
    const ctx = await makeApp({ configured: false });
    const s = await status(ctx, 'alice');
    check('status: configured false, not connected', s.configured === false && s.state === 'not_connected');
    // Unconfigured endpoints must not need the Gmail tables (safe before migration 0015 is applied remotely).
    const bare = await makeEnv({ users: ['u9'], domain: 'cybercabhunter.com' });
    bare.d1.exec('DROP TABLE gmail_processed_messages; DROP TABLE gmail_connections;');
    await bare.env.TESLA_SESSIONS.put('session:session-u9', JSON.stringify({ user_id: 'u9' }));
    bare.env.ASSETS = ctx.env.ASSETS;
    const bs = await worker.fetch(new Request('https://x/api/gmail/status', { headers: { Authorization: 'Bearer session-u9' } }), bare.env, {});
    check('status works without the Gmail tables when not configured', bs.status === 200 && (await bs.json()).configured === false);
    check('and the scheduled run is a no-op without them', (await runScheduledSync(bare.env)).skipped === 'not_configured');
    check('connect: 503 gmail_not_configured', (await call(ctx, 'POST', '/api/gmail/connect', 'alice')).status === 503);
    const cb = await call(ctx, 'GET', '/api/gmail/callback?code=a&state=b', null);
    check('callback: redirects to Rider Data with gmail=unavailable', result(cb.headers.get('Location')) === 'unavailable');
    check('the scheduled sync does nothing', (await runScheduledSync(ctx.env)).skipped === 'not_configured');
    const pending = [];
    await worker.scheduled({}, ctx.env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    check('the Worker exports a scheduled handler that is safe to run unconfigured', pending.length === 1 && ctx.g.calls.token === 0);
  }

  console.log('2. Connect: a separate Google authorization, for signed-in Google users only');
  {
    const ctx = await makeApp();
    check('connect requires a session (401)', (await call(ctx, 'POST', '/api/gmail/connect', null)).status === 401);
    const tessa = await call(ctx, 'POST', '/api/gmail/connect', 'tessa');
    check('an account without Google sign-in is refused (409 google_signin_required)', tessa.status === 409 && (await json(tessa)).error === 'google_signin_required');
    const r = await json(await call(ctx, 'POST', '/api/gmail/connect', 'alice'));
    const u = new URL(r.authorize_url);
    check("it returns Google's authorization URL", u.origin === 'https://accounts.google.com' && u.searchParams.get('client_id') === 'gmail-client');
    check('scope is openid, email and gmail.readonly only', u.searchParams.get('scope') === `openid email ${GMAIL_SCOPE}`);
    check('offline access with consent, and a hint for the signed-in Google account', u.searchParams.get('access_type') === 'offline' && u.searchParams.get('prompt') === 'consent' && u.searchParams.get('login_hint') === 'alice@gmail.com');
    check('redirect URI is the Gmail callback', u.searchParams.get('redirect_uri') === 'https://cybercabhunter.com/api/gmail/callback');
    const saved = JSON.parse(await ctx.env.TESLA_SESSIONS.get(`gmail_state:${u.searchParams.get('state')}`));
    check('the state is stored server-side, bound to the user and their Google identity, with an expiry', saved.user_id === 'alice' && saved.google_sub === 'sub-alice' && saved.exp > Date.now());
    check('no session id or user id appears in the URL', !u.href.includes('session-alice') && !u.href.includes('alice&') && !/user_id/.test(u.href));
    const signin = fs.readFileSync(`${ROOT}worker/google-auth.js`, 'utf8');
    check('normal Google sign-in is unchanged: still openid email profile, no Gmail scope', /const SCOPES = 'openid email profile';/.test(signin) && !/gmail/i.test(signin.match(/const SCOPES = .*/)[0]));
  }

  console.log('3. Callback: state, scope and account checks; encrypted token storage');
  {
    const ctx = await makeApp();
    check('an unknown state is refused', result((await call(ctx, 'GET', '/api/gmail/callback?code=c&state=nope', null)).headers.get('Location')) === 'invalid_state');
    check('Google-reported cancel is "cancelled"', result((await call(ctx, 'GET', '/api/gmail/callback?error=access_denied&state=x', null)).headers.get('Location')) === 'cancelled');

    // Expired state (the KV TTL is enforced by Cloudflare; the embedded expiry too).
    const r = await json(await call(ctx, 'POST', '/api/gmail/connect', 'alice'));
    const st = new URL(r.authorize_url).searchParams.get('state');
    const saved = JSON.parse(await ctx.env.TESLA_SESSIONS.get(`gmail_state:${st}`));
    await ctx.env.TESLA_SESSIONS.put(`gmail_state:${st}`, JSON.stringify({ ...saved, exp: Date.now() - 1 }));
    ctx.g.issueCode('c-exp', 'sub-alice');
    check('an expired state is refused (expired_state) and nothing is connected', result((await call(ctx, 'GET', `/api/gmail/callback?code=c-exp&state=${st}`, null)).headers.get('Location')) === 'expired_state' && !conn(ctx, 'alice'));

    const wrong = await connect(ctx, 'alice', { authAs: 'sub-other' });
    check('approving with a DIFFERENT Google account is refused (wrong_account)', result(wrong.location) === 'wrong_account' && !conn(ctx, 'alice'));
    check("…and that account's just-issued grant is revoked", ctx.g.revoked.length === 1);

    const noScope = await connect(ctx, 'alice', { scope: 'openid email' });
    check('unticking Gmail on the consent screen is refused (missing_permission) and revoked', result(noScope.location) === 'missing_permission' && !conn(ctx, 'alice') && ctx.g.revoked.length === 2);

    // State reuse: a callback URL replayed after success is refused.
    const r2 = await json(await call(ctx, 'POST', '/api/gmail/connect', 'alice'));
    const st2 = new URL(r2.authorize_url).searchParams.get('state');
    ctx.g.issueCode('c-ok', 'sub-alice');
    const ok = await call(ctx, 'GET', `/api/gmail/callback?code=c-ok&state=${st2}`, null);
    check('the real account connects (gmail=connected)', result(ok.headers.get('Location')) === 'connected' && new URL(ok.headers.get('Location')).pathname === '/rider-data');
    ctx.g.issueCode('c-replay', 'sub-alice');
    check('the same state cannot be used twice', result((await call(ctx, 'GET', `/api/gmail/callback?code=c-replay&state=${st2}`, null)).headers.get('Location')) === 'invalid_state');

    const row = conn(ctx, 'alice');
    const issued = Object.keys(ctx.g.refresh).filter(k => ctx.g.refresh[k].sub === 'sub-alice' && !ctx.g.refresh[k].revoked);
    check('the connection is active, for the right Google account', row.status === 'active' && row.google_sub === 'sub-alice' && row.email === 'alice@gmail.com');
    check('the refresh token is stored encrypted — not the plain token', !!row.encrypted_refresh_token && !issued.some(tk => row.encrypted_refresh_token.includes(tk)));
    check('…and decrypts only with the Gmail key', (await tokenCrypto.decrypt(row.encrypted_refresh_token, KEY)) === issued[issued.length - 1]);
    let teslaKeyWorks = true;
    try { await tokenCrypto.decrypt(row.encrypted_refresh_token, TESLA_KEY); } catch (e) { teslaKeyWorks = false; }
    check('…never the Tesla key', teslaKeyWorks === false);
    check('the starting mailbox position is recorded', row.history_id === String(ctx.g.historyId));
    const dump = JSON.stringify([...ctx.env.TESLA_SESSIONS._store.entries()]) + JSON.stringify(ctx.d1.query('SELECT * FROM receipt_ingestions')) + JSON.stringify(ctx.d1.query('SELECT * FROM ride_sync_runs'));
    check('no access or refresh token is stored in KV or any log table', !/\b(at|rt)-[a-z0-9]{6,}/.test(dump));
    const s = await status(ctx, 'alice');
    check('status: configured, syncing (the first import has not run), no token fields', s.configured && s.state === 'syncing' && s.initial_import_complete === false && !/token|refresh|access/i.test(Object.keys(s).join()));
  }

  console.log('4. Initial import: a bounded 90-day search; only matching receipts are downloaded');
  const ctx = await makeApp();
  const g = ctx.g;
  const rA = g.addMessage({ body: receiptBody({ date: 'September 20, 2026', pickupTime: '9:10 am', summary: '2.1 mi · 9 min · XVF2648' }), subject: 'Robotaxi Ride Receipt on September 20, 2026', ageDays: 6 });
  // Relayed through DuckDuckGo Email Protection: sender rewritten, subject intact.
  const rB = g.addMessage({ from: 'Tesla <noreply_at_tesla.com_rider@duck.com>', body: receiptBody({ date: 'September 22, 2026', pickupTime: '6:30 pm', summary: '3.4 mi · 12 min · XJR2195' }), subject: 'Robotaxi Ride Receipt on September 22, 2026', ageDays: 4 });
  const tooOld = g.addMessage({ body: receiptBody({ date: 'May 1, 2026' }), subject: 'Robotaxi Ride Receipt on May 1, 2026', ageDays: 140 });
  const unrelated = g.addMessage({ from: 'Friend <friend@example.com>', subject: 'Dinner Saturday?', body: 'See you then.', ageDays: 2 });
  const lookalike = g.addMessage({ from: 'Friend <friend@example.com>', subject: 'Re: Robotaxi Ride Receipt on September 22, 2026', body: 'lol that was fast', ageDays: 3 });
  const done = await connect(ctx, 'alice');
  check('connecting schedules the first sync immediately (ctx.waitUntil)', done.pending.length === 1);
  check('the search is the receipt subject, bounded to 90 days', g.queries.length >= 1 && g.queries[0] === `${RECEIPT_QUERY} newer_than:90d`);
  check('the unrelated email is never downloaded', !g.fetched.includes(unrelated));
  check('a receipt older than 90 days is not downloaded', !g.fetched.includes(tooOld));
  check('the two receipts and the subject look-alike were downloaded, once each', [rA, rB, lookalike].every(id => g.fetched.filter(x => x === id).length === 1) && g.fetched.length === 3);
  const tA = trips(ctx, 'alice');
  check('both receipts became rides, source gmail_api', tA.length === 2 && tA.every(tr => tr.source === 'gmail_api'));
  check('the DuckDuckGo-relayed receipt was accepted by the existing classifier', tA.some(tr => tr.ride_date === '2026-09-22' && tr.pickup_time === '18:30'));
  check('parsed fields come from the existing parser (plate → registry vehicle)', ctx.d1.query(`SELECT license_plate FROM robotaxi_vehicles ORDER BY license_plate`).map(v => v.license_plate).join() === 'XJR2195,XVF2648');
  check('new vehicles are PRIVATE (public eligibility unchanged)', ctx.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles WHERE visibility = 'private'`)[0].n === 2);
  check('the look-alike (not a Tesla receipt) created no ride', !tA.some(tr => tr.ride_date === null));
  // The existing classifier decides: a chat reply with the receipt subject is
  // not a receipt (no ride) — 'rejected', or 'unidentified' since it has no date.
  check('each downloaded message is recorded as processed, with its outcome', processed(ctx, 'alice').length === 3 && processed(ctx, 'alice').some(p => p.gmail_message_id === lookalike && ['rejected', 'unidentified'].includes(p.outcome)));
  check('a gmail_api sync run was recorded', ctx.d1.query(`SELECT * FROM ride_sync_runs WHERE user_id = 'alice' AND source = 'gmail_api'`).length === 1);
  let s = await status(ctx, 'alice');
  check('status: connected, initial import complete, last checked and last receipt set', s.state === 'connected' && s.initial_import_complete && !!s.last_checked_at && !!s.last_receipt_at && s.email === 'alice@gmail.com');
  const rd = await json(await call(ctx, 'GET', '/api/trips', 'alice'));
  check('the rides appear in Rider Data (/api/trips)', rd.trips.length === 2);

  console.log('5. Repeated polling downloads nothing new');
  {
    const before = { fetched: g.fetched.length, list: g.calls.list, trips: trips(ctx, 'alice').length };
    ctx.d1.exec(`UPDATE gmail_connections SET last_checked_at = datetime('now','-1 hour')`);
    const out = await syncUser(ctx.env, 'alice');
    check('a sync with no new mail: history says nothing was added, so no search and no downloads', out.processed === 0 && g.fetched.length === before.fetched && g.calls.list === before.list && g.calls.history >= 1);
    check('no new rides', trips(ctx, 'alice').length === before.trips);
    check('a fresh access token is obtained from the stored refresh token each sync', g.calls.refresh >= 2);
  }

  console.log('6. A new receipt arrives: history → search → one download → one ride');
  let historyBefore;
  {
    historyBefore = conn(ctx, 'alice').history_id;
    const rC = g.addMessage({ body: receiptBody({ date: 'September 26, 2026', pickupTime: '5:05 pm', summary: '2.5 mi · 17 min · XVF2648' }), subject: 'Robotaxi Ride Receipt on September 26, 2026', ageDays: 0 });
    g.addMessage({ from: 'News <news@example.com>', subject: 'Weekly digest', body: 'x', ageDays: 0 });
    const out = await syncUser(ctx.env, 'alice');
    check('exactly the new receipt is downloaded and imported', out.processed === 1 && g.fetched[g.fetched.length - 1] === rC && trips(ctx, 'alice').length === 3);
    check('the recurring search window is small, not 90 days', /newer_than:2d$/.test(g.queries[g.queries.length - 1]));
    check('the history position advanced after success', conn(ctx, 'alice').history_id === String(g.historyId) && conn(ctx, 'alice').history_id !== historyBefore);
    check('same vehicle as an earlier ride: no duplicate vehicle row', ctx.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles WHERE license_plate = 'XVF2648'`)[0].n === 1);
  }

  console.log('7. Temporary failures never advance history or lose a message');
  {
    const rD = g.addMessage({ body: receiptBody({ date: 'September 27, 2026', pickupTime: '8:00 am', summary: '1.2 mi · 6 min · XVF2648' }), subject: 'Robotaxi Ride Receipt on September 27, 2026', ageDays: 0 });
    const pos = conn(ctx, 'alice').history_id;
    g.fail[rD] = 500;
    const out = await syncUser(ctx.env, 'alice');
    check('a Gmail 500 while downloading: the sync reports gmail_api_unavailable', out.error === 'gmail_api_unavailable');
    check('history position unchanged, message not marked processed, no ride', conn(ctx, 'alice').history_id === pos && !processed(ctx, 'alice').some(p => p.gmail_message_id === rD) && trips(ctx, 'alice').length === 3);
    check('status shows a temporary error, still connected, lock released', (await status(ctx, 'alice')).state === 'error' && conn(ctx, 'alice').status === 'active' && conn(ctx, 'alice').sync_lock_until === null);
    g.fail[rD] = 429;
    check('rate limiting (429) is also temporary', (await syncUser(ctx.env, 'alice')).error === 'gmail_rate_limited' && conn(ctx, 'alice').history_id === pos);
    delete g.fail[rD];
    const again = await syncUser(ctx.env, 'alice');
    check('the next run retries and imports it exactly once', again.processed === 1 && trips(ctx, 'alice').length === 4 && (await status(ctx, 'alice')).state === 'connected');
  }

  console.log('8. Expired Gmail history (404) falls back to a bounded search');
  {
    const rE = g.addMessage({ body: receiptBody({ date: 'September 28, 2026', pickupTime: '7:45 pm', summary: '4.0 mi · 15 min · XJR2195' }), subject: 'Robotaxi Ride Receipt on September 28, 2026', ageDays: 0 });
    g.minHistoryId = g.historyId + 1; // everything before now is "expired"
    const listBefore = g.calls.list;
    const out = await syncUser(ctx.env, 'alice');
    check('the new receipt is still found and imported', out.processed === 1 && g.fetched.includes(rE) && trips(ctx, 'alice').length === 5);
    check('via a bounded search (not the whole mailbox)', g.calls.list > listBefore && /newer_than:\d+d$/.test(g.queries[g.queries.length - 1]) && Number(g.queries[g.queries.length - 1].match(/(\d+)d$/)[1]) <= 90);
    check('the history position is reset to the current mailbox position', conn(ctx, 'alice').history_id === String(g.historyId));
    g.minHistoryId = 0;
  }

  console.log('9. Malformed and non-receipt messages are recorded once and never block the sync');
  {
    const bad = g.addMessage({ subject: 'Robotaxi Ride Receipt on September 29, 2026', body: receiptBody({ date: 'September 29, 2026', pickupTime: null, summary: '1 mi · 5 min · XVF2648' }).replace(/\n\d{1,2}:\d{2} [ap]m\n/g, '\n'), ageDays: 0 });
    const out = await syncUser(ctx.env, 'alice');
    const p = processed(ctx, 'alice').find(x => x.gmail_message_id === bad);
    check('a receipt without a readable pickup time creates no ride but is marked processed', out.processed === 1 && p && p.outcome === 'unidentified' && trips(ctx, 'alice').length === 5);
    check('the sync still completed (history advanced)', conn(ctx, 'alice').history_id === String(g.historyId) && (await status(ctx, 'alice')).state === 'connected');
  }

  console.log('10. Duplicates: Gmail + forwarding + manual forward + a different Message-ID');
  {
    const c2 = await makeApp();
    await connect(c2, 'alice');
    const body = receiptBody({ date: 'September 26, 2026', pickupTime: '5:05 pm', summary: '2.5 mi · 17 min · XVF2648' });
    // Forwarding path first (automatic Gmail forward keeps the original headers).
    const fwd = eml({ to: c2.addressFor('alice'), body, subject: 'Robotaxi Ride Receipt on September 26, 2026', messageId: '<orig-0926@tesla.com>' });
    await worker.email(inboundMessage(fwd, c2.addressFor('alice')), c2.env, {});
    check('the forwarded copy created one ride', trips(c2, 'alice').length === 1);
    // The same email then read through Gmail.
    c2.g.addMessage({ body, subject: 'Robotaxi Ride Receipt on September 26, 2026', messageId: '<orig-0926@tesla.com>', ageDays: 0 });
    await syncUser(c2.env, 'alice');
    check('the Gmail copy of the same email is a duplicate, not a second ride', trips(c2, 'alice').length === 1 && processed(c2, 'alice').some(p => p.outcome === 'duplicate'));
    // A manual (quoted) forward, a new Message-ID.
    const quoted = body.split('\n').map(l => '> ' + l).join('\n');
    await worker.email(inboundMessage(eml({ to: c2.addressFor('alice'), from: 'rider@example.com', subject: 'Fw: Robotaxi Ride Receipt on September 26, 2026', body: 'On Saturday Tesla wrote:\n\n' + quoted }), c2.addressFor('alice')), c2.env, {});
    check('a manual quoted forward of the same receipt is not a second ride', trips(c2, 'alice').length === 1);
    // The same receipt content in Gmail under a different Message-ID.
    c2.g.addMessage({ body, subject: 'Robotaxi Ride Receipt on September 26, 2026', messageId: '<resent-0926@tesla.com>', ageDays: 0 });
    await syncUser(c2.env, 'alice');
    check('the same receipt with a different Message-ID is still one ride', trips(c2, 'alice').length === 1);
    check('one registry vehicle, one physical ride for public totals', c2.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles`)[0].n === 1 && c2.d1.query(`SELECT COUNT(DISTINCT ride_key) n FROM trips`)[0].n === 1);
  }

  console.log('11. Token refresh, rotation, revocation and reconnect');
  {
    const c3 = await makeApp();
    await connect(c3, 'alice');
    c3.g.rotateRefresh = true;
    const enc1 = conn(c3, 'alice').encrypted_refresh_token;
    await syncUser(c3.env, 'alice');
    const enc2 = conn(c3, 'alice').encrypted_refresh_token;
    const rotated = await tokenCrypto.decrypt(enc2, KEY);
    check('a rotated refresh token from Google is stored (encrypted) in place of the old one', enc2 !== enc1 && rotated.startsWith('rt-rot-'));
    c3.g.rotateRefresh = false;
    // Revoked in Google: the next refresh fails with invalid_grant.
    for (const k of Object.keys(c3.g.refresh)) c3.g.refresh[k].revoked = true;
    const out = await syncUser(c3.env, 'alice');
    const row = conn(c3, 'alice');
    check('a revoked authorization: status reconnect_required, token cleared, rides kept', out.error === 'reauthorization_required' && row.status === 'error' && row.encrypted_refresh_token === null && (await status(c3, 'alice')).state === 'reconnect_required');
    check('the scheduled sync skips it', (await syncUser(c3.env, 'alice')).skipped === 'not_connected');
    const re = await connect(c3, 'alice');
    check('reconnecting restores it', result(re.location) === 'connected' && conn(c3, 'alice').status === 'active' && (await status(c3, 'alice')).state === 'connected');
    // An unreadable stored token (e.g. the key was rotated) also asks to reconnect.
    c3.d1.exec(`UPDATE gmail_connections SET encrypted_refresh_token = 'not-ciphertext' WHERE user_id = 'alice'`);
    check('an undecryptable stored token asks for reconnect', (await syncUser(c3.env, 'alice')).error === 'stored_token_unreadable' && conn(c3, 'alice').status === 'error');
  }

  console.log('12. Disconnect');
  {
    const c4 = await makeApp();
    c4.g.addMessage({ body: receiptBody({ date: 'September 20, 2026' }), subject: 'Robotaxi Ride Receipt on September 20, 2026', ageDays: 6 });
    await connect(c4, 'alice');
    const token = await tokenCrypto.decrypt(conn(c4, 'alice').encrypted_refresh_token, KEY);
    check('before: connected with a ride and processed ids', trips(c4, 'alice').length === 1 && processed(c4, 'alice').length === 1);
    check('disconnect requires a session', (await call(c4, 'POST', '/api/gmail/disconnect', null)).status === 401);
    await call(c4, 'POST', '/api/gmail/disconnect', 'bob');
    check("another user's disconnect never touches alice's connection", conn(c4, 'alice').status === 'active');
    const d = await call(c4, 'POST', '/api/gmail/disconnect', 'alice');
    const row = conn(c4, 'alice');
    check('disconnect succeeds', d.status === 200 && (await json(d)).state === 'not_connected');
    check('Google is asked to revoke the refresh token', c4.g.revoked.includes(token));
    check('token, history and backfill state deleted; status revoked', row.status === 'revoked' && row.encrypted_refresh_token === null && row.history_id === null && row.backfill_completed_at === null);
    check('processed-message records deleted', processed(c4, 'alice').length === 0);
    check('existing rides are NOT deleted', trips(c4, 'alice').length === 1);
    check('status reads not connected, with no email', (await status(c4, 'alice')).state === 'not_connected' && (await status(c4, 'alice')).email === null);
    check('disconnect again is harmless', (await call(c4, 'POST', '/api/gmail/disconnect', 'alice')).status === 200);
    check('the scheduled sync skips it', (await syncUser(c4.env, 'alice')).skipped === 'not_connected');
  }

  console.log('13. Status isolation, locking and the scheduled run');
  {
    const c5 = await makeApp();
    await connect(c5, 'alice');   // lets the first sync (started by the callback) finish
    c5.d1.exec(`UPDATE gmail_connections SET sync_lock_until = NULL`);
    const bob = await status(c5, 'bob');
    check("another user's status shows nothing of alice's", bob.state === 'not_connected' && bob.email === null);
    check('status requires a session', (await call(c5, 'GET', '/api/gmail/status', null)).status === 401);
    const [a, b] = await Promise.all([syncUser(c5.env, 'alice'), syncUser(c5.env, 'alice')]);
    check('two overlapping syncs of one mailbox: one runs, one is skipped', [a, b].filter(x => x.skipped === 'locked').length === 1);
    await connect(c5, 'bob');
    c5.d1.exec(`UPDATE gmail_connections SET last_checked_at = datetime('now','-1 hour'), sync_lock_until = NULL`);
    const pending = [];
    await worker.scheduled({ cron: '*/10 * * * *' }, c5.env, { waitUntil: p => pending.push(p) });
    const runs = await Promise.all(pending);
    check('the scheduled handler syncs every due connection', runs[0].due === 2 && runs[0].synced === 2);
    check('then nothing is due until the next interval', (await runScheduledSync(c5.env)).due === 0);
    c5.d1.exec(`INSERT INTO gmail_processed_messages (user_id, gmail_message_id, processed_at, outcome) VALUES ('alice','old-1', datetime('now','-200 days'), 'created')`);
    await runScheduledSync(c5.env);
    check('processed-message ids older than the retention window are pruned', !processed(c5, 'alice').some(p => p.gmail_message_id === 'old-1'));
  }

  console.log('14. Rider Data card (real js/rider-data.js in jsdom)');
  const HTML = fs.readFileSync(`${ROOT}public/rider-data.html`, 'utf8');
  const JS = fs.readFileSync(`${ROOT}public/js/rider-data.js`, 'utf8');
  async function openPage(c, user, search = '') {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/rider-data' + search, pretendToBeVisual: true });
    const w = dom.window;
    w.localStorage.setItem('teslaSessionId', `session-${user}`);
    const requests = [];
    w.fetch = async (u, init = {}) => {
      const path = String(u).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      requests.push({ path, method: init.method || 'GET', auth: (init.headers || {}).Authorization });
      return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), c.env, {});
    };
    w.eval(JS);
    const d = w.document;
    const p = { w, d, requests, vis: id => !d.getElementById(id).classList.contains('hidden'), text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
      async waitFor(cond, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); } return false; } };
    await p.waitFor(() => p.vis('dataSignedIn') || p.vis('dataError'));
    await p.waitFor(() => p.requests.some(r => r.path === '/api/gmail/status'));
    await new Promise(r => setTimeout(r, 30));
    return p;
  }
  {
    const off = await makeApp({ configured: false });
    const p0 = await openPage(off, 'alice');
    check('not configured: the Gmail card stays hidden; the forwarding card still shows', !p0.vis('gmailCard') && p0.vis('fwdCard'));

    const c6 = await makeApp();
    const p1 = await openPage(c6, 'alice');
    check('configured, not connected: card visible with Connect Gmail, no Disconnect', p1.vis('gmailCard') && p1.vis('gmailConnectBtn') && !p1.vis('gmailDisconnectBtn') && /Not connected/.test(p1.text('gmailStatusText')));
    check('it explains the 90-day import, the subject search, the privacy page and the forwarding fallback', /90 days/.test(p1.text('gmailCard')) && /Robotaxi Ride Receipt/.test(p1.text('gmailCard')) && !!p1.d.querySelector('#gmailCard a[href="privacy.html"]') && /Forwarding receipts to your private address below works too/.test(p1.text('gmailCard')));
    p1.d.getElementById('gmailConnectBtn').click();
    await p1.waitFor(() => p1.requests.some(r => r.path === '/api/gmail/connect'));
    const cr = p1.requests.find(r => r.path === '/api/gmail/connect');
    check('Connect Gmail POSTs with the session only (no user id)', cr.method === 'POST' && cr.auth === 'Bearer session-alice' && !/user/.test(cr.path));

    c6.g.addMessage({ body: receiptBody({ date: 'September 20, 2026' }), subject: 'Robotaxi Ride Receipt on September 20, 2026', ageDays: 6 });
    await connect(c6, 'alice');
    const p2 = await openPage(c6, 'alice', '?gmail=connected');
    check('after connecting: ✓ Gmail connected, the address, last checked, last receipt, and Disconnect', /✓ Gmail connected/.test(p2.text('gmailStatusText')) && /alice@gmail\.com/.test(p2.text('gmailMeta')) && /Last checked/.test(p2.text('gmailMeta')) && /Last receipt found/.test(p2.text('gmailMeta')) && p2.vis('gmailDisconnectBtn') && !p2.vis('gmailConnectBtn'));
    check('the ?gmail=connected result is shown once, then removed from the URL', /Gmail connected/.test(p2.text('gmailNotice')) && p2.vis('gmailNotice') && !p2.w.location.search.includes('gmail='));
    check('the forwarding card is still there', p2.vis('fwdCard') && /Your receipt address/.test(p2.text('fwdCard')));
    check('nothing token-like is in the page', !/\b(at|rt)-[a-z0-9]{6,}/.test(p2.d.body.innerHTML));

    const p3 = await openPage(c6, 'alice', '?gmail=wrong_account');
    check('wrong_account result explains it', /isn't the Google account you signed in with/.test(p3.text('gmailNotice')));

    p2.d.getElementById('gmailDisconnectBtn').click();
    check('Disconnect asks for confirmation first', /Confirm disconnect/.test(p2.text('gmailDisconnectBtn')) && conn(c6, 'alice').status === 'active');
    p2.d.getElementById('gmailDisconnectBtn').click();
    await p2.waitFor(() => /Not connected/.test(p2.text('gmailStatusText')));
    check('confirming disconnects and the card returns to Connect Gmail', conn(c6, 'alice').status === 'revoked' && p2.vis('gmailConnectBtn'));

    for (const k of Object.keys(c6.g.refresh)) c6.g.refresh[k].revoked = true;
    await connect(c6, 'alice');
    for (const k of Object.keys(c6.g.refresh)) c6.g.refresh[k].revoked = true;
    await syncUser(c6.env, 'alice');
    const p4 = await openPage(c6, 'alice');
    check('reconnect required: "needs attention" with a Reconnect Gmail button', /needs attention/.test(p4.text('gmailStatusText')) && p4.vis('gmailConnectBtn') && /Reconnect Gmail/.test(p4.text('gmailConnectBtn')));
  }

  console.log('16. Gmail API disabled in the project (403 accessNotConfigured) is a config error, not a reconnect');
  {
    const c7 = await makeApp();
    c7.g.addMessage({ body: receiptBody({ date: 'September 20, 2026' }), subject: 'Robotaxi Ride Receipt on September 20, 2026', ageDays: 6 });
    await connect(c7, 'alice');
    const before = conn(c7, 'alice');
    // Google's real shape for a disabled API: 403, reason accessNotConfigured, status SERVICE_DISABLED.
    c7.g.failAll = 403;
    c7.g.failAllBody = { error: { code: 403, message: 'Gmail API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED',
      errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }], details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } };
    c7.g.addMessage({ body: receiptBody({ date: 'September 27, 2026', pickupTime: '8:00 am' }), subject: 'Robotaxi Ride Receipt on September 27, 2026', ageDays: 0 });
    const out = await syncUser(c7.env, 'alice');
    const row = conn(c7, 'alice');
    check('the sync reports gmail_api_disabled (not gmail_permission_missing)', out.error === 'gmail_api_disabled');
    check('the connection stays active and the stored refresh token is kept', row.status === 'active' && row.encrypted_refresh_token === before.encrypted_refresh_token && !!row.encrypted_refresh_token);
    check('history position unchanged; recorded as last_error', row.history_id === before.history_id && row.last_error === 'gmail_api_disabled');
    check('status is "error", not "reconnect_required"', (await status(c7, 'alice')).state === 'error');
    // Only SERVICE_DISABLED (newer error shape) — also a config error.
    c7.g.failAllBody = { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } };
    check('the SERVICE_DISABLED-only shape is treated the same', (await syncUser(c7.env, 'alice')).error === 'gmail_api_disabled' && conn(c7, 'alice').status === 'active');
    // Once the API is enabled again, the next run just works — with the same token.
    c7.g.failAll = null; c7.g.failAllBody = null;
    const again = await syncUser(c7.env, 'alice');
    check('the next run succeeds with the kept token and imports the new receipt', again.processed === 1 && trips(c7, 'alice').length === 2 && (await status(c7, 'alice')).state === 'connected');
    // A genuine permission failure still asks the rider to reconnect (unchanged).
    c7.g.failAll = 403;
    c7.g.failAllBody = { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } };
    const perm = await syncUser(c7.env, 'alice');
    check('a genuine 403 insufficientPermissions still requires reconnect (behavior unchanged)', perm.error === 'gmail_permission_missing' && conn(c7, 'alice').status === 'error' && conn(c7, 'alice').encrypted_refresh_token === null && (await status(c7, 'alice')).state === 'reconnect_required');
    c7.g.failAll = null; c7.g.failAllBody = null;
  }

  console.log('17. First-import status: syncing while running, error once it has failed');
  {
    const c8 = await makeApp();
    await connect(c8, 'alice');
    const set = sqlSet => c8.d1.exec(`UPDATE gmail_connections SET ${sqlSet} WHERE user_id = 'alice'`);
    set(`backfill_completed_at = NULL, last_error = NULL, sync_lock_until = NULL`);
    check('1. first import not finished, no error → syncing', (await status(c8, 'alice')).state === 'syncing');
    set(`sync_lock_until = datetime('now', '+5 minutes')`);
    check('   …and while a run holds the lock → syncing', (await status(c8, 'alice')).state === 'syncing');
    set(`sync_lock_until = NULL, last_error = 'gmail_api_unavailable'`);
    const failed = await status(c8, 'alice');
    check('2. first import not finished and last_error recorded → error', failed.state === 'error' && failed.initial_import_complete === false && failed.error === 'gmail_api_unavailable');
    set(`sync_lock_until = datetime('now', '+5 minutes')`);
    check('   …a retry that is running right now shows syncing again', (await status(c8, 'alice')).state === 'syncing');
    set(`sync_lock_until = NULL, last_error = NULL, backfill_completed_at = datetime('now')`);
    check('3. completed import, no error → connected', (await status(c8, 'alice')).state === 'connected');
    set(`last_error = 'gmail_rate_limited'`);
    check('   completed import with a later temporary error → error (unchanged)', (await status(c8, 'alice')).state === 'error');

    // The Rider Data card: a failed first import shows the error, not "importing…".
    set(`backfill_completed_at = NULL, last_error = 'gmail_api_unavailable', sync_lock_until = NULL`);
    const pf = await openPage(c8, 'alice');
    check('the card shows the error instead of "importing existing receipts…"', !/importing existing receipts/.test(pf.text('gmailStatusText')) && /didn't finish/.test(pf.text('gmailStatusText')));
    set(`last_error = NULL`);
    const pr = await openPage(c8, 'alice');
    check('while the first import genuinely runs, the card says importing', /importing existing receipts/.test(pr.text('gmailStatusText')));
  }

  console.log('15. Privacy page');
  {
    const html = fs.readFileSync(`${ROOT}public/privacy.html`, 'utf8');
    const text = new JSDOM(html).window.document.body.textContent.replace(/\s+/g, ' ');
    check('it is clearly marked as a draft pending legal review', /Draft — pending legal review/.test(text));
    check('it describes the Gmail permission, why, what is read, what is kept, token protection and revocation', /gmail\.readonly/.test(text) && /Robotaxi Ride Receipt/.test(text) && /Email contents are not stored/.test(text) && /AES-256-GCM/.test(text) && /Disconnect Gmail/.test(text) && /myaccount\.google\.com\/permissions/.test(text));
    check('open questions are flagged, not asserted', /To be confirmed/.test(text) && /Limited Use/.test(text));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
