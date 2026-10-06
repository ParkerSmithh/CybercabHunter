// The Gmail OAuth onboarding prompt that used to appear right after a Google
// sign-in is gone (owner decision 2026-10-05): forwarding receipts to the
// rider's address (/link-gmail) is the only ride source, so no rider is ever
// offered a Gmail connect prompt after signing in. The Gmail OAuth backend,
// its allowlist gate and Rider Data's own button are untouched and still
// tested here. Real pages + real calc.js/main.js in jsdom, the REAL Worker
// router and real SQL (every migration).
// Run: node tests/gmail-onboarding.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { GMAIL_CONNECT_ALLOWLIST, gmailConnectAllowed } from '../worker/gmail.js';
import { seedUser } from './helpers/d1-sqlite.mjs';

// TEMPORARY gate (worker/gmail.js GMAIL_CONNECT_ALLOWLIST, until Google verifies
// gmail.readonly): this file tests the connect flow itself, so its test riders are
// allowlisted here. The gate is tested in tests/gmail-connect-allowlist.test.mjs.
GMAIL_CONNECT_ALLOWLIST.push('alice@gmail.com', 'bob@gmail.com');

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

async function run() {
  console.log('1. No Gmail connect prompt after sign-in, for anyone');
  {
    const ctx = await makeApp();
    for (const [page, path] of [['index.html', '/'], ['link-gmail.html', '/link-gmail']]) {
      const pg = await signIn(ctx, 'alice', { page, path });
      await pg.settle(400);
      check(`${page}: the session from the sign-in fragment is stored and the fragment scrubbed`, pg.w.localStorage.getItem('teslaSessionId') === 'session-alice' && !pg.w.location.hash.includes('tesla_session'));
      check(`${page}: "Signed in" is still shown and ?signin= scrubbed`, !pg.w.location.search.includes('signin=') && /Signed in/.test((pg.d.getElementById('toastRoot') || {}).textContent || ''));
      check(`${page}: no Gmail prompt, and no Gmail status or connect request`, !pg.modal() && !pg.d.querySelector('[role="dialog"]') && !pg.requests.some(r => r.path.startsWith('/api/gmail/')));
    }
    check('main.js has no Gmail onboarding or connect code left', !/gmailOnboarding|\/api\/gmail\//.test(MAIN));

    // Google's consent screen cancelled (from Rider Data's own button): the existing callback sends the rider to Rider Data (?gmail=cancelled).
    const back = await open(ctx, { page: 'rider-data.html', path: '/rider-data', search: '?gmail=cancelled', storage: { teslaSessionId: 'session-alice' } });
    await back.waitFor(() => !back.d.getElementById('dataSignedIn').classList.contains('hidden'));
    check('after cancelling at Google: still signed in, Rider Data loads, and it says Gmail was not connected', !back.d.getElementById('dataSignedIn').classList.contains('hidden') && /cancelled/.test(back.d.getElementById('gmailNotice').textContent) && !back.modal());
  }

  console.log('6. Rider Data: "Link Gmail" is the only Gmail action');
  {
    const ctx = await makeApp();
    const rd = await open(ctx, { page: 'rider-data.html', path: '/rider-data', storage: { teslaSessionId: 'session-alice' } });
    await rd.waitFor(() => !rd.d.getElementById('dataSignedIn').classList.contains('hidden'));
    await rd.settle(300);
    const gmailActions = [...rd.d.querySelectorAll('a, button')].filter(el => /gmail/i.test(el.textContent));
    check('one "Link Gmail" button, and every Gmail-related control leads to the setup page',
      !!rd.d.getElementById('linkGmailBtn') && gmailActions.length >= 1 && gmailActions.every(el => el.tagName === 'A' && el.getAttribute('href') === '/link-gmail' && el.textContent.trim() === 'Link Gmail'));
    check('no Connect/Unlink Gmail button exists, and no Gmail request was made', !rd.d.getElementById('gmailToggleBtn') && !rd.requests.some(r => r.path.startsWith('/api/gmail/')));
    check('the accounts panel stays hidden when Tesla is not linked', rd.d.getElementById('accountsPanel').classList.contains('hidden'));
  }

  console.log('8. TEMPORARY: Gmail connect is allowlisted until Google verifies gmail.readonly');
  {
    const gmailSrc = read('worker/gmail.js');
    check('the shipped allowlist is exactly the owner, and the gate is on',
      /export const GMAIL_CONNECT_ALLOWLIST = \['contactjoeclos@gmail\.com'\];/.test(gmailSrc) && /export const GMAIL_CONNECT_GATE_ENABLED = true;/.test(gmailSrc));
    check('the match is on the signed-in Google email, case-insensitive; no Google identity is never allowed',
      gmailConnectAllowed({ email: 'ContactJoeClos@Gmail.com' }) && !gmailConnectAllowed({ email: 'carol@gmail.com' }) && !gmailConnectAllowed(null) && !gmailConnectAllowed({ email: null }));
    check('every gate is marked TEMPORARY for removal after verification',
      (gmailSrc.match(/TEMPORARY/g) || []).length >= 4);

    const ctx = await makeApp();
    for (const [u, email] of [['carol', 'carol@gmail.com'], ['owner', 'contactjoeclos@gmail.com']]) {
      seedUser(ctx.d1, u);
      ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES (?, ?, ?, ?)`).bind(`g-${u}`, u, `sub-${u}`, email)._exec();
      await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
    }
    const post = u => worker.fetch(new Request('https://x/api/gmail/connect', { method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: `Bearer session-${u}` } }), ctx.env, {});
    const statesBefore = [...ctx.env.TESLA_SESSIONS._store.keys()].filter(k => k.startsWith('gmail_state:')).length;
    const blocked = await post('carol');
    const blockedBody = await blocked.json();
    const statesAfterBlocked = [...ctx.env.TESLA_SESSIONS._store.keys()].filter(k => k.startsWith('gmail_state:')).length;
    check('a signed-in rider NOT on the allowlist is refused at the route (403), no OAuth URL, no state issued',
      blocked.status === 403 && blockedBody.error === 'gmail_connect_unavailable' && !blockedBody.authorize_url && statesAfterBlocked === statesBefore);
    const allowed = await post('owner');
    const allowedBody = await allowed.json();
    const authUrl = allowedBody.authorize_url ? new URL(allowedBody.authorize_url) : null;
    check('the allowlisted owner can start the flow: Google\'s URL with the unchanged gmail.readonly scope',
      allowed.status === 200 && authUrl && authUrl.hostname === 'accounts.google.com' && authUrl.searchParams.get('scope').split(' ').includes('https://www.googleapis.com/auth/gmail.readonly') && authUrl.searchParams.get('login_hint') === 'contactjoeclos@gmail.com');
    const status = async u => (await worker.fetch(new Request('https://x/api/gmail/status', { headers: { Origin: 'https://cybercabhunter.com', Authorization: `Bearer session-${u}` } }), ctx.env, {})).json();
    check('status reports connect_allowed: false for the rider, true for the owner', (await status('carol')).connect_allowed === false && (await status('owner')).connect_allowed === true);

    for (const u of ['carol', 'owner']) {
      const rd = await open(ctx, { page: 'rider-data.html', path: '/rider-data', storage: { teslaSessionId: `session-${u}` } });
      await rd.waitFor(() => !rd.d.getElementById('dataSignedIn').classList.contains('hidden'));
      await rd.settle(300);
      check(`Rider Data (${u}): no Connect Gmail button even though the gate ${u === 'owner' ? 'allows' : 'refuses'} it, and no Gmail request`,
        !rd.d.getElementById('gmailToggleBtn') && !rd.requests.some(r => r.path.startsWith('/api/gmail/')));
    }

    const carolSignIn = await signIn(ctx, 'carol');
    await carolSignIn.settle(400);
    check('right after Google sign-in, a rider not on the allowlist is not offered Gmail', !carolSignIn.modal() && !carolSignIn.requests.some(r => r.path === '/api/gmail/connect'));
    const ownerSignIn = await signIn(ctx, 'owner');
    await ownerSignIn.settle(400);
    check('...nor is the allowlisted owner (the popup is gone; the gate itself stays)', !ownerSignIn.modal() && !ownerSignIn.requests.some(r => r.path.startsWith('/api/gmail/')));
  }

  console.log('7. Nothing about Google sign-in or Gmail OAuth changed');
  {
    const signin = read('worker/google-auth.js');
    check('Google sign-in still requests only openid email profile', /const SCOPES = 'openid email profile';/.test(signin) && !/gmail/i.test(signin.match(/const SCOPES = .*/)[0]));
    const gmail = read('worker/gmail.js');
    check('Gmail OAuth scope is still gmail.readonly', /export const GMAIL_SCOPE = 'https:\/\/www\.googleapis\.com\/auth\/gmail\.readonly';/.test(gmail));
    check('main.js never requests Gmail scopes or builds an OAuth URL itself', !/googleapis\.com\/auth|accounts\.google\.com\/o\/oauth2/.test(MAIN));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
