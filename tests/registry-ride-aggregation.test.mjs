// End-to-end tests for "receipt rides aggregate onto a public registry vehicle".
// Every ride here goes through the REAL receipt pipeline (POST /api/rides/import ->
// extract -> classify -> normalize -> ingestRide, plus one forwarded-email check),
// and the numbers are read back from the REAL public endpoints. The invariant:
//
//   receipt -> canonical counted ride -> plate match -> the vehicle -> public aggregates
//
// and NEVER: receipt -> public vehicle, receipt -> approval, receipt -> VIN/model change.
// Real SQL (every migration), the REAL Worker router.
// Run: node tests/registry-ride-aggregation.test.mjs

import fs from 'node:fs';
import { makeEnv, seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, PASSENGER_NAME } from './helpers/receipts.mjs';
import worker from '../worker/index.js';
import { physicalRidesFrom } from '../worker/ride-status.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const VIN = '5YJSA1E14FF101183';
const PLATE = 'ABC123';

async function makeApp() {
  const users = { mod: 'moderator', u1: 'user', u2: 'user' };
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}

function call(ctx, method, path, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}
const json = async resp => resp.json();

// One receipt through the real import pipeline. Returns the per-item result.
async function ride(ctx, userId, o = {}) {
  const { plate = PLATE, miles = 2.5, date = 'September 30, 2026', pickupTime = '1:04 pm', ...rest } = o;
  const summary = o.summary !== undefined ? o.summary : (plate ? `${miles} mi · 14 min · ${plate}` : null);
  const resp = await call(ctx, 'POST', '/api/rides/import', userId, { items: [{ kind: 'text', content: receiptBody({ date, pickupTime, summary, ...rest }) }] });
  const body = await json(resp);
  return { status: resp.status, item: (body.results || body.items || [])[0] || body, body };
}

const vehicleId = (ctx, plate = PLATE) => (ctx.d1.query(`SELECT id FROM robotaxi_vehicles WHERE license_plate = ?`, plate)[0] || {}).id;
const vehicleRow = (ctx, id) => ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', id)[0];
const detail = async (ctx, id) => call(ctx, 'GET', `/api/robotaxi-vehicles/${id}`, null);
const history = async (ctx, id) => (await json(await detail(ctx, id))).history;
const listEntry = async (ctx, id) => (await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))).vehicles.find(v => v.id === id);
const stats = async ctx => json(await call(ctx, 'GET', '/api/registry/stats', null));
const reviews = (ctx, id) => ctx.d1.query('SELECT * FROM robotaxi_vehicle_reviews WHERE robotaxi_vehicle_id = ?', id);
const PROTECTED = ['model', 'color', 'service_area', 'vin', 'vin_set_by_user_id', 'vin_set_at', 'visibility', 'verification_status', 'origin'];
const protectedOf = row => JSON.stringify(PROTECTED.map(c => row[c]));

