// Regression: signing in sent a rider whose Gmail was already linked to the
// Link Gmail page every time (bug, Nov 2026). Root cause: a sign-in with no
// page requested defaulted to /link-gmail (public/signin.html), and every
// header "Sign In" link asked for no page; /link-gmail then showed the full
// setup steps even to a linked rider. Now sign-in returns to the page the
// rider was on (or the home page), Gmail setup is never forced, and the Gmail
// state comes from the server's record for the signed-in account.
// Real pages and scripts in jsdom, the REAL Worker router and real SQL (every
// migration); Google is stubbed (no real OAuth credentials anywhere).
// Run: node tests/gmail-signin.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { googleAuth } from '../worker/google-auth.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const CALC = read('public/js/calc.js'), MAIN = read('public/js/main.js');
const SIGNIN = read('public/signin.html');
const RD_HTML = read('public/rider-data.html'), RD_JS = read('public/js/rider-data.js');
const LG_HTML = read('public/link-gmail.html'), LG_JS = read('public/js/link-gmail.js');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const CONFIRMATION = { from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from rider@gmail.com', body: 'Confirmation code: 482913775' };
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await tick(); } return false; }

function stubBrowser(w) {
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.scrollTo = () => {};
  w.requestAnimationFrame = fn => setTimeout(fn, 0);
}

// ---------------------------------------------------------------- the sign-in page
const SIGNIN_SCRIPT = [...SIGNIN.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('signInGoogle'));
function signinReturn(url, referrer) {
  const dom = new JSDOM(SIGNIN.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', url, referrer, pretendToBeVisual: true });
  stubBrowser(dom.window);
  dom.window.eval(`${CALC}\n${MAIN}\n${SIGNIN_SCRIPT}`);
  const href = dom.window.document.getElementById('signInGoogle').getAttribute('href');
  dom.window.close();
  return new URL(href).searchParams.get('returnTo');
}

// ---------------------------------------------------------------- the Worker's Google sign-in
function fakeKV() {
  const store = new Map();
  return { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); }, _store: store };
}
function fakeD1() {
  const users = new Map(), conns = new Map();
  const stmt = sql => {
    const s = { _args: [] };
    s.bind = (...a) => { s._args = a; return s; };
    s.run = async () => { if (/INSERT INTO users/.test(sql)) users.set(s._args[0], 1); else if (/INSERT INTO google_connections/.test(sql)) conns.set(s._args[2], s._args[1]); return { success: true }; };
    s.first = async () => (/SELECT user_id FROM google_connections WHERE google_sub = \?/.test(sql) && conns.has(s._args[0]) ? { user_id: conns.get(s._args[0]) } : null);
    return s;
  };
  return { prepare: stmt };
}
const authEnv = () => ({ TESLA_SESSIONS: fakeKV(), cybercabhunter_db: fakeD1(), FRONTEND_URL: 'https://cybercabhunter.com/',
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REDIRECT_URI: 'https://cybercabhunter.com/oauth/google/callback' });
const realFetch = globalThis.fetch;
const stubGoogle = () => { globalThis.fetch = async url => {
  if (String(url).includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'test-access' });
  if (String(url).includes('userinfo')) return Response.json({ sub: 'google-sub-1', email: 'rider@example.com', name: 'Ada' });
  throw new Error('unexpected fetch ' + url);
}; };
const start = (env, qs) => googleAuth.startOAuth(new Request(`${WORKER_ORIGIN}/oauth/google/start${qs}`), env);
const stateOf = r => new URL(r.headers.get('Location')).searchParams.get('state');
const callback = (env, qs) => googleAuth.handleCallback(new Request(`https://cybercabhunter.com/oauth/google/callback${qs}`), env);
async function signInThrough(returnTo) {
  const env = authEnv();
  stubGoogle();
  try {
    const s = await start(env, returnTo === undefined ? '' : `?returnTo=${encodeURIComponent(returnTo)}`);
    return (await callback(env, `?code=test-code&state=${stateOf(s)}`)).headers.get('Location');
  } finally { globalThis.fetch = realFetch; }
}

