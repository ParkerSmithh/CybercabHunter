import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { makeEnv } from './helpers/env.mjs';
import worker from '../worker/index.js';

const PATH = '/api/moderation/forwarding-stats';
const HTML = fs.readFileSync(new URL('../public/moderation.html', import.meta.url), 'utf8');
const JS = fs.readFileSync(new URL('../public/js/moderation.js', import.meta.url), 'utf8');
const keys = ['addresses_issued', 'setup_completed', 'actively_receiving', 'receiving_7d', 'linked_30d', 'receipts_processed'];
const empty = Object.fromEntries(keys.map(key => [key, 0]));

async function fixture(users = ['mod', 'rider']) {
  const ctx = await makeEnv({ users });
  ctx.d1.exec("UPDATE users SET role = 'moderator' WHERE id = 'mod'");
  for (const user of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${user}`, JSON.stringify({ user_id: user }));
  return ctx;
}
const call = (ctx, user) => worker.fetch(new Request(`https://x${PATH}`, { headers: user ? { Authorization: `Bearer session-${user}` } : {} }), ctx.env, {});

test('forwarding stats reuse moderator authorization and never return rider data', async () => {
  const ctx = await fixture();
  assert.equal((await call(ctx)).status, 401);
  assert.equal((await call(ctx, 'invalid')).status, 401);
  const denied = await call(ctx, 'rider');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'forbidden');
  const response = await call(ctx, 'mod');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), { ...empty, addresses_issued: 2 });
  ctx.d1.exec('DELETE FROM receipt_ingestion_addresses');
  assert.deepEqual(await (await call(ctx, 'mod')).json(), empty);
});

test('active/revoked, setup/receipt evidence and inclusive time boundaries count independently', async () => {
  const users = ['mod', 'unstarted', 'setupOnly', 'receiptOnly', 'recent', 'stale', 'edge', 'justOutside', 'revoked'];
  const ctx = await fixture(users);
  // Fix only SQLite's clock in this test; execute the real endpoint SQL unchanged otherwise.
  const prepare = ctx.d1.prepare;
  ctx.d1.prepare = sql => prepare(sql.replaceAll("datetime('now'", "datetime('2026-10-11 12:00:00'"));
  ctx.d1.exec(`
    UPDATE receipt_ingestion_addresses SET setup_completed_at = '2026-10-10 12:00:00' WHERE user_id = 'setupOnly';
    UPDATE receipt_ingestion_addresses SET last_received_at = '2026-10-10 12:00:00' WHERE user_id = 'receiptOnly';
    UPDATE receipt_ingestion_addresses SET setup_completed_at = '2026-10-10 12:00:00', last_received_at = '2026-10-10 12:00:00' WHERE user_id = 'recent';
    UPDATE receipt_ingestion_addresses SET setup_completed_at = '2026-08-01 12:00:00', last_received_at = '2026-08-01 12:00:00' WHERE user_id = 'stale';
    UPDATE receipt_ingestion_addresses SET setup_completed_at = datetime('2026-10-11 12:00:00', '-30 days'), last_received_at = datetime('2026-10-11 12:00:00', '-7 days') WHERE user_id = 'edge';
    UPDATE receipt_ingestion_addresses SET setup_completed_at = datetime('2026-10-11 12:00:00', '-30 days', '-1 second'), last_received_at = datetime('2026-10-11 12:00:00', '-7 days', '-1 second') WHERE user_id = 'justOutside';
    UPDATE receipt_ingestion_addresses SET status = 'revoked', setup_completed_at = '2026-10-11 12:00:00', last_received_at = '2026-10-11 12:00:00' WHERE user_id = 'revoked';
    INSERT INTO receipt_ingestions (id, user_id, status) VALUES ('receipt-1', 'recent', 'accepted'), ('receipt-2', 'revoked', 'duplicate'), ('receipt-3', 'unstarted', 'parse_error');
  `);
  const data = await (await call(ctx, 'mod')).json();
  assert.deepEqual(data, { addresses_issued: 8, setup_completed: 5, actively_receiving: 5, receiving_7d: 3, linked_30d: 3, receipts_processed: 3 });
  assert.deepEqual(Object.keys(data).sort(), keys.toSorted());
  assert(Object.values(data).every(Number.isInteger));
});

async function open(ctx, user = 'mod', intercept) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://cybercabhunter.com/moderation' });
  const w = dom.window;
  if (user) w.localStorage.setItem('teslaSessionId', `session-${user}`);
  const requests = [];
  w.CCC = { toast() {}, enterList() {} };
  w.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === PATH && intercept) return intercept();
    return worker.fetch(new Request(`https://x${path}`, options), ctx.env, {});
  };
  w.eval(JS);
  const d = w.document;
  const visible = id => !d.getElementById(id).classList.contains('hidden');
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('UI did not reach expected state');
  };
  return { w, d, visible, requests, until };
}

