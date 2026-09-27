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

  console.log('7. Rider Data page: the receipt-address section is removed (the API above is unchanged)');
  {
    const HTML = fs.readFileSync(`${ROOT}public/rider-data.html`, 'utf8');
    const JS = fs.readFileSync(`${ROOT}public/js/rider-data.js`, 'utf8');
    const d = new JSDOM(HTML).window.document;
    check('no receipt-address card, address, Copy button, Gmail forwarding steps or code box', ['fwdCard', 'fwdAddress', 'fwdCopyBtn', 'fwdGmailSteps', 'fwdCodeBox'].every(id => d.getElementById(id) === null));
    check('none of its text remains', !/Your receipt address|Forward a receipt|forward new receipts automatically|Robotaxi Ride Receipt"\s*<\/code>|Disable forwarding/.test(HTML));
    check('the page script no longer requests or creates the address', !/receipt-ingestion\/address|rides\/sync-status|loadForwarding|setupForwarding/.test(JS));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
