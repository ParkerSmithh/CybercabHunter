// Tests for Phase 3E: registry trust hardening.
//   - one shared plate normalizer (worker/plate.js)
//   - race-safe, deterministic registry vehicle creation (private by default)
//   - unique / ambiguous / no-match plate resolution
//   - the public eligibility gate (visibility 'public' AND a counted ride)
//   - the moderator visibility endpoints
//   - the read-only production preflight (worker/registry-preflight.js)
// Real SQL (every migration, node:sqlite) and the REAL Worker router.
//
// Concurrency note: the SQL runs on a single synchronous SQLite connection,
// so the concurrent-creation checks prove the application no longer does a
// separate SELECT-then-INSERT that concurrent calls can interleave. They do
// NOT prove anything about Cloudflare D1's behavior under real parallel load.
// Run: node tests/registry-trust.test.mjs

import fs from 'node:fs';
import { makeEnv, seedRide, seedVehicle, approveVehicle, makeCheck } from './helpers/env.mjs';
import { receiptBody } from './helpers/receipts.mjs';
import { db } from '../worker/db.js';
import { normalizePlate, sqlNormalizedPlate } from '../worker/plate.js';
import { normalizePlate as canonicalNormalizePlate } from '../worker/ride-canonical.js';
import { REGISTRY_PREFLIGHT, runRegistryPreflight } from '../worker/registry-preflight.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}

function call(ctx, method, path, userId, body, rawBody) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, {
    method, headers, body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined)
  }), ctx.env, {});
}

async function pub(ctx, path) {
  const resp = await call(ctx, 'GET', path, null);
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: resp.status, text, json, cache: resp.headers.get('Cache-Control') };
}
const vehiclePage = (ctx, id) => pub(ctx, `/api/robotaxi-vehicles/${id}`);
const sightingsOf = (ctx, id) => pub(ctx, `/api/robotaxi-vehicles/${id}/sightings`);
const vehicleRow = (ctx, id) => ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', id)[0];
const vehicleCount = ctx => ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n;
const snapshot = (ctx, table, where = '1=1') => JSON.stringify(ctx.d1.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`));

async function submitSighting(ctx, userId, fields) {
  return (await call(ctx, 'POST', '/api/vehicle-sightings', userId, { service_area: 'Dallas', ...fields })).json();
}
async function approveSighting(ctx, submissionId) {
  return call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${submissionId}`, 'mod', { action: 'approve' });
}
// Raw registry row for tests that need specific/duplicate rows (bypasses findOrCreate on purpose).
function rawVehicle(ctx, id, plate, { visibility = 'private', firstSeenAt = '2026-06-01 00:00:00' } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, plate, visibility, firstSeenAt, firstSeenAt)._exec();
  return id;
}
const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';
const MISSING = '99999999-9999-4999-8999-999999999999';

