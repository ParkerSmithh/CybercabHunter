// The rider's own receipt intake address: GET /api/receipt-ingestion/address
// (worker/receipt-ingestion.js, db.findOrCreateReceiptIngestionAddress) and
// the "Your receipt address" section of Rider Data (rider-data.html +
// js/rider-data.js). The address is u_<32-hex token>@<RECEIPT_DOMAIN>, issued
// on first use, one per rider, resolved ONLY from the bearer session.
// Real SQL (every migration), the REAL Worker router; the page runs in jsdom.
// Run: node tests/receipt-address.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { seedUser } from './helpers/d1-sqlite.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const DOMAIN = 'cybercabhunter.com';
const ADDRESS_RE = /^u_[0-9a-f]{32}@cybercabhunter\.com$/;

// 'old' already has an address (makeEnv issues one); 'fresh' and 'other' are
// accounts created without one — like a user who signed up after the address
// UI was removed.
async function makeApp() {
  const ctx = await makeEnv({ users: ['old'], domain: DOMAIN });
  for (const id of ['fresh', 'other']) seedUser(ctx.d1, id);
  for (const id of ['old', 'fresh', 'other']) await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
  ctx.env.ASSETS = { fetch: async req => new Response('static:' + new URL(req.url).pathname, { status: 404 }) };
  return ctx;
}

function call(ctx, method, path, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}
const getAddress = async (ctx, userId, suffix = '') => {
  const r = await call(ctx, 'GET', '/api/receipt-ingestion/address' + suffix, userId);
  return { status: r.status, body: await r.json() };
};
const rows = (ctx, userId) => ctx.d1.query('SELECT * FROM receipt_ingestion_addresses WHERE user_id = ?', userId);
const deliver = async (ctx, to, body = receiptBody()) => {
  const msg = inboundMessage(eml({ to, body }), to);
  await worker.email(msg, ctx.env, {});
  return msg;
};

