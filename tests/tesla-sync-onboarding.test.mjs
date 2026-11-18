// First-time Tesla Sync onboarding (worker/onboarding.js,
// migrations/0054_tesla_sync_onboarding.sql, js/link-gmail.js): every account
// CREATED by a Google sign-in is invited once, on whichever platform it first
// signs in to; accounts that already existed never are; Skip or Complete on
// one platform ends it everywhere. The REAL Worker router over real SQL
// (every migration), Google stubbed (no real OAuth credentials), and the real
// Link Gmail page in jsdom.
// Run: node tests/tesla-sync-onboarding.test.mjs

import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { createTestD1 } from './helpers/d1-sqlite.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { getTeslaSyncOnboarding } from '../worker/onboarding.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const LG_HTML = fs.readFileSync(`${ROOT}public/link-gmail.html`, 'utf8');
const LG_JS = fs.readFileSync(`${ROOT}public/js/link-gmail.js`, 'utf8');
const MIGRATION = fs.readFileSync(`${ROOT}migrations/0054_tesla_sync_onboarding.sql`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await tick(); } return false; }
const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- The app: two existing riders (from before the migration) and Google stubbed.
async function makeApp() {
  const ctx = await makeEnv({ users: ['old1', 'old2'] });
  Object.assign(ctx.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
  ctx.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc-1', 'old1', 'sub-old1', 'o1@example.com'), ('gc-2', 'old2', 'sub-old2', 'o2@example.com')`);
  ctx.call = (path, init = {}) => worker.fetch(new Request(`https://cybercabhunter.com${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  ctx.state = userId => ctx.d1.query('SELECT tesla_sync_onboarding AS s FROM users WHERE id = ?', userId)[0].s;
  ctx.userOf = sub => (ctx.d1.query('SELECT user_id FROM google_connections WHERE google_sub = ?', sub)[0] || {}).user_id;
  ctx.tokenOf = u => ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'", u)[0].opaque_token;
  return ctx;
}
const realFetch = globalThis.fetch;
let sub = 'sub-new';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'test-access' });
  if (u.includes('/userinfo')) return Response.json({ sub, email: `${sub}@example.com`, name: 'New Rider' });
  return realFetch(url, init);
};
// The website's Google sign-in, end to end through the Worker: the callback's Location.
async function webSignIn(ctx, googleSub, returnTo) {
  sub = googleSub;
  const start = await ctx.call(`/oauth/google/start${returnTo === undefined ? '' : '?returnTo=' + encodeURIComponent(returnTo)}`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const loc = (await ctx.call(`/oauth/google/callback?code=c&state=${state}`)).headers.get('Location');
  return { loc, session: loc && loc.split('#tesla_session=')[1] };
}
// The app's Google sign-in (PKCE + one-time code): the session it gets.
async function appSignIn(ctx, googleSub) {
  sub = googleSub;
  const verifier = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const start = await ctx.call(`/oauth/google/start?app=ios&challenge=${challenge}&returnTo=%2F`);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const cb = await ctx.call(`/oauth/google/callback?code=c&state=${state}`);
  const code = new URL(cb.headers.get('Location')).searchParams.get('code');
  const ex = await ctx.call('/oauth/app/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }) });
  return { status: ex.status, session: (await ex.json()).session };
}
const me = async (ctx, session) => (await ctx.call('/api/me', { headers: { Authorization: `Bearer ${session}` } })).json();
const act = async (ctx, session, action) => { const r = await ctx.call('/api/onboarding/tesla-sync', { method: 'POST', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }); return { status: r.status, json: await r.json() }; };
const sessionFor = async (ctx, userId) => { const s = `s-${userId}-${Math.random().toString(16).slice(2)}`; await ctx.env.TESLA_SESSIONS.put(`session:${s}`, JSON.stringify({ user_id: userId })); return s; };

// ---- The Link Gmail page as `session`, with navigation captured.
async function linkGmail(ctx, session, search, { intercept } = {}) {
  const dom = new JSDOM(LG_HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/link-gmail' + search, pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = () => {}; w.scrollTo = () => {};
  if (session) w.localStorage.setItem('teslaSessionId', session);
  const requests = [], navigations = [];
  w.fetch = async (u, init = {}) => {
    const path = String(u).replace(WORKER_ORIGIN, '');
    requests.push({ path, method: init.method || 'GET', body: init.body });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.__navigate = p => navigations.push(p);
  w.eval(LG_JS.replaceAll('location.assign(', 'window.__navigate('));
  const d = w.document;
  const p = { w, d, requests, navigations, vis: id => !d.getElementById(id).classList.contains('hidden'), text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    click: id => d.getElementById(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    posts: () => requests.filter(r => r.path === '/api/onboarding/tesla-sync').map(r => JSON.parse(r.body).action) };
  await waitFor(() => p.vis('lgReady') || p.vis('lgError') || p.vis('lgSignedOut'));
  await tick(40);
  return p;
}

async function run() {
  console.log('1. The migration: additive; existing accounts are never "new"');
  {
    check('one nullable column with the four states (NULL = not applicable)', /ALTER TABLE users ADD COLUMN tesla_sync_onboarding TEXT/.test(MIGRATION) && /CHECK \(tesla_sync_onboarding IN \('pending', 'presented', 'skipped', 'completed'\)\)/.test(MIGRATION) && !/DEFAULT|UPDATE|DROP/i.test(MIGRATION.replace(/--.*$/gm, '')));
    const ctx = await makeApp();
    check('accounts that existed before: NULL (not applicable)', ctx.state('old1') === null && ctx.state('old2') === null);
    let threw = false;
    try { ctx.d1.exec("UPDATE users SET tesla_sync_onboarding = 'whatever' WHERE id = 'old1'"); } catch (e) { threw = true; }
    check('the database refuses any other value', threw && ctx.state('old1') === null);
    // On a database exactly as production is today (0001-0053), with riders in it.
    const prod = createTestD1({ migrateThrough: '0053_drop_robotaxi_owner_connections.sql' });
    prod.exec(`INSERT INTO users (id, display_name, profile_visibility, leaderboard_opt_in) VALUES ('r1', 'Rider One', 'public', 1), ('r2', NULL, 'private', 0)`);
    const tables = () => prod.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map(r => r.name);
    const dump = () => JSON.stringify(tables().map(tb => [tb, prod.query(`SELECT * FROM "${tb}"`).map(r => { const { tesla_sync_onboarding, ...rest } = r; return rest; })]));
    const before = dump(), beforeTables = tables().join();
    prod.exec(MIGRATION);
    check('applied to today\'s schema: every existing row and table unchanged', dump() === before && tables().join() === beforeTables);
    check('…and every existing rider is NULL (never invited)', prod.query('SELECT tesla_sync_onboarding AS s FROM users').every(r => r.s === null));
    const broken = { prepare: () => { throw new Error('no such column: tesla_sync_onboarding'); } };
    check('before the migration is applied: reads report null (nobody is invited, sign-in unaffected)', (await getTeslaSyncOnboarding(broken, 'x')) === null);
  }

  console.log('2. "New" means: this Google sign-in created the account (website)');
  {
    const ctx = await makeApp();
    const first = await webSignIn(ctx, 'sub-new', '/rider-data?tab=rides');
    const id = ctx.userOf('sub-new');
    check('the account was created by this sign-in and is pending', !!id && ctx.state(id) === 'pending');
    check('so the callback lands on the invitation, carrying the page asked for', first.loc.startsWith('https://cybercabhunter.com/link-gmail?welcome=1&next=%2Frider-data%3Ftab%3Drides&signin=success#tesla_session='));
    const m = await me(ctx, first.session);
    check('/api/me says so (and nothing about Gmail or tokens)', m.onboarding && m.onboarding.tesla_sync === 'pending' && !/token|refresh|gmail/i.test(JSON.stringify(m.onboarding)));
    const back = await webSignIn(ctx, 'sub-old1', '/rider-data');
    check('an existing account (from before): straight to the page, no invitation', back.loc.startsWith('https://cybercabhunter.com/rider-data?signin=success#') && ctx.state('old1') === null);
    check('…and /api/me reports null for it', (await me(ctx, back.session)).onboarding.tesla_sync === null);
    const noPage = await webSignIn(ctx, 'sub-new-2', undefined);
    check('a new account with no page asked for continues to the home page afterwards', noPage.loc.startsWith('https://cybercabhunter.com/link-gmail?welcome=1&next=%2F&signin=success#'));
    const evil = await webSignIn(ctx, 'sub-new-3', 'https://evil.example/');
    check('a hostile returnTo never becomes the next page', evil.loc.startsWith('https://cybercabhunter.com/link-gmail?welcome=1&next=%2F&signin=success#'));
    sub = 'sub-cancel';
    const cancel = await ctx.call('/oauth/google/callback?error=access_denied&state=x');
    check('cancelling Google: no account is created, no invitation', cancel.headers.get('Location') === 'https://cybercabhunter.com/?signin=cancelled' && !ctx.userOf('sub-cancel'));
  }

  console.log('3. The state machine: forward only, idempotent, the session\'s own account only');
  {
    const ctx = await makeApp();
    const { session } = await webSignIn(ctx, 'sub-sm', '/');
    const id = ctx.userOf('sub-sm');
    check('invalid action: 400; nothing changes', (await act(ctx, session, 'reset')).status === 400 && ctx.state(id) === 'pending');
    const anon = await ctx.call('/api/onboarding/tesla-sync', { method: 'POST', body: JSON.stringify({ action: 'skip' }) });
    check('no session: 401', anon.status === 401 && ctx.state(id) === 'pending');
    let r = await act(ctx, session, 'presented');
    check('presented: pending → presented', r.status === 200 && r.json.tesla_sync === 'presented' && ctx.state(id) === 'presented');
    r = await act(ctx, session, 'presented');
    check('presented again: no change (idempotent)', r.json.tesla_sync === 'presented');
    r = await act(ctx, session, 'skip');
    check('skip: presented → skipped', r.json.tesla_sync === 'skipped');
    r = await act(ctx, session, 'complete');
    check('a later complete can\'t rewrite it (skipped stays skipped)', r.json.tesla_sync === 'skipped');
    const olds = await sessionFor(ctx, 'old1');
    for (const a of ['presented', 'skip', 'complete']) await act(ctx, olds, a);
    check('an existing account can\'t be pulled into onboarding by any call', ctx.state('old1') === null);
    // A request can't name another account: the body's user_id is ignored.
    const other = await webSignIn(ctx, 'sub-other', '/');
    const otherId = ctx.userOf('sub-other');
    await ctx.call('/api/onboarding/tesla-sync', { method: 'POST', headers: { Authorization: `Bearer ${olds}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'skip', user_id: otherId }) });
    check('a client can\'t mark another account\'s onboarding', ctx.state(otherId) === 'pending');
    // Simultaneous: two devices of the same new account answer at once.
    const s2 = await sessionFor(ctx, otherId);
    const [a, b] = await Promise.all([act(ctx, other.session, 'skip'), act(ctx, s2, 'complete')]);
    const final = ctx.state(otherId);
    check('two devices at once: one consistent final state, both told the same', ['skipped', 'completed'].includes(final) && a.json.tesla_sync === final && b.json.tesla_sync === final);
    const { session: s3 } = await webSignIn(ctx, 'sub-direct', '/');
    check('complete straight from pending (shown, "presented" never arrived)', (await act(ctx, s3, 'complete')).json.tesla_sync === 'completed');
  }

  console.log('4. One invitation across platforms');
  {
    const ctx = await makeApp();
    // Website first, skipped there: the app and later sign-ins are normal.
    const w1 = await webSignIn(ctx, 'sub-web', '/community');
    await act(ctx, w1.session, 'presented'); await act(ctx, w1.session, 'skip');
    const app1 = await appSignIn(ctx, 'sub-web');
    check('signed up on the website and skipped: the app sees "skipped" (no invitation)', app1.status === 200 && (await me(ctx, app1.session)).onboarding.tesla_sync === 'skipped');
    const w1b = await webSignIn(ctx, 'sub-web', '/community');
    check('…and signing in on the website again goes straight to the page', w1b.loc.startsWith('https://cybercabhunter.com/community?signin=success#'));
    // App first: the account is created there, pending until the app shows it.
    const a2 = await appSignIn(ctx, 'sub-app');
    const id2 = ctx.userOf('sub-app');
    check('signed up in the app: created there, pending', a2.status === 200 && ctx.state(id2) === 'pending' && (await me(ctx, a2.session)).onboarding.tesla_sync === 'pending');
    await act(ctx, a2.session, 'presented'); await act(ctx, a2.session, 'skip');
    const w2 = await webSignIn(ctx, 'sub-app', '/rider-data');
    check('…skipped in the app: the website never shows it', w2.loc.startsWith('https://cybercabhunter.com/rider-data?signin=success#') && ctx.state(id2) === 'skipped');
    // Shown in the app (presented) but never answered: not offered again anywhere.
    const a3 = await appSignIn(ctx, 'sub-shown');
    await act(ctx, a3.session, 'presented');
    const w3 = await webSignIn(ctx, 'sub-shown', '/');
    check('shown in the app and closed: the website doesn\'t offer it again', w3.loc.startsWith('https://cybercabhunter.com/?signin=success#'));
    // Created in the app but never shown (closed before it appeared): the next sign-in, anywhere, offers it.
    await appSignIn(ctx, 'sub-unseen');
    const w4 = await webSignIn(ctx, 'sub-unseen', '/vehicles');
    check('created in the app but never shown: the website offers it once', w4.loc.startsWith('https://cybercabhunter.com/link-gmail?welcome=1&next=%2Fvehicles&signin=success#'));
    // Second device / cleared storage: the server state is what counts.
    const again = await appSignIn(ctx, 'sub-web');
    check('a second device or a reinstall: still "skipped" from the server', (await me(ctx, again.session)).onboarding.tesla_sync === 'skipped');
    check('existing accounts on either platform: never invited', (await me(ctx, (await appSignIn(ctx, 'sub-old2')).session)).onboarding.tesla_sync === null && (await webSignIn(ctx, 'sub-old2', '/')).loc.startsWith('https://cybercabhunter.com/?signin=success#'));
  }

  console.log('5. The website invitation on Link Gmail');
  {
    const ctx = await makeApp();
    const { session } = await webSignIn(ctx, 'sub-page', '/rider-data');
    const id = ctx.userOf('sub-page');
    const p = await linkGmail(ctx, session, '?welcome=1&next=%2Frider-data');
    check('a new account: "Welcome to CybercabHunter", "Set Up Tesla Sync", the description, both buttons',
      p.vis('lgWelcome') && p.text('lgWelcomeTitle') === 'Welcome to CybercabHunter' && /Set Up Tesla Sync/.test(p.text('lgWelcome')) &&
      /Automatically track your Tesla Robotaxi rides by forwarding Tesla receipts to CybercabHunter\./.test(p.text('lgWelcome')) && p.text('lgWelcomeSetup') === 'Set Up Gmail' && p.text('lgWelcomeSkip') === 'Skip for Now');
    check('…the setup steps and status wait behind it', !p.vis('lgSetup') && !p.vis('lgStatus') && !p.vis('lgSameAccount'));
    await waitFor(() => ctx.state(id) === 'presented');
    check('shown: recorded as presented (not offered automatically again)', ctx.state(id) === 'presented' && JSON.stringify(p.posts()) === '["presented"]');
    p.w.close();
    const refreshed = await linkGmail(ctx, session, '?welcome=1&next=%2Frider-data');
    check('refresh during onboarding: still the invitation, nothing recorded twice', refreshed.vis('lgWelcome') && refreshed.posts().length === 0);
    refreshed.click('lgWelcomeSetup');
    check('Set Up Gmail: the forwarding steps, with a way out (Skip for Now)', refreshed.vis('lgSetup') && refreshed.vis('lgSameAccount') && refreshed.vis('lgWelcomeBar') && !refreshed.vis('lgWelcome'));
    refreshed.click('lgWelcomeLater');
    await waitFor(() => refreshed.navigations.length > 0);
    check('Skip for Now during setup: recorded, then on to /rider-data', JSON.stringify(refreshed.navigations) === '["/rider-data"]' && ctx.state(id) === 'skipped');
    refreshed.w.close();
    const later = await linkGmail(ctx, session, '?welcome=1&next=%2Frider-data');
    check('afterwards ?welcome=1 is just Link Gmail (no invitation, nothing recorded)', !later.vis('lgWelcome') && later.vis('lgSetup') && later.posts().length === 0);
    later.w.close();

    // Skip straight from the card.
    const s2 = (await webSignIn(ctx, 'sub-skip', '/community')).session;
    const skip = await linkGmail(ctx, s2, '?welcome=1&next=%2Fcommunity');
    skip.click('lgWelcomeSkip');
    await waitFor(() => skip.navigations.length > 0);
    check('Skip for Now: on to the page asked for, recorded as skipped', JSON.stringify(skip.navigations) === '["/community"]' && ctx.state(ctx.userOf('sub-skip')) === 'skipped');
    skip.w.close();

    // Complete: set up, the first receipt arrives, Continue now.
    const s3 = (await webSignIn(ctx, 'sub-done', '/vehicles')).session;
    const done = await linkGmail(ctx, s3, '?welcome=1&next=%2Fvehicles');
    done.click('lgWelcomeSetup');
    const u3 = ctx.userOf('sub-done');
    const to = `u_${ctx.tokenOf(u3)}@${ctx.env.RECEIPT_DOMAIN}`;
    await handleIncomingEmail(inboundMessage(eml({ body: receiptBody(), to }), to), ctx.env);
    done.d.dispatchEvent(new done.w.Event('visibilitychange'));
    await waitFor(() => done.vis('lgSuccess'), 4000);
    check('the setup works: "GMAIL IS LINKED", continuing to the page asked for', done.vis('lgSuccess') && /Continuing|Saving/.test(done.text('lgCountdown')));
    done.click('lgContinueNow');
    await waitFor(() => done.navigations.length > 0, 4000);
    check('…Continue now: recorded as completed, on to /vehicles', JSON.stringify(done.navigations) === '["/vehicles"]' && ctx.state(u3) === 'completed');
    done.w.close();

    // Existing accounts, and a hostile ?next=.
    const olds = await sessionFor(ctx, 'old1');
    const old = await linkGmail(ctx, olds, '?welcome=1&next=%2Frider-data');
    check('an existing account with ?welcome=1: the normal page, nothing recorded', !old.vis('lgWelcome') && old.posts().length === 0 && ctx.state('old1') === null);
    old.w.close();
    const s4 = (await webSignIn(ctx, 'sub-evil', '/')).session;
    const evil = await linkGmail(ctx, s4, '?welcome=1&next=%2F%2Fevil.example');
    evil.click('lgWelcomeSkip');
    await waitFor(() => evil.navigations.length > 0);
    check('a hostile ?next= is never followed (the home page instead)', JSON.stringify(evil.navigations) === '["/"]');
    evil.w.close();

    // Temporary server errors never trap anyone.
    const s5 = (await webSignIn(ctx, 'sub-flaky', '/rider-data')).session;
    const meDown = await linkGmail(ctx, s5, '?welcome=1&next=%2Frider-data', { intercept: p => (p === '/api/me' ? new Response('{}', { status: 503 }) : null) });
    check('/api/me failing: the normal page (not a stuck invitation), still signed in', !meDown.vis('lgWelcome') && meDown.vis('lgReady') && meDown.w.localStorage.getItem('teslaSessionId') === s5);
    meDown.w.close();
    const postDown = await linkGmail(ctx, s5, '?welcome=1&next=%2Frider-data', { intercept: (p, init) => { if (p === '/api/onboarding/tesla-sync') throw new TypeError('network down'); return null; } });
    postDown.click('lgWelcomeSkip');
    await waitFor(() => postDown.navigations.length > 0, 6000);
    check('recording Skip fails: the rider still continues to the page', JSON.stringify(postDown.navigations) === '["/rider-data"]');
    postDown.w.close();
  }

  t.finish();
}

run().finally(() => { globalThis.fetch = realFetch; }).catch(e => { console.error(e); process.exit(1); });
