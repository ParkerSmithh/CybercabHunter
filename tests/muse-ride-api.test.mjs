// Tests for the Muse machine endpoint: POST /api/integrations/muse/robotaxi-rides
// (worker/muse-rides.js -> db.logManualRide) plus the shared ride-input validation.
// Real SQL (every migration) and the REAL Worker router. The token below is a dummy test value.
// Run: node tests/muse-ride-api.test.mjs

import fs from 'node:fs';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const VIN = '5YJSA1E14FF101183';
const iso = d => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const TOKEN = 'test-rides-token-not-a-real-secret';
const CONNECTOR_TOKEN = 'test-connector-token-not-a-real-secret';
const SYSTEM = 'muse-system';
const PATH = '/api/integrations/muse/robotaxi-rides';

async function makeApp({ token = TOKEN, owner = SYSTEM, limiter } = {}) {
  const ctx = await makeEnv({ users: ['mod', 'rider', SYSTEM] });
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  await ctx.env.TESLA_SESSIONS.put('session:session-mod', JSON.stringify({ user_id: 'mod' }));
  await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));
  if (token) ctx.env.MUSE_RIDES_TOKEN = token;
  if (owner) ctx.env.MUSE_CONNECTOR_USER_ID = owner;
  ctx.env.MUSE_CONNECTOR_TOKEN = CONNECTOR_TOKEN;
  if (limiter) ctx.env.MUSE_RIDES_LIMITER = limiter;
  return ctx;
}
function post(ctx, body, { auth = `Bearer ${TOKEN}`, raw, path = PATH, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: method === 'POST' ? (raw !== undefined ? raw : JSON.stringify(body)) : undefined }), ctx.env, {});
}
const json = r => r.json();
const count = (ctx, sql, ...a) => ctx.d1.query(sql, ...a)[0].n;
const get = (ctx, path) => worker.fetch(new Request(`https://x${path}`), ctx.env, {});

