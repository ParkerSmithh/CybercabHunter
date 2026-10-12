import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEnv } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

async function fixture() {
  const ctx = await makeEnv({ users: ['rider', 'other'] });
  await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));
  ctx.row = () => ctx.d1.query("SELECT * FROM receipt_ingestion_addresses WHERE user_id = 'rider'")[0];
  ctx.deliver = async (address = ctx.addressFor('rider'), body = receiptBody()) => handleIncomingEmail(inboundMessage(eml({ to: address, body }), address), ctx.env);
  ctx.call = (path, method = 'GET') => worker.fetch(new Request('https://x' + path, { method, headers: { Authorization: 'Bearer session-rider' } }), ctx.env, {});
  return ctx;
}

test('first forwarded receipt completes setup atomically without any Done POST', async () => {
  const ctx = await fixture();
  assert.equal(ctx.row().setup_completed_at, null);
  const address = ctx.addressFor('rider');
  await handleIncomingEmail(inboundMessage(eml({ to: address, from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation', body: 'Confirmation code: 482913775' }), address), ctx.env);
  assert.equal(ctx.row().forwarding_code, '482913775');
  assert.equal(ctx.row().setup_completed_at, null);
  await ctx.deliver();
  const row = ctx.row();
  assert(row.setup_completed_at);
  assert.equal(row.setup_completed_at, row.last_received_at);
  assert.equal(row.forwarding_code, null);
  assert.equal(row.forwarding_link, null);
  const response = await ctx.call('/api/rides/sync-status');
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.forwarding.setup_completed_at, row.setup_completed_at);
  assert.equal(status.forwarding.receiving, true);
  assert.equal(ctx.d1.query("SELECT setup_completed_at FROM receipt_ingestion_addresses WHERE user_id = 'other'")[0].setup_completed_at, null);
});

test('repeated receipts and the Done endpoint preserve the original completion time', async () => {
  const ctx = await fixture();
  await ctx.deliver();
  // Advance only the subsequent SQL clock, without a sleep or changing production code.
  const first = ctx.row().setup_completed_at;
  const prepare = ctx.d1.prepare;
  ctx.d1.prepare = sql => prepare(sql.replaceAll("datetime('now')", "datetime('now', '+1 hour')"));
  await ctx.deliver();
  assert.equal(ctx.row().setup_completed_at, first);
  assert.notEqual(ctx.row().last_received_at, first);
  assert.equal((await ctx.call('/api/receipt-ingestion/setup/complete', 'POST')).status, 200);
  assert.equal(ctx.row().setup_completed_at, first);
});

test('pre-existing manual setup completion is never overwritten by receipt or Done', async () => {
  const ctx = await fixture();
  ctx.d1.exec("UPDATE receipt_ingestion_addresses SET setup_completed_at = '2026-01-02 03:04:05' WHERE user_id = 'rider'");
  await ctx.deliver();
  assert.equal(ctx.row().setup_completed_at, '2026-01-02 03:04:05');
  assert(ctx.row().last_received_at);
  assert.equal((await ctx.call('/api/receipt-ingestion/setup/complete', 'POST')).status, 200);
  assert.equal(ctx.row().setup_completed_at, '2026-01-02 03:04:05');
});

test('rotation clears completion and only the new address can complete independently', async () => {
  const ctx = await fixture();
  await ctx.deliver();
  const oldAddress = ctx.addressFor('rider');
  const oldToken = ctx.row().opaque_token;
  const rotation = await ctx.call('/api/receipt-ingestion/address/rotate', 'POST');
  assert.equal(rotation.status, 200);
  const newAddress = (await rotation.json()).address;
  assert.notEqual(newAddress, oldAddress);
  assert.equal(ctx.row().setup_completed_at, null);
  assert.equal(ctx.row().last_received_at, null);
  // A receipt resolved before rotation must not update the new address afterward.
  await db.markReceiptReceived(ctx.d1, 'rider', oldToken);
  await ctx.deliver(oldAddress);
  assert.equal(ctx.row().setup_completed_at, null);
  assert.equal(ctx.row().last_received_at, null);
  await ctx.deliver(newAddress);
  assert(ctx.row().setup_completed_at);
  assert.equal(ctx.row().setup_completed_at, ctx.row().last_received_at);
});

test('confirmation messages and unrelated mail do not complete setup', async () => {
  const ctx = await fixture();
  const address = ctx.addressFor('rider');
  await handleIncomingEmail(inboundMessage(eml({ to: address, from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation', body: 'Confirmation code: 482913775' }), address), ctx.env);
  assert.equal(ctx.row().setup_completed_at, null);
  assert.equal(ctx.row().last_received_at, null);
  await handleIncomingEmail(inboundMessage(eml({ to: address, from: 'news@example.com', subject: 'Newsletter', body: 'Unrelated newsletter' }), address), ctx.env);
  assert.equal(ctx.row().setup_completed_at, null);
  assert.equal(ctx.row().last_received_at, null);
});
