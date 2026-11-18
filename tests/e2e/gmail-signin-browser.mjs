// Signing in never forces Gmail linking: end to end in a real browser
// (Chromium via Playwright). The real pages and the REAL Worker (Google
// sign-in, sessions, Rider Data, Link Gmail) over an isolated in-memory
// database (tests/e2e/harness.mjs). Google itself is a local stand-in that
// approves or cancels; no real OAuth credentials, nothing touches production.
//
//   node tests/e2e/gmail-signin-browser.mjs [outDir]
//   PW_PATH=…/playwright-core CHROME=…/chromium  — where Playwright and the browser are
//
// Covers the bug (Nov 2026): a rider whose Gmail is linked was sent to
// /link-gmail on every sign-in. Flows: linked and unlinked sign-in from a
// protected page, the home page and a deep link; refresh; closing and
// reopening the browser; an expired session; sign-out and sign-in again;
// cancelling Google; a network error during the Gmail status check; Link
// Gmail opened on purpose; the optional Gmail import's own callback result;
// and no redirect loops (every main-frame navigation recorded).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeEnv } from '../helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from '../helpers/receipts.mjs';
import { handleIncomingEmail } from '../../worker/receipt-ingestion.js';
import worker from '../../worker/index.js';
import { loadPlaywright, newContext } from './harness.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const OUT = process.argv[2] || null;
let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} — ${label}${!cond && extra ? ' ' + extra : ''}`); };

const pw = loadPlaywright();
if (!pw) { console.log('Playwright is not installed: skipped (set PW_PATH).'); process.exit(0); }

// ---- The app: alice (Gmail linked: receipts arriving), bob (never set up).
const ctx = await makeEnv({ users: ['alice', 'bob'] });
const env = ctx.env;
Object.assign(env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' });
ctx.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc-a', 'alice', 'sub-alice', 'alice@example.com'), ('gc-b', 'bob', 'sub-bob', 'bob@example.com')`);
const tokenOf = u => ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'", u)[0].opaque_token;
const mail = async (u, opts) => { const to = `u_${tokenOf(u)}@${env.RECEIPT_DOMAIN}`; await handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), env); };
await mail('alice', { body: receiptBody() });