async function run() {
  console.log('1. Authentication');
  {
    const ctx = await makeApp();
    check('no session: 401', (await getAddress(ctx, null)).status === 401);
    const bogus = await worker.fetch(new Request('https://x/api/receipt-ingestion/address', { headers: { Authorization: 'Bearer not-a-session' } }), ctx.env, {});
    check('an invalid session: 401', bogus.status === 401);
    check('neither created an address', ctx.d1.query('SELECT COUNT(*) n FROM receipt_ingestion_addresses')[0].n === 1);
  }

  console.log('2. A signed-in user gets their own address, created on first use');
  {
    const ctx = await makeApp();
    check('a new account starts with no address', rows(ctx, 'fresh').length === 0);
    const r = await getAddress(ctx, 'fresh');
    check('200 with a full address', r.status === 200 && r.body.success === true && r.body.domain_configured === true);
    check('the address is u_<32 hex>@cybercabhunter.com', ADDRESS_RE.test(r.body.address));
    const row = rows(ctx, 'fresh');
    check('exactly one active row was created for that user', row.length === 1 && row[0].status === 'active');
    check('the address carries that row\'s token (the existing token mechanism)', r.body.address === `u_${row[0].opaque_token}@${DOMAIN}`);
    check('the response carries nothing but the address fields', Object.keys(r.body).sort().join() === 'address,domain_configured,success');

    const existing = await getAddress(ctx, 'old');
    check('an existing address is returned as-is', existing.body.address === ctx.addressFor('old') && rows(ctx, 'old').length === 1);
  }

  console.log('3. Reuse, not duplicates');
  {
    const ctx = await makeApp();
    const first = await getAddress(ctx, 'fresh');
    const second = await getAddress(ctx, 'fresh');
    check('asking again returns the same address', first.body.address === second.body.address);
    check('still one row', rows(ctx, 'fresh').length === 1);
    const racing = await Promise.all(Array.from({ length: 5 }, () => getAddress(ctx, 'other')));
    check('five simultaneous first requests all succeed', racing.every(r => r.status === 200));
    check('and all get the SAME address, backed by one row', new Set(racing.map(r => r.body.address)).size === 1 && rows(ctx, 'other').length === 1);
  }

  console.log('4. A user can never get another user\'s address');
  {
    const ctx = await makeApp();
    const mine = await getAddress(ctx, 'fresh');
    const theirs = ctx.addressFor('old');
    check('each user gets a different address', mine.body.address !== theirs);
    for (const suffix of ['?user_id=old', '?userId=old', '?id=old', '?uid=old']) {
      check(`a query parameter (${suffix}) is ignored: still the caller's own`, (await getAddress(ctx, 'fresh', suffix)).body.address === mine.body.address);
    }
    const posted = await call(ctx, 'GET', '/api/receipt-ingestion/address', 'fresh');
    const byPath = await call(ctx, 'GET', '/api/receipt-ingestion/address/old', 'fresh');
    check('there is no route that takes a user id in the path', !(await byPath.text()).includes(theirs.split('@')[0]));
    check('POSTing a user id does not return theirs either', !(await (await call(ctx, 'POST', '/api/receipt-ingestion/address', 'fresh', { user_id: 'old' })).text()).includes(theirs.split('@')[0]));
    const sync = await (await call(ctx, 'GET', '/api/rides/sync-status', 'fresh')).json();
    check('sync-status reports only the caller\'s own address', sync.forwarding.address === mine.body.address && !JSON.stringify(sync).includes(theirs.split('@')[0]));
    check('the other user\'s row is untouched', rows(ctx, 'old').length === 1 && `u_${rows(ctx, 'old')[0].opaque_token}@${DOMAIN}` === theirs && posted.status === 200);
  }

  console.log('5. A revoked address is not silently re-issued');
  {
    const ctx = await makeApp();
    ctx.d1.exec(`UPDATE receipt_ingestion_addresses SET status = 'revoked', revoked_at = datetime('now') WHERE user_id = 'old'`);
    const r = await getAddress(ctx, 'old');
    check('409 address_revoked (not a 500, not a new address)', r.status === 409 && r.body.error === 'address_revoked');
    const rot = await call(ctx, 'POST', '/api/receipt-ingestion/address/rotate', 'old');
    check('rotate is refused the same way (never "u_null")', rot.status === 409 && !(await rot.text()).includes('u_null'));
    check('still one row, still revoked', rows(ctx, 'old').length === 1 && rows(ctx, 'old')[0].status === 'revoked');
  }

  console.log('6. The address really receives receipts; ingestion is otherwise unchanged');
  {
    const ctx = await makeApp();
    const { body } = await getAddress(ctx, 'fresh');
    const msg = await deliver(ctx, body.address);
    check('mail to the new address is accepted', msg.rejections.length === 0);
    const trips = ctx.d1.query(`SELECT user_id, source FROM trips`);
    check('it becomes a ride for THAT user, source receipt_email', trips.length === 1 && trips[0].user_id === 'fresh' && trips[0].source === 'receipt_email');
    const sync = await (await call(ctx, 'GET', '/api/rides/sync-status', 'fresh')).json();
    check('forwarding now reports receiving', sync.forwarding.receiving === true && !!sync.forwarding.last_received_at);

    const unknown = await deliver(ctx, `u_${'0'.repeat(32)}@${DOMAIN}`);
    check('an unknown u_ address is still rejected, writing nothing', unknown.rejections.join() === 'Unknown recipient' && ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 1);
    const shared = await deliver(ctx, `receipts@${DOMAIN}`);
    check('a non-u_ address (e.g. receipts@) is still rejected', shared.rejections.join() === 'Unknown recipient');
  }

  console.log('7. Rider Data page: "Your receipt address"');
  const HTML = fs.readFileSync(`${ROOT}public/rider-data.html`, 'utf8');
  const JS = fs.readFileSync(`${ROOT}public/js/rider-data.js`, 'utf8');
  async function openPage(ctx, userId, intercept) {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/rider-data.html', pretendToBeVisual: true });
    const w = dom.window;
    w.localStorage.setItem('teslaSessionId', `session-${userId}`);
    const requests = [];
    const copied = [];
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async s => { copied.push(s); } }, configurable: true });
    w.fetch = async (u, init = {}) => {
      const path = String(u).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      requests.push({ path, method: init.method || 'GET', auth: (init.headers || {}).Authorization });
      if (intercept) { const x = await intercept(path, init); if (x) return x; }
      return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
    };
    w.eval(JS);
    const d = w.document;
    const page = { w, d, requests, copied,
      vis: id => !d.getElementById(id).classList.contains('hidden'),
      async waitFor(cond, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); } return false; } };
    await page.waitFor(() => page.vis('dataSignedIn') || page.vis('dataError'));
    await page.waitFor(() => !page.vis('fwdLoading'));
    return page;
  }
  {
    const ctx = await makeApp();
    const p = await openPage(ctx, 'fresh');
    const shown = p.d.getElementById('fwdAddress').textContent;
    check('a user with no address sees a newly issued one', p.vis('fwdReady') && ADDRESS_RE.test(shown) && rows(ctx, 'fresh').length === 1 && shown === `u_${rows(ctx, 'fresh')[0].opaque_token}@${DOMAIN}`);
    check('it explains forwarding receipts and optional Gmail auto-forwarding', /Forward a receipt/.test(p.d.getElementById('fwdCard').textContent) && /Gmail/.test(p.d.getElementById('fwdCard').textContent) && /automatically/.test(p.d.getElementById('fwdCard').textContent));
    check('it says no receipt has arrived yet', /No receipt has arrived/.test(p.d.getElementById('fwdReceiving').textContent));
    check('the requests carry only the caller\'s session, never a user id', p.requests.filter(r => r.path.startsWith('/api/receipt-ingestion') || r.path.startsWith('/api/rides/sync-status')).every(r => r.auth === 'Bearer session-fresh' && !/user_?id|=fresh|=old/i.test(r.path)));

    p.d.getElementById('fwdCopyBtn').click();
    await p.waitFor(() => p.copied.length === 1 && /Copied/.test(p.d.getElementById('fwdCopyBtn').textContent));
    check('Copy puts exactly the address on the clipboard', p.copied[0] === shown && /Copied/.test(p.d.getElementById('fwdCopyBtn').textContent));

    check('a full page load requests the address exactly once, with no click needed', p.requests.filter(r => r.path === '/api/receipt-ingestion/address').length === 1);

    const again = await openPage(ctx, 'fresh');
    check('reopening shows the same address (no new one)', again.d.getElementById('fwdAddress').textContent === shown && rows(ctx, 'fresh').length === 1);
    const other = await openPage(ctx, 'old');
    check('another user sees only their own address', other.d.getElementById('fwdAddress').textContent === ctx.addressFor('old') && !other.d.body.textContent.includes(shown));
  }
  {
    // An expired/invalid session: the page shows signed-out and never asks for (or creates) an address.
    const ctx = await makeApp();
    const p = await openPage(ctx, 'expired-session-user');
    check('an invalid session sees the signed-out state', p.vis('dataSignedOut') && !p.vis('dataSignedIn'));
    check('and no address is requested or created', !p.requests.some(r => r.path.startsWith('/api/receipt-ingestion')) && ctx.d1.query('SELECT COUNT(*) n FROM receipt_ingestion_addresses')[0].n === 1);
  }
  {
    // Removing a ride refreshes the data without reloading the address card.
    const ctx = await makeApp();
    const to = ctx.addressFor('old');
    await worker.email(inboundMessage(eml({ to, body: receiptBody() }), to), ctx.env, {});
    await worker.email(inboundMessage(eml({ to, body: receiptBody({ date: 'June 10, 2026' }) }), to), ctx.env, {});
    const p = await openPage(ctx, 'old');
    await p.waitFor(() => p.d.querySelectorAll('#ridesBody tr').length === 2);
    const addrCalls = () => p.requests.filter(r => r.path === '/api/receipt-ingestion/address').length;
    const shownBefore = p.d.getElementById('fwdAddress').textContent;
    p.d.querySelector('#ridesBody tr button[data-action="ask-remove"]').click();
    await p.waitFor(() => !!p.d.querySelector('#ridesBody button[data-action="confirm-remove"]'));
    p.d.querySelector('#ridesBody button[data-action="confirm-remove"]').click();
    await p.waitFor(() => p.d.querySelectorAll('#ridesBody tr').length === 1);
    await new Promise(r => setTimeout(r, 50));
    check('after removing a ride, the address is not re-requested and never leaves the ready state', addrCalls() === 1 && p.vis('fwdReady') && !p.vis('fwdLoading') && p.d.getElementById('fwdAddress').textContent === shownBefore);
  }
  {
    // A Gmail confirmation code that arrived at the address is shown.
    const ctx = await makeApp();
    ctx.d1.exec(`UPDATE receipt_ingestion_addresses SET forwarding_code = '123456789', forwarding_code_received_at = datetime('now') WHERE user_id = 'old'`);
    const p = await openPage(ctx, 'old');
    check('the Gmail confirmation code is shown when one has arrived', p.vis('fwdCodeBox') && p.d.getElementById('fwdCode').textContent === '123456789');
  }
  {
    // Failure handling: the address section fails on its own.
    const ctx = await makeApp();
    let fail = true;
    const p = await openPage(ctx, 'fresh', async path => (fail && path.startsWith('/api/receipt-ingestion/address') ? new Response('{}', { status: 500 }) : null));
    check('a server error shows a retry, and the rest of Rider Data still loads', p.vis('fwdError') && !p.vis('fwdReady') && p.vis('dataSignedIn') && !p.vis('dataError'));
    fail = false;
    p.d.getElementById('fwdRetry').click();
    await p.waitFor(() => p.vis('fwdReady'));
    check('Try again then shows the address', p.vis('fwdReady') && ADDRESS_RE.test(p.d.getElementById('fwdAddress').textContent));

    const noClip = await openPage(ctx, 'fresh');
    Object.defineProperty(noClip.w.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
    noClip.d.getElementById('fwdCopyBtn').click();
    await noClip.waitFor(() => /Selected/.test(noClip.d.getElementById('fwdCopyBtn').textContent));
    check('without clipboard access, Copy selects the address instead', /Selected/.test(noClip.d.getElementById('fwdCopyBtn').textContent) && noClip.w.getSelection().toString() === noClip.d.getElementById('fwdAddress').textContent);

    ctx.d1.exec(`UPDATE receipt_ingestion_addresses SET status = 'revoked' WHERE user_id = 'old'`);
    const revoked = await openPage(ctx, 'old');
    check('a revoked address shows "turned off", not an address or an error', revoked.vis('fwdRevoked') && !revoked.vis('fwdReady') && !revoked.vis('fwdError'));
  }
  {
    // The Gmail forwarding instructions, as rendered for a signed-in rider.
    const ctx = await makeApp();
    const p = await openPage(ctx, 'old');
    const card = p.d.getElementById('fwdCard').textContent.replace(/\s+/g, ' ');
    const steps = [...p.d.querySelectorAll('#fwdGmailSteps ol > li')].map(li => li.textContent.replace(/\s+/g, ' '));
    check('the wrong sender filter (robotaxi@tesla.com) is gone from the page and its script', !/robotaxi@tesla\.com/i.test(HTML + JS));
    check('the filter uses the receipt subject: subject:"Robotaxi Ride Receipt"', card.includes('subject:"Robotaxi Ride Receipt"'));
    // Real Tesla receipts are "Robotaxi Ride Receipt on <date>" (the fixture below
    // is modeled on the real Sep 26 receipt; the real Jun 9 one reads the same).
    const realSubject = (fs.readFileSync(`${ROOT}tests/fixtures/tesla-receipt-quoted-forward.eml`, 'utf8').match(/^Subject: (.*)$/m) || [])[1] || '';
    check('that phrase is in the real-format receipt subject', realSubject.includes('Robotaxi Ride Receipt'));
    check('it says Cybercab Hunter never reads the inbox and receipts go to the rider first', /never reads your inbox/.test(card) && /Tesla emails each Robotaxi receipt to your own inbox/.test(card));
    check('it says a ride only arrives when the receipt is forwarded (by hand or by Gmail)', /appears here only when its receipt is forwarded/.test(card));
    check('it says adding the address alone does not forward anything', /Adding the address in Gmail doesn't forward anything by itself/.test(card));
    check('the Gmail steps run in order: add → confirmation code → verify → test search → create filter → Forward it to + save', steps.length === 6
      && /Add a forwarding address/.test(steps[0]) && /confirmation code/.test(steps[1]) && /verify the address/.test(steps[2])
      && /Test the search first/.test(steps[3]) && /Create filter/.test(steps[4]) && /Forward it to/.test(steps[5]) && /Create filter/.test(steps[5]));
    check('it warns against forwarding all mail (keep Gmail forwarding disabled; the filter forwards only receipts)', /Disable forwarding/.test(steps[2]) && /only receipts/.test(steps[2]));
    check('it explains why not to filter by sender: noreply@tesla.com and relays like DuckDuckGo', /noreply@tesla\.com/.test(card) && /DuckDuckGo Email Protection/.test(card));
    check('it says old receipts are not forwarded by the filter', /doesn't forward receipts already in your inbox/.test(card));
    check('manual forwarding is still offered, including for older receipts', /Forward a receipt/.test(card) && /forward it to the address above/.test(card) && /including for older receipts/.test(card));
    check('the private address, Copy button and confirmation-code box are still there', p.vis('fwdReady') && p.d.getElementById('fwdAddress').textContent === ctx.addressFor('old') && !!p.d.getElementById('fwdCopyBtn') && !!p.d.getElementById('fwdCodeBox'));
    check('no Gmail API / inbox-scanning language is introduced', !/Gmail API|connect (your )?Gmail|sign in (with|to) Gmail|we (scan|read|check|poll)|scans your|syncs? (with )?your (Gmail|inbox)|automatically (imports?|scans?|detects?)/i.test(card));
  }
  {
    // The markup: mobile-friendly and never truncating the address.
    const d = new JSDOM(HTML).window.document;
    const code = d.getElementById('fwdAddress');
    check('the address wraps rather than being cut off (break-all, no truncate)', /break-all/.test(code.className) && !/truncate/.test(code.className));
    check('address and Copy stack on narrow screens, side by side from sm up', /flex-col/.test(code.parentElement.className) && /sm:flex-row/.test(code.parentElement.className));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