// ---------------------------------------------------------------- real Worker + SQL for the pages
async function makeApp() {
  const ctx = await makeEnv({ users: ['u1', 'u2', 'u3'] });
  for (const u of ['u1', 'u2', 'u3']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.tokenOf = userId => ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'", userId)[0].opaque_token;
  ctx.email = async (userId, opts) => { const to = `u_${ctx.tokenOf(userId)}@${ctx.env.RECEIPT_DOMAIN}`; return handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env); };
  return ctx;
}
// A page as `user` (null = signed out). `intercept(path)` may return a Response,
// throw (network error) or return a promise that never settles (still loading).
async function openPage(ctx, html, js, { user, url, intercept, wait = true }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  stubBrowser(w);
  if (user) w.localStorage.setItem('teslaSessionId', `session-${user}`);
  const requests = [], navigations = [];
  w.fetch = async (u, init = {}) => {
    const path = String(u).replace(WORKER_ORIGIN, '');
    requests.push({ path, auth: (init.headers || {}).Authorization });
    if (intercept) { const r = await intercept(path); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.__navigate = p => navigations.push(p);
  w.eval(js.replaceAll('location.assign(', 'window.__navigate('));
  const d = w.document;
  const page = { w, d, requests, navigations, $: id => d.getElementById(id), vis: id => !d.getElementById(id).classList.contains('hidden'),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(), close: () => w.close() };
  if (wait) { await waitFor(() => requests.some(r => r.path === '/api/rides/sync-status') && !d.querySelector('[aria-busy="true"]#linkGmailBtn')); await tick(60); }
  return page;
}
const riderData = (ctx, user, opts = {}) => openPage(ctx, RD_HTML, RD_JS, { user, url: 'https://cybercabhunter.com/rider-data' + (opts.search || ''), ...opts });
const linkGmail = async (ctx, user, opts = {}) => {
  const p = await openPage(ctx, LG_HTML, LG_JS, { user, url: 'https://cybercabhunter.com/link-gmail', ...opts, wait: false });
  if (opts.wait !== false) await waitFor(() => p.vis('lgReady') || p.vis('lgError') || p.vis('lgSignedOut'));
  await tick(30);
  return p;
};

async function run() {
  console.log('1. The root cause: a sign-in with no page requested never lands on Link Gmail');
  {
    check('no page requested, no previous page: the home page', signinReturn('https://cybercabhunter.com/signin') === '/');
    for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/me', '/oauth/google/start']) {
      check(`a hostile or internal returnTo (${evil}) is not passed on: the home page`, signinReturn(`https://cybercabhunter.com/signin?returnTo=${encodeURIComponent(evil)}`) === '/');
    }
    check('no page requested: back to the site page the rider came from (query kept, one-time ?signin= dropped)',
      signinReturn('https://cybercabhunter.com/signin', 'https://cybercabhunter.com/vehicles?city=dallas&signin=cancelled') === '/vehicles?city=dallas');
    check('a previous page on another site is ignored', signinReturn('https://cybercabhunter.com/signin', 'https://evil.example/x') === '/');
    check('coming from the sign-in page itself is ignored', signinReturn('https://cybercabhunter.com/signin', 'https://cybercabhunter.com/signin?returnTo=%2Fx') === '/');
    check('a deep link is kept exactly (/rider-data?tab=rides)', signinReturn('https://cybercabhunter.com/signin?returnTo=%2Frider-data%3Ftab%3Drides') === '/rider-data?tab=rides');
    check('Link Gmail only when it was asked for', signinReturn('https://cybercabhunter.com/signin?returnTo=%2Flink-gmail') === '/link-gmail');
    check('signin.html no longer defaults to /link-gmail', !/DEFAULT_RETURN = '\/link-gmail'/.test(SIGNIN) && /DEFAULT_RETURN = '\/'/.test(SIGNIN));
  }

  console.log('2. Every Sign In link comes back to the page it was on (js/main.js)');
  {
    const dom = new JSDOM(`<!doctype html><body>
      <a id="header" href="signin.html">Sign In</a><a id="root" href="/signin">Sign In</a>
      <a id="explicit" href="signin.html?returnTo=%2Flink-gmail">Sign In</a><a id="other" href="/vehicles">Cars</a></body>`,
      { runScripts: 'outside-only', url: 'https://cybercabhunter.com/vehicle?id=v-42&signin=success', pretendToBeVisual: true });
    stubBrowser(dom.window);
    dom.window.eval(`${CALC}\n${MAIN}\nCCC.init(); window.__CCC = CCC;`);
    const href = id => dom.window.document.getElementById(id).getAttribute('href');
    check('the header Sign In carries this page (?signin= dropped)', href('header') === 'signin.html?returnTo=%2Fvehicle%3Fid%3Dv-42');
    check('…a "/signin" link too', href('root') === 'signin.html?returnTo=%2Fvehicle%3Fid%3Dv-42');
    check('a link that already names its page keeps it', href('explicit') === 'signin.html?returnTo=%2Flink-gmail');
    check('other links are untouched', href('other') === '/vehicles');
    const s = dom.window.__CCC;
    check('signInHref refuses another site, API and OAuth paths', ['//evil.example', 'https://evil.example', '/api/me', '/oauth/google/start', '/signin'].every(p => s.signInHref(p) === 'signin.html'));
    dom.window.close();
    const pages = ['index', 'rider-data', 'link-gmail', 'vehicles', 'sightings', 'community', 'profile', 'infrastructure'];
    check('the real pages\' sign-in links are plain (rewritten on load) or name their page explicitly',
      pages.every(pg => [...read(`public/${pg}.html`).matchAll(/href="(\/?signin(?:\.html)?[^"]*)"/g)].every(m => /^\/?signin(\.html)?(\?returnTo=%2F[^"&]*)?$/.test(m[1]))));
    check('the submit-a-sighting gate also comes back to the page', /window\.location\.href = signInHref\(\)/.test(MAIN) && !/window\.location\.href = SIGN_IN_PAGE/.test(MAIN));
  }

  console.log('3. The Worker returns the rider to that page (Google stubbed, no real credentials)');
  {
    check('deep link: /rider-data?tab=rides, signed in', /^https:\/\/cybercabhunter\.com\/rider-data\?tab=rides&signin=success#tesla_session=[a-f0-9]{64}$/.test(await signInThrough('/rider-data?tab=rides')));
    check('the home page when that is the page', /^https:\/\/cybercabhunter\.com\/\?signin=success#tesla_session=[a-f0-9]{64}$/.test(await signInThrough('/')));
    check('no page at all: the home page, never Link Gmail', /^https:\/\/cybercabhunter\.com\/\?signin=success#/.test(await signInThrough(undefined)));
    check('a hostile page is dropped by the Worker too', /^https:\/\/cybercabhunter\.com\/\?signin=success#/.test(await signInThrough('https://evil.example/')));
    const env = authEnv();
    const cancel = await callback(env, '?error=access_denied');
    check('cancelling Google sign-in: the site, not Link Gmail', cancel.headers.get('Location') === 'https://cybercabhunter.com/?signin=cancelled');
  }

  console.log('4. After sign-in, Rider Data uses the server\'s record for THIS account and never forces Gmail setup');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody() });   // u1: receipts arriving (linked); u2: never set up
    const landing = '?signin=success';
    const linked = await riderData(ctx, 'u1', { search: landing });
    check('already linked: "Gmail Linked" and Stop Sync, on the page they asked for', linked.vis('gmailLinkedChip') && linked.text('linkGmailLabel') === 'Stop Sync' && linked.w.location.pathname === '/rider-data' && linked.navigations.length === 0);
    check('…no "Link Gmail" or "Setup" label anywhere for a linked rider', !/Link Gmail|Setup Tesla Sync/.test(linked.text('linkGmailBtn')));
    check('the status came from the server with u1\'s own session', linked.requests.filter(r => r.path === '/api/rides/sync-status').every(r => r.auth === 'Bearer session-u1'));
    linked.close();

    const fresh = await riderData(ctx, 'u2', { search: landing });
    check('not linked: an optional "Setup Tesla Sync" action, no redirect', fresh.text('linkGmailLabel') === 'Setup Tesla Sync' && !fresh.vis('gmailLinkedChip') && fresh.$('linkGmailBtn').getAttribute('href') === '/link-gmail' && fresh.w.location.pathname === '/rider-data' && fresh.navigations.length === 0);
    fresh.close();

    // Account switching on the same browser: each session sees its own account.
    const a = await riderData(ctx, 'u1'), b = await riderData(ctx, 'u2');
    check('switching accounts: each sees its own Gmail state', a.vis('gmailLinkedChip') && !b.vis('gmailLinkedChip') && b.requests.every(r => !r.auth || r.auth === 'Bearer session-u2'));
    a.close(); b.close();

    // Still loading: no verdict yet, nothing forced.
    let release;
    const hold = new Promise(r => { release = r; });
    const loading = await riderData(ctx, 'u1', { wait: false, intercept: p => (p === '/api/rides/sync-status' ? hold.then(() => null) : null) });
    await waitFor(() => loading.requests.some(r => r.path === '/api/rides/sync-status'));
    await tick(30);
    check('while checking: "Checking Gmail…", no linked or unlinked verdict, no redirect', loading.text('linkGmailLabel') === 'Checking Gmail…' && !loading.vis('gmailLinkedChip') && loading.navigations.length === 0 && loading.w.location.pathname === '/rider-data');
    release(); await waitFor(() => loading.vis('gmailLinkedChip'));
    check('…then the real state (linked)', loading.vis('gmailLinkedChip') && loading.text('linkGmailLabel') === 'Stop Sync');
    loading.close();

    // The status check fails: still signed in, never "not linked", no redirect.
    const failed = await riderData(ctx, 'u1', { intercept: p => (p === '/api/rides/sync-status' ? new Response('{}', { status: 503 }) : null) });
    check('server error: "Check Gmail", not "Setup", still signed in, no redirect', failed.text('linkGmailLabel') === 'Check Gmail' && !failed.vis('gmailLinkedChip') && failed.vis('dataSignedIn') && failed.w.localStorage.getItem('teslaSessionId') === 'session-u1' && failed.navigations.length === 0);
    failed.close();
    const offline = await riderData(ctx, 'u1', { intercept: p => { if (p === '/api/rides/sync-status') throw new TypeError('network down'); return null; } });
    check('network error: the same (session kept, no redirect)', offline.text('linkGmailLabel') === 'Check Gmail' && offline.vis('dataSignedIn') && offline.w.localStorage.getItem('teslaSessionId') === 'session-u1' && offline.navigations.length === 0);
    offline.close();

    // Gmail asks to confirm forwarding again after receipts arrived: Reconnect, not "never linked".
    await ctx.email('u1', CONFIRMATION);
    const again = await riderData(ctx, 'u1');
    check('Gmail needs confirming again: "Reconnect Gmail" to the setup page, not "Setup"', again.text('linkGmailLabel') === 'Reconnect Gmail' && again.$('linkGmailBtn').getAttribute('href') === '/link-gmail' && !again.vis('gmailLinkedChip'));
    again.close();

    // Sign out, sign back in: the server still has the link (nothing was deleted).
    const out = await riderData(ctx, null, { wait: false });
    await tick(80);
    check('signed out: no Gmail request at all', !out.requests.some(r => r.path === '/api/rides/sync-status'));
    out.close();
    await ctx.email('u1', { body: receiptBody({ date: 'October 2, 2026' }) });   // the next receipt clears Gmail's request
    const back = await riderData(ctx, 'u1', { search: landing });
    check('signing back in: still linked (the connection was never removed)', back.vis('gmailLinkedChip') && back.text('linkGmailLabel') === 'Stop Sync');
    back.close();
  }

  console.log('5. Link Gmail, opened on purpose: the state first, the setup only when it is needed');
  {
    const ctx = await makeApp();
    await ctx.email('u1', { body: receiptBody() });
    const linked = await linkGmail(ctx, 'u1');
    check('linked: "Gmail Linked" with the last receipt, Go to Rider Data', linked.vis('lgStatus') && linked.text('lgStatusText') === 'Gmail Linked' && /Receipts are arriving/.test(linked.text('lgStatusDetail')) && linked.$('lgStatusPrimary').getAttribute('href') === '/rider-data');
    check('…the setup steps stay closed (no linking prompt, no "every step below" warning)', !linked.vis('lgSetup') && !linked.vis('lgSameAccount') && linked.$('lgStatusManage').getAttribute('aria-expanded') === 'false');
    linked.$('lgStatusManage').dispatchEvent(new linked.w.MouseEvent('click', { bubbles: true }));
    check('Manage forwarding opens them, with the same-Gmail warning (and closes again)', linked.vis('lgSetup') && linked.vis('lgSameAccount') && linked.$('lgStatusManage').getAttribute('aria-expanded') === 'true' && linked.text('lgStatusManage') === 'Hide forwarding setup');
    linked.$('lgStatusManage').dispatchEvent(new linked.w.MouseEvent('click', { bubbles: true }));
    check('…closed', !linked.vis('lgSetup'));
    check('no navigation away on its own', linked.navigations.length === 0);
    linked.close();

    const fresh = await linkGmail(ctx, 'u2');
    check('not linked: no status card, the setup steps and the same-Gmail warning (optional, nothing forced)', !fresh.vis('lgStatus') && fresh.vis('lgSetup') && fresh.vis('lgSameAccount') && fresh.navigations.length === 0);
    fresh.close();

    await ctx.email('u1', CONFIRMATION);
    const again = await linkGmail(ctx, 'u1');
    check('Gmail asks to confirm again: "Reconnect Gmail", the setup open at step 3', again.vis('lgStatus') && again.text('lgStatusText') === 'Reconnect Gmail' && again.vis('lgSetup') && again.vis('lgCodeShown') && again.$('lgStatusPrimary').getAttribute('href') === '#lgCodeShown' && !again.vis('lgStatusManage'));
    again.close();

    const failed = await linkGmail(ctx, 'u3', { intercept: p => (p === '/api/rides/sync-status' ? new Response('{}', { status: 500 }) : null) });
    check('status error: the error view ("still signed in"), never "not linked" or the setup', failed.vis('lgError') && /still signed in/.test(failed.text('lgError')) && !failed.vis('lgReady') && failed.w.localStorage.getItem('teslaSessionId') === 'session-u3');
    failed.close();
    const offline = await linkGmail(ctx, 'u3', { intercept: p => { if (p.startsWith('/api/')) throw new TypeError('network down'); return null; } });
    check('network error: the error view, session kept', offline.vis('lgError') && !offline.vis('lgReady') && offline.w.localStorage.getItem('teslaSessionId') === 'session-u3');
    offline.close();
    let release;
    const hold = new Promise(r => { release = r; });
    const loading = await linkGmail(ctx, 'u1', { wait: false, intercept: p => (p === '/api/rides/sync-status' ? hold.then(() => null) : null) });
    check('while checking: the loading view, no verdict', loading.vis('lgLoading') && !loading.vis('lgReady') && !loading.vis('lgStatus'));
    release(); await waitFor(() => loading.vis('lgReady'));
    loading.close();
  }

  console.log('6. One rule for both pages');
  {
    const fn = src => src.match(/function gmailState\(f\) \{[\s\S]*?\n  \}/)[0];
    check('rider-data.js and link-gmail.js use the identical gmailState', fn(RD_JS) === fn(LG_JS));
    const gmailState = new Function(`${fn(RD_JS)}; return gmailState;`)();
    const cases = [
      [{}, 'not_linked'],
      [{ setup_completed_at: '2026-11-01 10:00:00' }, 'linked'],
      [{ last_received_at: '2026-11-01 10:00:00' }, 'linked'],
      [{ confirmation_code: '123' }, 'not_linked'],                                       // first setup, at step 3
      [{ confirmation_link: 'https://mail-settings.google.com/x', last_received_at: '2026-11-01' }, 'reconnect'],
      [{ confirmation_code: '123', last_received_at: '2026-11-01' }, 'reconnect']
    ];
    check('linked / not linked / reconnect from the server\'s fields', cases.every(([f, want]) => gmailState(f) === want));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
