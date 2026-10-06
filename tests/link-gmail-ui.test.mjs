// Link Gmail page (/link-gmail): the rider's forwarding address, the Gmail
// confirmation code, live status, and "get a new address". The REAL
// js/link-gmail.js runs in jsdom against the REAL Worker code and real SQL
// (node:sqlite + the project's migrations); fetch() is routed straight into
// worker.fetch, and mail arrives through the real handleIncomingEmail.
// Also: the Rider Data entry point and the /link-gmail route.
// Layout/CSS is not exercised (jsdom has no renderer).
// Run: node tests/link-gmail-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/link-gmail.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}public/js/link-gmail.js`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const CONFIRMATION = { from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from rider@gmail.com', body: 'Confirmation code: 482913775' };

async function makeApp({ users = ['u1'] } = {}) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.env.ASSETS = { fetch: req => new Response('asset:' + new URL(req.url).pathname) };
  ctx.tokenOf = userId => ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = ? AND status = 'active'", userId)[0].opaque_token;
  ctx.mailTo = async (to, opts) => handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
  ctx.email = async (userId, opts) => ctx.mailTo(`u_${ctx.tokenOf(userId)}@${ctx.env.RECEIPT_DOMAIN}`, opts);
  return ctx;
}

const opened = [];
// Opens the page as `userId` (null = signed out). `intercept(path, init)` may
// return a Response to simulate a failing server.
async function openPage(ctx, userId, { intercept, clipboard } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/link-gmail', pretendToBeVisual: true });
  const w = dom.window;
  opened.push(w);
  if (userId) w.localStorage.setItem('teslaSessionId', `session-${userId}`);
  const copied = [];
  if (clipboard !== false) Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async s => { copied.push(s); } }, configurable: true });
  const requests = [];
  w.fetch = async (url, init = {}) => {
    const path = String(url).replace(WORKER_ORIGIN, '');
    requests.push({ method: init.method || 'GET', path, auth: (init.headers || {}).Authorization });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
  };
  w.eval(JS);
  const d = w.document;
  const page = {
    w, d, requests, copied,
    $: id => d.getElementById(id),
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    },
    // Click "check now" and wait for the round trip to finish.
    async refresh() {
      const before = requests.length;
      page.click(page.$('lgRefresh'));
      await page.waitFor(() => requests.length > before && !page.$('lgRefresh').disabled, 'refresh');
    }
  };
  if (userId) await page.waitFor(() => page.visible('lgReady') || page.visible('lgError') || page.visible('lgSignedOut'), 'page to load');
  return page;
}

