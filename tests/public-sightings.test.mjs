// Tests for Phase 3D-D: approved community sightings on the public vehicle
// profile (GET /api/robotaxi-vehicles/:id/sightings, db.getPublicVehicleSightings)
// plus the rejection-reason privacy fix on GET /api/submissions.
// Real SQL (every migration, node:sqlite) and the REAL Worker router. Sightings
// are created through the real submit endpoint and approved/rejected through the
// real moderator endpoint wherever possible; direct SQL is used only to set up
// states the API cannot produce (backdated timestamps, a non-public vehicle).
// Run: node tests/public-sightings.test.mjs

import { makeEnv, seedVehicle, seedRide, approveVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}

function call(ctx, method, path, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}

async function submit(ctx, userId, fields) {
  const resp = await call(ctx, 'POST', '/api/vehicle-sightings', userId, { service_area: 'Dallas', ...fields });
  return resp.json();
}
const approve = (ctx, submissionId) => call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${submissionId}`, 'mod', { action: 'approve' });
const reject = (ctx, submissionId, reason) => call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${submissionId}`, 'mod', { action: 'reject', rejection_reason: reason });
// Also ages the observation's created_at, which is what the 2-minute duplicate guard keys on.
const backdate = (ctx, submissionId, ts) => {
  ctx.d1.exec(`UPDATE submissions SET submitted_at = '${ts}' WHERE id = '${submissionId}'`);
  ctx.d1.exec(`UPDATE vehicle_observations SET created_at = '2000-01-01 00:00:00' WHERE submission_id = '${submissionId}'`);
};

// Public: deliberately no Authorization header.
async function sightings(ctx, vehicleId, qs = '') {
  const resp = await call(ctx, 'GET', `/api/robotaxi-vehicles/${vehicleId}/sightings${qs}`, null);
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: resp.status, text, json, headers: resp.headers };
}

// Submit + approve, optionally backdating so dates are deterministic.
async function approvedSighting(ctx, userId, fields, date) {
  const s = await submit(ctx, userId, fields);
  if (!s.submission_id) throw new Error('test setup: sighting was not created: ' + JSON.stringify(s));
  if (date) backdate(ctx, s.submission_id, `${date} 15:30:45`);
  await approve(ctx, s.submission_id);
  return s;
}

const vehicleCount = ctx => ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n;

