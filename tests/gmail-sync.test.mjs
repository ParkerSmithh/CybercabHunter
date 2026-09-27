// Optional direct Gmail receipt import (worker/gmail.js + migrations 0015,
// 0016): the connect/callback OAuth flow, token encryption, the polling sync
// (backfill, history, expired-history fallback, failures), dedupe against
// the forwarding path, disconnect, the status API and the Rider Data card —
// and the Workers Free plan budget: one bounded, resumable step per Worker
// invocation, with every Google call, D1 statement and KV call counted.
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
    failSub: {},           // Google account sub -> HTTP status for its Gmail API calls
    gets: {},              // message id -> messages.get attempts (successful or not)
    onGet: null,           // test hook: called with the id before a messages.get is answered
    ignoreSmaller: false,  // simulate Gmail NOT applying smaller: (defense-in-depth test)
    rotateRefresh: false,
    revoked: [],           // tokens posted to /revoke
    fetched: [],           // message ids downloaded with format=raw
    total: 0,              // every Google HTTP call (token, userinfo, revoke, Gmail API)
    calls: { token: 0, refresh: 0, list: 0, history: 0, profile: 0 },
    queries: [],
    seq: 0
  };
  g.addAccount = (sub, email) => { g.accounts[sub] = { email }; };
  g.issueCode = (code, sub, scope = `openid email ${GMAIL_SCOPE}`) => { g.codes[code] = { sub, scope }; };
  // `t` is Gmail's internalDate (epoch seconds), `ageDays` before now.
  g.addMessage = ({ subject = 'Robotaxi Ride Receipt on June 9, 2026', body = receiptBody(), from = 'Tesla <noreply@tesla.com>', ageDays = 1, messageId } = {}) => {
    g.historyId += 1;
    const id = 'gm' + (++g.seq);
    const raw = eml({ from, subject, body, messageId: messageId || `<${id}@tesla.com>` });
    g.messages.push({ id, raw, subject, ageDays, t: Math.floor(Date.now() / 1000 - ageDays * 86400), historyId: g.historyId });
    return id;
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  g.fetch = async (input, init = {}) => {
    g.total++;
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
      if (g.failSub[g.access[auth]]) return json({ error: { message: 'fail' } }, g.failSub[g.access[auth]]);
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
        const after = Number((q.match(/after:(\d+)/) || [])[1] || 0);
        const before = Number((q.match(/before:(\d+)/) || [])[1] || Infinity);
        const smaller = g.ignoreSmaller ? Infinity : Number((q.match(/smaller:(\d+)/) || [])[1] || Infinity);
        const hits = q.includes(RECEIPT_QUERY)
          ? g.messages.filter(m => !m.deleted && m.subject.includes('Robotaxi Ride Receipt') && m.t >= after && m.t < before && m.raw.length < smaller).sort((a, b) => b.t - a.t)
          : [];
        const size = Number(url.searchParams.get('maxResults') || 100);
        const from = Number(url.searchParams.get('pageToken') || 0);
        const page = hits.slice(from, from + size);
        return json({ messages: page.map(m => ({ id: m.id, threadId: m.id })), resultSizeEstimate: hits.length,
          ...(from + size < hits.length ? { nextPageToken: String(from + size) } : {}) });
      }
      const m = path.match(/^\/messages\/([^/]+)$/);
      if (m) {
        const msg = g.messages.find(x => x.id === decodeURIComponent(m[1]));
        g.gets[m[1]] = (g.gets[m[1]] || 0) + 1;
        if (g.onGet) g.onGet(m[1]);
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

// ------------------------------------------------ Free-plan instrumentation
// Counts, per Worker invocation, every Google HTTP call, every D1 statement
// (each statement of a batch separately) and every KV call — the things the
// Workers Free plan limits to 50 subrequests per invocation.
// 35: the designed worst case of a step that succeeds; 37: when a D1 write
// itself fails and the error path runs. Both well under the assumed 50.
const BUDGET = { subrequests: 35, failurePath: 37, google: 6 };
const SIZE_LIMIT = 256 * 1024;
function instrument(ctx) {
  if (ctx.meter) return ctx.meter;
  const meter = { d1: 0, kv: 0, runs: [] };
  const real = ctx.d1;
  ctx.env.cybercabhunter_db = {
    prepare(sql) {
      const st = real.prepare(sql);
      for (const m of ['first', 'all', 'run']) { const f = st[m]; st[m] = (...a) => { meter.d1++; return f(...a); }; }
      return st;
    },
    batch(stmts) { meter.d1 += stmts.length; return real.batch(stmts); }
  };
  const kv = ctx.env.TESLA_SESSIONS;
  ctx.env.TESLA_SESSIONS = {
    get: k => { meter.kv++; return kv.get(k); }, put: (k, v, o) => { meter.kv++; return kv.put(k, v, o); },
    delete: k => { meter.kv++; return kv.delete(k); }, _store: kv._store
  };
  ctx.meter = meter;
  return meter;
}
// Runs fn() as ONE invocation and records what it spent.
async function measured(ctx, fn) {
  const m = instrument(ctx);
  const start = { g: ctx.g.total, d1: m.d1, kv: m.kv };
  const out = await fn();
  const cost = { google: ctx.g.total - start.g, d1: m.d1 - start.d1, kv: m.kv - start.kv };
  cost.total = cost.google + cost.d1 + cost.kv;
  m.runs.push(cost);
  return { out, cost };
}
const maxCost = ctx => (ctx.meter ? ctx.meter.runs : []).reduce((a, c) => ({ total: Math.max(a.total, c.total), google: Math.max(a.google, c.google), d1: Math.max(a.d1, c.d1) }), { total: 0, google: 0, d1: 0 });
// Simulates the next 10-minute cron for the scheduler (last checks are "old").
const ageChecks = ctx => ctx.d1.exec(`UPDATE gmail_connections SET last_checked_at = datetime(last_checked_at, '-10 minutes') WHERE last_checked_at IS NOT NULL`);
async function cron(ctx, { age = true } = {}) {
  if (age) ageChecks(ctx);
  const { out, cost } = await measured(ctx, async () => {
    const pending = [];
    await worker.scheduled({ cron: '*/10 * * * *' }, ctx.env, { waitUntil: p => pending.push(p) });
    return (await Promise.all(pending))[0];
  });
  return { ...out, cost };
}
// Runs one-step syncs for `user` until its current scan finishes.
async function drain(ctx, user, limit = 1000) {
  let steps = 0, out;
  do { out = (await measured(ctx, () => syncUser(ctx.env, user))).out; steps++; } while (!out.complete && !out.idle && !out.error && !out.skipped && steps < limit);
  return { steps, out };
}
const cursorOf = (ctx, user) => JSON.parse(conn(ctx, user).sync_cursor || 'null');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// N distinct synthetic receipts spread over the last `days` days: every one a
// different physical ride (unique date + pickup time), so each is one ride.
function addReceipts(g, n, { days = 89, offset = 0 } = {}) {
  const ids = [];
  for (let k = 0; k < n; k++) {
    const i = k + offset;
    const ageDays = n === 1 ? 1 : (k * days) / (n - 1) + 0.01;
    const d = new Date(Date.now() - ageDays * 86400000);
    const date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    const time = `${(i % 12) + 1}:${String(Math.floor(i / 12) % 60).padStart(2, '0')} ${Math.floor(i / 720) % 2 ? 'pm' : 'am'}`;
    ids.push(g.addMessage({ body: receiptBody({ date, pickupTime: time, dropoffTime: time, summary: '2.1 mi · 9 min · XVF2648' }), subject: `Robotaxi Ride Receipt on ${date}`, ageDays }));
  }
  return ids;
}
async function addRider(ctx, user) {
  seedUser(ctx.d1, user);
  ctx.g.addAccount(`sub-${user}`, `${user}@gmail.com`);
  ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES (?, ?, ?, ?)`).bind(`gc-${user}`, user, `sub-${user}`, `${user}@gmail.com`)._exec();
  await ctx.env.TESLA_SESSIONS.put(`session:session-${user}`, JSON.stringify({ user_id: user }));
}

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

  console.log('4. Initial import: a bounded 90-day scan; only matching receipts are downloaded');
  const ctx = await makeApp();
  const g = ctx.g;
  const rA = g.addMessage({ body: receiptBody({ date: 'September 20, 2026', pickupTime: '9:10 am', summary: '2.1 mi · 9 min · XVF2648' }), subject: 'Robotaxi Ride Receipt on September 20, 2026', ageDays: 6 });
  // Relayed through DuckDuckGo Email Protection: sender rewritten, subject intact.
  const rB = g.addMessage({ from: 'Tesla <noreply_at_tesla.com_rider@duck.com>', body: receiptBody({ date: 'September 22, 2026', pickupTime: '6:30 pm', summary: '3.4 mi · 12 min · XJR2195' }), subject: 'Robotaxi Ride Receipt on September 22, 2026', ageDays: 4 });
  const tooOld = g.addMessage({ body: receiptBody({ date: 'May 1, 2026' }), subject: 'Robotaxi Ride Receipt on May 1, 2026', ageDays: 140 });
  const unrelated = g.addMessage({ from: 'Friend <friend@example.com>', subject: 'Dinner Saturday?', body: 'See you then.', ageDays: 2 });
  const lookalike = g.addMessage({ from: 'Friend <friend@example.com>', subject: 'Re: Robotaxi Ride Receipt on September 22, 2026', body: 'lol that was fast', ageDays: 3 });
  instrument(ctx);
  const done = await connect(ctx, 'alice');
  check('connecting schedules the first sync immediately (ctx.waitUntil)', done.pending.length === 1);
  const q0 = (g.queries[0] || '').match(/^(.*) after:(\d+) before:(\d+)$/);
  check('the search is the receipt subject, size-bounded, and bounded to 90 days', g.queries.length === 1 && q0 && q0[1] === `${RECEIPT_QUERY} smaller:${SIZE_LIMIT}` && Math.abs((q0[3] - q0[2]) - (90 * 86400 + 120)) <= 5);
  check('that first step (in the callback invocation) only lists: nothing is downloaded yet, and the import is not finished', g.fetched.length === 0 && conn(ctx, 'alice').backfill_completed_at === null && cursorOf(ctx, 'alice').queue.length === 3);
  const first = await drain(ctx, 'alice');
  check('the scheduled steps then import one message each: 3 steps for 3 matches, no re-search', first.steps === 3 && first.out.complete && g.calls.list === 1);
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
  check('gmail_api sync runs were recorded (one per step that downloaded)', ctx.d1.query(`SELECT * FROM ride_sync_runs WHERE user_id = 'alice' AND source = 'gmail_api'`).length === 3);
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
    check('exactly the new receipt is downloaded and imported, in one step', out.processed === 1 && out.complete && g.fetched[g.fetched.length - 1] === rC && trips(ctx, 'alice').length === 3);
    const w = g.queries[g.queries.length - 1].match(/after:(\d+) before:(\d+)$/);
    check('the recurring search window is small (since the last scan began, plus a day), not 90 days', w && (w[2] - w[1]) <= 2 * 86400);
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
    const w = g.queries[g.queries.length - 1].match(/after:(\d+) before:(\d+)$/);
    check('via a bounded search (not the whole mailbox)', g.calls.list === listBefore + 1 && w && (w[2] - w[1]) <= 90 * 86400 + 120);
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
    await drain(c4, 'alice');
    const token = await tokenCrypto.decrypt(conn(c4, 'alice').encrypted_refresh_token, KEY);
    check('before: connected with a ride and processed ids', trips(c4, 'alice').length === 1 && processed(c4, 'alice').length === 1);
    check('disconnect requires a session', (await call(c4, 'POST', '/api/gmail/disconnect', null)).status === 401);
    await call(c4, 'POST', '/api/gmail/disconnect', 'bob');
    check("another user's disconnect never touches alice's connection", conn(c4, 'alice').status === 'active');
    const d = await call(c4, 'POST', '/api/gmail/disconnect', 'alice');
    const row = conn(c4, 'alice');
    check('disconnect succeeds', d.status === 200 && (await json(d)).state === 'not_connected');
    check('Google is asked to revoke the refresh token', c4.g.revoked.includes(token));
    check('token, history, backfill and sync-cursor state deleted; status revoked', row.status === 'revoked' && row.encrypted_refresh_token === null && row.history_id === null && row.backfill_completed_at === null && row.sync_cursor === null);
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
    check('one scheduled run syncs ONE due connection (Free-plan budget)', runs[0].due === 1 && runs[0].synced === 1);
    const second = await runScheduledSync(c5.env);
    check('the next run takes the other one (round-robin)', second.due === 1 && second.synced === 1 && !!conn(c5, 'alice').last_checked_at && !!conn(c5, 'bob').last_checked_at);
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
    const pMid = await openPage(c6, 'alice', '?gmail=connected');
    check('right after connecting (import not finished): "importing existing receipts… continue importing automatically", not "✓ connected"', /importing existing receipts/.test(pMid.text('gmailStatusText')) && /continue importing automatically/.test(pMid.text('gmailStatusText')) && !/✓/.test(pMid.text('gmailStatusText')));
    check('…and the connect notice says it happens in the background over time', /in the background/.test(pMid.text('gmailNotice')) && /can take a while/.test(pMid.text('gmailNotice')));
    await drain(c6, 'alice');
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
    await drain(c7, 'alice');
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

  console.log('18. Free plan: the first import is resumable, one message per invocation, for any mailbox size');
  for (const n of [0, 1, 3, 49, 50, 51, 120, 230]) {
    const c = await makeApp();
    const ids = addReceipts(c.g, n);
    instrument(c);
    const cb = await measured(c, () => connect(c, 'alice'));
    let runs = 0, stalled = false, midway = null;
    const lists0 = c.g.calls.list;
    while (!conn(c, 'alice').backfill_completed_at && runs < n + 40) {
      const before = trips(c, 'alice').length;
      const r = await cron(c);
      runs++;
      if (r.due !== 1) stalled = true;
      if (runs === 3 && n >= 10) midway = { cursor: cursorOf(c, 'alice'), trips: trips(c, 'alice').length, s: await status(c, 'alice'), before };
    }
    const fetchedOnce = ids.every(id => c.g.fetched.filter(x => x === id).length === 1);
    const all = trips(c, 'alice');
    const label = `${n} receipt${n === 1 ? '' : 's'}`;
    check(`${label}: every receipt imported exactly once (${all.length} rides, each message downloaded once)`, all.length === n && fetchedOnce && c.g.fetched.length === n && !stalled);
    // One download per run, plus a few runs that only list a window (or halve a dense one).
    const listing = c.g.calls.list - lists0 + 1;
    check(`${label}: finished in ${runs} scheduled runs — at most one message each (≤ ${n} + listing runs)`, runs >= Math.max(0, n - 0) && runs <= n + listing && (n > 0 || runs === 0));
    check(`${label}: no window is searched again once queued (${listing} listing calls in total)`, listing <= Math.ceil(n / 25) + 8);
    const worst = maxCost(c);
    check(`${label}: every invocation within budget — max ${worst.total} subrequests (≤ ${BUDGET.subrequests}), ${worst.google} Google calls (≤ ${BUDGET.google})`, worst.total <= BUDGET.subrequests && worst.google <= BUDGET.google);
    check(`${label}: the callback invocation itself stays small (${cb.cost.total} subrequests, ${cb.cost.google} Google calls)`, cb.cost.total <= 20 && cb.cost.google <= BUDGET.google);
    if (midway) {
      check(`${label}: progress is saved between invocations (after 3 runs: a backfill cursor with a queue, not finished, status "syncing")`,
        midway.cursor && midway.cursor.mode === 'backfill' && Array.isArray(midway.cursor.queue) && midway.s.state === 'syncing' && midway.s.initial_import_complete === false && midway.trips >= 1 && midway.trips <= 3);
    }
    const s = await status(c, 'alice');
    check(`${label}: the import reaches completion (initial import complete, connected, cursor idle)`, s.state === 'connected' && s.initial_import_complete && !cursorOf(c, 'alice').mode);
    if (n === 51) {
      check('51 receipts: the too-dense 90-day window was halved rather than paged through', c.g.queries.some(q => { const m = q.match(/after:(\d+) before:(\d+)$/); return m && (m[2] - m[1]) < 50 * 86400; }));
    }
  }

  console.log('19. Free plan: an interrupted import resumes where it left off');
  {
    const c = await makeApp();
    const ids = addReceipts(c.g, 12);
    await connect(c, 'alice');
    await cron(c); await cron(c);
    const mid = cursorOf(c, 'alice');
    const listsBefore = c.g.calls.list;
    // A temporary Gmail outage mid-import.
    c.g.failAll = 503;
    const failed = await cron(c);
    const afterFail = cursorOf(c, 'alice');
    check('a temporary failure mid-import keeps the saved queue and the unfinished backfill', afterFail.mode === 'backfill' && JSON.stringify(afterFail.queue) === JSON.stringify(mid.queue) && conn(c, 'alice').backfill_completed_at === null && failed.cost.total <= BUDGET.subrequests);
    check('…and the rider sees a retrying error, not a finished import', (await status(c, 'alice')).state === 'error');
    c.g.failAll = null;
    // A step cut off before it saved (e.g. the Worker was stopped): simulate by
    // importing a message but restoring the older cursor.
    const saved = conn(c, 'alice').sync_cursor;
    await cron(c);
    c.d1.prepare(`UPDATE gmail_connections SET sync_cursor = ? WHERE user_id = 'alice'`).bind(saved)._exec();
    const tripsNow = trips(c, 'alice').length;
    const fetchedNow = c.g.fetched.length;
    await cron(c);
    check('a message already imported by a cut-off step is skipped, not imported or downloaded twice', trips(c, 'alice').length === tripsNow && c.g.fetched.length === fetchedNow);
    let guard = 0;
    while (!conn(c, 'alice').backfill_completed_at && guard++ < 40) await cron(c);
    check('the import then completes with every receipt once, without re-searching the queued window', trips(c, 'alice').length === 12 && ids.every(id => c.g.fetched.filter(x => x === id).length === 1) && c.g.calls.list <= listsBefore + 1);
  }

  console.log('20. Free plan: incremental sync after the import');
  {
    const c = await makeApp();
    addReceipts(c.g, 2);
    await connect(c, 'alice');
    await drain(c, 'alice');
    const pos0 = conn(c, 'alice').history_id;
    // One new receipt: one run.
    const [one] = addReceipts(c.g, 1, { days: 0, offset: 100 });
    let r = await cron(c);
    check('1 new receipt: imported in the next run, history advanced', trips(c, 'alice').length === 3 && c.g.fetched.includes(one) && conn(c, 'alice').history_id !== pos0 && r.cost.total <= BUDGET.subrequests);
    // More new receipts than one run handles.
    const pos1 = conn(c, 'alice').history_id;
    const many = addReceipts(c.g, 4, { days: 0.2, offset: 200 });
    r = await cron(c);
    const q1 = cursorOf(c, 'alice');
    check('4 new receipts: the first run imports ONE and queues the rest', trips(c, 'alice').length === 4 && q1.mode === 'incremental' && q1.queue.length === 3);
    check('…and the history position is NOT advanced while work is queued', conn(c, 'alice').history_id === pos1);
    // A temporary failure on the next queued message.
    c.g.fail[q1.queue[0]] = 500;
    r = await cron(c);
    check('a temporary failure leaves that message queued and history unmoved', r.cost.total <= BUDGET.subrequests && cursorOf(c, 'alice').queue[0] === q1.queue[0] && conn(c, 'alice').history_id === pos1 && trips(c, 'alice').length === 4);
    delete c.g.fail[q1.queue[0]];
    const listBefore = c.g.calls.list;
    await cron(c); await cron(c);
    check('the remaining receipts continue on the following runs, without re-searching', trips(c, 'alice').length === 6 && c.g.calls.list === listBefore && conn(c, 'alice').history_id === pos1);
    await cron(c);
    check('once the queue is drained the history position advances', trips(c, 'alice').length === 7 && conn(c, 'alice').history_id === String(c.g.historyId) && !cursorOf(c, 'alice').mode && many.every(id => c.g.fetched.filter(x => x === id).length === 1));
    // Mail arriving DURING a long import is found afterwards.
    const c2 = await makeApp();
    addReceipts(c2.g, 5);
    await connect(c2, 'alice');
    await cron(c2);
    const [late] = addReceipts(c2.g, 1, { days: 0, offset: 300 });
    let guard = 0;
    while (!conn(c2, 'alice').backfill_completed_at && guard++ < 20) await cron(c2);
    await cron(c2);
    check('a receipt that arrived during the import is picked up once it finishes', c2.g.fetched.includes(late) && trips(c2, 'alice').length === 6);
    const idle = await cron(c2);
    check('an idle run with no new mail: 2 Google calls (token + history), no search', idle.cost.google === 2 && idle.cost.total <= 10);
  }

  console.log('21. Free plan: many riders — one per invocation, round-robin, none starved');
  {
    const c = await makeApp();
    const riders = ['alice', 'bob', 'r3', 'r4', 'r5'];
    for (const u of riders.slice(2)) await addRider(c, u);
    addReceipts(c.g, 3);
    for (const u of riders) await connect(c, u);
    // r5's Gmail keeps failing (a problematic rider).
    c.g.failSub['sub-r5'] = 500;
    instrument(c);
    const order = [];
    let guard = 0;
    const healthy = riders.slice(0, 4);
    while (healthy.some(u => !conn(c, u).backfill_completed_at) && guard++ < 100) {
      ageChecks(c);
      const before = Object.fromEntries(riders.map(u => [u, conn(c, u).last_checked_at]));
      const r = await cron(c, { age: false });
      const touched = riders.filter(u => conn(c, u).last_checked_at !== before[u]);
      order.push(touched);
      if (r.due !== 1 || touched.length !== 1) { order.bad = true; }
    }
    check('every scheduled run touches exactly one rider', !order.bad);
    const firstRounds = order.slice(0, riders.length * 2).map(t => t[0]);
    const fair = [0, 1].every(k => new Set(firstRounds.slice(k * riders.length, (k + 1) * riders.length)).size === riders.length);
    check('round-robin: in every 5 consecutive runs each of the 5 riders gets exactly one turn', fair);
    check('the healthy riders all finish their imports (each ride imported once per rider)', healthy.every(u => trips(c, u).length === 3 && !!conn(c, u).backfill_completed_at));
    check('the failing rider keeps its turns but never blocks anyone, and is shown as retrying', [Math.floor(order.length / riders.length), Math.ceil(order.length / riders.length)].includes(order.filter(t => t[0] === 'r5').length) && (await status(c, 'r5')).state === 'error' && conn(c, 'r5').status === 'active');
    const worst = maxCost(c);
    check(`no run exceeds the budget across all riders (max ${worst.total} subrequests, ${worst.google} Google calls)`, worst.total <= BUDGET.subrequests && worst.google <= BUDGET.google);
    // A rider whose run was cut off mid-step (lock still held) is skipped, not waited on.
    c.d1.exec(`UPDATE gmail_connections SET sync_lock_until = datetime('now', '+4 minutes') WHERE user_id = 'alice'`);
    c.d1.exec(`UPDATE gmail_connections SET last_checked_at = datetime('now', '-3 hours') WHERE user_id = 'alice'`);
    ageChecks(c);
    const snap = Object.fromEntries(riders.map(u => [u, conn(c, u).last_checked_at]));
    const r = await cron(c, { age: false });
    const served = riders.filter(u => conn(c, u).last_checked_at !== snap[u]);
    check('a rider still locked by a cut-off run is skipped and another rider is served', r.due === 1 && served.length === 1 && served[0] !== 'alice' && conn(c, 'alice').sync_lock_until !== null);
    const lim = fs.readFileSync(`${ROOT}worker/gmail.js`, 'utf8');
    check('the per-invocation limits are explicit constants: 1 rider, 1 message, 6 Google calls, 50 ids per listing',
      /const RIDERS_PER_INVOCATION = 1;/.test(lim) && /const MESSAGES_PER_INVOCATION = 1;/.test(lim) && /const GOOGLE_CALLS_PER_INVOCATION = 6;/.test(lim) && /const LIST_PAGE_SIZE = 50;/.test(lim));
  }

  console.log('22. Free plan: worst-case step and the Google-call backstop');
  {
    const c = await makeApp();
    await connect(c, 'alice');
    await drain(c, 'alice');
    // Rotated refresh token + expired history (404 → profile) + a receipt to import, all in one step.
    c.g.rotateRefresh = true;
    addReceipts(c.g, 1, { days: 0, offset: 400 });
    c.g.minHistoryId = c.g.historyId + 1;
    const r = await cron(c);
    check(`rotation + expired history + an import in one run: ${r.cost.total} subrequests, ${r.cost.google} Google calls (within budget)`, r.cost.total <= BUDGET.subrequests && r.cost.google === 5 && trips(c, 'alice').length === 1);
    c.g.rotateRefresh = false; c.g.minHistoryId = 0;
    // Backstop: if a step were ever to need more Google calls than allowed, it stops
    // with a temporary error instead of running on — nothing is lost.
    addReceipts(c.g, 1, { days: 0, offset: 401 });
    const { newBudgetForTest } = await import('../worker/gmail.js').then(m => ({ newBudgetForTest: m.gmail.newBudget }));
    const out = await syncUser(c.env, 'alice', { budget: newBudgetForTest(2) });
    check('a step that would exceed its Google-call budget stops with a temporary error (invocation_budget_reached)', out.error === 'invocation_budget_reached' && conn(c, 'alice').status === 'active' && !!conn(c, 'alice').encrypted_refresh_token);
    const again = await drain(c, 'alice');
    check('…and the next run completes the work normally', again.out.complete && trips(c, 'alice').length === 2);
  }

  console.log('23. Duplicates across Gmail and forwarding (existing dedupe, unchanged)');
  {
    const c = await makeApp();
    await connect(c, 'alice');
    const body = receiptBody({ date: 'September 24, 2026', pickupTime: '3:15 pm', summary: '1.9 mi · 8 min · XVF2648' });
    // Gmail → Gmail: the same email twice in the mailbox (e.g. a copy in another label) and a re-listed window.
    c.g.addMessage({ body, subject: 'Robotaxi Ride Receipt on September 24, 2026', messageId: '<same-0924@tesla.com>', ageDays: 0 });
    c.g.addMessage({ body, subject: 'Robotaxi Ride Receipt on September 24, 2026', messageId: '<same-0924@tesla.com>', ageDays: 0 });
    await drain(c, 'alice'); await drain(c, 'alice');
    check('Gmail → Gmail: two copies of one email are one ride', trips(c, 'alice').length === 1 && processed(c, 'alice').some(p => p.outcome === 'duplicate'));
    // Gmail → forwarding: the same receipt later forwarded to the rider's address.
    await worker.email(inboundMessage(eml({ to: c.addressFor('alice'), body, subject: 'Robotaxi Ride Receipt on September 24, 2026', messageId: '<same-0924@tesla.com>' }), c.addressFor('alice')), c.env, {});
    check('Gmail → forwarding: the forwarded copy is not a second ride', trips(c, 'alice').length === 1);
    // Forwarding → Gmail: a different receipt forwarded first, then read from Gmail.
    const body2 = receiptBody({ date: 'September 25, 2026', pickupTime: '9:40 am', summary: '3.0 mi · 11 min · XJR2195' });
    await worker.email(inboundMessage(eml({ to: c.addressFor('alice'), body: body2, subject: 'Robotaxi Ride Receipt on September 25, 2026', messageId: '<fwd-0925@tesla.com>' }), c.addressFor('alice')), c.env, {});
    c.g.addMessage({ body: body2, subject: 'Robotaxi Ride Receipt on September 25, 2026', messageId: '<fwd-0925@tesla.com>', ageDays: 0 });
    await drain(c, 'alice');
    check('forwarding → Gmail: the Gmail copy is not a second ride', trips(c, 'alice').length === 2);
    // Different Gmail Message-IDs carrying the same physical receipt.
    c.g.addMessage({ body: body2, subject: 'Robotaxi Ride Receipt on September 25, 2026', messageId: '<resend-a@tesla.com>', ageDays: 0 });
    c.g.addMessage({ body: body2, subject: 'Robotaxi Ride Receipt on September 25, 2026', messageId: '<resend-b@tesla.com>', ageDays: 0 });
    await drain(c, 'alice'); await drain(c, 'alice');
    check('different Message-IDs, same physical receipt: still one ride', trips(c, 'alice').length === 2 && c.d1.query(`SELECT COUNT(DISTINCT ride_key) n FROM trips WHERE user_id = 'alice'`)[0].n === 2);
  }

  console.log('24. Free-plan changes stay inside the Gmail sync');
  {
    const mig = fs.readFileSync(`${ROOT}migrations/0016_gmail_sync_cursor.sql`, 'utf8').replace(/^--.*$/gm, '').trim();
    check('migration 0016 only adds one nullable column', mig === 'ALTER TABLE gmail_connections ADD COLUMN sync_cursor TEXT;');
    const cfg = fs.readFileSync(`${ROOT}wrangler.jsonc`, 'utf8');
    check('the cron is still every 10 minutes', /"crons":\s*\["\*\/10 \* \* \* \*"\]/.test(cfg));
    const g2 = fs.readFileSync(`${ROOT}worker/gmail.js`, 'utf8');
    check('scope, token key and account check unchanged', /export const GMAIL_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly';/.test(g2) && /key: env\.GMAIL_TOKEN_ENCRYPTION_KEY/.test(g2) && /profile\.sub !== saved\.google_sub/.test(g2));
    check('Gmail still enters the existing pipeline as gmail_api', /processReceiptMessage\(env, parsed, 'gmail_api'/.test(g2) && /parseRawEmail\(/.test(g2));
    check('no console output in the Gmail worker code (nothing token- or content-bearing can be logged)', !/console\./.test(g2) && !/console\./.test(fs.readFileSync(`${ROOT}worker/db-gmail.js`, 'utf8')));
  }

  console.log('25. Oversized Gmail messages never reach the parser');
  {
    const c = await makeApp();
    const small = (date, time, age, subject) => c.g.addMessage({ body: receiptBody({ date, pickupTime: time, summary: '2.0 mi · 8 min · XVF2648' }), subject: subject || `Robotaxi Ride Receipt on ${date}`, ageDays: age });
    const older = small('September 18, 2026', '8:10 am', 9);
    // A forwarded receipt with photos (e.g. in Sent): matches the subject but is ~400 KB.
    const big = c.g.addMessage({ body: receiptBody({ date: 'September 19, 2026', pickupTime: '9:20 am' }) + '\n' + 'P'.repeat(400 * 1024), subject: 'Fwd: Robotaxi Ride Receipt on September 19, 2026', ageDays: 8 });
    const fwdSmall = small('September 20, 2026', '10:30 am', 7, 'Fwd: Robotaxi Ride Receipt on September 20, 2026');
    const newer = small('September 21, 2026', '11:40 am', 6);
    check('the oversized test message really is over the limit, the others under it', c.g.messages.find(m => m.id === big).raw.length > SIZE_LIMIT && [older, fwdSmall, newer].every(id => c.g.messages.find(m => m.id === id).raw.length < SIZE_LIMIT));
    await connect(c, 'alice');
    let guard = 0;
    while (!conn(c, 'alice').backfill_completed_at && guard++ < 20) await cron(c);
    check(`every Gmail search carries smaller:${SIZE_LIMIT}`, c.g.queries.length > 0 && c.g.queries.every(q => q.includes(`smaller:${SIZE_LIMIT}`) && q.startsWith(RECEIPT_QUERY)));
    check('the oversized message is never listed, downloaded or recorded', !c.g.gets[big] && !processed(c, 'alice').some(p => p.gmail_message_id === big) && !(cursorOf(c, 'alice').queue || []).includes(big));
    check('the valid receipts around it — including a small forwarded one ("Fwd: …") — are imported and the import completes',
      [older, fwdSmall, newer].every(id => c.g.gets[id] === 1) && trips(c, 'alice').length === 3 && !!conn(c, 'alice').backfill_completed_at);
    // Defense in depth: if Gmail ever listed it anyway, it is rejected on size before parsing.
    const c2 = await makeApp();
    c2.g.ignoreSmaller = true;
    const big2 = c2.g.addMessage({ body: receiptBody({ date: 'September 19, 2026', pickupTime: '9:20 am' }) + '\n' + 'P'.repeat(400 * 1024), subject: 'Fwd: Robotaxi Ride Receipt on September 19, 2026', ageDays: 8 });
    const ok2 = c2.g.addMessage({ body: receiptBody({ date: 'September 21, 2026', pickupTime: '11:40 am' }), subject: 'Robotaxi Ride Receipt on September 21, 2026', ageDays: 6 });
    await connect(c2, 'alice');
    guard = 0;
    while (!conn(c2, 'alice').backfill_completed_at && guard++ < 20) await cron(c2);
    const p2 = processed(c2, 'alice').find(p => p.gmail_message_id === big2);
    check('…a listed oversized message is recorded as message_too_large without being parsed (no ingestion row), and the next receipt still imports',
      p2 && p2.outcome === 'message_too_large' && c2.d1.query(`SELECT COUNT(*) n FROM receipt_ingestions WHERE user_id = 'alice'`)[0].n === 1 && c2.g.gets[ok2] === 1 && trips(c2, 'alice').length === 1);
  }

  console.log('26. A message that keeps failing cannot block the queue');
  {
    // (a) A message that fails the same way every time (a non-temporary Gmail error).
    const c = await makeApp();
    const ids = addReceipts(c.g, 3);
    await connect(c, 'alice');
    const bad = cursorOf(c, 'alice').queue[0];
    c.g.fail[bad] = 400;
    const r1 = await cron(c);
    const cur1 = cursorOf(c, 'alice');
    check('1st failure: the attempt is recorded in the cursor and the message stays first, retryable, not processed',
      cur1.queue[0] === bad && cur1.attempt && cur1.attempt.id === bad && cur1.attempt.n === 1 && !processed(c, 'alice').some(p => p.gmail_message_id === bad) && (await status(c, 'alice')).state === 'error');
    const r2 = await cron(c);
    const skipRow = processed(c, 'alice').find(p => p.gmail_message_id === bad);
    check('2nd failure: the message is skipped, recorded only as skipped_repeated_failure, and leaves the queue',
      c.g.gets[bad] === 2 && skipRow && skipRow.outcome === 'skipped_repeated_failure' && cursorOf(c, 'alice').queue[0] !== bad && !cursorOf(c, 'alice').attempt);
    check('the failing runs stayed within budget', r1.cost.total <= BUDGET.subrequests && r2.cost.total <= BUDGET.subrequests);
    let guard = 0;
    while (!conn(c, 'alice').backfill_completed_at && guard++ < 20) await cron(c);
    check('the later receipts are then imported and the backfill completes', trips(c, 'alice').length === 2 && ids.filter(id => id !== bad).every(id => c.g.fetched.includes(id)) && (await status(c, 'alice')).state === 'connected');

    // (b) A message whose runs are cut off (e.g. the CPU limit): no error handling runs at all.
    const k = await makeApp();
    addReceipts(k.g, 2);
    await connect(k, 'alice');
    const kill = cursorOf(k, 'alice').queue[0];
    let atKill = null;
    k.g.onGet = id => { if (id === kill) atKill = { ...conn(k, 'alice') }; };
    k.g.fail[kill] = 500;
    const cutOff = async () => {
      await cron(k);
      // Put back exactly what was persisted when the download started: nothing after it happened.
      k.d1.prepare(`UPDATE gmail_connections SET sync_cursor = ?, last_error = ?, sync_lock_until = NULL WHERE user_id = 'alice'`).bind(atKill.sync_cursor, atKill.last_error)._exec();
    };
    await cutOff();
    check('a cut-off run still leaves its attempt marker (saved before the download)', (cursorOf(k, 'alice').attempt || {}).id === kill && (cursorOf(k, 'alice').attempt || {}).n === 1);
    await cutOff();
    check('…which survives into the next invocation and counts again', (cursorOf(k, 'alice').attempt || {}).n === 2 && k.g.gets[kill] === 2);
    await cron(k);
    check('after two cut-off attempts the next run skips it WITHOUT downloading it again', k.g.gets[kill] === 2 && processed(k, 'alice').find(p => p.gmail_message_id === kill).outcome === 'skipped_repeated_failure');
    k.g.onGet = null;
    guard = 0;
    while (!conn(k, 'alice').backfill_completed_at && guard++ < 20) await cron(k);
    check('…and the other receipt imports; the backfill completes', trips(k, 'alice').length === 1 && !!conn(k, 'alice').backfill_completed_at);

    // (c) Temporary errors are retried and do not count as hard failures…
    const t2 = await makeApp();
    addReceipts(t2.g, 2);
    await connect(t2, 'alice');
    const flaky = cursorOf(t2, 'alice').queue[0];
    t2.g.fail[flaky] = 503;
    for (let i = 0; i < 4; i++) await cron(t2);
    const ct = cursorOf(t2, 'alice');
    check('4 temporary failures in a row: still queued first, n = 0, t = 4 — not skipped', ct.queue[0] === flaky && (ct.attempt || {}).n === 0 && (ct.attempt || {}).t === 4 && !processed(t2, 'alice').some(p => p.gmail_message_id === flaky));
    delete t2.g.fail[flaky];
    await cron(t2);
    check('once Gmail recovers it imports normally and the marker is cleared', processed(t2, 'alice').find(p => p.gmail_message_id === flaky).outcome === 'created' && !cursorOf(t2, 'alice').attempt);
    // …but a message that NEVER stops failing temporarily is eventually skipped too.
    const t3 = await makeApp();
    addReceipts(t3.g, 2);
    await connect(t3, 'alice');
    const stuck = cursorOf(t3, 'alice').queue[0];
    t3.g.fail[stuck] = 503;
    let runs = 0;
    while (!processed(t3, 'alice').some(p => p.gmail_message_id === stuck) && runs < 30) { await cron(t3); runs++; }
    check('a permanently failing (temporary-error) message is skipped after 12 attempts, not kept forever', runs === 12 && t3.g.gets[stuck] === 12 && processed(t3, 'alice').find(p => p.gmail_message_id === stuck).outcome === 'skipped_repeated_failure');
    guard = 0;
    while (!conn(t3, 'alice').backfill_completed_at && guard++ < 20) await cron(t3);
    check('…and the backfill then completes with the remaining receipt', trips(t3, 'alice').length === 1);

    // (d) A normal duplicate is not a failure: no marker is left behind.
    const d = await makeApp();
    await connect(d, 'alice');
    const body = receiptBody({ date: 'September 23, 2026', pickupTime: '4:00 pm' });
    await worker.email(inboundMessage(eml({ to: d.addressFor('alice'), body, subject: 'Robotaxi Ride Receipt on September 23, 2026', messageId: '<dup-0923@tesla.com>' }), d.addressFor('alice')), d.env, {});
    d.g.addMessage({ body, subject: 'Robotaxi Ride Receipt on September 23, 2026', messageId: '<dup-0923@tesla.com>', ageDays: 0 });
    await drain(d, 'alice');
    check('a Gmail duplicate is recorded as duplicate (not skipped), with no attempt marker left', processed(d, 'alice').some(p => p.outcome === 'duplicate') && !processed(d, 'alice').some(p => p.outcome === 'skipped_repeated_failure') && !cursorOf(d, 'alice').attempt);

    // Budget: every run above — including the attempt-marker writes and failure paths — stayed bounded.
    const all = [c, k, t2, t3, d].map(maxCost);
    check(`with the attempt marker, no run exceeded ${BUDGET.subrequests} subrequests or ${BUDGET.google} Google calls (max ${Math.max(...all.map(x => x.total))})`, all.every(x => x.total <= BUDGET.subrequests && x.google <= BUDGET.google));
    const cur = JSON.stringify(cursorOf(c, 'alice')) + JSON.stringify(cursorOf(k, 'alice')) + JSON.stringify(cursorOf(t3, 'alice'));
    check('cursors hold only ids, counters and time bounds — no token or message content', !/\b(at|rt)-[a-z0-9]{6,}|Trip Summary|Pick up|Payment|tesla\.com/.test(cur) && cur.length < 4000);
  }

  console.log('27. Gmail authorization URL and Google granular-consent scope handling');
  {
    const c = await makeApp();
    // Sign-in's own client must never be used for the Gmail flow.
    Object.assign(c.env, { GOOGLE_CLIENT_ID: 'signin-client', GOOGLE_CLIENT_SECRET: 'signin-secret' });
    const r = await json(await call(c, 'POST', '/api/gmail/connect', 'alice'));
    const u = new URL(r.authorize_url);
    check('the authorization URL itself requests gmail.readonly (encoded exactly as sent to Google)',
      u.search.includes('scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly&') && u.searchParams.get('scope').split(' ').includes(GMAIL_SCOPE));
    check('…with only the identity scopes it needs (openid, email) — no profile, no broader Gmail scope', u.searchParams.get('scope').split(' ').sort().join() === ['email', 'openid', GMAIL_SCOPE].sort().join());
    check('it uses the Gmail client and the Gmail callback, never the sign-in client', u.searchParams.get('client_id') === 'gmail-client' && u.searchParams.get('redirect_uri') === 'https://cybercabhunter.com/api/gmail/callback' && !u.href.includes('signin-client'));
    // Real Google token responses expand "email" and may order scopes differently.
    const real = await connect(c, 'alice', { scope: `${GMAIL_SCOPE} openid https://www.googleapis.com/auth/userinfo.email` });
    check("Google's real scope format (expanded userinfo.email, any order) connects", result(real.location) === 'connected' && conn(c, 'alice').status === 'active');
    // Granular consent with the Gmail box left unticked: Google returns identity scopes only.
    const c2 = await makeApp();
    const unticked = await connect(c2, 'alice', { scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
    check('Gmail box unticked on Google\'s screen: missing_permission, nothing stored, the partial grant revoked', result(unticked.location) === 'missing_permission' && !conn(c2, 'alice') && c2.g.revoked.length === 1);
    const pm = await openPage(c2, 'alice', '?gmail=missing_permission');
    check('…and Rider Data tells the rider to tick "View your email messages and settings" and try again', /tick the box for "View your email messages and settings"/.test(pm.text('gmailNotice')) && /Connect Gmail again/.test(pm.text('gmailNotice')));
    const signin = fs.readFileSync(`${ROOT}worker/google-auth.js`, 'utf8');
    check('Google sign-in is untouched: its own scopes, no Gmail scope', /const SCOPES = 'openid email profile';/.test(signin) && !/gmail/i.test(signin));
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