// A moderator makes ABC123 a public Cybercab (the ONLY way anything becomes public).
async function makePublic(ctx, id) {
  const vin = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/vin`, 'mod', { vin: VIN });
  const review = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_cybercab' });
  return vin.status === 200 && review.status === 200;
}

async function run() {
  console.log('1. The worked example: two receipts for one eligible public vehicle');
  const ctx = await makeApp();
  {
    const first = await ride(ctx, 'u1', { date: 'September 30, 2026', pickupTime: '1:04 pm', miles: 2.5 });
    check('receipt 1 is ingested as a new ride', first.status === 200 && /created/.test(JSON.stringify(first.item)));
    const id = vehicleId(ctx);
    check('the plate matched/created exactly one registry vehicle (private)', !!id && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1 && vehicleRow(ctx, id).visibility === 'private');
    check('a private vehicle is NOT public: 404 and homepage stats 0/0', (await detail(ctx, id)).status === 404 && (await stats(ctx)).public_vehicles === 0);
    check('a moderator makes it public (VIN + Approve Cybercab)', await makePublic(ctx, id));

    let h = await history(ctx, id);
    check('1. Rides = 1 after the first receipt', h.trip_count === 1);
    check('3. First seen is the ride date (2026-09-30), not the ingestion time', h.first_ride_date === '2026-09-30');
    check('4. Last seen is the ride date (2026-09-30)', h.last_ride_date === '2026-09-30');
    check('5. Recorded distance includes the ride (2.5 mi)', h.total_distance === 2.5);

    const second = await ride(ctx, 'u1', { date: 'October 3, 2026', pickupTime: '9:15 am', miles: 2.5 });
    check('receipt 2 (a distinct ride) is ingested', /created/.test(JSON.stringify(second.item)));
    h = await history(ctx, id);
    check('6. the second distinct receipt raises Rides to 2', h.trip_count === 2);
    check('7. Last seen moves to October 3', h.last_ride_date === '2026-10-03');
    check('8. Recorded distance adds up to 5.0 mi', h.total_distance === 5);
    check('9. First seen stays September 30', h.first_ride_date === '2026-09-30');

    const entry = await listEntry(ctx, id);
    check('the public list card shows the same aggregates', entry.trip_count === 2 && entry.first_ride_date === '2026-09-30' && entry.last_ride_date === '2026-10-03' && entry.total_distance === 5);
    const st = await stats(ctx);
    check('the homepage stats agree: 1 public vehicle, 2 recorded rides', st.public_vehicles === 1 && st.recorded_rides === 2);

    const early = await ride(ctx, 'u1', { date: 'September 15, 2026', pickupTime: '4:40 pm', miles: 1.25 });
    h = await history(ctx, id);
    check('9b. a receipt for an EARLIER date pulls First seen back (order of arrival is irrelevant)', /created/.test(JSON.stringify(early.item)) && h.first_ride_date === '2026-09-15' && h.last_ride_date === '2026-10-03' && h.trip_count === 3 && h.total_distance === 6.25);
  }

  console.log('2. Duplicates never double count (the existing dedup is the source of truth)');
  {
    const id = vehicleId(ctx);
    const before = await history(ctx, id);
    const again = await ride(ctx, 'u1', { date: 'October 3, 2026', pickupTime: '9:15 am', miles: 2.5 });
    check('the identical receipt again is reported as a duplicate', /duplicate/.test(JSON.stringify(again.item)));
    const after = await history(ctx, id);
    check('10. Rides did not increase', after.trip_count === before.trip_count);
    check('11. Recorded distance did not increase', after.total_distance === before.total_distance);

    const msg = inboundMessage(eml({ to: 'x', body: receiptBody({ date: 'October 3, 2026', pickupTime: '9:15 am', summary: '2.5 mi · 14 min · ABC123' }) }), `u_${ctx.tokens.u1}@receipts.example.com`);
    await worker.email(msg, ctx.env, {});
    const viaEmail = await history(ctx, id);
    check('the same ride arriving by forwarded email (another message id) is also not counted twice', viaEmail.trip_count === before.trip_count && viaEmail.total_distance === before.total_distance);

    const corrected = await ride(ctx, 'u1', { date: 'October 3, 2026', pickupTime: '9:15 am', miles: 2.5, fare: '$7.50' });
    const afterCorrection = await history(ctx, id);
    check('a corrected receipt (new fare) updates the ride in place — still one ride, distance unchanged', afterCorrection.trip_count === before.trip_count && afterCorrection.total_distance === before.total_distance && !/created/.test(JSON.stringify(corrected.item)));
  }

  console.log('3. Multiple riders aggregate; nothing about them is exposed');
  {
    const id = vehicleId(ctx);
    const before = await history(ctx, id);
    await ride(ctx, 'u2', { date: 'October 8, 2026', pickupTime: '6:30 pm', miles: 3.5 });
    const h = await history(ctx, id);
    check('18. a DIFFERENT rider\'s distinct ride adds to the same vehicle', h.trip_count === before.trip_count + 1 && h.total_distance === before.total_distance + 3.5 && h.last_ride_date === '2026-10-08');
    const publicText = JSON.stringify([await json(await detail(ctx, id)), await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))]);
    check('the public payloads contain no user ids, names, emails, addresses or receipt content',
      !/u1|u2|"user_id"|@|Hanover|NorthPark|Alex Rider|8111/.test(publicText) && !publicText.includes(PASSENGER_NAME));
  }

  console.log('4. Only counted, live, this-vehicle rides contribute');
  {
    const id = vehicleId(ctx);
    const other = seedVehicle(ctx.d1, { id: crypto.randomUUID(), plate: 'OTH9999' });
    const before = await history(ctx, id);
    seedRide(ctx.d1, { userId: 'u1', vehicleId: id, status: 'needs_review', rideDate: '2026-11-01', distance: 40 });
    seedRide(ctx.d1, { userId: 'u1', vehicleId: id, status: 'rejected', rideDate: '2026-11-02', distance: 40 });
    const superseded = seedRide(ctx.d1, { userId: 'u1', vehicleId: id, status: 'pending', rideDate: '2026-11-03', distance: 40 });
    const winner = seedRide(ctx.d1, { userId: 'u1', vehicleId: other, status: 'pending', rideDate: '2026-11-03', distance: 1 });
    ctx.d1.exec(`UPDATE trips SET superseded_by = '${winner}' WHERE id = '${superseded}'`);
    seedRide(ctx.d1, { userId: 'u1', vehicleId: other, status: 'pending', rideDate: '2026-11-04', distance: 40 });   // a different vehicle
    const h = await history(ctx, id);
    check('19. needs-review, rejected, superseded and other-vehicle rides do not change Rides, dates or distance',
      h.trip_count === before.trip_count && h.last_ride_date === before.last_ride_date && h.total_distance === before.total_distance);
  }

  console.log('5. Missing / zero distance follows the existing convention');
  {
    const ctx2 = await makeApp();
    const id = seedVehicle(ctx2.d1, { id: crypto.randomUUID(), plate: 'DST0001' });
    ctx2.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${id}'`);
    seedRide(ctx2.d1, { userId: 'u1', vehicleId: id, status: 'pending', rideDate: '2026-09-01', distance: null });
    let h = await history(ctx2, id);
    check('20. a counted ride with NO recorded distance counts as a ride but adds no distance (null, never a fabricated 0)', h.trip_count === 1 && h.total_distance === null);
    seedRide(ctx2.d1, { userId: 'u1', vehicleId: id, status: 'pending', rideDate: '2026-09-02', distance: 0 });
    h = await history(ctx2, id);
    check('a real 0.0 mile ride is a ride and is summed as 0 (distinct from missing)', h.trip_count === 2 && h.total_distance === 0);
    seedRide(ctx2.d1, { userId: 'u1', vehicleId: id, status: 'pending', rideDate: '2026-09-03', distance: 4.2 });
    seedRide(ctx2.d1, { userId: 'u1', vehicleId: id, status: 'pending', rideDate: '2026-09-04', distance: null });
    h = await history(ctx2, id);
    check('missing distances are skipped, present ones summed (4.2), and all four rides still count', h.trip_count === 4 && h.total_distance === 4.2);
    check('the list card reports the same total', (await listEntry(ctx2, id)).total_distance === 4.2);
  }

  console.log('6. Trust boundary: a receipt can never publish, approve, or edit a vehicle');
  {
    const ctx3 = await makeApp();
    // The registry copy is stored dashed; receipts print plates without dashes — the shared normalizer must still match them.
    const pubId = seedVehicle(ctx3.d1, { id: crypto.randomUUID(), plate: 'PUB-0001' });
    ctx3.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}', vin_set_by_user_id = 'mod', vin_set_at = '2026-09-01 00:00:00', model = 'Cybercab', color = 'Gold', service_area = 'Houston', verification_status = 'unverified' WHERE id = '${pubId}'`);
    seedRide(ctx3.d1, { userId: 'u1', vehicleId: pubId, status: 'pending' });
    const beforeProtected = protectedOf(vehicleRow(ctx3, pubId));
    const beforeReviews = reviews(ctx3, pubId).length;
    await ride(ctx3, 'u2', { plate: 'PUB0001', date: 'October 20, 2026', pickupTime: '8:00 am', miles: 2 });
    await ride(ctx3, 'u2', { plate: 'pub0001', date: 'October 21, 2026', pickupTime: '8:00 am', miles: 2 });   // lower-case spelling
    const afterRow = vehicleRow(ctx3, pubId);
    check('receipts (different spellings of the plate) attached to the ONE existing public vehicle (Rides 3), creating no second row', (await history(ctx3, pubId)).trip_count === 3 && ctx3.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles WHERE license_plate LIKE 'PUB%'`)[0].n === 1);
    check('17/16. VIN, provenance, model, color, service area, visibility, verification_status are all untouched (a Dallas receipt did not overwrite Houston)', protectedOf(afterRow) === beforeProtected);
    check('15. no review/approval row was written by a receipt', reviews(ctx3, pubId).length === beforeReviews);

    // no plate on the receipt
    const snapshot = JSON.stringify(ctx3.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id'));
    const noPlate = await ride(ctx3, 'u2', { plate: null, date: 'October 22, 2026', pickupTime: '8:00 am' });
    check('12. a receipt with no plate is still stored for the rider and changes no registry vehicle', /created/.test(JSON.stringify(noPlate.item)) && JSON.stringify(ctx3.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id')) === snapshot);
    check('the no-plate ride is attached to no vehicle', ctx3.d1.query(`SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id IS NULL`)[0].n === 1);

    // unknown plate
    const publicBefore = JSON.stringify(await json(await call(ctx3, 'GET', '/api/robotaxi-vehicles', null)));
    const statsBefore = JSON.stringify(await stats(ctx3));
    const unknown = await ride(ctx3, 'u2', { plate: 'NEW7777', date: 'October 23, 2026', pickupTime: '8:00 am' });
    const created = ctx3.d1.query(`SELECT * FROM robotaxi_vehicles WHERE license_plate = 'NEW7777'`)[0];
    check('13. an unknown plate never creates a PUBLIC vehicle — only the pre-existing private, unapproved discovery row', /created/.test(JSON.stringify(unknown.item)) && created && created.visibility === 'private' && created.vin === null && created.origin === 'receipt');
    check('the public list, homepage stats and that vehicle\'s page are all unchanged/404', JSON.stringify(await json(await call(ctx3, 'GET', '/api/robotaxi-vehicles', null))) === publicBefore && JSON.stringify(await stats(ctx3)) === statsBefore && (await detail(ctx3, created.id)).status === 404);

    // a private vehicle
    const privId = created.id;
    const privBefore = protectedOf(vehicleRow(ctx3, privId));
    await ride(ctx3, 'u2', { plate: 'NEW7777', date: 'October 24, 2026', pickupTime: '9:00 am' });
    check('14/15/16. more receipts on a PRIVATE vehicle: still private, no VIN, unapproved, no review row, still 404', protectedOf(vehicleRow(ctx3, privId)) === privBefore && reviews(ctx3, privId).length === 0 && (await detail(ctx3, privId)).status === 404);
    const approve = await call(ctx3, 'POST', `/api/moderation/robotaxi-vehicles/${privId}/review`, 'mod', { action: 'approve_cybercab' });
    check('and it still cannot be approved without a moderator-entered VIN', approve.status === 409 && (await json(approve)).blocking_reasons.includes('no_vin'));

    // duplicated plate: a receipt attaches to ONE vehicle, deterministically, never several
    seedVehicle(ctx3.d1, { id: 'dup-old', plate: 'DUP5555', firstSeenAt: '2020-01-01 00:00:00' });
    seedVehicle(ctx3.d1, { id: 'dup-new', plate: 'DUP-5555', firstSeenAt: '2021-01-01 00:00:00' });
    await ride(ctx3, 'u2', { plate: 'DUP5555', date: 'October 25, 2026', pickupTime: '9:00 am' });
    const attached = ctx3.d1.query(`SELECT robotaxi_vehicle_id v FROM trips WHERE ride_date = '2026-10-25'`);
    check('an ambiguous plate attaches the ride to exactly one vehicle (the oldest), never both', attached.length === 1 && attached[0].v === 'dup-old');
  }

  console.log('6b. The live case: a public sighting-added vehicle (VIN-approved, no rides yet) receives its first receipt');
  {
    const ctx4 = await makeApp();
    const sid = crypto.randomUUID();
    ctx4.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, model, color, service_area, visibility, origin, vin, vin_set_by_user_id, vin_set_at)
      VALUES ('${sid}', 'XVF2566', 'Cybercab', 'Gold', 'Austin', 'public', 'sighting', '${VIN}', 'mod', '2026-09-25 02:34:00')`);
    let h = await history(ctx4, sid);
    check('before any receipt it is public with 0 rides and honest nulls', h.trip_count === 0 && h.first_ride_date === null && h.last_ride_date === null && h.total_distance === null);
    const beforeProtected = protectedOf(vehicleRow(ctx4, sid));
    await ride(ctx4, 'u1', { plate: 'XVF2566', date: 'October 12, 2026', pickupTime: '5:20 pm', miles: 3.2 });
    h = await history(ctx4, sid);
    check('its first receipt aggregates onto it: Rides 1, First/Last seen = that ride\'s date, distance 3.2', h.trip_count === 1 && h.first_ride_date === '2026-10-12' && h.last_ride_date === '2026-10-12' && h.total_distance === 3.2);
    check('the receipt did not change its VIN, model, color, area, visibility, origin or verification state', protectedOf(vehicleRow(ctx4, sid)) === beforeProtected);
    check('no second vehicle was created for that plate', ctx4.d1.query(`SELECT COUNT(*) n FROM robotaxi_vehicles WHERE license_plate = 'XVF2566'`)[0].n === 1);
    check('it stays publicly listed with the new aggregates', (await listEntry(ctx4, sid)).trip_count === 1 && (await stats(ctx4)).recorded_rides === 1);
  }

  console.log('6c. Cross-user dedup: the same PHYSICAL ride submitted by two riders is ONE public ride');
  {
    const c = await makeApp();
    const a1 = await ride(c, 'u1', { date: 'September 30, 2026', pickupTime: '1:04 pm', miles: 2.5 });
    const id = vehicleId(c);
    await makePublic(c, id);
    check('setup: rider A recorded ride R1 and a moderator made the vehicle public', /created/.test(JSON.stringify(a1.item)) && (await detail(c, id)).status === 200);

    const b1 = await ride(c, 'u2', { date: 'September 30, 2026', pickupTime: '1:04 pm', miles: 2.5 });
    check('rider B\'s receipt of the SAME ride is accepted as B\'s own ride (deduplication is per rider)', /created/.test(JSON.stringify(b1.item)));
    check('so two counted trips exist in the database, from two different riders, with one shared ride identity',
      c.d1.query(`SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id = ?`, id)[0].n === 2
      && c.d1.query(`SELECT COUNT(DISTINCT user_id) n FROM trips WHERE robotaxi_vehicle_id = ?`, id)[0].n === 2
      && c.d1.query(`SELECT COUNT(DISTINCT ride_key) n FROM trips WHERE robotaxi_vehicle_id = ?`, id)[0].n === 1);

    let h = await history(c, id);
    check('3. the public aggregate reports exactly 1 ride', h.trip_count === 1);
    check('4. distance is counted exactly once (2.5, not 5.0)', h.total_distance === 2.5);
    check('5/6. first seen and last seen are R1\'s date', h.first_ride_date === '2026-09-30' && h.last_ride_date === '2026-09-30');
    let entry = await listEntry(c, id);
    check('the Cars list card agrees (1 ride, 2.5 mi)', entry.trip_count === 1 && entry.total_distance === 2.5);
    check('the homepage stat agrees (1 vehicle, 1 ride)', (await stats(c)).recorded_rides === 1);

    await ride(c, 'u1', { date: 'October 3, 2026', pickupTime: '9:15 am', miles: 2.5 });
    h = await history(c, id);
    check('7/8. rider A\'s genuinely different ride R2 makes 2 public rides', h.trip_count === 2);
    check('9. distance is R1 + R2, each once (5.0 mi — not 7.5)', h.total_distance === 5);
    check('10/11. first seen stays R1\'s date; last seen becomes R2\'s date', h.first_ride_date === '2026-09-30' && h.last_ride_date === '2026-10-03');

    await ride(c, 'u2', { date: 'October 3, 2026', pickupTime: '9:15 am', miles: 2.5 });
    h = await history(c, id);
    check('12. a duplicate of the LATER ride changes nothing (2 rides, 5.0 mi, same dates)', h.trip_count === 2 && h.total_distance === 5 && h.first_ride_date === '2026-09-30' && h.last_ride_date === '2026-10-03');
    check('and the Cars list card and homepage stat still agree (2 rides, 5.0 mi)', (await listEntry(c, id)).trip_count === 2 && (await listEntry(c, id)).total_distance === 5 && (await stats(c)).recorded_rides === 2);

    // ride identity is date + pickup MINUTE + plate: change any one and it is a different ride
    await ride(c, 'u2', { date: 'October 3, 2026', pickupTime: '9:16 am', miles: 1 });
    await ride(c, 'u2', { date: 'October 4, 2026', pickupTime: '9:15 am', miles: 1 });
    h = await history(c, id);
    check('a different minute on the same day, and the same minute on a different day, are each a separate ride', h.trip_count === 4 && h.total_distance === 7);
    await ride(c, 'u1', { date: 'October 5, 2026', pickupTime: '12:05 am', miles: 1 });
    await ride(c, 'u1', { date: 'October 5, 2026', pickupTime: '12:05 pm', miles: 1 });
    h = await history(c, id);
    check('12:05 AM and 12:05 PM on one day are two rides (24-hour identity, no AM/PM collision)', h.trip_count === 6 && h.total_distance === 9);
  }
  {
    // Non-counted copies never count, and never cancel a counted one
    const c = await makeApp();
    const v = seedVehicle(c.d1, { id: crypto.randomUUID(), plate: 'DDP0001' });
    c.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${v}'`);
    const KEY = 'v1|2026-10-10|10:00|DDP0001';
    seedRide(c.d1, { userId: 'u1', vehicleId: v, status: 'pending', rideDate: '2026-10-10', distance: 2.5, rideKey: KEY });
    seedRide(c.d1, { userId: 'u2', vehicleId: v, status: 'rejected', rideDate: '2026-10-10', distance: 9, rideKey: KEY });
    let h = await history(c, v);
    check('13. a REJECTED copy of a counted ride adds nothing (1 ride, 2.5 mi)', h.trip_count === 1 && h.total_distance === 2.5);
    seedRide(c.d1, { userId: 'mod', vehicleId: v, status: 'needs_review', rideDate: '2026-10-11', distance: 4, rideKey: 'v1|2026-10-11|10:00|DDP0001' });
    h = await history(c, v);
    check('13. a needs-review-only ride is not counted and does not appear in first/last seen', h.trip_count === 1 && h.last_ride_date === '2026-10-10');
    seedRide(c.d1, { userId: 'u1', vehicleId: v, status: 'rejected', rideDate: '2026-10-12', distance: 3, rideKey: 'v1|2026-10-12|10:00|DDP0001' });
    check('13. a rejected-only ride is excluded', (await history(c, v)).trip_count === 1);

    // when the copies disagree or one lacks a distance
    const KEY2 = 'v1|2026-10-20|08:00|DDP0001';
    seedRide(c.d1, { userId: 'u1', vehicleId: v, status: 'pending', rideDate: '2026-10-20', distance: 2.5, rideKey: KEY2 });
    seedRide(c.d1, { userId: 'u2', vehicleId: v, status: 'pending', rideDate: '2026-10-20', distance: null, rideKey: KEY2 });
    h = await history(c, v);
    check('one copy has a distance, the other none: the recorded distance is used once (2.5 + 2.5), never dropped or doubled', h.trip_count === 2 && h.total_distance === 5);
    const KEY3 = 'v1|2026-10-21|08:00|DDP0001';
    seedRide(c.d1, { userId: 'u1', vehicleId: v, status: 'pending', rideDate: '2026-10-21', distance: null, rideKey: KEY3 });
    seedRide(c.d1, { userId: 'u2', vehicleId: v, status: 'pending', rideDate: '2026-10-21', distance: null, rideKey: KEY3 });
    h = await history(c, v);
    check('both copies without a distance: one ride, and the distance total is unchanged (missing stays missing)', h.trip_count === 3 && h.total_distance === 5);
    const solo = seedVehicle(c.d1, { id: crypto.randomUUID(), plate: 'NUL0001' });
    c.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${solo}'`);
    seedRide(c.d1, { userId: 'u1', vehicleId: solo, status: 'pending', rideDate: '2026-10-22', distance: null, rideKey: 'v1|2026-10-22|08:00|NUL0001' });
    seedRide(c.d1, { userId: 'u2', vehicleId: solo, status: 'pending', rideDate: '2026-10-22', distance: null, rideKey: 'v1|2026-10-22|08:00|NUL0001' });
    h = await history(c, solo);
    check('a vehicle whose only ride has no recorded distance stays NULL (never 0)', h.trip_count === 1 && h.total_distance === null);

    // legacy trips with no ride_key each count on their own
    const legacy = seedVehicle(c.d1, { id: crypto.randomUUID(), plate: 'LEG0001' });
    c.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${legacy}'`);
    seedRide(c.d1, { userId: 'u1', vehicleId: legacy, status: 'pending', rideDate: '2026-08-01', distance: 1 });
    seedRide(c.d1, { userId: 'u2', vehicleId: legacy, status: 'pending', rideDate: '2026-08-01', distance: 1 });
    h = await history(c, legacy);
    check('trips with no ride_key (legacy) are never merged: each counts', h.trip_count === 2 && h.total_distance === 2);

    // two different vehicles at the same date and minute are two rides (the plate is part of the identity)
    const other = seedVehicle(c.d1, { id: crypto.randomUUID(), plate: 'OTH0002' });
    c.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${other}'`);
    seedRide(c.d1, { userId: 'u1', vehicleId: other, status: 'pending', rideDate: '2026-10-10', distance: 2.5, rideKey: 'v1|2026-10-10|10:00|OTH0002' });
    check('the same date+minute on a DIFFERENT vehicle is its own ride there (and does not merge into this one)', (await history(c, other)).trip_count === 1 && (await history(c, v)).trip_count === 3);

    const listed = (await json(await call(c, 'GET', '/api/robotaxi-vehicles', null))).vehicles;
    const sumOfList = listed.reduce((n, x) => n + x.trip_count, 0);
    check('the homepage total always equals the sum of what the Cars list shows', (await stats(c)).recorded_rides === sumOfList);
  }

  console.log('7. Static guard: the receipt path has no code that can publish, approve, or set a VIN');
  {
    const files = ['ride-ingest.js', 'receipt-process.js', 'receipt-import.js', 'receipt-ingestion.js', 'ride-canonical.js', 'receipt-extraction.js'];
    for (const f of files) {
      const src = fs.readFileSync(`${ROOT}worker/${f}`, 'utf8').replace(/\/\/.*$/gm, '');
      check(`worker/${f} never touches visibility, VIN, approval, or verification state`, !/visibility|\bvin\b|approve|verification_status|setRegistryVehicleVin|changeRobotaxiVehicleVisibility/i.test(src));
    }
    const dbSrc = fs.readFileSync(`${ROOT}worker/db.js`, 'utf8');
    const fn = dbSrc.slice(dbSrc.indexOf('async function findOrCreateRobotaxiVehicleByPlate'), dbSrc.indexOf('// An accidental-double-submit guard'));
    check('the ONE function receipts use to reach a vehicle inserts only private rows and updates only last_seen_at/updated_at on a match',
      /VEHICLE_VISIBILITY\.PRIVATE/.test(fn) && !/SET\s+(?!last_seen_at)/.test(fn.replace(/UPDATE robotaxi_vehicles SET last_seen_at = datetime\('now'\), updated_at = datetime\('now'\)/, '')));
  }

  console.log('8. Query plans: the aggregates and the plate lookup');
  {
    const plan = sql => ctx.d1.query(`EXPLAIN QUERY PLAN ${sql}`).map(r => r.detail).join(' | ');
    const aggregate = plan(`SELECT COUNT(*), SUM(t.distance), MIN(t.ride_date), MAX(t.ride_date) FROM trips t JOIN submissions s ON s.id = t.submission_id WHERE t.robotaxi_vehicle_id = 'x' AND t.superseded_by IS NULL AND s.status IN ('pending','approved')`);
    check('the per-vehicle aggregates are served by the existing idx_trips_vehicle index (no new index needed)', /idx_trips_vehicle/.test(aggregate));
    const physical = plan(`SELECT COUNT(*), MIN(ride_date), SUM(distance) FROM ${physicalRidesFrom("'x'")}`);
    check('the physical-ride (deduplicating) aggregate is still served by idx_trips_vehicle — no new index needed', /idx_trips_vehicle/.test(physical));
    const lookup = plan(`SELECT id FROM robotaxi_vehicles WHERE UPPER(REPLACE(REPLACE(license_plate, '-', ''), ' ', '')) = 'ABC123'`);
    console.log(`    (informational) plate lookup plan: ${lookup}`);
    check('the plate lookup scans the vehicle table (an expression the plain plate index cannot serve) — fine at registry scale, recorded here so a future index is a deliberate choice', /SCAN/.test(lookup));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