async function run() {
  console.log('1. Visibility: only approved + verified sightings of a public vehicle appear');
  {
    const ctx = await makeApp({ rider: 'user', rider2: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });

    const pending = await submit(ctx, 'rider', { license_plate: 'XJR2195' });
    check('the sighting is linked to the registry vehicle at submit time', ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', pending.submission_id)[0].v === v);
    let r = await sightings(ctx, v);
    check('a pending sighting is not public', r.status === 200 && r.json.sightings.length === 0);

    await approve(ctx, pending.submission_id);
    r = await sightings(ctx, v);
    check('once approved, the sighting appears', r.json.sightings.length === 1);

    const toReject = await submit(ctx, 'rider2', { license_plate: 'XJR2195', service_area: 'Austin' });
    await reject(ctx, toReject.submission_id, 'Could not verify');
    r = await sightings(ctx, v);
    check('a rejected sighting never appears', r.json.sightings.length === 1 && r.json.sightings[0].service_area === 'Dallas');

    // Approved submission whose observation is somehow not verified.
    const odd = await submit(ctx, 'rider2', { license_plate: 'XJR2195', service_area: 'Houston' });
    await approve(ctx, odd.submission_id);
    ctx.d1.exec(`UPDATE vehicle_observations SET verification_status = 'unverified' WHERE submission_id = '${odd.submission_id}'`);
    r = await sightings(ctx, v);
    check('an approved submission whose observation is not verified is excluded', !r.json.sightings.some(x => x.service_area === 'Houston'));

    // Same observation data attached to a different submission type.
    const other = await submit(ctx, 'rider2', { license_plate: 'XJR2195', service_area: 'Austin' });
    await approve(ctx, other.submission_id);
    ctx.d1.exec(`UPDATE submissions SET submission_type = 'ride_receipt' WHERE id = '${other.submission_id}'`);
    r = await sightings(ctx, v);
    check('only vehicle_sighting submissions count', !r.json.sightings.some(x => x.service_area === 'Austin'));
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${v}'`);
    const r = await sightings(ctx, v);
    check('a non-public vehicle: sightings endpoint is 404 even with an approved sighting', r.status === 404 && r.json.error === 'not_found');
    const veh = await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`, null);
    check('a non-public vehicle: the vehicle endpoint is 404 too', veh.status === 404);
    check('the 404 leaks nothing about sightings', !/sightings|Dallas/.test(r.text));
    check('the db function itself also refuses a non-public vehicle', (await db.getPublicVehicleSightings(ctx.d1, v, 10)).length === 0);
  }

  console.log('2. Unmatched approved sightings stay private and never create a vehicle');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const before = vehicleCount(ctx);
    const s = await approvedSighting(ctx, 'rider', { license_plate: 'UNK0001' });
    check('the unknown-plate sighting really is unlinked', ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', s.submission_id)[0].v === null);
    check('approving an unmatched sighting creates no registry vehicle', vehicleCount(ctx) === before);
    const r = await sightings(ctx, v);
    check('it does not appear on some other public vehicle', r.json.sightings.length === 0);
    check('there is no global feed route for it to appear on', (await call(ctx, 'GET', '/api/robotaxi-vehicles/sightings', null)).status === 400);
  }

  console.log('3. Read-time plate matching: a later receipt-created vehicle picks up an earlier unmatched sighting, with zero mutation');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await approvedSighting(ctx, 'rider', { license_plate: 'new-1234', service_area: 'Austin' }, '2026-09-18');
    const other = await approvedSighting(ctx, 'rider', { license_plate: 'NEW1235', service_area: 'Houston' }, '2026-09-19');
    const obsBefore = JSON.stringify(ctx.d1.query('SELECT * FROM vehicle_observations ORDER BY id'));
    // Sighting submissions only: the test's own ride setup legitimately adds a ride submission.
    const subBefore = JSON.stringify(ctx.d1.query("SELECT * FROM submissions WHERE submission_type = 'vehicle_sighting' ORDER BY id"));
    const countBefore = vehicleCount(ctx);

    // A receipt later creates the vehicle (the only path that ever does).
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'NEW1234');
    approveVehicle(ctx.d1, v, { withRide: true });
    check('the receipt path created exactly one new registry vehicle', vehicleCount(ctx) === countBefore + 1);
    const obsAfterCreate = JSON.stringify(ctx.d1.query('SELECT * FROM vehicle_observations ORDER BY id'));

    const r = await sightings(ctx, v);
    check('the earlier approved sighting now appears on the new vehicle', r.status === 200 && r.json.sightings.length === 1 && r.json.sightings[0].service_area === 'Austin' && r.json.sightings[0].date === '2026-09-18');
    check('the sighting with a different plate stays private', !r.json.sightings.some(x => x.service_area === 'Houston'));
    check('reading it did not change any observation row (no relink, no backfill)', JSON.stringify(ctx.d1.query('SELECT * FROM vehicle_observations ORDER BY id')) === obsAfterCreate && obsAfterCreate === obsBefore);
    check('reading it did not change any sighting submission row', JSON.stringify(ctx.d1.query("SELECT * FROM submissions WHERE submission_type = 'vehicle_sighting' ORDER BY id")) === subBefore);
    check('the observation FK is still NULL', ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', s.submission_id)[0].v === null);
    check('reading it created no registry row', vehicleCount(ctx) === countBefore + 1);
  }
  {
    // Registry plates are not guaranteed to be stored normalized.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    seedVehicle(ctx.d1, { id: '11111111-1111-4111-8111-111111111111', plate: 'abc-123 4' });
    approveVehicle(ctx.d1, '11111111-1111-4111-8111-111111111111', { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'ABC1234' });
    const r = await sightings(ctx, '11111111-1111-4111-8111-111111111111');
    check('a registry plate stored with dashes/spaces/lowercase still matches by normalized value', r.json.sightings.length === 1);
  }
  {
    // A sighting already linked to vehicle A must not also show on vehicle B.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const a = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'AAA1111');
    approveVehicle(ctx.d1, a, { withRide: true });
    const b = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'BBB2222');
    approveVehicle(ctx.d1, b, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    check('a sighting linked to one vehicle does not appear on another', (await sightings(ctx, a)).json.sightings.length === 1 && (await sightings(ctx, b)).json.sightings.length === 0);
  }
  {
    // A NULL-FK sighting whose plate matches only a NON-public vehicle stays private.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await approvedSighting(ctx, 'rider', { license_plate: 'HID0001' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'HID0001');
    approveVehicle(ctx.d1, v, { withRide: true });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${v}'`);
    check('matching a non-public vehicle exposes nothing', (await sightings(ctx, v)).status === 404);
  }

  console.log('4. Privacy: nothing beyond { date, service_area } is ever returned');
  {
    const ctx = await makeApp({ 'rider-secret': 'user', 'rider2': 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const s = await submit(ctx, 'rider-secret', {
      license_plate: 'XJR2195', service_area: 'Dallas', approx_location: 'SECRET-LOCATION-9 Elm Street',
      notes: 'SECRET-NOTES-TEXT', model: 'SecretModelX', color: 'SecretColorZ', observed_at: '2020-01-01T03:04:05Z'
    });
    ctx.d1.exec(`UPDATE vehicle_observations SET evidence_ref = 'r2://SECRET-EVIDENCE' WHERE submission_id = '${s.submission_id}'`);
    const obsId = ctx.d1.query('SELECT id FROM vehicle_observations WHERE submission_id = ?', s.submission_id)[0].id;
    await approve(ctx, s.submission_id);
    const rej = await submit(ctx, 'rider2', { license_plate: 'XJR2195', service_area: 'Austin' });
    await reject(ctx, rej.submission_id, 'SECRET-REJECTION-REASON');

    const r = await sightings(ctx, v);
    const entry = r.json.sightings[0];
    check('exactly one public entry', r.json.sightings.length === 1);
    check('the entry has exactly the keys date and service_area', JSON.stringify(Object.keys(entry).sort()) === '["date","service_area"]');
    check('the top-level body has only the sightings key', JSON.stringify(Object.keys(r.json)) === '["sightings"]');
    check('approx_location never appears', !/SECRET-LOCATION|Elm Street/.test(r.text));
    check('notes never appear', !/SECRET-NOTES/.test(r.text));
    check('the submitter user id never appears', !/rider-secret|rider2/.test(r.text));
    check('the moderator id never appears (reviewed_by)', !/"mod"|mod\b/.test(r.text.replace(/moderat/gi, '')));
    check('the submission id never appears', !r.text.includes(s.submission_id));
    check('the observation id never appears', !r.text.includes(obsId));
    check('evidence_ref never appears', !/SECRET-EVIDENCE|r2:/.test(r.text));
    check('the rejection reason never appears', !/SECRET-REJECTION/.test(r.text));
    check('observation model/color never appear', !/SecretModelX|SecretColorZ/.test(r.text));
    check('no exact timestamp: the date is date-only', /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && !/\d{2}:\d{2}/.test(r.text));
    const today = new Date().toISOString().slice(0, 10);
    check('the date is the trusted server date, not the client-supplied observed_at', entry.date !== '2020-01-01' && (entry.date === today || entry.date === ctx.d1.query('SELECT substr(submitted_at,1,10) AS d FROM submissions WHERE id = ?', s.submission_id)[0].d));
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195', service_area: '<img src=x onerror=alert(1)> Secret Depot Lane' }, '2026-09-18');
    const r = await sightings(ctx, v);
    check('a raw free-text service area is never published', !/Secret Depot|onerror|<img/.test(r.text));
    check('it is replaced by "Area not specified"', r.json.sightings.length === 1 && r.json.sightings[0].service_area === 'Area not specified');
  }

  console.log('5. Service-area normalization');
  {
    const ctx = await makeApp({ a: 'user', b: 'user', c: 'user', d: 'user', e: 'user', f: 'user', g: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const cases = [['a', 'dallas', '2026-09-01'], ['b', '  AUSTIN  ', '2026-09-02'], ['c', 'san   antonio', '2026-09-03'], ['d', 'HoUsToN', '2026-09-04'], ['e', 'Fort Worth', '2026-09-05'], ['f', 'Springfield', '2026-09-06']];
    for (const [u, area, date] of cases) await approvedSighting(ctx, u, { license_plate: 'XJR2195', service_area: area }, date);
    const byDate = Object.fromEntries((await sightings(ctx, v)).json.sightings.map(x => [x.date, x.service_area]));
    check('lowercase is normalized', byDate['2026-09-01'] === 'Dallas');
    check('padding and uppercase are normalized', byDate['2026-09-02'] === 'Austin');
    check('internal whitespace runs are collapsed (San Antonio)', byDate['2026-09-03'] === 'San Antonio');
    check('mixed case is normalized', byDate['2026-09-04'] === 'Houston');
    check('a real city outside the four known areas is not published', byDate['2026-09-05'] === 'Area not specified');
    check('unknown free text is not published', byDate['2026-09-06'] === 'Area not specified');
  }

  console.log('6. Aggregation: one entry per vehicle + date + normalized area, no counts');
  {
    const ctx = await makeApp({ a: 'user', b: 'user', c: 'user', d: 'user', e: 'user', f: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'a', { license_plate: 'XJR2195', service_area: 'Dallas' }, '2026-09-18');
    await approvedSighting(ctx, 'b', { license_plate: 'XJR2195', service_area: ' dallas ' }, '2026-09-18');
    await approvedSighting(ctx, 'c', { license_plate: 'XJR2195', service_area: 'DALLAS' }, '2026-09-18');
    let r = await sightings(ctx, v);
    check('three riders, same day, same area (differently spelled) collapse to one entry', r.json.sightings.length === 1);
    check('no count of submitters is exposed', !/count|total|\b3\b/i.test(r.text));

    await approvedSighting(ctx, 'd', { license_plate: 'XJR2195', service_area: 'Austin' }, '2026-09-18');
    await approvedSighting(ctx, 'e', { license_plate: 'XJR2195', service_area: 'Dallas' }, '2026-09-20');
    r = await sightings(ctx, v);
    check('a different area on the same day is a separate entry', r.json.sightings.filter(x => x.date === '2026-09-18').length === 2);
    check('a different date is a separate entry', r.json.sightings.length === 3);
    check('entries are newest first', r.json.sightings[0].date === '2026-09-20');

    await approvedSighting(ctx, 'f', { license_plate: 'XJR2195', service_area: 'Nowhere One' }, '2026-09-21');
    await approvedSighting(ctx, 'a', { license_plate: 'XJR2195', service_area: 'Nowhere Two' }, '2026-09-21');
    r = await sightings(ctx, v);
    check('different unknown free-text areas on one day collapse into one "Area not specified"', r.json.sightings.filter(x => x.date === '2026-09-21').length === 1);

    // One rider posting many sightings cannot inflate anything either.
    await approvedSighting(ctx, 'a', { license_plate: 'XJR2195', service_area: 'Houston' }, '2026-09-22');
    await approvedSighting(ctx, 'a', { license_plate: 'XJR2195', service_area: 'Houston' }, '2026-09-22');
    r = await sightings(ctx, v);
    check('repeat submissions by one rider on the same day/area still yield one entry', r.json.sightings.filter(x => x.date === '2026-09-22').length === 1);
  }

  console.log('7. Integrity: approving a sighting changes no ride stats and no vehicle data');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: v, rideDate: '2026-06-09', distance: 2.8 });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: v, rideDate: '2026-06-15', distance: 3.4 });
    const vehicleBefore = await (await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`, null)).text();
    const rowBefore = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', v));
    const tripsBefore = JSON.stringify(ctx.d1.query('SELECT * FROM trips ORDER BY id'));
    const historyBefore = JSON.stringify(await db.getRobotaxiVehicleHistory(ctx.d1, v));

    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195' }, '2026-09-18');

    check('the public vehicle response is byte-identical after approval', (await (await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`, null)).text()) === vehicleBefore);
    check('the registry row (first/last seen, visibility, verification, metadata) is unchanged', JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', v)) === rowBefore);
    check('ride count, distance, first/last ride dates are unchanged', JSON.stringify(await db.getRobotaxiVehicleHistory(ctx.d1, v)) === historyBefore);
    check('no trip row was touched', JSON.stringify(ctx.d1.query('SELECT * FROM trips ORDER BY id')) === tripsBefore);
    await sightings(ctx, v);
    check('reading sightings mutates nothing either', JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', v)) === rowBefore);
  }

  console.log('8. Public API behavior');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195' }, '2026-09-18');
    const r = await sightings(ctx, v);
    check('works with no authentication at all', r.status === 200);
    check('short public cache header, like the vehicle endpoint', r.headers.get('Cache-Control') === 'public, max-age=60');
    check('an invalid vehicle id is 400 invalid_vehicle_id, like the vehicle endpoint', (await sightings(ctx, 'not-a-uuid')).status === 400 && (await sightings(ctx, 'not-a-uuid')).json.error === 'invalid_vehicle_id');
    const missing = await sightings(ctx, '11111111-1111-1111-1111-111111111111');
    check('a well-formed but missing vehicle is 404 not_found', missing.status === 404 && missing.json.error === 'not_found');
    check('a bad Authorization header is simply ignored (endpoint is public)', (await worker.fetch(new Request(`https://x/api/robotaxi-vehicles/${v}/sightings`, { headers: { Authorization: 'Bearer garbage' } }), ctx.env, {})).status === 200);
    ctx.env.ASSETS = { fetch: async () => new Response('not an api route', { status: 404 }) };
    const post = await call(ctx, 'POST', `/api/robotaxi-vehicles/${v}/sightings`, 'rider', {});
    check('POST is not handled by the route (read-only)', post.status === 404 && !/sightings/.test(await post.text()));
    check('the existing vehicle endpoint is unaffected', (await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`, null)).status === 200);
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    // 60 distinct approved days, inserted directly so the 2-minute duplicate guard is not in play.
    for (let i = 0; i < 60; i++) {
      const sid = `s${i}`, day = `2026-08-${String((i % 28) + 1).padStart(2, '0')}`;
      const area = i < 28 ? 'Dallas' : i < 56 ? 'Austin' : 'Houston';
      ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at) VALUES ('${sid}', 'rider', 'vehicle_sighting', 'approved', '${day} 10:00:00')`);
      ctx.d1.exec(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, service_area, license_plate, verification_status) VALUES ('o${i}', '${v}', 'rider', '${sid}', '${area}', 'XJR2195', 'verified')`);
    }
    check('default limit is 10', (await sightings(ctx, v)).json.sightings.length === 10);
    check('an explicit limit is honored', (await sightings(ctx, v, '?limit=3')).json.sightings.length === 3);
    check('the limit is capped at 50', (await sightings(ctx, v, '?limit=500')).json.sightings.length === 50);
    check('a non-numeric limit falls back to the default', (await sightings(ctx, v, '?limit=abc')).json.sightings.length === 10);
    check('a negative limit falls back to the default', (await sightings(ctx, v, '?limit=-5')).json.sightings.length === 10);
    check('there is no cursor/offset pagination', (await sightings(ctx, v, '?limit=10&offset=10&cursor=x')).json.sightings.length === 10);
  }

  console.log('9. GET /api/submissions never returns a moderator\'s rejection_reason to users');
  {
    const ctx = await makeApp({ rider: 'user', other: 'user', mod: 'moderator' });
    const s = await submit(ctx, 'rider', { license_plate: 'AAA1111' });
    await reject(ctx, s.submission_id, 'PRIVATE-MODERATOR-NOTE');
    const stored = ctx.d1.query('SELECT rejection_reason, status FROM submissions WHERE id = ?', s.submission_id)[0];
    check('the reason really is stored (moderators keep it)', stored.rejection_reason === 'PRIVATE-MODERATOR-NOTE' && stored.status === 'rejected');
    check('the moderator-side lookup still returns it', (await db.getVehicleSightingSubmission(ctx.d1, s.submission_id)).rejection_reason === 'PRIVATE-MODERATOR-NOTE');

    const own = await call(ctx, 'GET', '/api/submissions', 'rider');
    const ownText = await own.text();
    check('the submitter still sees their submission and its status', own.status === 200 && JSON.parse(ownText).submissions.some(x => x.id === s.submission_id && x.status === 'rejected'));
    check('the submitter does not receive the reason text', !/PRIVATE-MODERATOR-NOTE/.test(ownText));
    check('the submitter does not receive a rejection_reason key at all', !/rejection_reason/.test(ownText));
    const others = await (await call(ctx, 'GET', '/api/submissions', 'other')).text();
    check('another user sees neither the submission nor the reason', !/PRIVATE-MODERATOR-NOTE|rejection_reason/.test(others) && !others.includes(s.submission_id));
    const modText = await (await call(ctx, 'GET', '/api/submissions', 'mod')).text();
    check('the moderator\'s own submissions list is also just a normal user list', !/PRIVATE-MODERATOR-NOTE/.test(modText));

    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'AAA1111');

    approveVehicle(ctx.d1, v, { withRide: true });
    const pub = await sightings(ctx, v);
    const pubVehicle = await (await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`, null)).text();
    check('the public sightings and vehicle endpoints never carry the reason', !/PRIVATE-MODERATOR-NOTE|rejection/.test(pub.text + pubVehicle));

    const queue = await call(ctx, 'GET', '/api/moderation/vehicle-sightings', 'mod');
    check('the moderation queue API is unaffected', queue.status === 200);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
