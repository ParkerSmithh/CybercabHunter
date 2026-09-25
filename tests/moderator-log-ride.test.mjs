// Tests for the moderator-only "Log ride" feature: POST
// /api/moderation/robotaxi-vehicles/:id/rides (worker/moderation.js ->
// db.logModeratorRide) and the Log ride panel on the moderator page.
// The ride is a normal approved submission + counted trip, so the EXISTING
// public physical-ride aggregation picks it up — nothing here changes it.
// Real SQL (every migration), the REAL Worker router, jsdom for the UI.
// Run: node tests/moderator-log-ride.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import { receiptBody } from './helpers/receipts.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const VIN = '5YJSA1E14FF101183';
const iso = d => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const YEAR_AHEAD = iso(new Date(Date.now() + 366 * 86400000));

// The dedicated system owner: a non-login user (no session), configured as MUSE_CONNECTOR_USER_ID exactly as
// in production, where it already owns the Muse connector's registry-level records.
const SYSTEM = 'muse-system';
async function makeApp({ configureOwner = true } = {}) {
  const users = { mod: 'moderator', rider: 'user', u2: 'user', [SYSTEM]: 'user' };
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    if (id !== SYSTEM) await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  if (configureOwner) ctx.env.MUSE_CONNECTOR_USER_ID = SYSTEM;
  return ctx;
}
function call(ctx, method, path, userId, body, raw) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) }), ctx.env, {});
}
const json = r => r.json();
const log = (ctx, id, body, user = 'mod') => call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/rides`, user, body);
const count = (ctx, sql, ...a) => ctx.d1.query(sql, ...a)[0].n;

function mkVehicle(ctx, { plate = 'ABC123', visibility = 'private', vin = null, origin = 'receipt', model = null, color = null, area = null } = {}) {
  const id = crypto.randomUUID();
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, vin, origin, model, color, service_area, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`)
    .bind(id, plate, visibility, vin, origin, model, color, area)._exec();
  return id;
}
const vrow = (ctx, id) => ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', id)[0];
const detail = async (ctx, id) => call(ctx, 'GET', `/api/robotaxi-vehicles/${id}`, null);
const history = async (ctx, id) => (await json(await detail(ctx, id))).history;
const listEntry = async (ctx, id) => (await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))).vehicles.find(v => v.id === id);
const stats = async ctx => json(await call(ctx, 'GET', '/api/registry/stats', null));
const FROZEN = ['visibility', 'vin', 'vin_set_by_user_id', 'vin_set_at', 'model', 'color', 'service_area', 'verification_status', 'origin', 'license_plate', 'first_seen_at'];
const frozen = row => JSON.stringify(FROZEN.map(c => row[c]));

