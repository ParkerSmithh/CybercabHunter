// Phase 2 — the receipt-sync APIs through the real router (worker/index.js):
// authentication on every new route, import validation, sync status,
// deletion (and what it must NOT delete), and cross-user isolation. Real SQL.
// Run: node tests/phase2-api.test.mjs

import worker from '../worker/index.js';
import { makeEnv, makeCheck, seedRide, seedVehicle } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';

const t = makeCheck();
const { check } = t;

async function withSessions(opts) {
  const ctx = await makeEnv(opts);
  ctx.sessionFor = async userId => {
    const id = `session-${userId}`;
    await ctx.env.TESLA_SESSIONS.put(`session:${id}`, JSON.stringify({ user_id: userId }));
    return id;
  };
  ctx.call = async (method, path, { userId, body } = {}) => {
    const headers = { Origin: 'https://cybercabhunter.com' };
    if (userId) headers.Authorization = `Bearer ${await ctx.sessionFor(userId)}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ctx.env, {});
    let json = null;
    try { json = await resp.clone().json(); } catch (e) { /* not json */ }
    return { status: resp.status, json, resp };
  };
  ctx.email = async (userId, opts) => {
    const to = ctx.addressFor(userId);
    await handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
  };
  return ctx;
}

async function run() {
  console.log('1. Every new route requires a session — nothing is reachable anonymously');
  {
    const ctx = await withSessions();
    const routes = [
      ['GET', '/api/trips'], ['DELETE', '/api/trips'], ['DELETE', '/api/trips/anything'],
      ['POST', '/api/rides/import'], ['GET', '/api/rides/sync-status'], ['GET', '/api/profile'], ['POST', '/oauth/tesla/link']
    ];
    for (const [method, path] of routes) {
      const r = await ctx.call(method, path, { body: method === 'GET' ? undefined : {} });
      check(`${method} ${path} -> 401 without a session`, r.status === 401);
    }
    const bogus = await worker.fetch(new Request('https://x/api/trips', { headers: { Authorization: 'Bearer not-a-session' } }), ctx.env, {});
    check('an unknown session id is rejected too', bogus.status === 401);
  }

  console.log('2. Import: input validation');
  {
    const ctx = await withSessions();
    const post = body => ctx.call('POST', '/api/rides/import', { userId: 'u1', body });
    check('no items -> 400', (await post({ items: [] })).status === 400);
    check('missing items -> 400', (await post({})).status === 400);
    check('unknown kind -> 400', (await post({ items: [{ kind: 'pdf', content: 'x' }] })).status === 400);
    check('empty content -> 400', (await post({ items: [{ kind: 'text', content: '   ' }] })).status === 400);
    check('non-string content -> 400', (await post({ items: [{ kind: 'text', content: 42 }] })).status === 400);
    check('more than 25 items -> 400', (await post({ items: Array.from({ length: 26 }, () => ({ kind: 'text', content: 'x' })) })).status === 400);
    const badJson = await worker.fetch(new Request('https://x/api/rides/import', { method: 'POST', headers: { Authorization: `Bearer ${await ctx.sessionFor('u1')}` }, body: '{not json' }), ctx.env, {});
    check('malformed JSON -> 400', badJson.status === 400);
    check('a rejected request creates nothing (no run, no ride)', ctx.d1.query('SELECT COUNT(*) n FROM ride_sync_runs')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0);
  }

  console.log('3. Import through the router creates rides for the SESSION user only, whatever the body claims');
  {
    const ctx = await withSessions({ users: ['u1', 'u2'] });
    const r = await ctx.call('POST', '/api/rides/import', { userId: 'u1', body: { user_id: 'u2', userId: 'u2', items: [{ kind: 'text', content: receiptBody() }] } });
    check('import succeeded', r.status === 200 && r.json.run.added === 1);
    check('the ride belongs to the signed-in user, not the id in the body', ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 1 && ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u2'")[0].n === 0);
  }

  console.log('4. Sync status: three separate facts, and honesty about what is actually happening');
  {
    const ctx = await withSessions();
    // A user with NO address yet: nothing is claimed.
    const fresh = await withSessions({ users: [] });
    fresh.d1.exec(`INSERT INTO users (id) VALUES ('nobody')`);
    const bare = await fresh.call('GET', '/api/rides/sync-status', { userId: 'nobody' });
    check('no address issued: forwarding is not claimed', bare.json.forwarding.address_issued === false && bare.json.forwarding.address === null && bare.json.forwarding.receiving === false);
    check('no rides received yet', bare.json.receipt_sync.totals.added === 0 && bare.json.receipt_sync.last_run === null && bare.json.receipt_sync.last_ride_received_at === null);

    // Address issued but nothing received: still NOT "receiving".
    let s = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('address issued but no mail has arrived: address_issued true, receiving FALSE', s.forwarding.address_issued === true && s.forwarding.receiving === false);
    check('the address is a full working address when a domain is configured', s.forwarding.address === ctx.addressFor('u1') && s.forwarding.domain_configured === true);

    // A pasted/imported receipt is NOT evidence that email forwarding works.
    await ctx.call('POST', '/api/rides/import', { userId: 'u1', body: { items: [{ kind: 'text', content: receiptBody() }] } });
    s = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('an imported ride does NOT flip "receiving" (forwarding unproven)', s.forwarding.receiving === false);
    check('but the import is counted as rides added, from import', s.receipt_sync.rides_from_import === 1 && s.receipt_sync.rides_from_email === 0 && s.receipt_sync.totals.added === 1);

    // A real forwarded email does.
    await ctx.email('u1', { body: receiptBody({ date: 'June 12, 2026' }), date: sentAt(0) });
    s = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('a receipt that arrived by email flips receiving to true', s.forwarding.receiving === true && s.receipt_sync.rides_from_email === 1);
    check('last run details are reported', s.receipt_sync.last_run.source === 'receipt_email' && s.receipt_sync.last_run.added === 1 && s.receipt_sync.last_run.status === 'completed');
    check('last_ride_received_at is set', !!s.receipt_sync.last_ride_received_at);
    check('totals across runs: 2 added, 0 errors', s.receipt_sync.totals.added === 2 && s.receipt_sync.totals.errors === 0);

    // Duplicates are reported as such.
    await ctx.email('u1', { body: receiptBody({ date: 'June 12, 2026' }) });
    s = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('a repeat delivery shows up as an ignored duplicate', s.receipt_sync.totals.duplicates === 1 && s.receipt_sync.totals.added === 2);

    // Forwarding is proven by ANY recognised receipt arriving by email — even one
    // for a ride that was already imported (so it is only a duplicate).
    const only = await withSessions();
    await only.call('POST', '/api/rides/import', { userId: 'u1', body: { items: [{ kind: 'text', content: receiptBody() }] } });
    check('imported only: receiving is false', (await only.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json.forwarding.receiving === false);
    await only.email('u1', { body: receiptBody() });
    const afterDup = (await only.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('the same ride arriving by email (a duplicate) still proves forwarding works', afterDup.forwarding.receiving === true);
    check('but no ride is added by that duplicate: still 1 added, from import', afterDup.receipt_sync.totals.added === 1 && afterDup.receipt_sync.rides_from_email === 0 && afterDup.receipt_sync.rides_from_import === 1);

    // Receipts that arrived by email BEFORE sync runs existed are still evidence (last_received_at).
    const legacy = await withSessions();
    legacy.d1.exec(`UPDATE receipt_ingestion_addresses SET last_received_at = '2026-09-18 00:49:18'`);
    const lg = (await legacy.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('mail received before sync runs were recorded still counts as receiving', lg.forwarding.receiving === true && lg.receipt_sync.totals.added === 0);

    // A corrected receipt arriving by email is an update, not an addition
    // (both copies carry their own send time, so their order is known).
    await ctx.email('u1', { body: receiptBody({ date: 'June 12, 2026', fare: '$9.99' }), date: sentAt(20) });
    s = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    check('an updated receipt counts as updated, and is not double-counted as added', s.receipt_sync.totals.updated === 1 && s.receipt_sync.totals.added === 2 && s.receipt_sync.rides_from_email === 1);

    // Nothing about Tesla's ride API is claimed anywhere.
    check("the status never claims a Tesla ride API", !/fleet|tesla ride sync/i.test(JSON.stringify(s)));
  }

  console.log('5. Sync status: the Gmail confirmation code is shown only to its own rider');
  {
    const ctx = await withSessions({ users: ['u1', 'u2'] });
    await ctx.email('u1', { from: 'forwarding-noreply@google.com', subject: 'Gmail Forwarding Confirmation - Receive Mail from a@b.com', body: 'Confirmation code: 555444333' });
    const mine = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u1' })).json;
    const theirs = (await ctx.call('GET', '/api/rides/sync-status', { userId: 'u2' })).json;
    check('u1 sees their confirmation code', mine.forwarding.confirmation_code === '555444333');
    check("u2 does not see u1's code", theirs.forwarding.confirmation_code === null);
  }

  console.log('6. Deleting one ride: own ride only, and never the public vehicle');
  {
    const ctx = await withSessions({ users: ['u1', 'u2'] });
    await ctx.email('u1', { body: receiptBody() });
    await ctx.email('u2', { body: receiptBody() });
    const u1Trip = ctx.d1.query("SELECT id FROM trips WHERE user_id = 'u1'")[0].id;
    const u2Trip = ctx.d1.query("SELECT id FROM trips WHERE user_id = 'u2'")[0].id;

    const cross = await ctx.call('DELETE', `/api/trips/${u2Trip}`, { userId: 'u1' });
    check("u1 cannot delete u2's ride: 404, not 403 (no existence leak)", cross.status === 404);
    check("u2's ride is untouched", ctx.d1.query('SELECT COUNT(*) n FROM trips WHERE id = ?', u2Trip)[0].n === 1);

    const mine = await ctx.call('DELETE', `/api/trips/${u1Trip}`, { userId: 'u1' });
    check('u1 deletes their own ride', mine.status === 200 && mine.json.success === true);
    check('the ride, its submission and its ingestion audit rows are gone', ctx.d1.query('SELECT COUNT(*) n FROM trips WHERE id = ?', u1Trip)[0].n === 0 && ctx.d1.query("SELECT COUNT(*) n FROM submissions WHERE user_id = 'u1'")[0].n === 0 && ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestions WHERE user_id = 'u1' AND status IN ('accepted','needs_review')")[0].n === 0);
    check('the PUBLIC robotaxi vehicle is NOT deleted (u2 still rode it)', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
    check("u2's stats still include the vehicle", ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u2' AND robotaxi_vehicle_id IS NOT NULL")[0].n === 1);

    // After deletion the same receipt can come back in.
    await ctx.email('u1', { body: receiptBody() });
    check('re-forwarding the deleted ride recreates it (deleted rides are not "remembered" as duplicates)', ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 1);
  }

  console.log('7. Deleting everything requires explicit confirmation and removes only that rider\'s private data');
  {
    const ctx = await withSessions({ users: ['u1', 'u2'] });
    for (const d of ['June 9, 2026', 'June 10, 2026']) await ctx.email('u1', { body: receiptBody({ date: d }) });
    await ctx.email('u2', { body: receiptBody() });
    ctx.d1.exec(`UPDATE submissions SET evidence_ref = 'receipts/u1/file.pdf' WHERE user_id = 'u1'`);
    await ctx.env.EVIDENCE_BUCKET.put('receipts/u1/file.pdf', 'pdf-bytes');

    const noConfirm = await ctx.call('DELETE', '/api/trips', { userId: 'u1', body: {} });
    check('without the confirmation token nothing is deleted', noConfirm.status === 400 && ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 2);
    const wrong = await ctx.call('DELETE', '/api/trips', { userId: 'u1', body: { confirm: 'yes' } });
    check('a wrong confirmation value is refused', wrong.status === 400);

    const ok = await ctx.call('DELETE', '/api/trips', { userId: 'u1', body: { confirm: 'delete-all-rides' } });
    check('confirmed: all of u1\'s rides deleted', ok.status === 200 && ok.json.deleted === 2 && ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u1'")[0].n === 0);
    check("u1's ingestion audit rows and sync runs are gone", ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestions WHERE user_id = 'u1'")[0].n === 0 && ctx.d1.query("SELECT COUNT(*) n FROM ride_sync_runs WHERE user_id = 'u1'")[0].n === 0);
    check("u1's stored receipt evidence file is removed too", !ctx.env.EVIDENCE_BUCKET._objects.has('receipts/u1/file.pdf'));
    check("u2's ride, submission and history are untouched", ctx.d1.query("SELECT COUNT(*) n FROM trips WHERE user_id = 'u2'")[0].n === 1 && ctx.d1.query("SELECT COUNT(*) n FROM ride_sync_runs WHERE user_id = 'u2'")[0].n === 1);
    check('the public robotaxi vehicle registry is intact', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
    check("u1's forwarding address survives (only ride data was deleted)", ctx.d1.query("SELECT COUNT(*) n FROM receipt_ingestion_addresses WHERE user_id = 'u1'")[0].n === 1);
  }

  console.log('8. Deleting a ride that legacy duplicates point at takes the duplicates with it (no zombie rides, no constraint error)');
  {
    const ctx = await withSessions();
    const d1 = ctx.d1;
    seedVehicle(d1, { id: 'v1', plate: 'XJR2195' });
    const key = 'v1|2026-06-09|13:04|XJR2195';
    seedRide(d1, { id: 'canon', vehicleId: 'v1', rideKey: key, createdAt: '2026-09-17 10:00:00' });
    seedRide(d1, { id: 'dupA', vehicleId: 'v1', rideKey: key, supersededBy: 'canon', createdAt: '2026-09-17 11:00:00' });
    seedRide(d1, { id: 'dupB', vehicleId: 'v1', rideKey: key, supersededBy: 'canon', createdAt: '2026-09-17 12:00:00' });
    const r = await ctx.call('DELETE', '/api/trips/canon', { userId: 'u1' });
    check('the delete succeeds', r.status === 200);
    check('canonical ride and both duplicates are gone', d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0);
    check('their submissions are gone too', d1.query('SELECT COUNT(*) n FROM submissions')[0].n === 0);

    // and through the older submissions endpoint's db path
    seedRide(d1, { id: 'canon2', vehicleId: 'v1', rideKey: key, createdAt: '2026-09-17 10:00:00' });
    seedRide(d1, { id: 'dup2A', vehicleId: 'v1', rideKey: key, supersededBy: 'canon2', createdAt: '2026-09-17 11:00:00' });
    seedRide(d1, { id: 'dup2B', vehicleId: 'v1', rideKey: key, supersededBy: 'canon2', createdAt: '2026-09-17 12:00:00' });
    const { db } = await import('../worker/db.js');
    await db.deleteSubmission(d1, 'sub-canon2', 'u1');
    check('deleteSubmission on the canonical ride also removes its duplicates cleanly', d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0);
  }

  console.log('9. CORS: the new methods are allowed for the site origin');
  {
    const ctx = await withSessions();
    const pre = await worker.fetch(new Request('https://x/api/trips', { method: 'OPTIONS', headers: { Origin: 'https://cybercabhunter.com' } }), ctx.env, {});
    check('preflight allows DELETE and POST', /DELETE/.test(pre.headers.get('Access-Control-Allow-Methods')) && /POST/.test(pre.headers.get('Access-Control-Allow-Methods')));
    const authed = await ctx.call('GET', '/api/trips', { userId: 'u1' });
    check('responses carry the CORS header for the site origin', authed.resp.headers.get('Access-Control-Allow-Origin') === 'https://cybercabhunter.com');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