// A publicly ELIGIBLE vehicle: public + registry evidence (a sighting-origin vehicle with a VIN).
function mkVehicle(ctx, { plate = 'XJR1903', visibility = 'public', vin = VIN, origin = 'sighting' } = {}) {
  const id = crypto.randomUUID();
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, vin, origin, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`)
    .bind(id, plate, visibility, vin, origin)._exec();
  return id;
}
const vrowId = (ctx, plate) => ctx.d1.query('SELECT id FROM robotaxi_vehicles WHERE license_plate = ?', plate)[0].id;
const vrow = (ctx, id) => ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', id)[0];
const FROZEN = ['visibility', 'vin', 'model', 'color', 'service_area', 'verification_status', 'origin', 'license_plate', 'first_seen_at'];
const frozen = row => JSON.stringify(FROZEN.map(c => row[c]));

(async () => {
  console.log('1. Valid request, response shape, provenance');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const before = vrow(ctx, id);
    const r = await post(ctx, { plate: 'XJR1903', date: '2026-09-24', miles: 12.4 });
    const b = await json(r);
    check('201 with ok:true', r.status === 201 && b.ok === true);
    check('response is exactly { ok, vehicle:{id,license_plate}, ride:{id,date,miles} }',
      JSON.stringify(Object.keys(b)) === '["ok","vehicle","ride"]' && JSON.stringify(Object.keys(b.vehicle)) === '["id","license_plate"]' && JSON.stringify(Object.keys(b.ride)) === '["id","date","miles"]');
    check('vehicle id/plate, ride date and miles echo the request', b.vehicle.id === id && b.vehicle.license_plate === 'XJR1903' && b.ride.date === '2026-09-24' && b.ride.miles === 12.4);
    const s = ctx.d1.query('SELECT * FROM submissions')[0];
    const tr = ctx.d1.query('SELECT * FROM trips')[0];
    check('exactly one submission and one trip, linked, and the trip id is the ride id', count(ctx, 'SELECT COUNT(*) n FROM submissions') === 1 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 1 && tr.submission_id === s.id && tr.id === b.ride.id);
    check('system ownership: submission.user_id and trip.user_id are MUSE_CONNECTOR_USER_ID', s.user_id === SYSTEM && tr.user_id === SYSTEM);
    check('reviewed_by is NULL (no human reviewed it) and reviewed_at is set', s.reviewed_by === null && !!s.reviewed_at);
    check("provenance: evidence_type = 'muse_api' and trips.source = 'muse_api'", s.evidence_type === 'muse_api' && tr.source === 'muse_api');
    check('approved ride_receipt, distance 12.4 mi, no service_area, ride_key NULL, linked to the vehicle',
      s.status === 'approved' && s.submission_type === 'ride_receipt' && tr.distance === 12.4 && tr.distance_unit === 'mi' && tr.service_area === null && tr.ride_key === null && tr.robotaxi_vehicle_id === id);
    const after = vrow(ctx, id);
    check('last_seen_at advanced', after.last_seen_at !== before.last_seen_at);
    check('visibility, VIN, model, color, service_area, verification, origin, plate are untouched', frozen(after) === frozen(before));
    check('the response never contains the system owner id or the token', !JSON.stringify(b).includes(SYSTEM) && !JSON.stringify(b).includes(TOKEN));
  }

  console.log('2. Authentication and configuration');
  {
    const ctx = await makeApp();
    mkVehicle(ctx);
    const ok = { plate: 'XJR1903', date: '2026-09-24' };
    const none = await post(ctx, ok, { auth: null });
    check('missing credential -> 401 with WWW-Authenticate: Bearer', none.status === 401 && none.headers.get('WWW-Authenticate') === 'Bearer' && (await json(none)).error === 'unauthorized');
    check('wrong credential -> 401', (await post(ctx, ok, { auth: 'Bearer nope' })).status === 401);
    check('a non-Bearer scheme -> 401', (await post(ctx, ok, { auth: `Basic ${TOKEN}` })).status === 401);
    check('the sightings/connector token is rejected on the Muse rides route', (await post(ctx, ok, { auth: `Bearer ${CONNECTOR_TOKEN}` })).status === 401);
    check('a rider or moderator SESSION token is rejected', (await post(ctx, ok, { auth: 'Bearer session-mod' })).status === 401 && (await post(ctx, ok, { auth: 'Bearer session-rider' })).status === 401);
    check('the rides token is rejected by the connector route', (await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' }), ctx.env, {})).status === 401);
    check('nothing was written by any rejected request', count(ctx, 'SELECT COUNT(*) n FROM trips') === 0 && count(ctx, 'SELECT COUNT(*) n FROM submissions') === 0);
    const noBody = await post(ctx, null, { auth: null, raw: '{not json' });
    check('the body is not parsed before authentication (malformed JSON + no credential is still 401, not 400)', noBody.status === 401);
    ctx.env.ASSETS = { fetch: async () => new Response('static', { status: 404 }) }; // non-API paths fall through to static assets
    check('a non-POST method does not reach the handler (no ride written)', (await post(ctx, ok, { method: 'GET' })).status !== 201 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
  }
  {
    const noToken = await makeApp({ token: null });
    mkVehicle(noToken);
    const r = await post(noToken, { plate: 'XJR1903', date: '2026-09-24' }, { auth: `Bearer ${TOKEN}` });
    check('missing MUSE_RIDES_TOKEN -> 503 not_configured (fails closed, nothing written)', r.status === 503 && (await json(r)).error === 'not_configured' && count(noToken, 'SELECT COUNT(*) n FROM trips') === 0);
    const noOwner = await makeApp({ owner: null });
    mkVehicle(noOwner);
    const r2 = await post(noOwner, { plate: 'XJR1903', date: '2026-09-24' });
    check('missing MUSE_CONNECTOR_USER_ID -> 503 not_configured, nothing written', r2.status === 503 && (await json(r2)).error === 'not_configured' && count(noOwner, 'SELECT COUNT(*) n FROM trips') === 0);
    const ghost = await makeApp({ owner: 'no-such-user' });
    mkVehicle(ghost);
    const r3 = await post(ghost, { plate: 'XJR1903', date: '2026-09-24' });
    check('an owner id that is not a real user -> 503 not_configured, never falls back, nothing written', r3.status === 503 && count(ghost, 'SELECT COUNT(*) n FROM trips') === 0);
    const emptyTokenReq = await post(noToken, { plate: 'XJR1903', date: '2026-09-24' }, { auth: 'Bearer ' });
    check('an unconfigured server never authenticates an empty token', emptyTokenReq.status === 503);
  }

  console.log('3. Input validation (strict schema)');
  {
    const ctx = await makeApp();
    mkVehicle(ctx);
    const send = async body => { const r = await post(ctx, body); return [r.status, (await json(r)).error]; };
    const eq = (a, s, e) => a[0] === s && a[1] === e;
    check('non-object bodies -> 400 invalid_body', eq(await send([]), 400, 'invalid_body') && eq(await send('x'), 400, 'invalid_body') && eq(await send(null), 400, 'invalid_body'));
    check('unparseable JSON -> 400 invalid_body', (await post(ctx, null, { raw: '{oops' })).status === 400);
    check('missing plate -> 400 invalid_plate', eq(await send({ date: '2026-09-24' }), 400, 'invalid_plate'));
    check('non-string / empty / symbol-only / overlong plate -> 400 invalid_plate',
      eq(await send({ plate: 123, date: '2026-09-24' }), 400, 'invalid_plate') && eq(await send({ plate: '', date: '2026-09-24' }), 400, 'invalid_plate') &&
      eq(await send({ plate: ' - - ', date: '2026-09-24' }), 400, 'invalid_plate') && eq(await send({ plate: 'A'.repeat(30), date: '2026-09-24' }), 400, 'invalid_plate'));
    check('missing date -> 400 invalid_date', eq(await send({ plate: 'XJR1903' }), 400, 'invalid_date'));
    for (const bad of ['2026-9-24', '09/24/2026', '2026-02-30', '2026-13-01', 20260924, '2026-09-24T10:00:00Z', '']) {
      check(`invalid date ${JSON.stringify(bad)} -> 400 invalid_date`, eq(await send({ plate: 'XJR1903', date: bad }), 400, 'invalid_date'));
    }
    check('a future date -> 400 future_date (tomorrow and next year)', eq(await send({ plate: 'XJR1903', date: iso(new Date(Date.now() + 2 * 86400000)) }), 400, 'future_date') && eq(await send({ plate: 'XJR1903', date: iso(new Date(Date.now() + 366 * 86400000)) }), 400, 'future_date'));
    check('today (UTC) is accepted', (await post(ctx, { plate: 'XJR1903', date: TODAY })).status === 201);
    for (const bad of ['0', '-3', '"12.4"', 'true', '[]', '{}', '1e999']) {
      const r = await post(ctx, null, { raw: `{"plate":"XJR1903","date":"2026-08-01","miles":${bad}}` });
      check(`miles ${bad} -> 400 invalid_miles`, r.status === 400 && (await json(r)).error === 'invalid_miles');
    }
    check('miles 0 and negative are rejected with nothing written', count(ctx, 'SELECT COUNT(*) n FROM trips WHERE ride_date = ?', '2026-08-01') === 0);
    for (const extra of ['vin', 'model', 'color', 'service_area', 'user_id', 'status', 'reviewed_by', 'distance', 'distance_unit', 'source', 'evidence_type', 'visibility']) {
      const r = await post(ctx, { plate: 'XJR1903', date: '2026-07-01', miles: 5, [extra]: 'x' });
      check(`unknown top-level field "${extra}" -> 400 unknown_field`, r.status === 400 && (await json(r)).error === 'unknown_field');
    }
    check('none of the rejected requests wrote a ride on 2026-07-01', count(ctx, 'SELECT COUNT(*) n FROM trips WHERE ride_date = ?', '2026-07-01') === 0);
    const omitted = await post(ctx, { plate: 'XJR1903', date: '2026-06-01' });
    const ob = await json(omitted);
    check('omitted miles -> 201 with miles null and a NULL distance stored', omitted.status === 201 && ob.ride.miles === null && count(ctx, 'SELECT COUNT(*) n FROM trips WHERE ride_date = ? AND distance IS NULL', '2026-06-01') === 1);
    const nul = await post(ctx, { plate: 'XJR1903', date: '2026-05-01', miles: null });
    check('miles: null is treated as omitted', nul.status === 201 && (await json(nul)).ride.miles === null);
  }

  console.log('4. Plate lookup, normalization, and the no-vehicle-creation rule');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { plate: 'XJR1903' });
    const n = () => count(ctx, 'SELECT COUNT(*) n FROM robotaxi_vehicles');
    const start = n();
    let i = 0;
    for (const variant of ['xjr1903', ' xjr-1903 ', 'XJR 1903', 'x.j.r.1903']) {
      i += 1;
      const r = await post(ctx, { plate: variant, date: `2026-04-0${i}`, miles: 3 });
      const b = await json(r);
      check(`plate ${JSON.stringify(variant)} normalizes to XJR1903 and resolves the same vehicle`, r.status === 201 && b.vehicle.id === id && b.vehicle.license_plate === 'XJR1903');
    }
    const stored = mkVehicle(ctx, { plate: 'ABC-123' });
    const r = await post(ctx, { plate: 'abc 123', date: '2026-04-09' });
    check('a vehicle stored with a hyphen is found by a differently-punctuated plate', r.status === 201 && (await json(r)).vehicle.id === stored);
    const unknown = await post(ctx, { plate: 'ZZZ9999', date: '2026-04-09', miles: 2 });
    check('unknown plate -> 404 vehicle_not_found', unknown.status === 404 && (await json(unknown)).error === 'vehicle_not_found');
    check('no vehicle is ever created (the row count is unchanged by the unknown plate)', n() === start + 1 /* only the ABC-123 fixture */);
    check('and no ride was written for the unknown plate', count(ctx, `SELECT COUNT(*) n FROM trips WHERE robotaxi_vehicle_id NOT IN ('${id}', '${stored}')`) === 0);
  }

  console.log('5. Any existing registry vehicle accepts a ride; nothing about its status changes (no auto-approve / auto-publish)');
  {
    const ctx = await makeApp();
    const modGet = async scope => (await (await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles?scope=${scope}`, { headers: { Authorization: 'Bearer session-mod', Origin: 'https://cybercabhunter.com' } }), ctx.env, {})).json()).vehicles || [];
    const STATE = ['visibility', 'vin', 'vin_set_by_user_id', 'vin_set_at', 'model', 'color', 'service_area', 'verification_status', 'origin', 'license_plate', 'first_seen_at'];
    const state = id => JSON.stringify(STATE.map(c => vrow(ctx, id)[c]));
    const cases = [
      ['PRIV111', { visibility: 'private', vin: null, origin: 'receipt' }],
      ['PRIV222', { visibility: 'private', vin: VIN, origin: 'sighting' }],
      ['PRIV333', { visibility: 'private', vin: null, origin: 'sighting' }]
    ];
    for (const [plate, opts] of cases) {
      const id = mkVehicle(ctx, { plate, ...opts });
      const before = state(id);
      const r = await post(ctx, { plate, date: '2026-09-01', miles: 2 });
      const b = await json(r);
      check(`private/pending vehicle ${plate} (${opts.origin}, vin ${opts.vin ? 'set' : 'none'}) accepts a ride -> 201`, r.status === 201 && b.ok === true && b.vehicle.id === id && b.ride.miles === 2);
      check(`${plate}: visibility, VIN, verification status, model, color, service area, origin and plate are byte-for-byte unchanged`, state(id) === before && vrow(ctx, id).visibility === 'private');
      check(`${plate}: the ride is a system-owned muse_api ride with reviewed_by NULL`, count(ctx, `SELECT COUNT(*) n FROM trips t JOIN submissions s ON s.id = t.submission_id WHERE t.robotaxi_vehicle_id = ? AND t.source = 'muse_api' AND s.evidence_type = 'muse_api' AND s.reviewed_by IS NULL AND s.user_id = ? AND t.user_id = ?`, id, SYSTEM, SYSTEM) === 1);
      const pub = await get(ctx, `/api/robotaxi-vehicles/${id}`);
      check(`${plate}: still NOT public — its public page is 404`, pub.status === 404);
    }
    check('no vehicle was approved or published: the public list and stats are still empty', (await (await get(ctx, '/api/registry/stats')).json()).public_vehicles === 0 && (await (await get(ctx, '/api/robotaxi-vehicles')).json()).total === 0);
    check('no approval/return review rows were written', count(ctx, 'SELECT COUNT(*) n FROM robotaxi_vehicle_reviews') === 0);
    const cards = await modGet('private');
    check('the moderator registry list still shows all three as PRIVATE (so the moderator can review them with the ride data in front of them)', cards.length === 3 && cards.every(v => v.visibility === 'private'));
    check('the moderator card for a pending vehicle now shows its counted ride (the point of the change)', (cards.find(v => v.license_plate === 'PRIV222') || {}).counted_ride_count === 1);
    check('a second ride on a pending vehicle still 201s and duplicates still 409', (await post(ctx, { plate: 'PRIV111', date: '2026-09-02' })).status === 201 && (await post(ctx, { plate: 'PRIV111', date: '2026-09-02' })).status === 409);
    const nope = await post(ctx, { plate: 'NOPE000', date: '2026-09-01', miles: 2 });
    check('a plate with no registry vehicle at all -> 404 vehicle_not_found', nope.status === 404 && (await json(nope)).error === 'vehicle_not_found');
    check('and no vehicle is ever created', count(ctx, 'SELECT COUNT(*) n FROM robotaxi_vehicles') === 3);
    // Public vehicles behave exactly as before.
    const pubId = mkVehicle(ctx, { plate: 'PUB4444', visibility: 'public', vin: VIN, origin: 'sighting' });
    const pubBefore = state(pubId);
    const ok = await post(ctx, { plate: 'PUB4444', date: '2026-09-01', miles: 2 });
    check('a public vehicle still accepts a ride exactly as before (201, status untouched)', ok.status === 201 && state(pubId) === pubBefore);
    // Deleting a vehicle removes it entirely, so it is then "no vehicle" -> 404.
    const gone = mkVehicle(ctx, { plate: 'GONE555', visibility: 'private', vin: null, origin: 'receipt' });
    ctx.d1.prepare('DELETE FROM robotaxi_vehicles WHERE id = ?').bind(gone)._exec();
    check('a deleted vehicle is 404 vehicle_not_found', (await post(ctx, { plate: 'GONE555', date: '2026-09-01' })).status === 404);
    // The db layer keeps its optional eligibility switch (off for this route).
    const direct = await db.logManualRide(ctx.d1, { vehicleId: vrowId(ctx, 'PRIV333'), ownerUserId: SYSTEM, source: 'muse_api', requirePublicEligible: true, rideDate: '2026-09-09', distance: 1 });
    check('db.logManualRide still supports requirePublicEligible (refuses a private vehicle when asked)', direct.status === 'not_found');
  }
  {
    // Documented consequence: a vehicle a moderator ALREADY made public (visibility stays exactly as set) but that has no
    // registry evidence becomes evidence-backed by its first counted ride, exactly as with the moderator's Log ride.
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { plate: 'NOEV222', visibility: 'public', vin: null, origin: 'sighting' });
    const before = (await (await get(ctx, '/api/registry/stats')).json()).public_vehicles;
    const r = await post(ctx, { plate: 'NOEV222', date: '2026-09-01', miles: 2 });
    check('an already-public vehicle keeps visibility public after a Muse ride (never flipped either way)', r.status === 201 && vrow(ctx, id).visibility === 'public');
    void before;
  }
  {
    const ctx = await makeApp();
    mkVehicle(ctx, { plate: 'DUP0001', visibility: 'public' });
    mkVehicle(ctx, { plate: 'DUP-0001', visibility: 'private' });
    const r = await post(ctx, { plate: 'dup 0001', date: '2026-09-01' });
    check('an ambiguous normalized plate (two vehicles) -> 409 ambiguous_plate and nothing written', r.status === 409 && (await json(r)).error === 'ambiguous_plate' && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
  }

  console.log('6. Duplicates (same vehicle + date + distance; NULL matches NULL)');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const send = (date, miles) => post(ctx, miles === undefined ? { plate: 'XJR1903', date } : { plate: 'XJR1903', date, miles });
    check('first ride 201', (await send('2026-09-10', 5)).status === 201);
    const dup = await send('2026-09-10', 5);
    check('same date + same distance -> 409 duplicate_ride, nothing added', dup.status === 409 && (await json(dup)).error === 'duplicate_ride' && count(ctx, 'SELECT COUNT(*) n FROM trips') === 1);
    check('same date, different distance is a different ride', (await send('2026-09-10', 6)).status === 201);
    check('different date, same distance is a different ride', (await send('2026-09-11', 5)).status === 201);
    check('NULL distance: first 201', (await send('2026-09-12')).status === 201);
    check('NULL distance again -> 409 (NULL matches NULL)', (await send('2026-09-12')).status === 409);
    check('a NULL-distance ride does not block a measured ride on the same date', (await send('2026-09-12', 4)).status === 201);
    const before = count(ctx, 'SELECT COUNT(*) n FROM trips');
    const seenBefore = vrow(ctx, id).last_seen_at;
    await send('2026-09-10', 5);
    check('a duplicate writes nothing and leaves last_seen_at alone', count(ctx, 'SELECT COUNT(*) n FROM trips') === before && vrow(ctx, id).last_seen_at === seenBefore);
    // Cross-source: the moderator path's ride blocks the Muse ride and vice versa (one shared guard).
    await db.logModeratorRide(ctx.d1, { vehicleId: id, moderatorId: 'mod', ownerUserId: SYSTEM, rideDate: '2026-09-20', distance: 7 });
    check('a moderator-logged ride blocks an identical Muse ride (same guard)', (await send('2026-09-20', 7)).status === 409);
    await send('2026-09-21', 8);
    const viaMod = await db.logModeratorRide(ctx.d1, { vehicleId: id, moderatorId: 'mod', ownerUserId: SYSTEM, rideDate: '2026-09-21', distance: 8 });
    check('and a Muse ride blocks an identical moderator ride', viaMod.status === 'duplicate');
    const [a, b] = await Promise.all([send('2026-09-25', 3), send('2026-09-25', 3)]);
    check('two identical concurrent Muse requests: exactly one 201 and one 409', [a.status, b.status].sort().join() === '201,409');
    check('and never a submission without its trip', count(ctx, `SELECT COUNT(*) n FROM submissions s WHERE s.evidence_type = 'muse_api' AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.submission_id = s.id)`) === 0);
  }

  console.log('7. Atomicity and failure handling');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    ctx.d1.exec(`CREATE TRIGGER refuse_touch BEFORE UPDATE OF last_seen_at ON robotaxi_vehicles BEGIN SELECT RAISE(ABORT, 'forced failure on the last write'); END;`);
    const r = await post(ctx, { plate: 'XJR1903', date: '2026-09-01', miles: 2 });
    const b = await json(r);
    check('a failure in the LAST statement -> 500 internal_error with no internals', r.status === 500 && b.error === 'internal_error' && !JSON.stringify(b).includes('forced'));
    check('and the whole batch rolled back: no submission, no trip', count(ctx, 'SELECT COUNT(*) n FROM submissions') === 0 && count(ctx, 'SELECT COUNT(*) n FROM trips') === 0);
    ctx.d1.exec('DROP TRIGGER refuse_touch');
    check('once the fault is removed the same request succeeds', (await post(ctx, { plate: 'XJR1903', date: '2026-09-01', miles: 2 })).status === 201);
    void id;
  }

  console.log('8. Public aggregation, ownership survival, and the moderator path unchanged');
  {
    const ctx = await makeApp();
    const id = mkVehicle(ctx);
    const s0 = await (await get(ctx, '/api/registry/stats')).json();
    check('baseline: 1 public vehicle, 0 recorded rides', s0.public_vehicles === 1 && s0.recorded_rides === 0);
    await post(ctx, { plate: 'XJR1903', date: '2026-09-10', miles: 5 });
    await post(ctx, { plate: 'XJR1903', date: '2026-09-11' });
    const s1 = await (await get(ctx, '/api/registry/stats')).json();
    check('the existing homepage aggregation counts both Muse rides', s1.public_vehicles === 1 && s1.recorded_rides === 2);
    const detail = await (await get(ctx, `/api/robotaxi-vehicles/${id}`)).json();
    check('the public detail history counts both rides and sums 5 mi (the NULL-distance ride adds nothing)', detail.history.trip_count === 2 && detail.history.total_distance === 5);
    check('the public detail never exposes the system owner id or provenance', !JSON.stringify(detail).includes(SYSTEM) && !JSON.stringify(detail).includes('muse_api'));
    const list = await (await get(ctx, '/api/robotaxi-vehicles')).json();
    check('the public list shows the vehicle and never the owner id', list.vehicles.length === 1 && !JSON.stringify(list).includes(SYSTEM));
    // Deleting a rider's rides cannot touch system-owned rides.
    ctx.d1.exec(`UPDATE users SET role = 'user' WHERE id = 'mod'`);
    seedRide(ctx.d1, { id: 'rider-own', userId: 'rider', status: 'approved' });
    const del = await worker.fetch(new Request('https://x/api/trips', { method: 'DELETE', headers: { Authorization: 'Bearer session-mod', 'Content-Type': 'application/json', Origin: 'https://cybercabhunter.com' }, body: JSON.stringify({ confirm: 'delete-all-rides' }) }), ctx.env, {});
    const delRider = await worker.fetch(new Request('https://x/api/trips', { method: 'DELETE', headers: { Authorization: 'Bearer session-rider', 'Content-Type': 'application/json', Origin: 'https://cybercabhunter.com' }, body: JSON.stringify({ confirm: 'delete-all-rides' }) }), ctx.env, {});
    check("a rider's (and a moderator's) delete-all removes only their own rides — the Muse rides stay",
      delRider.status === 200 && del.status === 200 && count(ctx, `SELECT COUNT(*) n FROM trips WHERE id = 'rider-own'`) === 0 && count(ctx, `SELECT COUNT(*) n FROM trips WHERE source = 'muse_api'`) === 2);
  }
  {
    // The moderator endpoint is unchanged: same route, same provenance, same fields.
    const ctx = await makeApp();
    const id = mkVehicle(ctx, { visibility: 'private', vin: null, origin: 'receipt' });
    const r = await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${id}/rides`, {
      method: 'POST', headers: { Authorization: 'Bearer session-mod', 'Content-Type': 'application/json', Origin: 'https://cybercabhunter.com' },
      body: JSON.stringify({ ride_date: '2026-09-01', distance: 4, distance_unit: 'mi' })
    }), ctx.env, {});
    const s = ctx.d1.query('SELECT * FROM submissions')[0];
    const tr = ctx.d1.query('SELECT * FROM trips')[0];
    check('the moderator endpoint still works (201) and records manual_entry provenance with reviewed_by = the moderator and the system owner', r.status === 201 && s.evidence_type === 'manual_entry' && tr.source === 'manual_entry' && s.reviewed_by === 'mod' && s.user_id === SYSTEM && tr.user_id === SYSTEM);
    const muse = await post(ctx, { plate: 'XJR1903', date: '2026-09-02' });
    check('and the Muse route now also accepts that (private) vehicle, leaving it private', muse.status === 201 && vrow(ctx, id).visibility === 'private');
  }

  console.log('9. Rate limiting (abuse brake only)');
  {
    let calls = 0; const keys = [];
    const limiter = { async limit({ key }) { calls += 1; keys.push(key); return { success: calls <= 2 }; } };
    const ctx = await makeApp({ limiter });
    mkVehicle(ctx);
    const send = date => post(ctx, { plate: 'XJR1903', date, miles: 1 });
    check('within the limit requests succeed', (await send('2026-09-01')).status === 201 && (await send('2026-09-02')).status === 201);
    const limited = await send('2026-09-03');
    check('over the limit -> 429 rate_limited with Retry-After and nothing written', limited.status === 429 && (await json(limited)).error === 'rate_limited' && limited.headers.get('Retry-After') === '60' && count(ctx, 'SELECT COUNT(*) n FROM trips') === 2);
    check('the key is the stable route key — not the token and not an IP', keys.every(k => k === 'muse-robotaxi-rides') && !keys.some(k => k.includes(TOKEN)));
    const before = calls;
    await post(ctx, { plate: 'XJR1903', date: '2026-09-04' }, { auth: 'Bearer wrong' });
    check('unauthenticated requests never reach (or consume) the limiter', calls === before);
    const badLimiter = { async limit() { throw new Error('limiter down'); } };
    const ctx2 = await makeApp({ limiter: badLimiter });
    mkVehicle(ctx2);
    check('a limiter failure fails open — the D1 write is the authority', (await post(ctx2, { plate: 'XJR1903', date: '2026-09-01' })).status === 201);
    const ctx3 = await makeApp();
    mkVehicle(ctx3);
    check('with no binding at all (local/test) requests still work', (await post(ctx3, { plate: 'XJR1903', date: '2026-09-01' })).status === 201);
    const ctx4 = await makeApp({ limiter: { async limit() { return { success: false }; } } });
    mkVehicle(ctx4);
    check('the limiter runs after authentication and before the D1 write: a blocked request writes nothing', (await post(ctx4, { plate: 'XJR1903', date: '2026-09-01' })).status === 429 && count(ctx4, 'SELECT COUNT(*) n FROM trips') === 0);
    const cfg = fs.readFileSync(`${ROOT}wrangler.jsonc`, 'utf8');
    check('wrangler.jsonc declares the MUSE_RIDES_LIMITER binding (ratelimits, simple 30 / 60s)', /"ratelimits"[\s\S]*"name":\s*"MUSE_RIDES_LIMITER"[\s\S]*"limit":\s*30[\s\S]*"period":\s*60/.test(cfg));
  }

  console.log('10. Secrets and scope guards');
  {
    const cfg = fs.readFileSync(`${ROOT}wrangler.jsonc`, 'utf8');
    check('no MUSE token or user id value is in wrangler.jsonc (secrets are never vars)', !/MUSE_RIDES_TOKEN|MUSE_CONNECTOR_TOKEN|MUSE_CONNECTOR_USER_ID/.test(cfg));
    const src = ['worker/muse-rides.js', 'worker/ride-input.js', 'worker/connector.js'].map(f => fs.readFileSync(`${ROOT}${f}`, 'utf8')).join('\n');
    check('the handler never logs (no console.* in the Muse route or shared validation)', !/console\./.test(fs.readFileSync(`${ROOT}worker/muse-rides.js`, 'utf8')) && !/console\./.test(fs.readFileSync(`${ROOT}worker/ride-input.js`, 'utf8')));
    check('no frontend file mentions the Muse rides route or token', !fs.readdirSync(`${ROOT}js`).some(f => /MUSE_RIDES|integrations\/muse/.test(fs.readFileSync(`${ROOT}js/${f}`, 'utf8'))));
    check('no migration was added', !fs.readdirSync(`${ROOT}migrations`).some(f => f.startsWith('0015')));
    const handler = fs.readFileSync(`${ROOT}worker/muse-rides.js`, 'utf8');
    check("the route hard-codes provenance: reviewedBy null, source 'muse_api'; and no longer requires public eligibility", /reviewedBy: null/.test(handler) && /source: 'muse_api'/.test(handler) && !/requirePublicEligible/.test(handler));
    check('the handler cannot create vehicles (no INSERT and no findOrCreate call)', !/INSERT|findOrCreate/i.test(handler));
    check('ride_key and the public aggregation are untouched', !/ride_key/.test(handler) && !/physicalRidesFrom/.test(handler));
    void src;
  }

  t.finish();
})();