async function run() {
  console.log('1. Authorization: moderators only, reusing the existing moderation gate');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const anon = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/rides`, null, { ride_date: '2026-09-01' });
    check('1. unauthenticated -> 401', anon.status === 401 && (await json(anon)).authenticated === false);
    const rider = await log(ctx, id, { ride_date: '2026-09-01' }, 'rider');
    check('2. an authenticated non-moderator -> 403', rider.status === 403);
    const connector = await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${id}/rides`, {
      method: 'POST', headers: { Authorization: 'Bearer some-connector-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ ride_date: '2026-09-01' })
    }), { ...ctx.env, MUSE_CONNECTOR_TOKEN: 'some-connector-token' }, {});
    check('the Muse connector token cannot log rides (401)', connector.status === 401);
    check('the connector sighting route did not gain the ability either (a ride body creates no trip)', (await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', {
      method: 'POST', headers: { Authorization: 'Bearer some-connector-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ ride_date: '2026-09-01', service_area: 'Austin', vehicle_id: id })
    }), { ...ctx.env, MUSE_CONNECTOR_TOKEN: 'some-connector-token', MUSE_CONNECTOR_USER_ID: SYSTEM }, {})).status === 201 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    check('nothing was written by any refused request', count(ctx, `SELECT COUNT(*) n FROM trips`) === 0 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE evidence_type = 'manual_entry'`) === 0);
    check('a malformed vehicle id is 400 and an unknown one is 404', (await log(ctx, 'not-a-uuid', { ride_date: '2026-09-01' })).status === 400 && (await log(ctx, crypto.randomUUID(), { ride_date: '2026-09-01' })).status === 404);
    check('a non-JSON body is 400', (await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/rides`, 'mod', undefined, 'not json')).status === 400);
  }

  console.log('2. Validation: 400s, and nothing is written');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const rejects = async (label, body, code, raw) => {
      const r = raw !== undefined ? await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/rides`, 'mod', undefined, raw) : await log(ctx, id, body);
      check(`${label} -> 400 ${code}`, r.status === 400 && (await json(r)).error === code);
    };
    await rejects('3. an impossible calendar date (Feb 30)', { ride_date: '2026-02-30' }, 'invalid_ride_date');
    await rejects('3. month 13', { ride_date: '2026-13-01' }, 'invalid_ride_date');
    await rejects('3. a wrong format (June 9, 2026)', { ride_date: 'June 9, 2026' }, 'invalid_ride_date');
    await rejects('3. a non-padded date', { ride_date: '2026-9-1' }, 'invalid_ride_date');
    await rejects('3. a missing ride_date', { distance: 2.5 }, 'invalid_ride_date');
    await rejects('3. a non-string ride_date', { ride_date: 20260901 }, 'invalid_ride_date');
    await rejects('4. a future date', { ride_date: YEAR_AHEAD }, 'future_ride_date');
    await rejects('5. a negative distance', { ride_date: '2026-09-01', distance: -2.5 }, 'invalid_distance');
    await rejects('6. a zero distance', { ride_date: '2026-09-01', distance: 0 }, 'invalid_distance');
    await rejects('7. a malformed (string) distance', { ride_date: '2026-09-01', distance: 'abc' }, 'invalid_distance');
    await rejects('7. a numeric STRING distance (only JSON numbers are accepted)', { ride_date: '2026-09-01', distance: '2.5' }, 'invalid_distance');
    await rejects('7. a non-finite distance (1e999)', null, 'invalid_distance', '{"ride_date":"2026-09-01","distance":1e999}');
    await rejects('7. an object distance', { ride_date: '2026-09-01', distance: { a: 1 } }, 'invalid_distance');
    await rejects('an unknown distance unit', { ride_date: '2026-09-01', distance: 2, distance_unit: 'yd' }, 'invalid_distance_unit');
    await rejects('a non-string service area', { ride_date: '2026-09-01', service_area: 5 }, 'invalid_service_area');
    await rejects('an over-long service area', { ride_date: '2026-09-01', service_area: 'x'.repeat(101) }, 'invalid_service_area');
    check('nothing was written by any invalid request', count(ctx, 'SELECT COUNT(*) n FROM trips') === 0 && count(ctx, `SELECT COUNT(*) n FROM submissions`) === 0);
    check('today (UTC) is accepted, i.e. the boundary is "not after today"', (await log(ctx, id, { ride_date: TODAY })).status === 201);
  }

  console.log('3. Success: the rows written');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { model: 'Model Y', color: 'White', area: 'Houston' });
    const before = frozen(vrow(ctx, id));
    const resp = await log(ctx, id, { ride_date: '2026-08-30', distance: 2.5, distance_unit: 'mi', service_area: 'Dallas' });
    const body = await json(resp);
    check('8. a ride with a distance succeeds (201)', resp.status === 201 && body.success === true && body.ride.distance === 2.5);
    const trip = ctx.d1.query('SELECT * FROM trips WHERE id = ?', body.ride.id)[0];
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', trip.submission_id)[0];
    check('8. the stored distance is 2.5 in miles', trip.distance === 2.5 && trip.distance_unit === 'mi');
    check('14. an APPROVED manual submission is created (evidence_type manual_entry), OWNED by the system user and reviewed by the moderator',
      sub.status === 'approved' && sub.evidence_type === 'manual_entry' && sub.submission_type === 'ride_receipt' && sub.user_id === SYSTEM && sub.reviewed_by === 'mod' && !!sub.reviewed_at && sub.rejection_reason === null);
    check('15. the linked trip: this vehicle, this submission, this date, source manual_entry, owned by the moderator',
      trip.robotaxi_vehicle_id === id && trip.submission_id === sub.id && trip.ride_date === '2026-08-30' && trip.source === 'manual_entry' && trip.user_id === SYSTEM);
    check('15. nothing is invented: no fare, currency, ride_key, times, addresses, receipt hash; ride-level service area kept',
      trip.fare_amount_cents === null && trip.currency === null && trip.ride_key === null && trip.pickup_time === null && trip.pickup_description === null && trip.receipt_hash === null && trip.service_area === 'Dallas' && trip.superseded_by === null);
    check('16. the vehicle\'s last_seen_at moved forward from its old value', vrow(ctx, id).last_seen_at > '2026-01-01 00:00:00' && vrow(ctx, id).updated_at > '2026-01-01 00:00:00');
    check('17. visibility, VIN, model, color, service area, verification state, origin and first_seen_at are untouched (a Dallas ride did not overwrite Houston)', frozen(vrow(ctx, id)) === before);
    check('17. no review/approval history row was written', count(ctx, 'SELECT COUNT(*) n FROM robotaxi_vehicle_reviews') === 0);
    check('the response carries the refreshed moderator card, still private and unapproved', body.vehicle.visibility === 'private' && body.vehicle.counted_ride_count === 1 && body.vehicle.origin === 'receipt');

    const noDist = await json(await log(ctx, id, { ride_date: '2026-09-01' }));
    const nd = ctx.d1.query('SELECT * FROM trips WHERE id = ?', noDist.ride.id)[0];
    check('9. a ride WITHOUT a distance stores NULL (never 0, never guessed)', nd.distance === null && noDist.ride.distance === null);
    check('10. the default distance unit is mi', nd.distance_unit === 'mi');
    const explicitNull = await json(await log(ctx, id, { ride_date: '2026-09-02', distance: null, service_area: '  ' }));
    const en = ctx.d1.query('SELECT * FROM trips WHERE id = ?', explicitNull.ride.id)[0];
    check('an explicit null distance and a blank service area are stored as NULL', en.distance === null && en.service_area === null);
    const ignoring = await log(ctx, id, { ride_date: '2026-09-03', distance: 1, visibility: 'public', vin: VIN, model: 'Cybercab', approve: true, action: 'approve_cybercab' });
    check('17. unknown/dangerous body fields are ignored — they cannot publish, approve, or set a VIN', ignoring.status === 201 && frozen(vrow(ctx, id)) === before && count(ctx, 'SELECT COUNT(*) n FROM robotaxi_vehicle_reviews') === 0);
  }
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const km = await json(await log(ctx, id, { ride_date: '2026-09-01', distance: 10, distance_unit: 'km' }));
    const trip = ctx.d1.query('SELECT * FROM trips WHERE id = ?', km.ride.id)[0];
    check('11. an explicit km is accepted', km.success === true);
    check('11. km is CONVERTED to miles (10 km = 6.214 mi) and stored as mi, so the public mileage — which sums the column as miles — stays correct', trip.distance === 6.214 && trip.distance_unit === 'mi' && km.ride.converted_from === 'km');
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${id}'`);
    check('and the public aggregate shows 6.2 mi worth of distance, not 10', (await history(ctx, id)).total_distance === 6.214);
    const dupKm = await log(ctx, id, { ride_date: '2026-09-01', distance: 10, distance_unit: 'km' });
    const dupMi = await log(ctx, id, { ride_date: '2026-09-01', distance: 6.214 });
    check('the duplicate guard compares the stored (miles) value, so the same ride in km or miles is a duplicate', dupKm.status === 409 && dupMi.status === 409);
  }

  console.log('4. Duplicate guard: same vehicle + ride date + distance among COUNTED, non-superseded rides');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const other = mkVehicle(ctx, { plate: 'OTH0001' });
    check('the first ride is accepted', (await log(ctx, id, { ride_date: '2026-08-30', distance: 2.5 })).status === 201);
    const dup = await log(ctx, id, { ride_date: '2026-08-30', distance: 2.5 });
    const dupBody = await json(dup);
    check('12. the same vehicle + date + distance is 409 duplicate_ride', dup.status === 409 && dupBody.error === 'duplicate_ride');
    check('12. the 409 wrote nothing (1 trip, 1 manual submission) and returns the unchanged card', count(ctx, 'SELECT COUNT(*) n FROM trips') === 1 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE evidence_type = 'manual_entry'`) === 1 && dupBody.vehicle.counted_ride_count === 1);
    check('a different distance on the same date is a different ride', (await log(ctx, id, { ride_date: '2026-08-30', distance: 3 })).status === 201);
    check('the same distance on a different date is a different ride', (await log(ctx, id, { ride_date: '2026-09-01', distance: 2.5 })).status === 201);
    check('the same date and distance on a DIFFERENT vehicle is a different ride', (await log(ctx, other, { ride_date: '2026-08-30', distance: 2.5 })).status === 201);
    check('NULL distance: the first is accepted', (await log(ctx, id, { ride_date: '2026-07-01' })).status === 201);
    check('NULL distance: the same date with NULL again is 409 (NULL matches NULL)', (await log(ctx, id, { ride_date: '2026-07-01' })).status === 409);
    check('NULL vs a number on the same date is NOT a duplicate', (await log(ctx, id, { ride_date: '2026-07-01', distance: 4 })).status === 201);
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending', rideDate: '2026-07-02', distance: 5 });
    check('an existing counted RECEIPT ride also blocks (the guard covers every counted ride, not just manual ones)', (await log(ctx, id, { ride_date: '2026-07-02', distance: 5 })).status === 409);
  }
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'rejected', rideDate: '2026-09-15', distance: 2.5 });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'needs_review', rideDate: '2026-09-16', distance: 2.5 });
    const gone = seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending', rideDate: '2026-09-17', distance: 2.5 });
    const winner = seedRide(ctx.d1, { userId: 'u2', vehicleId: id, status: 'pending', rideDate: '2026-09-17', distance: 9 });
    ctx.d1.exec(`UPDATE trips SET superseded_by = '${winner}' WHERE id = '${gone}'`);
    check('13. an existing REJECTED ride with the same date+distance does not block', (await log(ctx, id, { ride_date: '2026-09-15', distance: 2.5 })).status === 201);
    check('13. an existing NEEDS-REVIEW ride (not counted) does not block', (await log(ctx, id, { ride_date: '2026-09-16', distance: 2.5 })).status === 201);
    check('13. a SUPERSEDED ride does not block', (await log(ctx, id, { ride_date: '2026-09-17', distance: 2.5 })).status === 201);
  }

  console.log('5. Atomicity: all three writes, or none');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    ctx.d1.exec(`CREATE TRIGGER refuse_touch BEFORE UPDATE OF last_seen_at ON robotaxi_vehicles BEGIN SELECT RAISE(ABORT, 'forced failure on the last write'); END;`);
    let threw = false;
    try { await db.logModeratorRide(ctx.d1, { vehicleId: id, moderatorId: 'mod', ownerUserId: SYSTEM, rideDate: '2026-09-01', distance: 2 }); } catch (e) { threw = true; }
    check('a failure in the LAST statement makes the whole call fail', threw);
    check('and rolls back: no submission and no trip were left behind', count(ctx, 'SELECT COUNT(*) n FROM submissions') === 0 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    const viaApi = await log(ctx, id, { ride_date: '2026-09-01', distance: 2 });
    check('through the API that is a clean 500 with no internals, and still nothing written', viaApi.status === 500 && (await json(viaApi)).error === 'log_ride_failed' && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    ctx.d1.exec('DROP TRIGGER refuse_touch');
    check('once the fault is removed the same request succeeds', (await log(ctx, id, { ride_date: '2026-09-01', distance: 2 })).status === 201);
  }
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const [a, b] = await Promise.all([log(ctx, id, { ride_date: '2026-09-05', distance: 3 }), log(ctx, id, { ride_date: '2026-09-05', distance: 3 })]);
    check('two identical requests at once: exactly one succeeds, the other is 409', [a.status, b.status].sort().join() === '201,409');
    check('and exactly one submission + one trip exist', count(ctx, 'SELECT COUNT(*) n FROM trips') === 1 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE evidence_type = 'manual_entry'`) === 1);
    check('a submission is never left without its trip', count(ctx, `SELECT COUNT(*) n FROM submissions s WHERE s.evidence_type = 'manual_entry' AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.submission_id = s.id)`) === 0);
  }

  console.log('6. Public aggregation: the existing physical-ride aggregate picks the ride up untouched');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { plate: 'XVF2566', visibility: 'public', vin: VIN, origin: 'sighting', model: 'Cybercab', color: 'Gold', area: 'Austin' });
    check('before any ride the public vehicle has 0 rides and honest nulls', JSON.stringify(await history(ctx, id)) === JSON.stringify({ trip_count: 0, first_ride_date: null, last_ride_date: null, total_distance: null, service_areas: null }));
    await log(ctx, id, { ride_date: '2026-08-30', distance: 2.5 });
    await log(ctx, id, { ride_date: '2026-09-03', distance: 2.5 });
    const h = await history(ctx, id);
    check('18. vehicle detail: Rides Recorded 2, Recorded Distance 5.0, First Recorded Ride Aug 30, Latest Recorded Ride Sep 3',
      h.trip_count === 2 && h.total_distance === 5 && h.first_ride_date === '2026-08-30' && h.last_ride_date === '2026-09-03');
    const entry = await listEntry(ctx, id);
    check('18. the Cars list card shows the same', entry.trip_count === 2 && entry.total_distance === 5 && entry.first_ride_date === '2026-08-30' && entry.last_ride_date === '2026-09-03');
    check('18. the homepage Total Rides counts them, and equals the sum of the list', (await stats(ctx)).recorded_rides === 2 && (await stats(ctx)).public_vehicles === 1);
    await log(ctx, id, { ride_date: '2026-08-01' });
    const h2 = await history(ctx, id);
    check('a ride with no distance counts as a ride but adds no distance; an earlier date pulls First Recorded Ride back', h2.trip_count === 3 && h2.total_distance === 5 && h2.first_ride_date === '2026-08-01');

    // interplay with the cross-user physical-ride dedupe (unchanged): a receipt ride adds normally
    ctx.d1.exec(`UPDATE users SET role = 'user' WHERE id = 'u2'`);
    await call(ctx, 'POST', '/api/rides/import', 'u2', { items: [{ kind: 'text', content: receiptBody({ date: 'July 5, 2026', pickupTime: '9:15 am', summary: '3.5 mi · 14 min · XVF2566' }) }] });
    const h3 = await history(ctx, id);
    check('receipt rides for the same plate aggregate alongside manual ones (4 rides, 8.5 mi)', h3.trip_count === 4 && h3.total_distance === 8.5);
    check('a manual ride on a public vehicle leaves it public, VIN-approved, with its moderator-confirmed fields', vrow(ctx, id).visibility === 'public' && vrow(ctx, id).vin === VIN && vrow(ctx, id).model === 'Cybercab' && vrow(ctx, id).color === 'Gold' && vrow(ctx, id).service_area === 'Austin');
  }
  {
    const ctx = await makeApp();
    const priv = mkVehicle(ctx, { plate: 'PRV0001' });
    const before = await stats(ctx);
    await log(ctx, priv, { ride_date: '2026-08-30', distance: 2.5 });
    check('17. logging a ride on a PRIVATE vehicle never publishes it (public page 404, homepage unchanged)', (await detail(ctx, priv)).status === 404 && JSON.stringify(await stats(ctx)) === JSON.stringify(before) && vrow(ctx, priv).visibility === 'private');
    const card = (await json(await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', 'mod'))).vehicles.find(v => v.id === priv);
    check('the moderator card now shows the ride (1 counted, source Other) — eligible for approval but NOT approved', card.counted_ride_count === 1 && card.counted_rides_by_source.other === 1 && card.approval.state === 'eligible_for_approval' && card.visibility === 'private');
    check('a ride alone cannot approve: Approve Cybercab still needs a moderator-entered VIN', (await json(await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${priv}/review`, 'mod', { action: 'approve_cybercab' }))).blocking_reasons.includes('no_vin'));
    check('the ride is owned by the system user and is NOT in the moderator\'s own account', count(ctx, `SELECT COUNT(*) n FROM trips WHERE user_id = ? AND source = 'manual_entry'`, SYSTEM) === 1 && count(ctx, `SELECT COUNT(*) n FROM trips WHERE user_id = 'mod'`) === 0);
  }

  console.log('6b. Ownership: the ride belongs to the system user; the moderator is provenance only');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { plate: 'OWN0001', visibility: 'public', vin: VIN, origin: 'sighting', model: 'Cybercab', color: 'Gold' });
    const resp = await log(ctx, id, { ride_date: '2026-08-30', distance: 2.5 });
    const body = await json(resp);
    const trip = ctx.d1.query('SELECT * FROM trips WHERE id = ?', body.ride.id)[0];
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', trip.submission_id)[0];
    check('the manually logged ride is owned by the established system identity (submission AND trip)', resp.status === 201 && sub.user_id === SYSTEM && trip.user_id === SYSTEM);
    check('reviewed_by identifies the actual moderator who logged it, with a review time', sub.reviewed_by === 'mod' && !!sub.reviewed_at && sub.status === 'approved');
    check('it is the SAME identity the Muse connector uses (MUSE_CONNECTOR_USER_ID) — no new user, no new schema', ctx.env.MUSE_CONNECTOR_USER_ID === SYSTEM && count(ctx, 'SELECT COUNT(*) n FROM users') === 4);
    check('the system owner is not a moderator and has no login session', ctx.d1.query(`SELECT role FROM users WHERE id = ?`, SYSTEM)[0].role === 'user' && (await ctx.env.TESLA_SESSIONS.get(`session:session-${SYSTEM}`)) === null);

    const myTrips = await json(await call(ctx, 'GET', '/api/trips', 'mod'));
    check('it does NOT appear in the moderator\'s personal Rider Data (their trip list is empty, total 0)', myTrips.trips.length === 0 && myTrips.pagination.total === 0);
    const profile = await json(await call(ctx, 'GET', '/api/profile', 'mod'));
    check('and it is not in the moderator\'s personal statistics', profile.rideSummary.trip_count === 0 && profile.rideSummary.unique_vehicles === 0);
    check('the public and moderator responses never expose the system owner\'s id', !JSON.stringify(body).includes(SYSTEM) && !JSON.stringify(await json(await detail(ctx, id))).includes(SYSTEM) && !JSON.stringify(await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))).includes(SYSTEM));
    const beforeAgg = JSON.stringify(await history(ctx, id));
    const beforeStats = JSON.stringify(await stats(ctx));

    // ---- "delete my rides" cannot reach it ----
    seedRide(ctx.d1, { userId: 'mod', status: 'pending', rideDate: '2026-07-01' });
    check('setup: the moderator has one PERSONAL ride of their own', count(ctx, `SELECT COUNT(*) n FROM trips WHERE user_id = 'mod'`) === 1);
    const delOne = await call(ctx, 'DELETE', `/api/trips/${body.ride.id}`, 'mod');
    check('the moderator deleting THIS ride through Rider Data is refused (404 — not their ride)', delOne.status === 404 && count(ctx, 'SELECT COUNT(*) n FROM trips WHERE id = ?', body.ride.id) === 1);
    const delSub = await call(ctx, 'DELETE', `/api/submissions/${trip.submission_id}`, 'mod');
    check('nor can they delete its submission (not theirs)', delSub.status >= 400 && count(ctx, 'SELECT COUNT(*) n FROM submissions WHERE id = ?', trip.submission_id) === 1);
    const delAll = await call(ctx, 'DELETE', '/api/trips', 'mod', { confirm: 'delete-all-rides' });
    check('"delete all my rides" succeeds for the moderator (200) and removes only their personal ride', delAll.status === 200 && count(ctx, `SELECT COUNT(*) n FROM trips WHERE user_id = 'mod'`) === 0);
    check('the manually logged trip and its submission SURVIVE the moderator\'s delete-all', count(ctx, 'SELECT COUNT(*) n FROM trips WHERE id = ?', body.ride.id) === 1 && count(ctx, 'SELECT COUNT(*) n FROM submissions WHERE id = ?', trip.submission_id) === 1);
    check('so the public registry history and homepage total are unchanged', JSON.stringify(await history(ctx, id)) === beforeAgg && JSON.stringify(await stats(ctx)) === beforeStats && (await history(ctx, id)).trip_count === 1);

    // ---- it does not depend on the moderator's account ----
    ctx.d1.exec(`UPDATE users SET role = 'user' WHERE id = 'mod'`);
    check('revoking the moderator\'s role leaves the ride and public aggregate intact', JSON.stringify(await history(ctx, id)) === beforeAgg);
    let removed = true; try { ctx.d1.exec(`DELETE FROM users WHERE id = 'mod'`); } catch (e) { removed = false; }
    check('even deleting the moderator\'s whole account leaves the ride, its submission and the public aggregate intact',
      removed && count(ctx, 'SELECT COUNT(*) n FROM trips WHERE id = ?', body.ride.id) === 1 && count(ctx, 'SELECT COUNT(*) n FROM submissions WHERE id = ?', trip.submission_id) === 1 && JSON.stringify(await history(ctx, id)) === beforeAgg);
  }
  {
    // the connector's own cap and dedupe are unaffected by manual rides
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { plate: 'CAP0001' });
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) await log(ctx, id, { ride_date: d, distance: 1 });
    check('manual rides do not count toward the Muse connector\'s daily submission cap (it counts sightings only)',
      count(ctx, `SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND submission_type = 'vehicle_sighting'`, SYSTEM) === 0 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND evidence_type = 'manual_entry'`, SYSTEM) === 3);
    const sighting = await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', {
      method: 'POST', headers: { Authorization: 'Bearer connector-token-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ license_plate: 'CAP0002', service_area: 'Austin' })
    }), { ...ctx.env, MUSE_CONNECTOR_TOKEN: 'connector-token-0123456789' }, {});
    check('the connector still works exactly as before, under the same identity', sighting.status === 201 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND submission_type = 'vehicle_sighting'`, SYSTEM) === 1);
    // the moderator's "Delete Vehicle" (a deliberate, disclosed registry action) still removes the vehicle's rides, leaving no orphans
    const del = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${id}`, 'mod');
    check('a moderator deleting the VEHICLE removes its manual rides and their submissions together (no orphans)', del.status === 200 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE evidence_type = 'manual_entry'`) === 0 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
  }
  {
    // ---- fails closed: never falls back to the moderator ----
    const noOwner = await makeApp({ configureOwner: false });
    const v1 = mkVehicle(noOwner);
    const r1 = await log(noOwner, v1, { ride_date: '2026-08-30', distance: 2.5 });
    check('no system owner configured -> 503 system_owner_not_configured, and nothing is written', r1.status === 503 && (await json(r1)).error === 'system_owner_not_configured' && count(noOwner, 'SELECT COUNT(*) n FROM trips') === 0 && count(noOwner, 'SELECT COUNT(*) n FROM submissions') === 0);
    const ghost = await makeApp();
    ghost.env.MUSE_CONNECTOR_USER_ID = 'a-user-that-does-not-exist';
    const v2 = mkVehicle(ghost);
    const r2 = await log(ghost, v2, { ride_date: '2026-08-30', distance: 2.5 });
    check('a configured id that is not a real user -> 503 as well, still nothing written (never falls back to the moderator)', r2.status === 503 && count(ghost, 'SELECT COUNT(*) n FROM trips') === 0 && count(ghost, `SELECT COUNT(*) n FROM trips WHERE user_id = 'mod'`) === 0);
    check('an unauthenticated caller still gets 401 (not 503) even when unconfigured', (await call(noOwner, 'POST', `/api/moderation/robotaxi-vehicles/${v1}/rides`, null, { ride_date: '2026-08-30' })).status === 401);
    check('validation errors are still reported as 400 when unconfigured', (await log(noOwner, v1, { ride_date: 'nope' })).status === 400);
  }
  {
    // ---- the system identity grants nobody the ability to call the endpoint ----
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    await ctx.env.TESLA_SESSIONS.put(`session:session-${SYSTEM}`, JSON.stringify({ user_id: SYSTEM }));   // even a session FOR the system user…
    const asSystem = await log(ctx, id, { ride_date: '2026-08-30', distance: 2 }, SYSTEM);
    check('…is 403 on the endpoint: owning the ride confers no moderator authority', asSystem.status === 403 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    const viaToken = await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${id}/rides`, {
      method: 'POST', headers: { Authorization: 'Bearer connector-token-0123456789', 'Content-Type': 'application/json' }, body: JSON.stringify({ ride_date: '2026-08-30', distance: 2 })
    }), { ...ctx.env, MUSE_CONNECTOR_TOKEN: 'connector-token-0123456789' }, {});
    check('the connector\'s shared-secret token is 401 on the endpoint (it is not a session)', viaToken.status === 401 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    check('an ordinary rider is 403 and an anonymous caller 401, as before', (await log(ctx, id, { ride_date: '2026-08-30' }, 'rider')).status === 403 && (await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/rides`, null, { ride_date: '2026-08-30' })).status === 401);
    const connectorSrc = fs.readFileSync(`${ROOT}worker/connector.js`, 'utf8').replace(/\/\/.*$/gm, '');
    check('the connector module has no code path to log rides (it never references the ride-logging function or the rides route)', !/logModeratorRide|\/rides/.test(connectorSrc));
  }

  console.log('7. Moderator page (jsdom): the Log ride panel');
  {
    const HTML = fs.readFileSync(`${ROOT}moderation.html`, 'utf8');
    const COMBINED = `${fs.readFileSync(`${ROOT}js/calc.js`, 'utf8')}\n${fs.readFileSync(`${ROOT}js/main.js`, 'utf8')}\nCCC.init();\n${fs.readFileSync(`${ROOT}js/moderation.js`, 'utf8')}`;
    const ctx = await makeApp();
    const privId = mkVehicle(ctx, { plate: 'PRV0001' });
    const privId2 = mkVehicle(ctx, { plate: 'PRV0002' });
    const pubId = mkVehicle(ctx, { plate: 'PUB0001', visibility: 'public', vin: VIN, origin: 'sighting', model: 'Cybercab', color: 'Gold' });

    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-mod');
    const requests = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      if (path.startsWith('/api/moderation/')) requests.push({ path, method: init.method || 'GET', body: init.body });
      return worker.fetch(new Request(`https://x${path}`, init), ctx.env, {});
    };
    w.eval(COMBINED);
    const d = w.document;
    const waitFor = async (cond, ms = 2500) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 5)); } return false; };
    const cardFor = id => [...d.querySelectorAll('[data-vehicle-id]')].find(c => c.dataset.vehicleId === id);
    const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const setVal = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
    await waitFor(() => !!cardFor(privId));
    const rideRequests = () => requests.filter(r => r.method === 'POST' && /\/rides$/.test(r.path));
    const listLoads = () => requests.filter(r => r.method === 'GET' && r.path.startsWith('/api/moderation/robotaxi-vehicles')).length;

    const panel = cardFor(privId).querySelector('[data-log-ride-panel]');
    check('19. a private vehicle card renders the Log ride panel', !!panel && /Log ride/.test(panel.textContent));
    check('19. it has a required date input, an optional miles input and a Log ride button',
      panel.querySelector('input[type="date"][data-log-ride-date]').required === true && !!panel.querySelector('input[type="number"][data-log-ride-miles]') && panel.querySelector('input[data-log-ride-miles]').required === false
      && panel.querySelector('button[data-vehicle-action="log-ride"]').textContent.trim() === 'Log ride');
    check('19. the date input cannot pick a future date (max = today)', panel.querySelector('[data-log-ride-date]').max === TODAY);
    check('19. it works on a PUBLIC vehicle card too (the moderator switches scope to see it)', await (async () => {
      const sel = d.getElementById('modVehicleScope'); sel.value = 'public'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
      return waitFor(() => !!cardFor(pubId) && !!cardFor(pubId).querySelector('[data-log-ride-panel]'));
    })());
    const sel = d.getElementById('modVehicleScope'); sel.value = 'private'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await waitFor(() => !!cardFor(privId));

    // ---- validation: inline, no request ----
    const before = listLoads();
    click(cardFor(privId).querySelector('button[data-vehicle-action="log-ride"]'));
    check('21. an empty date shows an inline error and sends NO request', /Pick the ride date/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent) && rideRequests().length === 0);
    setVal(cardFor(privId).querySelector('[data-log-ride-date]'), '2026-08-30');
    setVal(cardFor(privId).querySelector('[data-log-ride-miles]'), '-3');
    click(cardFor(privId).querySelector('button[data-vehicle-action="log-ride"]'));
    check('21. negative miles shows an inline error and sends NO request (what was typed is kept)', /greater than 0/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent) && rideRequests().length === 0 && cardFor(privId).querySelector('[data-log-ride-date]').value === '2026-08-30');

    // ---- success ----
    const stateBefore = { approval: cardFor(privId).dataset.approvalState, badge: /Private — Needs Review/.test(cardFor(privId).textContent), scope: sel.value };
    setVal(cardFor(privId).querySelector('[data-log-ride-miles]'), '2.5');
    click(cardFor(privId).querySelector('button[data-vehicle-action="log-ride"]'));
    await waitFor(() => /Logged a ride/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent));
    const posted = rideRequests();
    check('20. it POSTs { ride_date, distance, distance_unit: "mi" } to the rides endpoint for that vehicle', posted.length === 1 && posted[0].path === `/api/moderation/robotaxi-vehicles/${privId}/rides` && JSON.stringify(JSON.parse(posted[0].body)) === JSON.stringify({ ride_date: '2026-08-30', distance_unit: 'mi', distance: 2.5 }));
    const okMsg = cardFor(privId).querySelector('[data-log-ride-msg]').textContent;
    check('20. a clear confirmation with the date, distance and the vehicle\'s new counted-ride total', /Logged a ride on Aug 30, 2026 \(2\.5 mi\)/.test(okMsg) && /1 counted ride/.test(okMsg));
    check('20. the card refreshed in place: it now shows "1 counted ride" and the ride provenance (Other: 1)', /1 counted ride/.test(cardFor(privId).textContent) && /Other: 1/.test(cardFor(privId).textContent));
    check('20. NO full-page reload and no list re-fetch: the window did not navigate and only the one POST happened', w.location.href === 'https://cybercabhunter.com/moderation.html' && listLoads() === before && rideRequests().length === 1);
    check('20. the approval/public state is unchanged (still Private — Needs Review, same scope, not public)', cardFor(privId).dataset.approvalState === 'eligible_for_approval' && stateBefore.badge && /Private — Needs Review/.test(cardFor(privId).textContent) && sel.value === stateBefore.scope && !cardFor(privId).querySelector('a[href^="vehicle/"]'));
    check('20. the inputs were cleared after success', cardFor(privId).querySelector('[data-log-ride-date]').value === '' && cardFor(privId).querySelector('[data-log-ride-miles]').value === '');
    check('20. the ride really exists in the database', count(ctx, `SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id = ? AND source = 'manual_entry'`, privId) === 1);

    // ---- 409 duplicate ----
    const approvalBefore = cardFor(privId).dataset.approvalState;
    setVal(cardFor(privId).querySelector('[data-log-ride-date]'), '2026-08-30');
    setVal(cardFor(privId).querySelector('[data-log-ride-miles]'), '2.5');
    click(cardFor(privId).querySelector('button[data-vehicle-action="log-ride"]'));
    await waitFor(() => /already recorded/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent));
    const errEl = cardFor(privId).querySelector('[data-log-ride-msg]');
    check('21. a duplicate shows a useful inline error in an alert region', /already recorded for this vehicle/.test(errEl.textContent) && errEl.getAttribute('role') === 'alert');
    check('21. the duplicate did not reload the page, change the approval state, or add a ride', w.location.href === 'https://cybercabhunter.com/moderation.html' && listLoads() === before && cardFor(privId).dataset.approvalState === approvalBefore && count(ctx, `SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id = ?`, privId) === 1 && /1 counted ride/.test(cardFor(privId).textContent));
    check('21. what was typed is kept so the moderator can correct it', cardFor(privId).querySelector('[data-log-ride-date]').value === '2026-08-30' && cardFor(privId).querySelector('[data-log-ride-miles]').value === '2.5');

    // ---- server-side rejection (future date) surfaces inline too ----
    setVal(cardFor(privId).querySelector('[data-log-ride-date]'), YEAR_AHEAD);
    click(cardFor(privId).querySelector('button[data-vehicle-action="log-ride"]'));
    await waitFor(() => /future/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent));
    check('21. a server 400 (future date) is shown inline and changes nothing', /cannot be in the future/.test(cardFor(privId).querySelector('[data-log-ride-msg]').textContent) && count(ctx, `SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id = ?`, privId) === 1 && cardFor(privId).dataset.approvalState === approvalBefore);

    // ---- drafts survive another card's re-render ----
    setVal(cardFor(privId).querySelector('[data-log-ride-date]'), '2026-08-01');
    click(cardFor(privId2).querySelector('button[data-vehicle-action="ask-delete"]'));
    await waitFor(() => /Permanently delete/.test(cardFor(privId2).textContent));
    check('what was typed in one card\'s panel survives a re-render triggered by another card (its delete confirmation opened)', /Permanently delete/.test(cardFor(privId2).textContent) && cardFor(privId).querySelector('[data-log-ride-date]').value === '2026-08-01');
  }

  console.log('8. Scope guard');
  {
    const dbSrc = fs.readFileSync(`${ROOT}worker/db.js`, 'utf8');
    const fn = dbSrc.slice(dbSrc.indexOf('async function logModeratorRide'), dbSrc.indexOf('// Public registry AGGREGATES for the homepage'));
    check('logModeratorRide only ever UPDATEs last_seen_at/updated_at on the vehicle — never visibility, vin, model, color, service_area, verification_status', /UPDATE robotaxi_vehicles SET last_seen_at = datetime\('now'\), updated_at = datetime\('now'\)/.test(fn) && (fn.match(/UPDATE robotaxi_vehicles/g) || []).length === 1);
    check('it adds no ride_key (no new identity scheme) and no migration was added', !/ride_key/.test(fn.replace(/\/\/.*$/gm, '')) && !fs.readdirSync(`${ROOT}migrations`).some(f => /^0015/.test(f)));
    const connectorSrc = fs.readFileSync(`${ROOT}worker/connector.js`, 'utf8');
    check('the Muse connector code does not reference the ride-logging function', !/logModeratorRide/.test(connectorSrc));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