// Google's side, stubbed in this process (the Worker calls it from here).
let nextSub = 'sub-alice';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'test-access-token' });
  if (u.startsWith('https://openidconnect.googleapis.com') || u.includes('/userinfo')) return Response.json({ sub: nextSub, email: `${nextSub}@example.com`, name: nextSub });
  return realFetch(url, init);
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p === '/') p = '/index.html';
  else if (!path.extname(p)) p += '.html';
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response('Not found', { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
}
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://localhost');
    let resp;
    if (/^\/(api|oauth)\//.test(url.pathname)) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      resp = await worker.fetch(new Request(`https://cybercabhunter.com${url.pathname}${url.search}`, { method: req.method, headers: { ...req.headers, origin: 'https://cybercabhunter.com' }, body }), env, { waitUntil() {} });
    } else resp = serveFile(url.pathname);
    const headers = {}; resp.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(resp.status, headers);
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end(String(e && e.stack || e)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
env.FRONTEND_URL = ORIGIN + '/';

const browser = await pw.chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
// A browser for one rider: production addresses go to the local Worker, and
// Google's sign-in page is a stand-in that approves (or cancels) at once.
async function wire(c, { cancel = false } = {}) {
  // The Worker's own redirects go to the browser as they are, so it follows
  // every hop itself (newer routes win). Its redirect to Google is answered
  // here by the stand-in: approve (a test code) or cancel, straight back to
  // the Worker's callback. Google is never contacted (a redirect's next
  // request can't be intercepted, so it must not be sent at all).
  await c.route(/^https:\/\/[^/]*(cybercabhunter\.com|workers\.dev)\//, async r => {
    const u = new URL(r.request().url());
    const resp = await r.fetch({ url: ORIGIN + u.pathname + u.search, maxRedirects: 0 });
    const loc = resp.headers().location || '';
    if (/^https:\/\/accounts\.google\.com\//.test(loc)) {
      const state = new URL(loc).searchParams.get('state');
      const back = cancel ? `${ORIGIN}/oauth/google/callback?error=access_denied&state=${state}` : `${ORIGIN}/oauth/google/callback?code=test-code&state=${state}`;
      return r.fulfill({ status: 302, headers: { location: back } });
    }
    // The local page's origin stands in for https://cybercabhunter.com, the
    // origin the Worker allows (CORS), as on the real site.
    const headers = { ...resp.headers() };
    if (headers['access-control-allow-origin']) headers['access-control-allow-origin'] = ORIGIN;
    return r.fulfill({ status: resp.status(), headers, body: await resp.body() });
  });
  await c.route(/^https:\/\/accounts\.google\.com\//, r => r.abort());   // belt and braces
}
async function open({ width = 1440, height = 900, mobile = false, cancel = false } = {}) {
  const c = await newContext(browser, { width, height, mobile, origin: ORIGIN });
  await wire(c, { cancel });
  const page = await c.newPage();
  const visited = [];
  // Real document loads only: the site tidies the address bar with
  // history.replaceState (dropping ?signin= and the session fragment), which
  // is not a navigation or a redirect.
  page.on('load', () => visited.push(new URL(page.url()).pathname));
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  return { c, page, visited, errors };
}
const settle = p => p.waitForLoadState('networkidle').catch(() => {});
async function signIn(page, link) {
  await page.click(link);
  await page.waitForURL(/\/signin/);
  await page.click('#signInGoogle');
  await page.waitForURL(u => !/\/(signin|oauth)/.test(u.pathname) && !/accounts\.google/.test(u.host));
  await settle(page);
  await page.waitForTimeout(400);
}
const shot = async (page, name) => { if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` }); };
const gmailLabel = page => page.textContent('#linkGmailLabel').then(s => s.trim());

try {
  console.log('1. Linked rider signs in from a protected page (deep link): straight back there, "Gmail Linked"');
  {
    nextSub = 'sub-alice';
    const { c, page, visited, errors } = await open();
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    const href = await page.getAttribute('#dataSignedOut a[href*="signin"], a[href^="signin.html"]', 'href');
    check('signed out on /rider-data: Sign In asks to come back here', /returnTo=%2Frider-data/.test(href || ''), href);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForSelector('#gmailLinkedChip:not(.hidden)', { timeout: 8000 }).catch(() => {});
    check('back on /rider-data, signed in', new URL(page.url()).pathname === '/rider-data' && await page.isVisible('#dataSignedIn'));
    check('"Gmail Linked" with Stop Sync; no Link Gmail prompt', await page.isVisible('#gmailLinkedChip') && (await gmailLabel(page)) === 'Stop Sync');
    check('never visited /link-gmail', !visited.includes('/link-gmail'), JSON.stringify(visited));
    check('the URL is clean (no session or ?signin=)', !/tesla_session|signin=/.test(page.url()));
    await shot(page, 'signin-linked-rider-data');
    // Refresh, then close and reopen the browser (same profile): still signed in, no redirect.
    await page.reload(); await settle(page); await page.waitForTimeout(400);
    check('refresh: still signed in, still "Gmail Linked", still here', new URL(page.url()).pathname === '/rider-data' && await page.isVisible('#gmailLinkedChip'));
    const state = await c.storageState();
    await c.close();
    const again = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    await again.route(/googletagmanager|google-analytics|fonts\.g|vendor\/maplibre/, r => r.abort());
    await wire(again);
    const p2 = await again.newPage();
    await p2.goto(`${ORIGIN}/rider-data`); await settle(p2); await p2.waitForTimeout(400);
    check('browser closed and reopened: signed in, "Gmail Linked", no redirect', new URL(p2.url()).pathname === '/rider-data' && await p2.isVisible('#gmailLinkedChip'));
    await again.close();
    check('no page errors', errors.length === 0, JSON.stringify(errors));
  }

  console.log('2. Linked rider signs in from the header on the home page: back on the home page');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open();
    await page.goto(`${ORIGIN}/`); await settle(page);
    const header = await page.$$eval('a[href^="signin.html"]', as => as.map(a => a.getAttribute('href')));
    check('every Sign In link on the home page asks to come back to "/"', header.length > 0 && header.every(h => h === 'signin.html?returnTo=%2F'), JSON.stringify(header));
    await signIn(page, 'a[href^="signin.html"] >> visible=true');
    check('back on the home page, not Link Gmail', new URL(page.url()).pathname === '/' && !visited.includes('/link-gmail'), JSON.stringify(visited));
    check('no redirect loop: home, sign-in, home (three page loads)', JSON.stringify(visited) === JSON.stringify(['/', '/signin.html', '/']), JSON.stringify(visited));
    await c.close();
  }

  console.log('3. Unlinked rider signs in from a page: back there; Gmail setup is optional');
  {
    nextSub = 'sub-bob';
    const { c, page, visited } = await open({ width: 390, height: 844, mobile: true });
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForFunction(() => /Setup Tesla Sync|Check Gmail/.test(document.getElementById('linkGmailLabel').textContent), null, { timeout: 8000 }).catch(() => {});
    check('back on /rider-data (phone), no forced Gmail linking', new URL(page.url()).pathname === '/rider-data' && !visited.includes('/link-gmail'));
    check('an optional "Setup Tesla Sync" action instead', (await gmailLabel(page)) === 'Setup Tesla Sync' && !(await page.isVisible('#gmailLinkedChip')));
    await shot(page, 'signin-unlinked-rider-data-390');
    await c.close();
  }

  console.log('4. Expired session, then sign in again: back to the page, still linked');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open();
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    const session = await page.evaluate(() => localStorage.getItem('teslaSessionId'));
    await env.TESLA_SESSIONS.delete(`session:${session}`);   // the session expires on the server
    await page.reload(); await settle(page); await page.waitForTimeout(400);
    check('expired: the signed-out view, no redirect anywhere', await page.isVisible('#dataSignedOut') && new URL(page.url()).pathname === '/rider-data');
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForSelector('#gmailLinkedChip:not(.hidden)', { timeout: 8000 }).catch(() => {});
    check('signed in again: back on /rider-data, still "Gmail Linked" (the connection was kept)', new URL(page.url()).pathname === '/rider-data' && await page.isVisible('#gmailLinkedChip') && !visited.includes('/link-gmail'));
    await c.close();
  }

  console.log('5. Sign out, then sign in again');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open();
    await page.goto(`${ORIGIN}/vehicles`); await settle(page);
    await signIn(page, 'a[href^="signin.html"] >> visible=true');
    check('signed in from /vehicles: back on /vehicles', new URL(page.url()).pathname === '/vehicles');
    await page.evaluate(() => { const b = document.getElementById('accountMenuSignOut'); if (b) b.click(); else localStorage.removeItem('teslaSessionId'); });
    await page.waitForTimeout(500);
    await page.goto(`${ORIGIN}/vehicles`); await settle(page);
    const signedOut = await page.evaluate(() => !localStorage.getItem('teslaSessionId'));
    await signIn(page, 'a[href^="signin.html"] >> visible=true');
    check('signed out, then in again: back on /vehicles, never Link Gmail', signedOut && new URL(page.url()).pathname === '/vehicles' && !visited.includes('/link-gmail'), JSON.stringify(visited));
    await c.close();
  }

  console.log('6. Cancelling Google sign-in: the site, signed out, no Gmail page');
  {
    const { c, page, visited } = await open({ cancel: true });
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await page.click('main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForURL(/\/signin/);
    await page.click('#signInGoogle');
    await page.waitForURL(u => !/\/(signin|oauth)/.test(u.pathname)); await settle(page);
    check('cancelled: on the site, not signed in, never Link Gmail', !(await page.evaluate(() => localStorage.getItem('teslaSessionId'))) && !visited.includes('/link-gmail'), page.url());
    await c.close();
  }

  console.log('7. A network error during the Gmail status check: session kept, no redirect');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open();
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await c.route(/\/api\/rides\/sync-status/, r => r.abort('internetdisconnected'));
    await page.reload(); await settle(page); await page.waitForTimeout(500);
    check('"Check Gmail" (not "not linked"), still signed in, still here', (await gmailLabel(page)) === 'Check Gmail' && await page.isVisible('#dataSignedIn') && new URL(page.url()).pathname === '/rider-data' && !visited.includes('/link-gmail'));
    await c.close();
  }

  console.log('8. Link Gmail opened on purpose, and the optional Gmail import\'s callback result');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open();
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.goto(`${ORIGIN}/link-gmail`); await settle(page); await page.waitForTimeout(500);
    check('linked: "Gmail Linked" first, setup steps closed', (await page.textContent('#lgStatusText')).trim() === 'Gmail Linked' && await page.isVisible('#lgStatus') && !(await page.isVisible('#lgSetup')));
    await shot(page, 'link-gmail-linked');
    await page.click('#lgStatusManage');
    check('Manage forwarding opens the setup', await page.isVisible('#lgSetup'));
    await page.click('#lgStatusPrimary'); await page.waitForURL(/\/rider-data/); await settle(page);
    check('Go to Rider Data', new URL(page.url()).pathname === '/rider-data');
    await page.goto(`${ORIGIN}/rider-data?gmail=cancelled`); await settle(page); await page.waitForTimeout(300);
    check('the Gmail import\'s ?gmail=cancelled: explained on Rider Data, no redirect', /wasn't connected/.test(await page.textContent('#gmailNotice')) && new URL(page.url()).pathname === '/rider-data' && !/gmail=/.test(page.url()));
    check('no loop: each page loaded once per visit', visited.filter(v => v === '/link-gmail').length === 1, JSON.stringify(visited));
    await c.close();
  }

  console.log('9. Linked rider on a phone (390 px): the labels fit, no sideways scrolling');
  {
    nextSub = 'sub-alice';
    const { c, page, visited } = await open({ width: 390, height: 844, mobile: true });
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForSelector('#gmailLinkedChip:not(.hidden)', { timeout: 8000 }).catch(() => {});
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('Rider Data: "Gmail Linked" and Stop Sync on screen, no overflow', await page.isVisible('#gmailLinkedChip') && (await overflow()) <= 0 && !visited.includes('/link-gmail'));
    await shot(page, 'signin-linked-rider-data-390');
    await page.goto(`${ORIGIN}/link-gmail`); await settle(page); await page.waitForTimeout(400);
    check('Link Gmail: "Gmail Linked" card, no overflow', await page.isVisible('#lgStatus') && (await overflow()) <= 0);
    await shot(page, 'link-gmail-linked-390');
    await c.close();
  }

  console.log('10. A brand-new account (desktop): the one-time Tesla Sync invitation, then the page asked for');
  {
    nextSub = 'sub-brand-new';
    const { c, page, visited, errors } = await open();
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    await page.waitForSelector('#lgWelcome:not(.hidden)', { timeout: 8000 }).catch(() => {});
    check('signed up from Rider Data: the invitation on Link Gmail', new URL(page.url()).pathname === '/link-gmail' && await page.isVisible('#lgWelcome'));
    check('…"Welcome to CybercabHunter", "Set Up Tesla Sync", Set Up Gmail and Skip for Now', (await page.textContent('#lgWelcomeTitle')).trim() === 'Welcome to CybercabHunter' && /Set Up Tesla Sync/.test(await page.textContent('#lgWelcome')) && await page.isVisible('#lgWelcomeSetup') && await page.isVisible('#lgWelcomeSkip'));
    await shot(page, 'onboarding-web-1440');
    await page.reload(); await settle(page); await page.waitForTimeout(400);
    check('refresh: still the invitation', await page.isVisible('#lgWelcome'));
    await page.click('#lgWelcomeSkip');
    await page.waitForURL(/\/rider-data/); await settle(page); await page.waitForTimeout(300);
    check('Skip for Now: on to Rider Data, signed in', new URL(page.url()).pathname === '/rider-data' && await page.isVisible('#dataSignedIn'));
    await page.evaluate(() => { const b = document.getElementById('accountMenuSignOut'); if (b) b.click(); else localStorage.removeItem('teslaSessionId'); });
    await page.waitForTimeout(400);
    await page.goto(`${ORIGIN}/rider-data`); await settle(page);
    const before = visited.filter(v => v === '/link-gmail').length;
    await signIn(page, 'main a[href^="signin.html?returnTo=%2Frider-data"]');
    check('signing out and in again: straight to Rider Data, the invitation not repeated', new URL(page.url()).pathname === '/rider-data' && visited.filter(v => v === '/link-gmail').length === before);
    // The harness blocks MapLibre (tests/e2e/harness.mjs), so the home page's minimap can't start after sign-out.
    const real = errors.filter(e => !/maplibregl is not defined/.test(e));
    check('no page errors (besides the harness\'s blocked map library)', real.length === 0, JSON.stringify(real));
    await c.close();
  }

  console.log('11. A brand-new account (phone): Set Up Gmail, then Skip for Now from the steps');
  {
    nextSub = 'sub-brand-new-phone';
    const { c, page } = await open({ width: 390, height: 844, mobile: true });
    await page.goto(`${ORIGIN}/`); await settle(page);
    await signIn(page, 'a[href^="signin.html"] >> visible=true');
    await page.waitForSelector('#lgWelcome:not(.hidden)', { timeout: 8000 }).catch(() => {});
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check('the invitation on a phone, no sideways scrolling', await page.isVisible('#lgWelcome') && (await overflow()) <= 0);
    await shot(page, 'onboarding-web-390');
    await page.click('#lgWelcomeSetup'); await page.waitForTimeout(300);
    check('Set Up Gmail: the forwarding steps and the "Skip for Now" bar', await page.isVisible('#lgSetup') && await page.isVisible('#lgWelcomeBar') && !(await page.isVisible('#lgWelcome')));
    await shot(page, 'onboarding-web-setup-390');
    await page.click('#lgWelcomeLater');
    await page.waitForURL(u => u.pathname === '/'); await settle(page);
    check('Skip for Now from the steps: back to the home page they started from', new URL(page.url()).pathname === '/');
    await c.close();
  }
} finally {
  await browser.close();
  server.close();
  globalThis.fetch = realFetch;
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