async function run() {
  console.log('1. Plate normalization: one shared definition, behavior unchanged');
  {
    const cases = [
      ['xjr2195', 'XJR2195'], ['XJR 2195', 'XJR2195'], ['xjr-2195', 'XJR2195'], ['xjr.2195', 'XJR2195'],
      ['XJR_2195', 'XJR2195'], ['  xjr\t2195 ', 'XJR2195'], ['XJR2195', 'XJR2195'], ['a/b\\c!d', 'ABCD'],
      ['', ''], [null, ''], [undefined, ''], ['---', ''], ['   ', ''], [12345, '12345'],
      ['O0I1', 'O0I1'],                                   // look-alikes are NOT merged
      ['ß12', 'SS12'], ['ı12', 'I12'], ['ſ12', 'S12'], ['ﬁ12', 'FI12'],   // Unicode folding, exactly as before
      ['ＸＪＲ２１９５', ''], ['K12', '12']                        // fullwidth / Kelvin sign are removed, as before
    ];
    for (const [input, expected] of cases) check(`normalizePlate(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, normalizePlate(input) === expected);
    check('deterministic: the same input always gives the same output', normalizePlate('xjr-2195') === normalizePlate('xjr-2195') && normalizePlate('xjr-2195') === normalizePlate(normalizePlate('xjr-2195')));
    check('idempotent on already-normalized plates', ['XJR2195', 'A1', 'SS12'].every(p => normalizePlate(p) === p));

    check('receipt canonicalization delegates to it and adds only its 2-10 length rule',
      canonicalNormalizePlate('xjr-2195') === 'XJR2195' && canonicalNormalizePlate('A') === null && canonicalNormalizePlate('A'.repeat(11)) === null && canonicalNormalizePlate('') === null && canonicalNormalizePlate(null) === null);
    check('SQL-side normalization agrees for every shape the app itself stores', sqlNormalizedPlate('x') === "UPPER(REPLACE(REPLACE(x, '-', ''), ' ', ''))");

    // No worker file may carry its own copy of the normalization regex any more.
    const offenders = fs.readdirSync(`${ROOT}worker`).filter(f => f.endsWith('.js') && f !== 'plate.js')
      .filter(f => /toUpperCase\(\)\s*\.replace\(\s*\/\[\^A-Z0-9\]\/g/.test(fs.readFileSync(`${ROOT}worker/${f}`, 'utf8')));
    check('no other worker file duplicates the normalization regex', offenders.length === 0);
    const users = ['db.js', 'sightings.js', 'ride-canonical.js'].filter(f => /from '\.\/plate\.js'/.test(fs.readFileSync(`${ROOT}worker/${f}`, 'utf8')));
    check('registry, sighting and receipt code all import the shared module', users.length === 3);
  }
  {
    // End to end: every path reaches the same registry identity.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.8 mi · 14 min · XJR2195' }) }] });
    check('a receipt created exactly one registry vehicle with the normalized plate', vehicleCount(ctx) === 1 && vehicleRow(ctx, ctx.d1.query('SELECT id FROM robotaxi_vehicles')[0].id).license_plate === 'XJR2195');
    const s = await submitSighting(ctx, 'rider', { license_plate: 'xjr-2195' });
    const obs = ctx.d1.query('SELECT robotaxi_vehicle_id AS v, license_plate AS p FROM vehicle_observations WHERE submission_id = ?', s.submission_id)[0];
    check('a differently formatted sighting plate is stored normalized and links to that same vehicle', obs.p === 'XJR2195' && obs.v === ctx.d1.query('SELECT id FROM robotaxi_vehicles')[0].id);
    check('and the sighting created no registry vehicle', vehicleCount(ctx) === 1);
  }
  {
    // Existing stored values are never rewritten.
    const ctx = await makeApp({ rider: 'user' });
    rawVehicle(ctx, V1, 'abc-123');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'ABC123');
    check('a legacy row stored as "abc-123" is reused for "ABC123"', id === V1 && vehicleCount(ctx) === 1);
    check('its stored plate text was NOT rewritten', vehicleRow(ctx, V1).license_plate === 'abc-123');
  }

  console.log('2. Vehicle creation: race-safe, reuses the existing vehicle, private by default');
  {
    const ctx = await makeApp({ rider: 'user' });
    const id = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'xjr-2195');
    const row = vehicleRow(ctx, id);
    check('a new vehicle is stored normalized', row.license_plate === 'XJR2195');
    check('a new vehicle is NOT public: it starts private', row.visibility === 'private');
    check('a new vehicle starts unverified with no invented metadata', row.verification_status === 'unverified' && row.model === null && row.color === null && row.service_area === null);
    check('the database default was not changed (explicit application behavior, no migration)', ctx.d1.query("SELECT dflt_value FROM pragma_table_info('robotaxi_vehicles') WHERE name = 'visibility'")[0].dflt_value === "'public'");

    const again = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR 2195');
    check('the same plate (different spelling) reuses the existing vehicle id', again === id && vehicleCount(ctx) === 1);
  }
  {
    // last_seen_at advances, and nothing else about an existing vehicle is overwritten.
    const ctx = await makeApp({ rider: 'user' });
    rawVehicle(ctx, V1, 'XJR2195', { visibility: 'public', firstSeenAt: '2020-01-01 00:00:00' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET model = 'Model Y', color = 'White', service_area = 'Dallas', verification_status = 'verified' WHERE id = '${V1}'`);
    const before = vehicleRow(ctx, V1);
    await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    const after = vehicleRow(ctx, V1);
    check('last_seen_at was advanced', after.last_seen_at > before.last_seen_at);
    check('first_seen_at was not touched', after.first_seen_at === before.first_seen_at);
    check('model, color and service area were not overwritten', after.model === 'Model Y' && after.color === 'White' && after.service_area === 'Dallas');
    check('verification_status was not overwritten', after.verification_status === 'verified');
    check('visibility was not changed by a later receipt (public stays public)', after.visibility === 'public');
    check('the plate text and id are unchanged', after.license_plate === before.license_plate && after.id === V1);
  }
  {
    // Reproduces the audit's "8 concurrent calls -> 8 rows" case.
    const ctx = await makeApp({ rider: 'user' });
    const ids = await Promise.all(Array.from({ length: 8 }, () => db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'RACE777')));
    check('8 concurrent creations of one plate return ONE id', new Set(ids).size === 1);
    check('and produce exactly one registry row (previously 8)', ctx.d1.query("SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE license_plate = 'RACE777'")[0].n === 1);

    const ctx2 = await makeApp({ rider: 'user' });
    const spellings = ['RACE-777', 'race 777', 'Race777', 'RACE.777', ' race777 ', 'RACE777', 'r-a-c-e-7-7-7', 'RACE777'];
    const ids2 = await Promise.all(spellings.map(p => db.findOrCreateRobotaxiVehicleByPlate(ctx2.d1, p)));
    check('concurrent calls with different spellings of one plate also converge on one row', new Set(ids2).size === 1 && vehicleCount(ctx2) === 1);

    const ctx3 = await makeApp({ rider: 'user' });
    const mixed = await Promise.all(['AAA1111', 'BBB2222', 'AAA-1111', 'BBB 2222', 'CCC3333'].map(p => db.findOrCreateRobotaxiVehicleByPlate(ctx3.d1, p)));
    check('concurrent creations of DIFFERENT plates still each get their own vehicle', vehicleCount(ctx3) === 3 && new Set(mixed).size === 3);
  }
  {
    const ctx = await makeApp({ rider: 'user' });
    check('a plate with nothing left after normalization creates nothing and returns null', (await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, '---')) === null && (await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, '')) === null && vehicleCount(ctx) === 0);
  }
  {
    // Legacy duplicates: never merged, never guessed at, never multiplied.
    const ctx = await makeApp({ rider: 'user' });
    rawVehicle(ctx, V2, 'DUP1234', { firstSeenAt: '2026-03-01 00:00:00' });
    rawVehicle(ctx, V1, 'dup-1234', { firstSeenAt: '2026-01-01 00:00:00' });
    const before = snapshot(ctx, 'robotaxi_vehicles');
    const a = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'DUP1234');
    const b = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'DUP1234');
    check('with existing duplicates a new ride deterministically attaches to the OLDEST row, every time', a === V1 && b === V1);
    check('no new row was created, none deleted, none merged', vehicleCount(ctx) === 2);
    const rows = ctx.d1.query('SELECT id, license_plate, visibility FROM robotaxi_vehicles ORDER BY id');
    check('both duplicate rows keep their ids, plates and visibility', rows.length === 2 && rows.find(r => r.id === V2).license_plate === 'DUP1234' && rows.find(r => r.id === V1).license_plate === 'dup-1234');
    check('only the chosen row\'s last_seen_at moved', vehicleRow(ctx, V2).last_seen_at === JSON.parse(before).find(r => r.id === V2).last_seen_at);
  }

  console.log('3. Deterministic lookups: none / unique / ambiguous');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    check('no match -> status none, no id', JSON.stringify(await db.resolveRobotaxiVehicleByPlate(ctx.d1, 'NOPE123')) === '{"status":"none","vehicleId":null}');
    check('a blank plate -> none', (await db.resolveRobotaxiVehicleByPlate(ctx.d1, '---')).status === 'none');
    rawVehicle(ctx, V1, 'UNI1234');
    const unique = await db.resolveRobotaxiVehicleByPlate(ctx.d1, 'uni-1234');
    check('exactly one row -> status unique with its id (normalization-insensitive)', unique.status === 'unique' && unique.vehicleId === V1);
    rawVehicle(ctx, V2, 'AMB1234'); rawVehicle(ctx, V3, 'amb-1234');
    const amb = await db.resolveRobotaxiVehicleByPlate(ctx.d1, 'AMB1234');
    check('two rows -> status ambiguous and NO id is offered', amb.status === 'ambiguous' && amb.vehicleId === null);
    check('the read-only finder returns an id only for a unique match', (await db.findRobotaxiVehicleByPlate(ctx.d1, 'UNI1234')) === V1 && (await db.findRobotaxiVehicleByPlate(ctx.d1, 'AMB1234')) === null && (await db.findRobotaxiVehicleByPlate(ctx.d1, 'NOPE123')) === null);
    check('resolving is read-only: nothing was created or changed', vehicleCount(ctx) === 3);

    // Submit-time linking follows the same rule.
    const link = async plate => ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', (await submitSighting(ctx, 'rider', { license_plate: plate })).submission_id)[0].v;
    check('a sighting of a unique plate links to that vehicle', (await link('UNI1234')) === V1);
    check('a sighting of an unknown plate is left unlinked', (await link('NOPE123')) === null);
    check('a sighting of an AMBIGUOUS plate is left unlinked, not attached to an arbitrary duplicate', (await link('AMB1234')) === null);
    check('none of those sightings created or changed a registry row', vehicleCount(ctx) === 3);
  }

  console.log('4. Public eligibility gate: visibility public AND a counted, non-superseded ride');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const mk = (id, plate, visibility = 'public') => rawVehicle(ctx, id, plate, { visibility });
    const cases = {};
    cases.counted = mk('aaaaaaaa-0000-4000-8000-000000000001', 'CNT0001'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.counted, status: 'pending' });
    cases.approved = mk('aaaaaaaa-0000-4000-8000-000000000002', 'APR0002'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.approved, status: 'approved' });
    cases.zero = mk('aaaaaaaa-0000-4000-8000-000000000003', 'ZER0003');
    cases.review = mk('aaaaaaaa-0000-4000-8000-000000000004', 'REV0004'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.review, status: 'needs_review' });
    cases.rejected = mk('aaaaaaaa-0000-4000-8000-000000000005', 'REJ0005'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.rejected, status: 'rejected' });
    cases.privateCounted = mk('aaaaaaaa-0000-4000-8000-000000000006', 'PRV0006', 'private'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.privateCounted, status: 'pending' });
    cases.supersededOnly = mk('aaaaaaaa-0000-4000-8000-000000000007', 'SUP0007');
    const winner = seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.counted, status: 'pending' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.supersededOnly, status: 'pending', supersededBy: winner });
    cases.mixed = mk('aaaaaaaa-0000-4000-8000-000000000008', 'MIX0008');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.mixed, status: 'needs_review' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.mixed, status: 'pending' });

    const expect = { counted: 200, approved: 200, zero: 404, review: 404, rejected: 404, privateCounted: 404, supersededOnly: 404, mixed: 200 };
    const labels = {
      counted: 'public + a counted (pending) ride -> served', approved: 'public + an approved ride -> served',
      zero: 'public + zero rides -> 404', review: 'public + only needs_review rides -> 404', rejected: 'public + only rejected rides -> 404',
      privateCounted: 'private + a counted ride -> 404', supersededOnly: 'public + only a superseded ride -> 404',
      mixed: 'public + a needs_review ride AND a counted ride -> served'
    };
    for (const [k, status] of Object.entries(expect)) {
      const v = await vehiclePage(ctx, cases[k]); const s = await sightingsOf(ctx, cases[k]);
      check(`${labels[k]} (vehicle endpoint)`, v.status === status);
      check(`${labels[k]} (sightings endpoint uses the identical rule)`, s.status === status);
    }
    check('a nonexistent vehicle -> 404 on both endpoints', (await vehiclePage(ctx, MISSING)).status === 404 && (await sightingsOf(ctx, MISSING)).status === 404);
    check('only counted rides are reported publicly (the needs_review one is not counted)', (await vehiclePage(ctx, cases.mixed)).json.history.trip_count === 1);

    check('ineligible vehicles are hidden, not deleted', ['zero', 'review', 'rejected', 'privateCounted', 'supersededOnly'].every(k => !!vehicleRow(ctx, cases[k])));

    // Hiding is reversible without touching the vehicle: a review-only vehicle becomes visible when its ride is upgraded.
    ctx.d1.exec(`UPDATE submissions SET status = 'pending' WHERE id IN (SELECT submission_id FROM trips WHERE robotaxi_vehicle_id = '${cases.review}')`);
    check('once a ride becomes counted the same vehicle becomes public, with no other change', (await vehiclePage(ctx, cases.review)).status === 200);
  }
  {
    // A rider deleting their only trip takes the vehicle out of public view (audit: it used to stay).
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = rawVehicle(ctx, V1, 'DEL1234', { visibility: 'public' });
    const trip = seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending' });
    check('while its trip exists the vehicle is public', (await vehiclePage(ctx, id)).status === 200);
    const del = await call(ctx, 'DELETE', `/api/trips/${trip}`, 'rider');
    check('the rider can still delete the trip', del.status === 200 && ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0);
    check('the vehicle row is not deleted', !!vehicleRow(ctx, id));
    check('but with no counted ride it is no longer public (previously it stayed public with 0 rides)', (await vehiclePage(ctx, id)).status === 404 && (await sightingsOf(ctx, id)).status === 404);
  }

  console.log('5. End to end: a receipt creates an INTERNAL vehicle; only a moderator makes it public');
  {
    const ctx = await makeApp({ rider: 'user', other: 'user', mod: 'moderator' });
    // A fabricated but well-formed pasted receipt for an arbitrary plate (the audit's attack).
    const imp = await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.8 mi · 14 min · FAKE999' }) }] });
    const result = (await imp.json()).results[0];
    check('the forged receipt is accepted as a counted ride (this phase does not authenticate receipts)', result.outcome === 'created' && result.review_status === 'accepted');
    const id = ctx.d1.query("SELECT id FROM robotaxi_vehicles WHERE license_plate = 'FAKE999'")[0].id;
    check('a registry vehicle was created internally, private', vehicleRow(ctx, id).visibility === 'private');
    check('it is NOT publicly retrievable even though it has a counted ride', (await vehiclePage(ctx, id)).status === 404 && (await sightingsOf(ctx, id)).status === 404);
    check('the rider\'s own ride history still works (their data is unaffected)', (await (await call(ctx, 'GET', '/api/trips', 'rider')).json()).trips.length === 1);

    check('a signed-in ordinary user cannot make it public', (await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, 'other', { visibility: 'public' })).status === 403 && vehicleRow(ctx, id).visibility === 'private');
    check('the rider who imported it cannot make it public either', (await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, 'rider', { visibility: 'public' })).status === 403);

    // Public visibility is granted ONLY by the review action (Phase 3H); PATCH can no longer do it.
    const ok = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_public' });
    check('a moderator approves it (through the review action)', ok.status === 200);
    check('now it is public', (await vehiclePage(ctx, id)).status === 200);
    await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, 'mod', { visibility: 'private' });
    check('and a moderator can take it down again', (await vehiclePage(ctx, id)).status === 404);
  }
  {
    // A needs_review receipt creates a vehicle too — but moderator approval still cannot make it public without a counted ride.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const body = receiptBody({ summary: '2.8 mi · 14 min · REV1234' }).replace('Trip Fare $6.92', 'Trip Fare $9.99');
    const r = (await (await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: body }] })).json()).results[0];
    const id = ctx.d1.query("SELECT id FROM robotaxi_vehicles WHERE license_plate = 'REV1234'")[0].id;
    check('a needs_review receipt still creates an internal (private) vehicle', r.review_status === 'needs_review' && vehicleRow(ctx, id).visibility === 'private');
    // Phase 3H tightened this: a vehicle with no counted ride can no longer be flagged public at all.
    const resp = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_public' });
    const body2 = await resp.json();
    check('a moderator can NOT approve it: 409 not_eligible, because it has no counted ride', resp.status === 409 && body2.error === 'not_eligible' && body2.blocking_reasons.includes('no_counted_rides') && vehicleRow(ctx, id).visibility === 'private');
    const viaPatch = await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, 'mod', { visibility: 'public' });
    check('and the legacy PATCH cannot grant public either: 409 review_required', viaPatch.status === 409 && (await viaPatch.json()).error === 'review_required' && vehicleRow(ctx, id).visibility === 'private');
    check('it stays 404 publicly', (await vehiclePage(ctx, id)).status === 404 && (await sightingsOf(ctx, id)).status === 404);
  }

  console.log('6. Public sighting fallback: zero / one / many matches');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const unlinked = async (plate, area = 'Dallas') => {
      const s = await submitSighting(ctx, 'rider', { license_plate: plate, service_area: area });
      ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL WHERE submission_id = '${s.submission_id}'`);
      ctx.d1.exec(`UPDATE vehicle_observations SET created_at = '2000-01-01 00:00:00' WHERE submission_id = '${s.submission_id}'`);
      await approveSighting(ctx, s.submission_id);
      return s;
    };

    // Zero matches.
    const other = rawVehicle(ctx, V3, 'OTH9999', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: other, status: 'pending' });
    await unlinked('NOMATCH1');
    check('zero matches: the sighting stays private and appears on no vehicle', (await sightingsOf(ctx, other)).json.sightings.length === 0);

    // Exactly one eligible public match (a receipt later creates the vehicle).
    await unlinked('uni-5555', 'Austin');
    const uni = rawVehicle(ctx, V1, 'UNI5555', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: uni, status: 'pending' });
    const one = await sightingsOf(ctx, uni);
    check('one eligible public match: the unlinked sighting appears', one.json.sightings.length === 1 && one.json.sightings[0].service_area === 'Austin');

    // One match, but not eligible.
    await unlinked('HID6666');
    const hidden = rawVehicle(ctx, V2, 'HID6666', { visibility: 'private' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: hidden, status: 'pending' });
    check('one match that is private: nothing is exposed (404, like any hidden vehicle)', (await sightingsOf(ctx, hidden)).status === 404);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${hidden}'`);
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${hidden}'`);
    check('one match that is public but has no counted ride: also 404', (await sightingsOf(ctx, hidden)).status === 404);
  }
  {
    // Multiple matches: refused everywhere.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const a = rawVehicle(ctx, V1, 'AMB1234', { visibility: 'public', firstSeenAt: '2026-01-01 00:00:00' });
    const b = rawVehicle(ctx, V2, 'amb-1234', { visibility: 'public', firstSeenAt: '2026-02-01 00:00:00' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: a, status: 'pending' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: b, status: 'pending' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AMB1234' });
    check('the new sighting was not linked to either duplicate', ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', s.submission_id)[0].v === null);
    await approveSighting(ctx, s.submission_id);

    const obsBefore = snapshot(ctx, 'vehicle_observations'); const subBefore = snapshot(ctx, 'submissions', "submission_type = 'vehicle_sighting'"); const regBefore = snapshot(ctx, 'robotaxi_vehicles');
    const ra = await sightingsOf(ctx, a); const rb = await sightingsOf(ctx, b);
    check('ambiguous plate: the sighting appears on NEITHER duplicate (previously it appeared on both)', ra.status === 200 && rb.status === 200 && ra.json.sightings.length === 0 && rb.json.sightings.length === 0);
    check('the observation, sighting submission and registry rows were not modified', snapshot(ctx, 'vehicle_observations') === obsBefore && snapshot(ctx, 'submissions', "submission_type = 'vehicle_sighting'") === subBefore && snapshot(ctx, 'robotaxi_vehicles') === regBefore);
    check('no registry vehicle was created', vehicleCount(ctx) === 2);

    // One duplicate private + one public is still ambiguous (private rows count).
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${b}'`);
    check('a private duplicate still makes the plate ambiguous for the public row', (await sightingsOf(ctx, a)).json.sightings.length === 0);

    // The direct foreign-key path is unaffected by plate ambiguity.
    const direct = await submitSighting(ctx, 'rider', { license_plate: 'ZZZ0001', service_area: 'Houston' });
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = '${a}', license_plate = 'AMB1234', created_at = '2000-01-01 00:00:00' WHERE submission_id = '${direct.submission_id}'`);
    await approveSighting(ctx, direct.submission_id);
    const withDirect = await sightingsOf(ctx, a);
    check('a sighting explicitly linked (FK) to a duplicate still appears on THAT vehicle', withDirect.json.sightings.length === 1 && withDirect.json.sightings[0].service_area === 'Houston');
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${b}'`);
    check('and never on the other duplicate', (await sightingsOf(ctx, b)).json.sightings.length === 0);
  }
  {
    // The regular direct-FK path and unmatched privacy still behave exactly as in Phase 3D-D.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'DIR1234');
    approveVehicle(ctx.d1, v, { withRide: true });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'dir-1234', service_area: 'Dallas' });
    await approveSighting(ctx, s.submission_id);
    const un = await submitSighting(ctx, 'rider', { license_plate: 'UNMATCHED', service_area: 'Austin' });
    await approveSighting(ctx, un.submission_id);
    const before = vehicleCount(ctx);
    const r = await sightingsOf(ctx, v);
    check('an approved directly linked sighting is public', r.json.sightings.length === 1 && r.json.sightings[0].service_area === 'Dallas');
    check('an approved unmatched sighting remains private and never became a vehicle', !r.json.sightings.some(x => x.service_area === 'Austin') && vehicleCount(ctx) === before);
    check('public sighting fields are still only date and service_area', JSON.stringify(Object.keys(r.json.sightings[0]).sort()) === '["date","service_area"]');
  }

  console.log('7. Moderator visibility API: authorization, validation, and no side effects');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const id = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'MOD1234');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending', distance: 2.8 });
    const patch = (user, body, vid = id, raw) => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${vid}`, user, body, raw);

    const unauth = await patch(null, { visibility: 'public' });
    check('unauthenticated -> 401', unauth.status === 401);
    check('unauthenticated made no change', vehicleRow(ctx, id).visibility === 'private');
    check('unauthenticated request with an INVALID id is still 401, not 400 (auth is checked first)', (await patch(null, { visibility: 'public' }, 'not-a-uuid')).status === 401);
    const bad = await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, null, { visibility: 'public' });
    check('a bogus bearer token is also 401', (await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${id}`, { method: 'PATCH', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{"visibility":"public"}' }), ctx.env, {})).status === 401 && bad.status === 401);

    const forbidden = await patch('rider', { visibility: 'public' });
    const forbiddenText = await forbidden.text();
    check('an ordinary authenticated user -> 403', forbidden.status === 403);
    check('the 403 carries no vehicle data (no plate, id or visibility)', !/MOD1234|visibility|counted/.test(forbiddenText) && !forbiddenText.includes(id));
    check('the forbidden attempt made no change', vehicleRow(ctx, id).visibility === 'private');

    // Snapshot everything that must NOT change.
    const trips = snapshot(ctx, 'trips'); const subs = snapshot(ctx, 'submissions'); const obs = snapshot(ctx, 'vehicle_observations');
    const history = JSON.stringify(await db.getRobotaxiVehicleHistory(ctx.d1, id));
    const before = vehicleRow(ctx, id);

    const makePublic = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_public' });
    const mp = await makePublic.json();
    check('a moderator can make an eligible vehicle public through the review action -> 200', makePublic.status === 200 && mp.success === true);
    check('the stored visibility changed', vehicleRow(ctx, id).visibility === 'public');
    check('the response reports the fresh state, including eligibility', mp.vehicle.visibility === 'public' && mp.vehicle.counted_ride_count === 1 && mp.vehicle.publicly_eligible === true);
    check('the response has exactly the registry + provenance fields and no rider/receipt data', JSON.stringify(Object.keys(mp.vehicle).sort()) === '["approval","counted_ride_count","counted_rides_by_source","created_at","first_counted_ride_date","first_seen_at","id","last_counted_ride_date","last_seen_at","latest_review","license_plate","needs_review_ride_count","plate_vehicle_count","publicly_eligible","rejected_ride_count","total_trip_count","verification_status","visibility"]' && !/rider|user_id|pickup|dropoff|@/i.test(JSON.stringify(mp).replace(/"moderator_user_id"/g, '')) && !/email/i.test(JSON.stringify(mp).replace(/receipt_email/g, '')));
    check('the public endpoint now serves it', (await vehiclePage(ctx, id)).status === 200);

    const makePrivate = await patch('mod', { visibility: 'private' });
    check('a moderator can make a vehicle private -> 200', makePrivate.status === 200 && vehicleRow(ctx, id).visibility === 'private');
    check('and the public endpoint immediately stops serving it', (await vehiclePage(ctx, id)).status === 404);
    check('repeating a change is idempotent (200)', (await patch('mod', { visibility: 'private' })).status === 200);

    const after = vehicleRow(ctx, id);
    check('ride statistics are unchanged (trips, history)', snapshot(ctx, 'trips') === trips && JSON.stringify(await db.getRobotaxiVehicleHistory(ctx.d1, id)) === history);
    check('submissions and observations are unchanged', snapshot(ctx, 'submissions') === subs && snapshot(ctx, 'vehicle_observations') === obs);
    check('no vehicle metadata changed: only visibility (and updated_at bookkeeping)', ['id', 'provider', 'license_plate', 'model', 'color', 'service_area', 'first_seen_at', 'last_seen_at', 'verification_status', 'created_at'].every(k => after[k] === before[k]));

    for (const [label, body] of [['an unsupported value', { visibility: 'hidden' }], ['a missing field', {}], ['a number', { visibility: 1 }], ['null', { visibility: null }], ['uppercase', { visibility: 'PUBLIC' }], ['a boolean', { visibility: true }]]) {
      const r = await patch('mod', body);
      check(`invalid visibility (${label}) -> 400 invalid_visibility`, r.status === 400 && (await r.json()).error === 'invalid_visibility');
    }
    check('an array body -> 400 invalid_body', (await (await patch('mod', ['public'])).json()).error === 'invalid_body');
    check('a non-JSON body -> 400 invalid_body', (await patch('mod', undefined, id, 'not json')).status === 400);
    check('invalid vehicle ids -> 400 invalid_vehicle_id', (await Promise.all(['not-a-uuid', 'XJR2195', "x'; DROP TABLE robotaxi_vehicles;--", '12345'].map(async bad => { const r = await patch('mod', { visibility: 'public' }, encodeURIComponent(bad)); return r.status === 400 && (await r.json()).error === 'invalid_vehicle_id'; }))).every(Boolean));
    const missing = await patch('mod', { visibility: 'public' }, MISSING);
    check('a well-formed but missing vehicle -> 404 not_found', missing.status === 404 && (await missing.json()).error === 'not_found');
    check('none of the rejected requests changed anything', vehicleRow(ctx, id).visibility === 'private' && vehicleCount(ctx) === 1);
  }

  console.log('8. Moderator registry list API');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const list = (user, qs = '') => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles${qs}`, user);
    const awaiting = rawVehicle(ctx, V1, 'AWT0001'); seedRide(ctx.d1, { userId: 'rider', vehicleId: awaiting, status: 'pending' });
    const noRides = rawVehicle(ctx, V2, 'NOR0002');
    const pubOne = rawVehicle(ctx, V3, 'PUB0003', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: pubOne, status: 'pending' });
    rawVehicle(ctx, '44444444-4444-4444-8444-444444444444', 'DUP0004', { visibility: 'public' });
    rawVehicle(ctx, '55555555-5555-4555-8555-555555555555', 'dup-0004', { visibility: 'private' });

    check('unauthenticated list -> 401', (await list(null)).status === 401);
    const forbidden = await list('rider'); const ftxt = await forbidden.text();
    check('ordinary user list -> 403 with no registry data', forbidden.status === 403 && !/AWT0001|PUB0003|DUP0004|vehicles/.test(ftxt));

    const a = (await (await list('mod')).json()).vehicles;
    check('default scope lists private vehicles that already have a counted ride (candidates for approval)', a.length === 1 && a[0].id === awaiting && a[0].counted_ride_count === 1 && a[0].publicly_eligible === false);
    check('vehicles with no counted rides are not in the approval list', !a.some(v => v.id === noRides));
    const p = (await (await list('mod', '?scope=public')).json()).vehicles;
    check('scope=public lists currently public vehicles for audit/takedown', p.some(v => v.id === pubOne && v.publicly_eligible === true) && !p.some(v => v.id === awaiting));
    check('a public vehicle with no counted rides is reported as NOT eligible', p.find(v => v.id === '44444444-4444-4444-8444-444444444444').publicly_eligible === false);
    const s = (await (await list('mod', '?plate=dup-0004')).json()).vehicles;
    check('a plate search returns every registry row for that normalized plate, any visibility, and flags the duplicate', s.length === 2 && s.every(v => v.plate_vehicle_count === 2));
    check('a plate search finds a vehicle regardless of scope or formatting', (await (await list('mod', '?plate=nor%200002')).json()).vehicles[0].id === noRides);
    const hostile = await list('mod', `?plate=${encodeURIComponent("' OR 1=1 --")}`);
    check('a hostile search string is inert (no error, no rows)', hostile.status === 200 && (await hostile.json()).vehicles.length === 0);
    check('a blank-after-normalization search matches nothing', (await (await list('mod', '?plate=---')).json()).vehicles.length === 0);
    check('the list exposes no rider, receipt or address data', !/user_id|rider|pickup|dropoff|@|session/i.test(JSON.stringify(s)) && !/email/i.test(JSON.stringify(s).replace(/receipt_email/g, '')));
    check('listing is read-only', vehicleRow(ctx, awaiting).visibility === 'private');
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    for (let i = 0; i < 60; i++) { const id = rawVehicle(ctx, `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, `BULK${String(i).padStart(4, '0')}`); seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending' }); }
    check('the list is bounded at 50 rows', (await (await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles', 'mod')).json()).vehicles.length === 50);
  }

  console.log('9. Privacy: hidden vehicles do not reveal themselves; ambiguity is not public');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const priv = rawVehicle(ctx, V1, 'SEC0001', { visibility: 'private' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: priv, status: 'pending' });
    const zero = rawVehicle(ctx, V2, 'SEC0002', { visibility: 'public' });
    for (const suffix of ['', '/sightings']) {
      const missing = await pub(ctx, `/api/robotaxi-vehicles/${MISSING}${suffix}`);
      for (const [label, id] of [['private', priv], ['public-but-no-rides', zero]]) {
        const r = await pub(ctx, `/api/robotaxi-vehicles/${id}${suffix}`);
        check(`a ${label} vehicle is indistinguishable from a nonexistent one${suffix ? ' (sightings)' : ''}: same status, body and cache header`, r.status === missing.status && r.text === missing.text && r.cache === missing.cache);
        check(`the ${label} 404 does not echo its plate or id`, !/SEC000|"id"/.test(r.text) && !r.text.includes(id));
      }
    }
    // The static page shell must not vary with the id either: hidden, missing and public ids all get the same asset.
    const shellPaths = [];
    ctx.env.ASSETS = { fetch: async r => { shellPaths.push(new URL(r.url).pathname); return new Response('shell', { status: 200 }); } };
    const shells = await Promise.all([priv, zero, MISSING].map(id => call(ctx, 'GET', `/vehicle/${id}`, null).then(r => r.text())));
    check('the /vehicle/:id page shell is identical for hidden, ineligible and nonexistent ids (it reveals nothing)', shells.every(x => x === 'shell') && shellPaths.every(x => x === '/vehicle'));

    // Ambiguity details never reach the public.
    const a = rawVehicle(ctx, V3, 'AMB7777', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: a, status: 'pending' });
    const b = rawVehicle(ctx, '44444444-4444-4444-8444-444444444444', 'amb-7777', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: b, status: 'pending' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AMB7777' }); await approveSighting(ctx, s.submission_id);
    const ra = await sightingsOf(ctx, a); const va = await vehiclePage(ctx, a);
    check('an ambiguous plate produces a plain empty list, with no collision hint', JSON.stringify(ra.json) === '{"sightings":[]}');
    check('the public vehicle response for a duplicate has the normal shape and does not mention the other vehicle', !va.text.includes(b) && !/ambig|duplicate|plate_vehicle_count/i.test(va.text + ra.text) && va.status === 200);
    check('public vehicle fields are unchanged by Phase 3E', JSON.stringify(Object.keys(va.json.vehicle)) === '["id","provider","license_plate","model","color","service_area","first_seen_at","last_seen_at","verification_status"]');
    check('moderator-only fields never appear publicly', !/counted_ride_count|publicly_eligible|visibility/.test(va.text));
  }

  console.log('10. Production preflight: read-only reports find each problem class');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    // Fixtures for every report.
    const fine = rawVehicle(ctx, V1, 'FINE001', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: fine, status: 'pending' });
    const zero = rawVehicle(ctx, V2, 'ZERO002', { visibility: 'public' });                                           // no trips at all (orphaned)
    const review = rawVehicle(ctx, V3, 'REVW003', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: review, status: 'needs_review' });
    const rej = rawVehicle(ctx, '44444444-4444-4444-8444-444444444444', 'REJC004', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: rej, status: 'rejected' });
    const dupA = rawVehicle(ctx, '55555555-5555-4555-8555-555555555555', 'DUPL005', { visibility: 'public' });
    const dupB = rawVehicle(ctx, '66666666-6666-4666-8666-666666666666', 'dupl-005', { visibility: 'private' });
    rawVehicle(ctx, '77777777-7777-4777-8777-777777777777', 'ab.c 123', { visibility: 'private' });                  // not normalized
    const priv = rawVehicle(ctx, '88888888-8888-4888-8888-888888888888', 'PRVT006', { visibility: 'private' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: priv, status: 'pending' });

    const ambS = await submitSighting(ctx, 'rider', { license_plate: 'DUPL005' }); await approveSighting(ctx, ambS.submission_id);
    const oneS = await submitSighting(ctx, 'rider', { license_plate: 'FINE001' });
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL WHERE submission_id = '${oneS.submission_id}'`); await approveSighting(ctx, oneS.submission_id);

    const tables = ['robotaxi_vehicles', 'trips', 'submissions', 'vehicle_observations', 'users'];
    const before = tables.map(x => snapshot(ctx, x)).join('|');
    const r = await runRegistryPreflight(ctx.d1);
    check('running every report changed nothing (read-only)', tables.map(x => snapshot(ctx, x)).join('|') === before);
    check('every report is a single SELECT', REGISTRY_PREFLIGHT.every(q => /^\s*SELECT/i.test(q.sql) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE INTO|PRAGMA)\b/i.test(q.sql)));

    check('duplicate_plates finds the shared normalized plate and its ids/visibilities', r.duplicate_plates.length === 1 && r.duplicate_plates[0].normalized_plate === 'DUPL005' && r.duplicate_plates[0].vehicle_count === 2 && r.duplicate_plates[0].vehicle_ids.includes(dupA) && r.duplicate_plates[0].vehicle_ids.includes(dupB));
    check('non_normalized_plates finds the un-normalized row', r.non_normalized_plates.some(x => x.license_plate === 'ab.c 123') && !r.non_normalized_plates.some(x => x.license_plate === 'FINE001'));
    check('public_vehicles lists every public row with counted/live/all ride counts', r.public_vehicles.length === 5 && r.public_vehicles.find(x => x.id === fine).counted_rides === 1 && r.public_vehicles.find(x => x.id === review).counted_rides === 0 && r.public_vehicles.find(x => x.id === review).live_rides === 1);
    const zeroIds = r.public_zero_counted_rides.map(x => x.id).sort();
    check('public_zero_counted_rides lists exactly the public vehicles that will stop being public', JSON.stringify(zeroIds) === JSON.stringify([zero, review, rej, dupA].sort()));
    const ro = r.public_review_or_rejected_only;
    check('public_review_or_rejected_only lists only review/rejected-backed vehicles, with a breakdown', ro.length === 2 && ro.find(x => x.id === review).needs_review_rides === 1 && ro.find(x => x.id === rej).rejected_rides === 1);
    check('public_orphaned lists public vehicles with no trips at all', r.public_orphaned.map(x => x.id).sort().join() === [zero, dupA].sort().join());
    check('a private vehicle never appears in the public-only reports', ![r.public_vehicles, r.public_zero_counted_rides, r.public_orphaned].some(rows => rows.some(x => x.id === priv)));
    check('ambiguous_sighting_matches finds the sighting the fallback refuses', r.ambiguous_sighting_matches.length === 1 && r.ambiguous_sighting_matches[0].normalized_plate === 'DUPL005' && r.ambiguous_sighting_matches[0].sightings === 1 && r.ambiguous_sighting_matches[0].vehicle_count === 2);
    const single = r.unlinked_sightings_matching_one_vehicle;
    check('unlinked_sightings_matching_one_vehicle finds the sighting that would show, with the vehicle\'s visibility and counted rides', single.length === 1 && single[0].vehicle_id === fine && single[0].visibility === 'public' && single[0].counted_rides === 1);
    check('the reports return only registry/ride facts, never a user or receipt field', !/user_id|rider|email|pickup|dropoff/i.test(JSON.stringify(r)));
  }

  console.log('11. Scope: nothing beyond this phase was added');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
    check('there is no public /api/robotaxi-vehicles list endpoint', (await call(ctx, 'GET', '/api/robotaxi-vehicles', null)).status === 404 && (await call(ctx, 'GET', '/api/robotaxi-vehicles?limit=5', null)).status === 404);
    check('there is no public preflight/diagnostics route', (await call(ctx, 'GET', '/api/moderation/registry-preflight', 'mod')).status === 404 && (await call(ctx, 'GET', '/api/registry-preflight', null)).status === 404);
    check('/vehicles and /registry are not served by the worker (still plain static-asset lookups)', (await call(ctx, 'GET', '/vehicles', null)).status === 404 && (await call(ctx, 'GET', '/registry', null)).status === 404);
    check('the moderator vehicle route does not accept DELETE or POST', (await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${V1}`, 'mod')).status === 404 && (await call(ctx, 'POST', '/api/moderation/robotaxi-vehicles', 'mod', {})).status === 404);
    const migrations = fs.readdirSync(`${ROOT}migrations`).filter(f => f.endsWith('.sql')).sort();
    check('Phase 3E itself added no migration: 0011 (moderator roles) is still followed only by 0012 (Phase 3H review history), and nothing else exists', migrations.join() === migrations.filter(f => /^00(0[1-9]|1[0-2])_/.test(f)).join() && migrations.length === 12 && migrations[10].startsWith('0011_') && migrations[11].startsWith('0012_robotaxi_vehicle_reviews'));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