async function run() {
  console.log('1. Signed out');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, null);
    check('no session: the sign-in prompt is shown, nothing else', page.visible('lgSignedOut') && !page.visible('lgReady') && !page.visible('lgLoading'));
    check('...and no request is made', page.requests.length === 0);
    const signIn = page.d.querySelector('#lgSignedOut a');
    check('Sign In brings the rider back here afterwards', signIn.getAttribute('href') === 'signin.html?returnTo=%2Flink-gmail');

    const expired = await openPage(ctx, 'ghost');
    check('an expired session is shown as signed out, not as an error', expired.visible('lgSignedOut') && !expired.visible('lgError'));
  }

  console.log('2. The forwarding address');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 'u1');
    check('the page loads into the ready view', page.visible('lgReady'));
    check('the full address is shown', page.text('lgAddress') === ctx.addressFor('u1'));
    check('every request carries only the rider\'s own session', page.requests.every(r => r.auth === 'Bearer session-u1'));
    check('the "treat it like a password" warning is shown', /Treat this address like a password/.test(page.text('lgAddressReady')));
    const copyButtons = [...page.d.querySelectorAll('[data-copy="address"]')];
    check('every "Copy address" button is enabled', copyButtons.length >= 3 && copyButtons.every(b => !b.disabled));
    page.click(copyButtons[0]);
    await page.waitFor(() => copyButtons[0].querySelector('[data-copy-label]').textContent === 'Copied', 'copy');
    check('Copy puts the exact address on the clipboard', page.copied[0] === ctx.addressFor('u1'));
    check('...and says so', copyButtons[0].querySelector('[data-copy-label]').textContent === 'Copied');
    page.click(page.d.querySelector('[data-copy="tesla.com"]'));
    await page.waitFor(() => page.copied.length === 2, 'copy filter text');
    check('the filter text (tesla.com) can be copied too', page.copied[1] === 'tesla.com');
  }

  console.log('3. Status and the Gmail confirmation code, without reloading the page');
  {
    const ctx = await makeApp();
    const page = await openPage(ctx, 'u1');
    check('before anything arrives: "Not receiving yet"', page.visible('lgStateOff') && !page.visible('lgStateOn'));
    check('step 3 waits for Gmail\'s code', page.visible('lgCodeWaiting') && !page.visible('lgCodeShown'));
    check('totals start at 0 and the last receipt is "Never"', page.text('lgProcessed') === '0' && page.text('lgAdded') === '0' && page.text('lgLastReceived') === 'Never');

    await ctx.email('u1', CONFIRMATION);
    await page.refresh();
    check('Gmail\'s code appears on the page', page.visible('lgCodeShown') && page.text('lgCode') === '482913775');
    check('...and the waiting message goes away', !page.visible('lgCodeWaiting'));
    page.click(page.d.querySelector('[data-copy="code"]'));
    await page.waitFor(() => page.copied.length === 1, 'copy code');
    check('the code can be copied', page.copied[0] === '482913775');
    check('a code alone does not mean receipts are arriving', page.visible('lgStateOff'));

    await ctx.email('u1', { body: receiptBody() });
    await page.refresh();
    check('after a real receipt: "Receiving receipts"', page.visible('lgStateOn') && !page.visible('lgStateOff'));
    // "Emails processed" counts every message read, Gmail's confirmation included.
    check('...the totals show it (2 emails processed, 1 ride added)', page.text('lgProcessed') === '2' && page.text('lgAdded') === '1');
    check('...the last receipt time is filled in', page.text('lgLastReceived') !== 'Never');
    check('...and step 3 shows forwarding as confirmed', page.visible('lgCodeDone') && !page.visible('lgCodeShown') && !page.visible('lgCodeWaiting'));

    await ctx.email('u1', { body: receiptBody() });
    await page.refresh();
    check('forwarding the same receipt again is a duplicate, not a second ride', page.text('lgAdded') === '1' && page.text('lgDuplicates') === '1');

    const before = page.requests.length;
    page.d.dispatchEvent(new page.w.Event('visibilitychange'));
    await page.waitFor(() => page.requests.length > before, 'refresh on return to tab');
    check('coming back to the tab re-checks the status', page.requests.slice(before).some(r => r.path === '/api/rides/sync-status'));
  }

  console.log('4. Only the signed-in rider\'s own address and status');
  {
    const ctx = await makeApp({ users: ['u1', 'u2'] });
    await ctx.email('u1', CONFIRMATION);
    await ctx.email('u1', { body: receiptBody() });
    const page = await openPage(ctx, 'u2');
    check('u2 sees their own address', page.text('lgAddress') === ctx.addressFor('u2'));
    check('...never u1\'s address', !page.d.body.textContent.includes(ctx.addressFor('u1')));
    check('...nor u1\'s status', page.visible('lgStateOff') && page.text('lgProcessed') === '0' && page.visible('lgCodeWaiting'));
  }

  console.log('5. Get a new address');
  {
    const ctx = await makeApp();
    await ctx.email('u1', CONFIRMATION);
    const page = await openPage(ctx, 'u1');
    const oldAddress = page.text('lgAddress');
    page.click(page.$('lgRotateOpen'));
    check('asking first: the confirmation explains the old address stops working', page.visible('lgRotateConfirm') && /stops working immediately/.test(page.text('lgRotateConfirm')));
    page.click(page.$('lgRotateCancel'));
    check('"Keep this one" closes it and changes nothing', !page.visible('lgRotateConfirm') && page.text('lgAddress') === oldAddress && !page.requests.some(r => r.method === 'POST'));

    page.click(page.$('lgRotateOpen'));
    page.click(page.$('lgRotateConfirmBtn'));
    await page.waitFor(() => page.visible('lgRotateNotice'), 'rotate');
    const newAddress = page.text('lgAddress');
    check('a new address is shown', newAddress !== oldAddress && newAddress === `u_${ctx.tokenOf('u1')}@${ctx.env.RECEIPT_DOMAIN}`);
    check('...with a note to update Gmail', /old one no longer works/.test(page.text('lgRotateNotice')));
    await page.waitFor(() => page.visible('lgCodeWaiting'), 'status after rotate');
    check('...and the old address\'s confirmation code is gone', !page.visible('lgCodeShown'));
    page.click(page.d.querySelector('[data-copy="address"]'));
    await page.waitFor(() => page.copied.length === 1, 'copy');
    check('Copy now gives the new address', page.copied[0] === newAddress);

    await ctx.mailTo(oldAddress, { body: receiptBody() });
    check('mail to the old address no longer adds a ride', ctx.d1.query("SELECT COUNT(*) AS n FROM trips WHERE user_id = 'u1'")[0].n === 0);
  }

  console.log('6. No receipt domain configured: "coming soon"');
  {
    const ctx = await makeApp();
    ctx.env.RECEIPT_DOMAIN = '';
    const page = await openPage(ctx, 'u1');
    check('the address section says "Coming soon"', page.visible('lgAddressPending') && !page.visible('lgAddressReady'));
    check('...and no address is offered for copying', [...page.d.querySelectorAll('[data-copy="address"]')].every(b => b.disabled));
    check('...nor shown anywhere on the page', !/u_[0-9a-f]{8,}/.test(page.d.body.textContent));
  }

  console.log('7. Errors are not "signed out"');
  {
    const ctx = await makeApp();
    let fail = true;
    const page = await openPage(ctx, 'u1', { intercept: path => (fail && path === '/api/rides/sync-status' ? new Response('{}', { status: 500 }) : null) });
    check('a server error shows the error view with its code', page.visible('lgError') && !page.visible('lgSignedOut') && /code 500/.test(page.text('lgErrorDetail')));
    fail = false;
    page.click(page.$('lgRetry'));
    await page.waitFor(() => page.visible('lgReady'), 'retry');
    check('Try again recovers', page.visible('lgReady') && page.text('lgAddress') === ctx.addressFor('u1'));
    fail = true;
    await page.refresh();
    check('a failed background check keeps the page and says so quietly', page.visible('lgReady') && page.visible('lgStatusError'));
  }

  console.log('8. Entry points and the route');
  {
    const ctx = await makeApp();
    const route = await worker.fetch(new Request('https://x/link-gmail'), ctx.env, {});
    check('/link-gmail is served from the static site (link-gmail.html)', (await route.text()) === 'asset:/link-gmail');
    const rider = fs.readFileSync(`${ROOT}public/rider-data.html`, 'utf8');
    check('Rider Data has one "Link Gmail" button pointing at the setup page', (rider.match(/id="linkGmailBtn"/g) || []).length === 1 && /id="linkGmailBtn" href="\/link-gmail"/.test(rider));
    check('Rider Data does not hold the forwarding setup itself', !/lgAddress|Forwarding and POP\/IMAP/.test(rider));
  }

  console.log('9. Copy');
  {
    const text = new JSDOM(HTML).window.document.body.textContent;
    check('no em or en dashes anywhere on the page', !/[–—]/.test(HTML) && !/[–—]/.test(JS));
    check('the zero-setup option comes before the automatic one', text.indexOf('Forward each receipt') < text.indexOf('Forward automatically'));
    check('the backfill says duplicates are handled', /never counted twice/.test(text));
  }

  opened.forEach(w => w.close());
  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
