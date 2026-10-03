// The Gmail onboarding prompt shown right after a successful Google sign-in
// (public/js/main.js, initGmailOnboarding). It only offers the EXISTING
// Gmail connect flow (POST /api/gmail/connect); nothing about Google sign-in,
// Gmail OAuth, scopes or the importer changes. Real pages (index.html,
// rider-data.html) + real calc.js/main.js in jsdom, the REAL Worker router and
// real SQL (every migration).
// Run: node tests/gmail-onboarding.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)).toString('base64');
const CALC = read('public/js/calc.js'), MAIN = read('public/js/main.js');

async function makeApp({ configured = true } = {}) {
  const ctx = await makeEnv({ users: ['alice', 'bob', 'tessa'], domain: 'cybercabhunter.com' });
  ctx.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('g1','alice','sub-a','alice@gmail.com'), ('g2','bob','sub-b','bob@gmail.com')`);
  for (const u of ['alice', 'bob', 'tessa']) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  if (configured) Object.assign(ctx.env, { GMAIL_CLIENT_ID: 'gmail-client', GMAIL_CLIENT_SECRET: 'gmail-secret', GMAIL_TOKEN_ENCRYPTION_KEY: KEY });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  return ctx;
}

// Opens `page` the way a browser lands on it. `hashSession` puts the session
// in the URL fragment exactly as the Google sign-in callback does; `storage`
// seeds localStorage (e.g. a remembered Skip, or an existing session).
async function open(ctx, { page = 'index.html', path = '/', search = '', hashSession = null, storage = {}, intercept } = {}) {
  const url = `https://cybercabhunter.com${path}${search}${hashSession ? `#tesla_session=session-${hashSession}` : ''}`;
  const dom = new JSDOM(read(`public/${page}`), { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const requests = [];
  w.fetch = async (u, init = {}) => {
    const p = String(u).replace(WORKER_ORIGIN, '');
    requests.push({ path: p, method: init.method || 'GET', auth: (init.headers || {}).Authorization });
    if (intercept) { const r = await intercept(p, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${p}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  const extra = page === 'rider-data.html' ? `\n${read('public/js/rider-data.js')}` : '';
  w.eval(`${CALC}\n${MAIN}\nCCC.init();${extra}`);
  const d = w.document;
  const pg = {
    w, d, requests,
    modal: () => d.getElementById('gmailOnboarding'),
    text: () => (d.getElementById('gmailOnboarding') || { textContent: '' }).textContent.replace(/\s+/g, ' '),
    async settle(ms = 250) { const end = Date.now() + ms; while (Date.now() < end) await new Promise(r => setTimeout(r, 10)); },
    async waitFor(cond, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); } return false; }
  };
  await pg.settle();
  return pg;
}
const signIn = (ctx, user, opts = {}) => open(ctx, { search: '?signin=success', hashSession: user, ...opts });
const click = (pg, id) => pg.d.getElementById(id).dispatchEvent(new pg.w.MouseEvent('click', { bubbles: true }));

async function run() {
  console.log('1. A new Google user without Gmail: the prompt appears right after sign-in');
  {
    const ctx = await makeApp();
    const pg = await signIn(ctx, 'alice');
    check('the session from the sign-in fragment is stored, as before', pg.w.localStorage.getItem('teslaSessionId') === 'session-alice' && !pg.w.location.hash.includes('tesla_session'));
    check('the ?signin=success result is still shown and scrubbed, as before', !pg.w.location.search.includes('signin=') && /Signed in/.test((pg.d.getElementById('toastRoot') || {}).textContent || ''));
    check('the onboarding prompt appears', !!pg.modal() && pg.modal().classList.contains('modal-backdrop'));
    check('title and explanation', /Automatically import your Tesla Robotaxi receipts\?/.test(pg.text()) && /Connect Gmail to automatically find your Robotaxi receipt emails and add your rides to Cybercab Hunter\./.test(pg.text()));
    check('Connect Gmail with its note, Skip for now with its note', !!pg.d.getElementById('gmailOnboardingConnect') && /Only the Robotaxi receipt emails needed for your ride history are imported\./.test(pg.text()) && !!pg.d.getElementById('gmailOnboardingSkip') && /You can connect Gmail later from Rider Data\./.test(pg.text()));
    check('it says Gmail is optional and that sign-in alone gives no Gmail access', /Gmail is optional/.test(pg.text()) && /Signing in with Google doesn't give Cybercab Hunter access to your Gmail/.test(pg.text()) && /Google asks for your permission first/.test(pg.text()));
    check('it is an accessible dialog, reusing the existing modal styles', pg.modal().querySelector('[role="dialog"][aria-modal="true"]') && pg.modal().querySelector('.modal-panel.glass-strong'));
    check('it only read the account and Gmail status — nothing was connected', pg.requests.some(r => r.path === '/api/gmail/status') && !pg.requests.some(r => r.path === '/api/gmail/connect'));
  }

  console.log('2. When NOT to show it');
  {
    const ctx = await makeApp();
    ctx.d1.exec(`INSERT INTO gmail_connections (id, user_id, google_sub, email, status, encrypted_refresh_token) VALUES ('gm1','alice','sub-a','alice@gmail.com','active','enc')`);
    check('Gmail already connected: no prompt', !(await signIn(ctx, 'alice')).modal());
    ctx.d1.exec(`UPDATE gmail_connections SET status = 'error', encrypted_refresh_token = NULL WHERE user_id = 'alice'`);
    check('Gmail connected but needing a reconnect: no onboarding prompt (Rider Data handles it)', !(await signIn(ctx, 'alice')).modal());
    const off = await makeApp({ configured: false });
    check('Gmail import not configured on the server: no prompt', !(await signIn(off, 'alice')).modal());
    const ctx2 = await makeApp();
    check('an ordinary page load (no ?signin=success), signed in, not connected: no prompt', !(await open(ctx2, { storage: { teslaSessionId: 'session-alice' } })).modal());
    check('a cancelled or failed sign-in: no prompt', !(await open(ctx2, { search: '?signin=cancelled' })).modal() && !(await open(ctx2, { search: '?signin=error' })).modal());
    check('Tesla linking (?tesla=linked) is not a Google sign-in: no prompt', !(await open(ctx2, { search: '?tesla=linked', storage: { teslaSessionId: 'session-alice' } })).modal());
    check('an invalid session after sign-in: no prompt', !(await open(ctx2, { search: '?signin=success', hashSession: 'nobody' })).modal());
  }

  console.log('3. Skip for now: dismissed, and not shown again on later sign-ins');
  {
    const ctx = await makeApp();
    const pg = await signIn(ctx, 'alice');
    click(pg, 'gmailOnboardingSkip');
    await pg.waitFor(() => !pg.modal());
    check('Skip closes the prompt', !pg.modal());
    check('Skip is remembered for this account', pg.w.localStorage.getItem('gmailOnboardingDone:alice') === '1');
    check('Skip connects nothing', !pg.requests.some(r => r.path === '/api/gmail/connect') && ctx.d1.query('SELECT COUNT(*) n FROM gmail_connections')[0].n === 0);
    const again = await signIn(ctx, 'alice', { storage: { 'gmailOnboardingDone:alice': '1' } });
    check('the next Google sign-in: no prompt', !again.modal());
    const bob = await signIn(ctx, 'bob', { storage: { 'gmailOnboardingDone:alice': '1' } });
    check("another account on the same browser is still offered it (the flag is per account)", !!bob.modal());
    const esc = await signIn(ctx, 'bob');
    esc.d.dispatchEvent(new esc.w.KeyboardEvent('keydown', { key: 'Escape' }));
    await esc.waitFor(() => !esc.modal());
    check('Escape also dismisses it and is remembered', !esc.modal() && esc.w.localStorage.getItem('gmailOnboardingDone:bob') === '1');
  }

  console.log('4. Connect Gmail: the EXISTING /api/gmail/connect flow');
  {
    const ctx = await makeApp();
    const pg = await signIn(ctx, 'alice');
    click(pg, 'gmailOnboardingConnect');
    await pg.waitFor(() => pg.requests.some(r => r.path === '/api/gmail/connect'));
    const req = pg.requests.find(r => r.path === '/api/gmail/connect');
    check('Connect Gmail POSTs to /api/gmail/connect with only the bearer session', req && req.method === 'POST' && req.auth === 'Bearer session-alice' && !/user/.test(req.path));
    const stateKeys = () => [...ctx.env.TESLA_SESSIONS._store.keys()].filter(k => k.startsWith('gmail_state:'));
    await pg.waitFor(() => stateKeys().length === 1);
    const state = stateKeys();
    check("the server issued its normal single-use OAuth state for this user (the same flow as Rider Data's button)", state.length === 1 && JSON.parse(ctx.env.TESLA_SESSIONS._store.get(state[0])).user_id === 'alice');
    check('choosing Connect is remembered too (no re-prompt; Rider Data covers a retry)', pg.w.localStorage.getItem('gmailOnboardingDone:alice') === '1');
    check('no error is shown while it hands off to Google', pg.d.getElementById('gmailOnboardingError').classList.contains('hidden'));
  }

  console.log('5. Connect failures and a cancelled Google screen never block the site');
  {
    const ctx = await makeApp();
    const failing = await signIn(ctx, 'alice', { intercept: async p => (p === '/api/gmail/connect' ? Response.json({ success: false, error: 'gmail_not_configured' }, { status: 503 }) : null) });
    click(failing, 'gmailOnboardingConnect');
    await failing.waitFor(() => !failing.d.getElementById('gmailOnboardingError').classList.contains('hidden'));
    check('a connect error is shown inside the prompt, with a way out', /Couldn't start connecting Gmail/.test(failing.text()) && !!failing.d.getElementById('gmailOnboardingSkip') && !failing.d.getElementById('gmailOnboardingConnect').disabled);
    click(failing, 'gmailOnboardingSkip');
    await failing.waitFor(() => !failing.modal());
    check('…and Skip then closes it; the rider is still signed in', !failing.modal() && failing.w.localStorage.getItem('teslaSessionId') === 'session-alice');
    const offline = await signIn(ctx, 'bob', { intercept: async p => { if (p === '/api/gmail/connect') throw new TypeError('network down'); return null; } });
    click(offline, 'gmailOnboardingConnect');
    await offline.waitFor(() => !offline.d.getElementById('gmailOnboardingError').classList.contains('hidden'));
    check('a network failure is handled the same way', /Couldn't start connecting Gmail/.test(offline.text()));

    // Google's consent screen cancelled: the existing callback sends the rider to Rider Data (?gmail=cancelled).
    const back = await open(ctx, { page: 'rider-data.html', path: '/rider-data', search: '?gmail=cancelled', storage: { teslaSessionId: 'session-alice', 'gmailOnboardingDone:alice': '1' } });
    await back.waitFor(() => !back.d.getElementById('dataSignedIn').classList.contains('hidden'));
    check('after cancelling at Google: still signed in, Rider Data loads, and it says Gmail was not connected', !back.d.getElementById('dataSignedIn').classList.contains('hidden') && /cancelled/.test(back.d.getElementById('gmailNotice').textContent) && !back.modal());
  }

  console.log("6. Rider Data's own Connect Gmail still works");
  {
    const ctx = await makeApp();
    const rd = await open(ctx, { page: 'rider-data.html', path: '/rider-data', storage: { teslaSessionId: 'session-alice' } });
    await rd.waitFor(() => !rd.d.getElementById('gmailToggleBtn').classList.contains('hidden'));
    check('the Rider Data "Connect Gmail" button is shown (no onboarding prompt on a normal visit)', rd.d.getElementById('gmailToggleBtn').textContent === 'Connect Gmail' && !rd.modal());
    rd.d.getElementById('gmailToggleBtn').dispatchEvent(new rd.w.MouseEvent('click', { bubbles: true }));
    await rd.waitFor(() => rd.requests.some(r => r.path === '/api/gmail/connect'));
    check('its Connect Gmail still calls /api/gmail/connect', rd.requests.some(r => r.path === '/api/gmail/connect' && r.method === 'POST'));
  }

  console.log('7. Nothing about Google sign-in or Gmail OAuth changed');
  {
    const signin = read('worker/google-auth.js');
    check('Google sign-in still requests only openid email profile', /const SCOPES = 'openid email profile';/.test(signin) && !/gmail/i.test(signin.match(/const SCOPES = .*/)[0]));
    const gmail = read('worker/gmail.js');
    check('Gmail OAuth scope is still gmail.readonly', /export const GMAIL_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly';/.test(gmail));
    check('the prompt never requests Gmail scopes or builds an OAuth URL itself', !/googleapis\.com\/auth|accounts\.google\.com\/o\/oauth2/.test(MAIN) && /\/api\/gmail\/connect/.test(MAIN));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
