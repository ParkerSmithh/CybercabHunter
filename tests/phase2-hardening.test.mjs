// Phase 2 hardening/closeout — regression tests for the gaps found in the
// hardening audit: forwarding-address rotation, the /api/rides/import
// request-size boundary, PATCH /api/profile robustness against a malformed
// body, and auth coverage for the legacy Tesla ownerapi/debug routes.
// Real SQL (node:sqlite + the project's migrations) and the real Worker
// router — nothing here is a hand-rolled fake of production behavior.
// Run: node tests/phase2-hardening.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

async function makeApp(users = ['u1']) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  ctx.email = async (userId, opts) => {
    const to = ctx.addressFor(userId);
    await handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
  };
  return ctx;
}

function call(ctx, method, path, { userId, body, headers } = {}) {
  const h = { Origin: 'https://cybercabhunter.com', ...(headers || {}) };
  if (userId) h.Authorization = `Bearer session-${userId}`;
  return worker.fetch(new Request(`https://x${path}`, { method, headers: h, body }), ctx.env, {});
}

async function run() {
  console.log('1. Forwarding-address rotation — the UNIQUE(user_id) index used to make this impossible');
  {
    const ctx = await makeApp(['u1', 'u2']);
    const oldToken = ctx.tokens.u1;
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    const tripsBefore = ctx.d1.query("SELECT id FROM trips WHERE user_id = 'u1'");

    const resp = await call(ctx, 'POST', '/api/receipt-ingestion/address/rotate', { userId: 'u1' });
    check('rotation succeeds (200)', resp.status === 200);
    const rotated = await resp.json();
    check('a new address is returned, different from the old one', rotated.address && rotated.address !== `u_${oldToken}@receipts.example.com`);

    const rows = ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0];
    check('still exactly one address row for the rider (the UNIQUE(user_id) index holds)', rows.n === 1);

    const newToken = ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0].opaque_token;
    check('the row was updated in place, not replaced by a second row', `u_${newToken}@receipts.example.com` === rotated.address);

    await ctx.email('u1', { body: receiptBody({ date: 'June 10, 2026' }), date: sentAt(60) });
    const afterOldMail = ctx.d1.query("SELECT id FROM trips WHERE user_id = 'u1'");
    check('mail to the OLD address is rejected once rotated (Unknown recipient — no new ride)', afterOldMail.length === tripsBefore.length);

    const toNew = `u_${newToken}@receipts.example.com`;
    await handleIncomingEmail(inboundMessage(eml({ body: receiptBody({ date: 'June 10, 2026' }), date: sentAt(60), to: toNew }), toNew), ctx.env);
    const afterNewMail = ctx.d1.query("SELECT id FROM trips WHERE user_id = 'u1'");
    check('mail to the NEW address is accepted and attributed to the same rider', afterNewMail.length === tripsBefore.length + 1);

    check("u1's pre-rotation ride and ingestion history are untouched", ctx.d1.query("SELECT id FROM trips WHERE id = ?", tripsBefore[0].id).length === 1);
    check("u2's address is untouched by u1 rotating", ctx.d1.query("SELECT opaque_token FROM receipt_ingestion_addresses WHERE user_id = 'u2'")[0].opaque_token === ctx.tokens.u2);

    const unauth = await call(ctx, 'POST', '/api/receipt-ingestion/address/rotate', {});
    check('rotating without a session is refused (401)', unauth.status === 401);
  }
  {
    const ctx = await makeApp(['u1']);
    const before = ctx.d1.query("SELECT last_received_at, forwarding_code FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0];
    check('precondition: no receipt received yet, no pending code', before.last_received_at === null && before.forwarding_code === null);
    await ctx.email('u1', { body: receiptBody(), date: sentAt(0) });
    const received = ctx.d1.query("SELECT last_received_at FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0];
    check('last_received_at is set once mail actually arrives', received.last_received_at !== null);

    await db.rotateReceiptIngestionAddress(ctx.d1, 'u1');
    const afterRotate = ctx.d1.query("SELECT last_received_at, forwarding_code, forwarding_code_received_at FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0];
    check('rotation clears last_received_at/forwarding_code — they described the OLD address', afterRotate.last_received_at === null && afterRotate.forwarding_code === null && afterRotate.forwarding_code_received_at === null);
  }
  {
    // Rotating a rider who has no address yet behaves like issuing one for
    // the first time, rather than failing.
    const ctx = await makeEnv({ users: [] });
    await ctx.d1.exec(`INSERT INTO users (id, profile_visibility) VALUES ('fresh', 'public')`);
    const token = await db.rotateReceiptIngestionAddress(ctx.d1, 'fresh');
    check('rotating with no prior address issues one', typeof token === 'string' && token.length > 0);
    check('exactly one row exists', ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestion_addresses WHERE user_id = 'fresh'")[0].n === 1);
  }

  console.log('2. /api/rides/import enforces its request-size limit against the real body, not just Content-Length');
  {
    const ctx = await makeApp();
    function streamBody(str) {
      const bytes = new TextEncoder().encode(str);
      return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    }
    // 25 items (the max item COUNT), each just under the per-item cap, so
    // no single item and no item count trips those separate checks — only
    // the whole-body limit can catch this. No Content-Length header at
    // all, matching a chunked-transfer request.
    const items = Array.from({ length: 25 }, () => ({ kind: 'text', content: 'x'.repeat(1_900_000) }));
    const payload = JSON.stringify({ items });
    check('precondition: payload is ~45MB, well past the intended 6MB cap', payload.length > 40 * 1024 * 1024);

    const req = new Request('https://x/api/rides/import', {
      method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-u1' },
      body: streamBody(payload), duplex: 'half'
    });
    check('the request truly carries no Content-Length (the bypass shape)', req.headers.get('content-length') === null);
    const resp = await worker.fetch(req, ctx.env, {});
    check('rejected with 413 before being parsed, despite no Content-Length header', resp.status === 413);
    const json = await resp.json();
    check('reports too_large', json.success === false && json.error === 'too_large');
    check('nothing was written — no sync run was created for it', ctx.d1.query("SELECT COUNT(*) n FROM ride_sync_runs WHERE user_id = 'u1'")[0].n === 0);
  }
  {
    // A legitimate small import (no Content-Length, same as the harness
    // sends for every other test in this suite) must still work.
    const ctx = await makeApp();
    const payload = JSON.stringify({ items: [{ kind: 'text', content: receiptBody() }] });
    const resp = await call(ctx, 'POST', '/api/rides/import', { userId: 'u1', body: payload, headers: { 'Content-Type': 'application/json' } });
    check('a normal-sized import still succeeds', resp.status === 200);
    const json = await resp.json();
    check('the receipt was actually processed', json.run.processed === 1);
  }

  console.log('3. PATCH /api/profile with a malformed or empty JSON body returns 400, never 500');
  {
    const ctx = await makeApp();
    const cases = [
      ['empty body', ''],
      ['literal null', 'null'],
      ['literal number', '42'],
      ['literal array', '[]'],
      ['not json at all', '{not json'],
    ];
    for (const [label, body] of cases) {
      const resp = await call(ctx, 'PATCH', '/api/profile', { userId: 'u1', body, headers: { 'Content-Type': 'application/json' } });
      check(`${label} -> clean 400, not 500 or an uncaught exception`, resp.status === 400);
    }
    const before = ctx.d1.query("SELECT display_name, handle, bio FROM users WHERE id = 'u1'")[0];
    check('none of the malformed bodies changed the stored profile', before.display_name === null && before.handle === null && before.bio === null);

    const ok = await call(ctx, 'PATCH', '/api/profile', { userId: 'u1', body: JSON.stringify({ display_name: 'Alex' }), headers: { 'Content-Type': 'application/json' } });
    check('a genuinely valid body still succeeds', ok.status === 200);
  }

  console.log('5. Legacy routes (ownerapi PKCE flow, Tesla debug capabilities) stay authenticated and expose nothing without a session');
  {
    const ctx = await makeApp(['u1', 'u2']);
    const anonGets = [
      ['GET', '/oauth/robotaxi/start'],
      ['GET', '/api/robotaxi/status'],
      ['GET', '/api/tesla/debug/capabilities']
    ];
    for (const [method, path] of anonGets) {
      const resp = await call(ctx, method, path, {});
      check(`${method} ${path} without a session is refused (401), not served`, resp.status === 401);
    }
    const anonPost = await call(ctx, 'POST', '/api/robotaxi/disconnect', {});
    check('POST /api/robotaxi/disconnect without a session is refused (401)', anonPost.status === 401);

    const status = await call(ctx, 'GET', '/api/robotaxi/status', { userId: 'u1' });
    check('an authenticated rider with no ownerapi connection gets a clean "not connected" status, not an error', status.status === 200);
    const statusJson = await status.json();
    check('reports connected: false, never_connected, and nothing else', statusJson.connected === false && statusJson.status === 'never_connected');

    const debug = await call(ctx, 'GET', '/api/tesla/debug/capabilities', { userId: 'u1' });
    check('an authenticated rider with no Fleet API connection is told so, not served stale/other data', debug.status === 409);

    // Seed a connection for u2 only, then confirm u1 can never see it through
    // these routes — isolation, not just "requires a session".
    await ctx.d1.exec(`
      INSERT INTO robotaxi_owner_connections (id, user_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, status)
      VALUES ('conn-u2', 'u2', 'x', 'y', datetime('now', '+1 hour'), 'active')
    `);
    const u1Status = await call(ctx, 'GET', '/api/robotaxi/status', { userId: 'u1' });
    const u1Json = await u1Status.json();
    check("u1's status is unaffected by u2's connection", u1Json.connected === false);
    const u2Status = await call(ctx, 'GET', '/api/robotaxi/status', { userId: 'u2' });
    const u2Json = await u2Status.json();
    check("u2 sees their own connection as connected", u2Json.connected === true);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
