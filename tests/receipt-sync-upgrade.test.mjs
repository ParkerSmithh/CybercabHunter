// The mobile receipt sync upgrade's backend: the import preview (nothing
// saved), the rider's recent-imports list, and the opt-in "ride imported"
// notification. Real Worker, real SQL; receipts are sanitized fixtures.
// Run: node tests/receipt-sync-upgrade.test.mjs
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { defaults, validatePreferences, eligible } from '../worker/push-policy.js';
import { collectEvents, eventStillPublic } from '../worker/push-sources.js';
import { runPushTick } from '../worker/push.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

async function app() {
  const ctx = await makeEnv({ users: ['u1', 'u2'] });
  for (const u of ['u1', 'u2']) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}
async function call(ctx, method, path, { who, json } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer s-${who}`;
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, text: JSON.stringify(out), cache: r.headers.get('Cache-Control') };
}
const preview = (ctx, who, text) => call(ctx, 'POST', '/api/rides/import/preview', { who, json: { items: [{ kind: 'text', content: text }] } });
const importText = (ctx, who, text) => call(ctx, 'POST', '/api/rides/import', { who, json: { items: [{ kind: 'text', content: text }] } });
const email = async (ctx, who, body) => { const to = ctx.addressFor(who); await handleIncomingEmail(inboundMessage(eml({ to, body }), to), ctx.env); };
const counts = ctx => ctx.d1.query(`SELECT (SELECT COUNT(*) FROM trips) trips, (SELECT COUNT(*) FROM receipt_ingestions) ingestions, (SELECT COUNT(*) FROM submissions) subs, (SELECT COUNT(*) FROM ride_sync_runs) runs`)[0];

console.log('1. Preview: the same parser, nothing saved');
{
  const ctx = await app();
  check('signed out: 401', (await preview(ctx, null, receiptBody())).status === 401);
  const before = JSON.stringify(counts(ctx));
  const r = await preview(ctx, 'u1', receiptBody());
  check('a clear receipt: would be a new ride', r.status === 200 && r.json.would === 'new');
  check('the fields the import will store', r.json.fields.ride_date === '2026-06-09' && r.json.fields.pickup_time === '13:04' && r.json.fields.dropoff_time === '13:18' && r.json.fields.fare_amount_cents === 692 && r.json.fields.license_plate === 'XJR2195');
  check('pickup and drop-off kept apart', /Hanover/.test(r.json.fields.pickup) && /NorthPark/.test(r.json.fields.dropoff));
  check('time zone from the service area', r.json.fields.timezone === 'America/Chicago');
  check('nothing uncertain on a complete receipt', r.json.uncertain.length === 0);
  check('nothing was written (trips, ingestions, submissions, runs)', JSON.stringify(counts(ctx)) === before);
  check('never cached', /no-store/.test(r.cache));
  const missing = await preview(ctx, 'u1', receiptBody().replace('1:04 pm\n\n', ''));
  check('a missing pickup time: needs details, the time is null (never the drop-off time)', missing.json.would === 'needs_details' && missing.json.fields.pickup_time === null && missing.json.uncertain.includes('pickup_time'));
  check('...and its drop-off time stays the drop-off time', missing.json.fields.dropoff_time === '13:18');
  check('not a receipt: rejected', (await preview(ctx, 'u1', 'Hello, this is a note about lunch on Friday.')).json.would === 'rejected');
  check('more than one item: refused', (await call(ctx, 'POST', '/api/rides/import/preview', { who: 'u1', json: { items: [{ kind: 'text', content: receiptBody() }, { kind: 'text', content: receiptBody() }] } })).status === 400);
  check('malformed body: refused', (await call(ctx, 'POST', '/api/rides/import/preview', { who: 'u1', json: { nope: 1 } })).status === 400);
}

console.log('2. Duplicates across import methods');
{
  const ctx = await app();
  await email(ctx, 'u1', receiptBody());
  check('the forwarded email made one ride', counts(ctx).trips === 1);
  const sameText = await preview(ctx, 'u1', receiptBody());
  check('the same ride scanned or shared later: a known ride, not a new one', ['same_ride', 'duplicate'].includes(sameText.json.would));
  await importText(ctx, 'u1', receiptBody());
  check('importing it anyway still leaves one trip', ctx.d1.query('SELECT COUNT(*) n FROM trips WHERE superseded_by IS NULL')[0].n === 1);
  check("another rider's preview of that receipt is a new ride for them (no cross-account matching)", (await preview(ctx, 'u2', receiptBody())).json.would === 'new');
}

console.log('3. Recent imports');
{
  const ctx = await app();
  check('signed out: 401', (await call(ctx, 'GET', '/api/rides/imports')).status === 401);
  await email(ctx, 'u1', receiptBody());
  await importText(ctx, 'u1', receiptBody({ date: 'June 10, 2026', pickupTime: '9:00 am', dropoffTime: '9:20 am' }));
  await importText(ctx, 'u1', receiptBody().replace('1:04 pm\n\n', ''));
  await importText(ctx, 'u1', receiptBody({ date: 'June 10, 2026', pickupTime: '9:00 am', dropoffTime: '9:20 am' }));
  const r = await call(ctx, 'GET', '/api/rides/imports', { who: 'u1' });
  const list = r.json.imports;
  check('four receipts, newest first', list.length === 4);
  check('sources named in plain terms', list.filter(i => i.source === 'email').length === 1 && list.filter(i => i.source === 'import').length === 3);
  check('results: imported, needs details, duplicate', list.some(i => i.result === 'imported') && list.some(i => i.result === 'needs_details') && list.some(i => i.result === 'duplicate'));
  check('an imported receipt links its ride', list.filter(i => i.result === 'imported').every(i => i.ride && i.ride.id && i.ride.ride_date));
  check('a receipt that made no ride has no ride and a reason', list.find(i => i.result === 'needs_details').ride === null && !!list.find(i => i.result === 'needs_details').error);
  check('no email text, Message-ID or hash', !/msg-|receipt_hash|message_id|Thanks for the ride/.test(r.text));
  check('only my own', (await call(ctx, 'GET', '/api/rides/imports', { who: 'u2' })).json.imports.length === 0);
  check('never cached', /no-store/.test(r.cache));
  for (let i = 0; i < 22; i++) await importText(ctx, 'u1', receiptBody({ date: 'June 11, 2026', pickupTime: `${(i % 11) + 1}:${String(i).padStart(2, '0')} am` }));
  const p1 = (await call(ctx, 'GET', '/api/rides/imports', { who: 'u1' })).json;
  const p2 = (await call(ctx, 'GET', `/api/rides/imports?cursor=${p1.next_cursor}`, { who: 'u1' })).json;
  check('paged by 20, no repeats', p1.imports.length === 20 && !!p1.next_cursor && p2.imports.length === 6 && !p2.imports.some(a => p1.imports.some(b => b.id === a.id)));
  check('a bad cursor: 400', (await call(ctx, 'GET', '/api/rides/imports?cursor=xyz', { who: 'u1' })).status === 400);
}

console.log('4. Ride-imported notifications');
{
  check('off by default', defaults().rides === false && !eligible(defaults(), { category: 'rides' }));
  check('a rider can turn them on', validatePreferences({ rides: true }).rides === true && eligible(validatePreferences({ rides: true }), { category: 'rides' }));
  check('a wrong type is refused', (() => { try { validatePreferences({ rides: 'yes' }); return false; } catch (e) { return true; } })());

  const ctx = await app();
  const now = Date.now();
  await email(ctx, 'u1', receiptBody());
  await importText(ctx, 'u1', receiptBody({ date: 'June 12, 2026' }));
  await email(ctx, 'u1', receiptBody());                                   // the same receipt again
  await email(ctx, 'u1', receiptBody().replace('1:04 pm\n\n', ''));         // no pickup time: no ride
  await collectEvents(ctx.d1, now - 60e3, now + 60e3);
  const events = ctx.d1.query("SELECT * FROM push_events WHERE category = 'rides'");
  check('one event: the automatic import only (not the manual one, the duplicate or the incomplete receipt)', events.length === 1 && events[0].recipient === 'u1');
  const payload = JSON.parse(events[0].payload);
  check('the preview names no address, time or fare', payload.title === 'New Tesla ride imported' && !/Hanover|NorthPark|1:04|6\.92|XJR/.test(events[0].payload) && payload.link === '/rider-data');
  await collectEvents(ctx.d1, now - 60e3, now + 120e3);
  check('collecting again adds nothing (one notice per ride)', ctx.d1.query("SELECT COUNT(*) n FROM push_events WHERE category = 'rides'")[0].n === 1);
  check('still valid while the ride exists', await eventStillPublic(ctx.d1, events[0]));
  check("never for someone else's account", !(await eventStillPublic(ctx.d1, { ...events[0], recipient: 'u2' })));
  ctx.d1.exec(`DELETE FROM trips`);
  check('a removed ride cancels it', !(await eventStillPublic(ctx.d1, events[0])));

  // Delivery: grouped, opt-in, through the real tick with a mocked APNs.
  const d = await app();
  d.env.PUSH_ENABLED = 'true'; d.env.PUSH_DELIVERY_ENABLED = 'true';
  Object.assign(d.env, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_PRIVATE_KEY: 'P', APNS_TOPIC: 'com.cybercabhunter.native' });
  const t0 = Date.now() - 5 * 60e3;
  d.d1.exec(`INSERT INTO push_preferences (user_id, settings, updated_at, initialized_at) VALUES ('u1', '${JSON.stringify({ ...defaults(), rides: true, group: true })}', ${t0}, ${t0})`);
  d.d1.exec(`INSERT INTO push_devices (id, user_id, token, environment, authorized, refreshed_at) VALUES ('12345678-1234-1234-1234-123456789abc', 'u1', '${'a'.repeat(64)}', 'sandbox', 1, ${Date.now()})`);
  d.d1.exec(`INSERT INTO push_state (key, value) VALUES ('activated', '${t0}')`);
  await email(d, 'u1', receiptBody());
  await email(d, 'u1', receiptBody({ date: 'June 13, 2026', pickupTime: '2:00 pm', dropoffTime: '2:20 pm' }));
  const sent = [];
  await runPushTick(d.env, Date.now(), async (env, device, payload) => { sent.push(payload); return { ok: true, status: 200 }; });
  const planned = d.d1.query("SELECT * FROM push_deliveries WHERE category = 'rides'");
  check('two new rides: one summarized notification', planned.length === 1 && JSON.parse(planned[0].payload).title === '2 new Tesla rides imported');
  check('it opens Rider Data', JSON.parse(planned[0].payload).link === '/rider-data');
  d.d1.exec(`UPDATE push_preferences SET settings = '${JSON.stringify({ ...defaults(), rides: false })}' WHERE user_id = 'u1'`);
  await email(d, 'u1', receiptBody({ date: 'June 14, 2026', pickupTime: '3:00 pm', dropoffTime: '3:20 pm' }));
  d.d1.exec(`DELETE FROM push_state WHERE key = 'lease'`);
  await runPushTick(d.env, Date.now() + 1000, async () => ({ ok: true, status: 200 }));
  check('turned off: no new notification is planned', d.d1.query("SELECT COUNT(*) n FROM push_deliveries WHERE category = 'rides'")[0].n === 1);
}

console.log('5. Preferences always come back complete (older saved settings lack newer keys)');
{
  const ctx = await app();
  ctx.env.PUSH_ENABLED = 'true';
  const old = { ...defaults() }; delete old.rides;
  ctx.d1.exec(`INSERT INTO push_preferences (user_id, settings, updated_at, initialized_at) VALUES ('u1', '${JSON.stringify(old)}', 0, 0)`);
  const r = await call(ctx, 'GET', '/api/push/preferences', { who: 'u1' });
  check('a rider saved before this change gets rides: false', r.status === 200 && r.json.preferences.rides === false);
}

t.finish();