test('panel shows a skeleton, six formatted counts, and refreshes only when visible', async () => {
  const ctx = await fixture();
  let resolve;
  let reply = () => new Promise(done => { resolve = done; });
  const page = await open(ctx, 'mod', () => reply());
  try {
    await page.until(() => !!resolve && page.visible('modQueue'));
    assert(page.visible('modForwardingStatsLoading'));
    assert(!page.visible('modForwardingStatsValues'));
    const values = { addresses_issued: 1234, setup_completed: 22, actively_receiving: 19, receiving_7d: 13, linked_30d: 10, receipts_processed: 5678 };
    resolve(Response.json({ ...values, email: 'private@example.com', address: 'u_secret@example.com', plate: 'SECRET123' }));
    await page.until(() => page.visible('modForwardingStatsValues'));
    assert(!page.visible('modForwardingStatsLoading'));
    assert.deepEqual([...page.d.querySelectorAll('[data-forwarding-stat]')].map(el => el.textContent), ['1,234', '22', '19', '13', '10', '5,678']);
    assert.deepEqual([...page.d.querySelectorAll('#modForwardingStats dt')].map(el => el.textContent), ['Addresses issued', 'Setup completed', 'Actively receiving', 'Receiving (7d)', 'Linked (30d)', 'Receipts processed']);
    assert(!/private@example|u_secret|SECRET123/.test(page.d.body.textContent));
    assert.match(page.d.getElementById('modForwardingStats').textContent, /Linked means setup completed.*Actively receiving means at least one forwarded receipt/);
    let hidden = true;
    Object.defineProperty(page.d, 'hidden', { get: () => hidden });
    const before = page.requests.filter(path => path === PATH).length;
    page.d.dispatchEvent(new page.w.Event('visibilitychange'));
    assert.equal(page.requests.filter(path => path === PATH).length, before);
    reply = () => Response.json({ ...values, addresses_issued: 1235 });
    hidden = false;
    page.d.dispatchEvent(new page.w.Event('visibilitychange'));
    await page.until(() => page.d.querySelector('[data-forwarding-stat]').textContent === '1,235');
    assert.equal(page.requests.filter(path => path === PATH).length, before + 1);
  } finally { page.w.close(); }
});

test('fetch failure or invalid counts show an error and retry recovers', async () => {
  for (const broken of [() => { throw new Error('offline'); }, () => Response.json({}, { status: 500 }), () => Response.json({ ...empty, setup_completed: '<img src=x onerror=alert(1)>' })]) {
    const ctx = await fixture();
    let reply = broken;
    const page = await open(ctx, 'mod', () => reply());
    try {
      await page.until(() => page.visible('modForwardingStatsError') && page.visible('modQueue'));
      assert(!page.visible('modForwardingStatsValues'));
      assert(!page.visible('modForwardingStatsLoading'));
      assert([...page.d.querySelectorAll('[data-forwarding-stat]')].every(el => el.textContent === ''));
      reply = () => Response.json(empty);
      page.d.getElementById('modForwardingStatsRetry').click();
      await page.until(() => page.visible('modForwardingStatsValues'));
      assert([...page.d.querySelectorAll('[data-forwarding-stat]')].every(el => el.textContent === '0'));
    } finally { page.w.close(); }
  }
});

test('signed-out and ordinary users cannot fetch or render numbers; revoked access clears old counts', async () => {
  const ctx = await fixture();
  for (const user of [null, 'rider']) {
    const page = await open(ctx, user);
    try {
      await page.until(() => page.visible(user ? 'modForbidden' : 'modSignedOut'));
      assert(!page.visible('modQueue'));
      assert(!page.requests.includes(PATH));
      assert([...page.d.querySelectorAll('[data-forwarding-stat]')].every(el => el.textContent === ''));
    } finally { page.w.close(); }
  }
  let reply = () => Response.json({ ...empty, addresses_issued: 2 });
  const page = await open(ctx, 'mod', () => reply());
  try {
    await page.until(() => page.visible('modForwardingStatsValues'));
    reply = () => Response.json({ error: 'forbidden' }, { status: 403 });
    page.d.dispatchEvent(new page.w.Event('visibilitychange'));
    await page.until(() => page.visible('modForbidden'));
    assert(!page.visible('modQueue'));
    assert([...page.d.querySelectorAll('[data-forwarding-stat]')].every(el => el.textContent === ''));
  } finally { page.w.close(); }
});
