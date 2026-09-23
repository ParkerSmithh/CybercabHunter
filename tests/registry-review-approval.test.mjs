// Tests for Phase 3H: the moderator reapproval workflow for private registry
// vehicles.
//   - POST /api/moderation/robotaxi-vehicles/:id/review   (strict, audited)
//   - GET  /api/moderation/robotaxi-vehicles/:id/reviews  (append-only history)
//   - the moderator payload's approval state / factual reasons / provenance
//   - the takedown-only PATCH (private is audited; public is refused with review_required)
//   - the public endpoints never leak an approved-but-ineligible vehicle
// Real SQL (every migration incl. 0012) and the REAL Worker router.
// Nothing here touches production.
// Run: node tests/registry-review-approval.test.mjs

import fs from 'node:fs';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import { receiptBody } from './helpers/receipts.mjs';
import { db } from '../worker/db.js';
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
function call(ctx, method, p, userId, body, rawBody) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${p}`, { method, headers, body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined) }), ctx.env, {});
}
async function pub(ctx, p) {
  const r = await call(ctx, 'GET', p, null);
  return { status: r.status, text: await r.text(), cache: r.headers.get('Cache-Control') };
}
const review = (ctx, user, id, body, raw) => call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, user, body, raw);
const approveCybercab = (ctx, user, id, reason) => review(ctx, user, id, { action: 'approve_cybercab', ...(reason !== undefined ? { reason } : {}) });
// The ordinary/ungated "approve" action no longer exists — approve_cybercab is
// the only remaining approval path, and it requires a vin. This helper keeps
// every existing call site (this file has many, all exercising the SAME
// shared guard: counted ride, unique plate, race safety, audit trail — none
// of that changed) working unchanged by quietly ensuring a vin is on file
// first. The vin write is best-effort/idempotent here: if the caller isn't a
// real moderator, or a vin is already set, it's simply ignored and the
// review call below still runs (and still correctly fails) on its own.
async function approve(ctx, user, id, reason) {
  await setVin(ctx, user, id, VIN_A).catch(() => {});
  return review(ctx, user, id, { action: 'approve_cybercab', ...(reason !== undefined ? { reason } : {}) });
}
const giveBack = (ctx, user, id, reason) => review(ctx, user, id, { action: 'return_private', ...(reason !== undefined ? { reason } : {}) });
const setVin = (ctx, user, id, vin, raw) => call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/vin`, user, vin === undefined ? undefined : { vin }, raw);
const VIN_A = '5YJSA1E14FF101183';
const VIN_B = '5YJSA1E27FF101184';
const list = (ctx, qs = '', user = 'mod') => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles${qs}`, user).then(r => r.json());
const one = async (ctx, plate) => (await list(ctx, `?plate=${encodeURIComponent(plate)}`)).vehicles[0];

function rawVehicle(ctx, id, plate, { visibility = 'private' } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, first_seen_at, last_seen_at) VALUES (?, ?, ?, '2026-05-01 10:00:00', '2026-05-01 10:00:00')`)
    .bind(id, plate, visibility)._exec();
  return id;
}
const id = n => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MISSING = '99999999-9999-4999-8999-999999999999';
const rows = ctx => ctx.d1.query('SELECT * FROM robotaxi_vehicle_reviews ORDER BY rowid');
const vis = (ctx, vid) => ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', vid)[0].visibility;
const snap = (ctx, table) => JSON.stringify(ctx.d1.query(`SELECT * FROM ${table} ORDER BY 1`));

async function run() {
  console.log('1. Authorization');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(1), 'AUT0001'); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    const routes = [
      ['POST review', () => review(ctx, undefined, v, { action: 'approve_cybercab' }), () => review(ctx, 'rider', v, { action: 'approve_cybercab' })],
      ['GET reviews', () => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, undefined), () => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, 'rider')],
      ['GET list', () => call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', undefined), () => call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', 'rider')],
      ['PATCH', () => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${v}`, undefined, { visibility: 'public' }), () => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${v}`, 'rider', { visibility: 'public' })],
      ['DELETE', () => call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, undefined), () => call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'rider')]
    ];
    for (const [name, unauth, ordinary] of routes) {
      check(`${name}: unauthenticated -> 401`, (await unauth()).status === 401);
      const r = await ordinary(); const txt = await r.text();
      check(`${name}: ordinary user -> 403 with no registry data`, r.status === 403 && !/AUT0001|counted|approval|reviews|license_plate/.test(txt));
    }
    check('none of the refused requests changed anything or wrote history', vis(ctx, v) === 'private' && rows(ctx).length === 0);
    check('a bogus bearer token is 401', (await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${v}/review`, { method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{"action":"approve_cybercab"}' }), ctx.env, {})).status === 401);
    check('a moderator is allowed', (await approve(ctx, 'mod', v)).status === 200);
    check('the moderator can read the history', (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, 'mod')).status === 200);
  }

  console.log('2. Approval safety: only an eligible private vehicle can be approved');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const eligible = rawVehicle(ctx, id(10), 'ELG0010'); seedRide(ctx.d1, { userId: 'rider', vehicleId: eligible, status: 'pending' });
    const before = await one(ctx, 'ELG0010');
    check('before approval: state eligible_for_approval, can_approve, no blocking reasons', before.approval.state === 'eligible_for_approval' && before.approval.can_approve === true && before.approval.blocking_reasons.length === 0 && before.approval.notes.includes('eligible_counted_ride_present'));
    const r = await approve(ctx, 'mod', eligible); const j = await r.json();
    check('a private eligible vehicle is approved (200)', r.status === 200 && j.success === true && j.action === 'approved_public');
    check('it is now public and publicly eligible', vis(ctx, eligible) === 'public' && j.vehicle.approval.state === 'public' && j.vehicle.publicly_eligible === true);
    check('the response reports the latest review', j.vehicle.latest_review.action === 'approved_public' && j.vehicle.latest_review.moderator_user_id === 'mod');
    check('an approved vehicle is served by the public endpoints', (await pub(ctx, `/api/robotaxi-vehicles/${eligible}`)).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${eligible}/sightings`)).status === 200);

    const cases = {};
    cases.zero = rawVehicle(ctx, id(11), 'ZER0011');
    cases.needsReview = rawVehicle(ctx, id(12), 'NRV0012'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.needsReview, status: 'needs_review' });
    cases.rejected = rawVehicle(ctx, id(13), 'REJ0013'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.rejected, status: 'rejected' });
    cases.orphan = rawVehicle(ctx, id(14), 'ORP0014');
    const winner = seedRide(ctx.d1, { userId: 'rider', vehicleId: eligible, status: 'pending' });
    cases.superseded = rawVehicle(ctx, id(15), 'SUP0015'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.superseded, status: 'pending', supersededBy: winner });
    cases.noPlate = rawVehicle(ctx, id(16), null); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.noPlate, status: 'pending' });
    cases.blankPlate = rawVehicle(ctx, id(17), '---'); seedRide(ctx.d1, { userId: 'rider', vehicleId: cases.blankPlate, status: 'pending' });
    const expectations = {
      zero: ['no_counted_rides', 'no_rides_on_record'], needsReview: ['no_counted_rides', 'needs_review_ride_present'],
      rejected: ['no_counted_rides', 'rejected_only_history'], orphan: ['no_counted_rides', 'no_rides_on_record'],
      superseded: ['no_counted_rides'], noPlate: ['no_plate'], blankPlate: ['no_plate']
    };
    const auditBefore = rows(ctx).length;
    for (const [k, [reason, note]] of Object.entries(expectations)) {
      const resp = await approve(ctx, 'mod', cases[k]); const body = await resp.json();
      check(`${k}: refused with 409 not_eligible and the factual reason (${reason})`, resp.status === 409 && body.error === 'not_eligible' && body.blocking_reasons.includes(reason));
      check(`${k}: it stays private and is not publicly retrievable`, vis(ctx, cases[k]) === 'private' && (await pub(ctx, `/api/robotaxi-vehicles/${cases[k]}`)).status === 404);
      if (note) {
        const listed = (await list(ctx, '?scope=private')).vehicles.find(x => x.id === cases[k]);
        check(`${k}: the moderator payload states the fact (${note})`, !!listed && listed.approval.notes.includes(note) && listed.approval.state === 'not_eligible' && listed.approval.can_approve === false);
      }
    }
    check('no refused approval wrote any history', rows(ctx).length === auditBefore);
    check('rejected-only is reported distinctly from needs_review-only', !(await list(ctx, '?scope=private')).vehicles.find(x => x.id === cases.needsReview).approval.notes.includes('rejected_only_history') && !(await list(ctx, '?scope=private')).vehicles.find(x => x.id === cases.rejected).approval.notes.includes('needs_review_ride_present'));

    // Ambiguous / duplicate plate.
    const dupA = rawVehicle(ctx, id(20), 'DUP0020'); const dupB = rawVehicle(ctx, id(21), 'dup-0020');
    for (const d of [dupA, dupB]) seedRide(ctx.d1, { userId: 'rider', vehicleId: d, status: 'pending' });
    const ra = await approve(ctx, 'mod', dupA); const rb = await approve(ctx, 'mod', dupB);
    check('a duplicated plate cannot be approved (either row): 409 duplicate_plate', ra.status === 409 && rb.status === 409 && (await ra.json()).blocking_reasons.includes('duplicate_plate') && (await rb.json()).blocking_reasons.includes('duplicate_plate'));
    check('neither duplicate became public, and neither is publicly retrievable', vis(ctx, dupA) === 'private' && vis(ctx, dupB) === 'private' && (await pub(ctx, `/api/robotaxi-vehicles/${dupA}`)).status === 404);
    check('the payload flags the duplicate factually', (await one(ctx, 'DUP0020')).plate_vehicle_count === 2);
    check('nothing was merged or rewritten', ctx.d1.query("SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE license_plate IN ('DUP0020','dup-0020')")[0].n === 2);

    // Other states.
    check('approving an already public vehicle -> 409 already_public (nothing written)', (await approve(ctx, 'mod', eligible)).status === 409 && rows(ctx).length === auditBefore);
    check('returning an already private vehicle -> 409 already_private', (await giveBack(ctx, 'mod', cases.zero)).status === 409);
  }
  {
    // The SQL guard itself, independent of the handler's pre-check.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(30), 'RAC0030'); const ride = seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    ctx.d1.exec(`DELETE FROM trips WHERE id = '${ride}'`);   // the ride disappears after the moderator's page was loaded
    const direct = await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: v, moderatorId: 'mod', target: 'public' });
    check('the atomic write refuses a vehicle that lost its counted ride (no stale approval slips through)', direct.applied === false && vis(ctx, v) === 'private');
    check('and it wrote no history row for the refused change', rows(ctx).length === 0);
    const w = seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    check('with a counted ride restored the same atomic write succeeds', (await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: v, moderatorId: 'mod', target: 'public' })).applied === true && rows(ctx).length === 1);
    // A second row for the same normalized plate, WITH a counted ride of its own: the ONLY thing wrong with it is the duplicate.
    const dup = rawVehicle(ctx, id(31), 'RAC-0030'); seedRide(ctx.d1, { userId: 'rider', vehicleId: dup, status: 'pending' });
    const other = rawVehicle(ctx, id(32), 'ZZZ0032'); seedRide(ctx.d1, { userId: 'rider', vehicleId: other, status: 'pending' });
    const reviewsBefore = rows(ctx).length;
    check('control: an otherwise identical vehicle with a UNIQUE plate and a counted ride is accepted by the same guard', (await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: other, moderatorId: 'mod', target: 'public' })).applied === true);
    check('the atomic write refuses a vehicle whose ONLY problem is a duplicate plate (it has a counted ride)', (await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: dup, moderatorId: 'mod', target: 'public' })).applied === false && vis(ctx, dup) === 'private');
    check('and it wrote no history for it (only the control\'s one row was added)', rows(ctx).length === reviewsBefore + 1);
  }
  {
    // Validation.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(40), 'VAL0040'); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    const bad = async (label, resp, status, error) => { const r = await resp; const j = await r.json(); check(`${label} -> ${status} ${error}`, r.status === status && j.error === error); };
    await bad('an unknown action', review(ctx, 'mod', v, { action: 'publish' }), 400, 'invalid_action');
    await bad('a missing action', review(ctx, 'mod', v, {}), 400, 'invalid_action');
    await bad('the legacy visibility field is not accepted here', review(ctx, 'mod', v, { visibility: 'public' }), 400, 'invalid_action');
    await bad('a non-JSON body', review(ctx, 'mod', v, undefined, 'not json'), 400, 'invalid_body');
    await bad('an array body', review(ctx, 'mod', v, ['approve_cybercab']), 400, 'invalid_body');
    await bad('a non-string reason', approve(ctx, 'mod', v, 42), 400, 'invalid_reason');
    await bad('an over-long reason (281)', approve(ctx, 'mod', v, 'x'.repeat(281)), 400, 'invalid_reason');
    await bad('a malformed vehicle id', review(ctx, 'mod', 'not-a-uuid', { action: 'approve_cybercab' }), 400, 'invalid_vehicle_id');
    await bad('a well-formed but missing vehicle', approve(ctx, 'mod', MISSING), 404, 'not_found');
    check('nothing was changed or recorded by any invalid request', vis(ctx, v) === 'private' && rows(ctx).length === 0);
    check('a 280-character reason is accepted', (await approve(ctx, 'mod', v, 'y'.repeat(280))).status === 200);
  }

  console.log('3. Public API: an approved vehicle is served; everything else is indistinguishable from missing');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const priv = rawVehicle(ctx, id(50), 'PRV0050'); seedRide(ctx.d1, { userId: 'rider', vehicleId: priv, status: 'pending' });
    const hiddenApproved = rawVehicle(ctx, id(51), 'HID0051', { visibility: 'public' });   // flagged public, but no counted ride
    const good = rawVehicle(ctx, id(52), 'GOD0052'); seedRide(ctx.d1, { userId: 'rider', vehicleId: good, status: 'pending' });
    await approve(ctx, 'mod', good);
    for (const suffix of ['', '/sightings']) {
      const missing = await pub(ctx, `/api/robotaxi-vehicles/${MISSING}${suffix}`);
      for (const [label, vid] of [['private (needs review)', priv], ['approved-but-ineligible', hiddenApproved]]) {
        const r = await pub(ctx, `/api/robotaxi-vehicles/${vid}${suffix}`);
        check(`${label}${suffix ? ' (sightings)' : ''}: same status, body and cache header as a nonexistent vehicle`, r.status === 404 && r.text === missing.text && r.cache === missing.cache);
      }
      check(`an approved eligible vehicle${suffix ? ' (sightings)' : ''} is served`, (await pub(ctx, `/api/robotaxi-vehicles/${good}${suffix}`)).status === 200);
    }
    const goodText = (await pub(ctx, `/api/robotaxi-vehicles/${good}`)).text + (await pub(ctx, `/api/robotaxi-vehicles/${good}/sightings`)).text;
    check('the public responses carry no review, moderator, reason or approval data', !/moderator|reason|review|approved_public|approval|latest_review|user_id|mod\b/.test(goodText));

    // Approval made while eligible; the ride later disappears; the vehicle is hidden, then visible again if a counted ride returns.
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${good}'`);
    check('an approved vehicle that loses its last counted ride stops being public (404), without any moderator action', (await pub(ctx, `/api/robotaxi-vehicles/${good}`)).status === 404 && vis(ctx, good) === 'public');
    check('the moderator payload says so plainly: Not Eligible, no counted rides', (await one(ctx, 'GOD0052')).approval.state === 'not_eligible' && (await one(ctx, 'GOD0052')).approval.blocking_reasons.includes('no_counted_rides'));
    seedRide(ctx.d1, { userId: 'rider', vehicleId: good, status: 'pending' });
    check('documented behavior: the earlier approval still stands, so a later counted ride makes it public again (return it to private to withdraw approval)', (await pub(ctx, `/api/robotaxi-vehicles/${good}`)).status === 200);
  }

  console.log('4. Audit: who, when, what — recorded once and never overwritten');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
    ctx.d1.exec(`UPDATE users SET display_name = 'Moderator One' WHERE id = 'mod'`);
    ctx.d1.exec(`UPDATE users SET display_name = 'Moderator Two' WHERE id = 'mod2'`);
    const v = rawVehicle(ctx, id(60), 'AUD0060'); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'approved' });
    check('there is no history before any decision', rows(ctx).length === 0 && (await one(ctx, 'AUD0060')).latest_review === null);

    await approve(ctx, 'mod', v, '  Looks consistent with the ride history.  ');
    const a = rows(ctx)[0];
    check('approval records the moderator identity', a.moderator_user_id === 'mod');
    check('approval records the action and the prior visibility', a.action === 'approved_public' && a.previous_visibility === 'private');
    check('approval records a timestamp', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.created_at) && Math.abs(Date.now() - Date.parse(a.created_at.replace(' ', 'T') + 'Z')) < 120000);
    check('approval records the reason, trimmed', a.reason === 'Looks consistent with the ride history.');
    check('approval snapshots the facts it was made on (plate, counted rides, plate rows)', a.license_plate === 'AUD0060' && a.counted_ride_count === 2 && a.plate_vehicle_count === 1 && a.robotaxi_vehicle_id === v);

    await giveBack(ctx, 'mod2', v, 'Taking it down for now.');
    const b = rows(ctx)[1];
    check('returning to private records a NEW row with that action, moderator and reason', rows(ctx).length === 2 && b.action === 'returned_private' && b.moderator_user_id === 'mod2' && b.previous_visibility === 'public' && b.reason === 'Taking it down for now.');
    check('the earlier approval row was not modified by the later action', JSON.stringify(rows(ctx)[0]) === JSON.stringify(a));

    await approve(ctx, 'mod', v);
    await giveBack(ctx, 'mod', v);
    check('repeated cycles append; every earlier row is byte-identical', rows(ctx).length === 4 && JSON.stringify(rows(ctx)[0]) === JSON.stringify(a) && JSON.stringify(rows(ctx)[1]) === JSON.stringify(b));
    check('a blank reason is stored as null', rows(ctx)[2].reason === null && rows(ctx)[3].reason === null);

    const hist = await (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, 'mod')).json();
    check('the history endpoint returns every entry, newest first', hist.reviews.length === 4 && hist.reviews[0].action === 'returned_private' && hist.reviews[3].action === 'approved_public');
    check('it names the moderators (moderator-only view) and carries the snapshots', hist.reviews.map(x => x.moderator_display_name).join() === 'Moderator One,Moderator One,Moderator Two,Moderator One' && hist.reviews[3].counted_ride_count === 2);
    check('the moderator payload shows the latest review', (await one(ctx, 'AUD0060')).latest_review.action === 'returned_private');
    check('the history endpoint: malformed id 400, missing vehicle 404', (await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles/nope/reviews', 'mod')).status === 400 && (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${MISSING}/reviews`, 'mod')).status === 404);
    check('history is NOT reachable from any public route', (await pub(ctx, `/api/robotaxi-vehicles/${v}/reviews`)).status !== 200 && !(await pub(ctx, `/api/robotaxi-vehicles/${v}`)).text.includes('AUD0060') );

    // No refused or no-op request adds history.
    const n = rows(ctx).length;
    await approve(ctx, 'rider', v); await approve(ctx, undefined, v); await giveBack(ctx, 'mod', v); await review(ctx, 'mod', v, { action: 'nope' });
    check('refused, unauthorized and no-op requests add no history', rows(ctx).length === n);

    // The history survives deletion of its vehicle and of its moderator (no foreign keys).
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${v}'`);
    ctx.d1.exec(`DELETE FROM robotaxi_vehicles WHERE id = '${v}'`);
    ctx.d1.exec(`DELETE FROM users WHERE id = 'mod2'`);
    check('history rows survive the deletion of the vehicle and of a moderator account', rows(ctx).length === n && rows(ctx).some(r => r.moderator_user_id === 'mod2') && rows(ctx).every(r => r.robotaxi_vehicle_id === v));

    // The application never rewrites history.
    const offenders = fs.readdirSync(`${ROOT}worker`).filter(f => f.endsWith('.js')).filter(f => /\b(UPDATE|DELETE\s+FROM|INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\s+robotaxi_vehicle_reviews\b/i.test(fs.readFileSync(`${ROOT}worker/${f}`, 'utf8').replace(/\/\/.*$/gm, '')));
    check('no application code UPDATEs, DELETEs or REPLACEs rows of robotaxi_vehicle_reviews (append-only)', offenders.length === 0);
    const inserters = fs.readdirSync(`${ROOT}worker`).filter(f => f.endsWith('.js') && /INSERT\s+INTO\s+robotaxi_vehicle_reviews/i.test(fs.readFileSync(`${ROOT}worker/${f}`, 'utf8')));
    check('the single writer is db.js', JSON.stringify(inserters) === '["db.js"]');
  }
  {
    // The operator's cleanup is not a review.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const legacy = rawVehicle(ctx, id(70), 'LEG0070', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: legacy, status: 'pending' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${legacy}'`);   // the operator's bulk cleanup, done directly in SQL
    check('a vehicle made private by the operator cleanup has no review history (it was not a moderator decision)', (await one(ctx, 'LEG0070')).latest_review === null && rows(ctx).length === 0);
    check('and it is Private — Needs Review / eligible for approval, awaiting an explicit decision', (await one(ctx, 'LEG0070')).approval.state === 'eligible_for_approval');
  }

  console.log('4b. PATCH can no longer grant public visibility: POST /review is the only way');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', other: 'user' });
    ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
    const patch = (user, body, vid, raw) => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${vid}`, user, body, raw);
    const eligible = rawVehicle(ctx, id(100), 'ELG0100'); seedRide(ctx.d1, { userId: 'rider', vehicleId: eligible, status: 'pending' });
    const dupA = rawVehicle(ctx, id(101), 'DUP0101'); const dupB = rawVehicle(ctx, id(102), 'dup-0101');
    for (const d of [dupA, dupB]) seedRide(ctx.d1, { userId: 'rider', vehicleId: d, status: 'pending' });
    const noRides = rawVehicle(ctx, id(103), 'NOR0103');
    const reviewOnly = rawVehicle(ctx, id(104), 'NRV0104'); seedRide(ctx.d1, { userId: 'rider', vehicleId: reviewOnly, status: 'needs_review' });
    const all = [eligible, dupA, dupB, noRides, reviewOnly];
    const rowsBefore = Object.fromEntries(all.map(v => [v, JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', v)[0])]));

    const cases = [['an eligible private vehicle', eligible], ['a duplicate-plate vehicle (A)', dupA], ['a duplicate-plate vehicle (B)', dupB], ['a vehicle with no counted rides', noRides], ['a needs_review-only vehicle', reviewOnly]];
    for (const [label, vid] of cases) {
      const r = await patch('mod', { visibility: 'public' }, vid); const body = await r.json();
      check(`PATCH public on ${label} is rejected: 409 review_required`, r.status === 409 && body.success === false && body.error === 'review_required');
      check(`  … and the response is only the error (no vehicle data, no facts)`, JSON.stringify(body) === '{"success":false,"error":"review_required"}');
      check(`  … the vehicle stays private and its row is byte-for-byte unchanged (not even updated_at)`, vis(ctx, vid) === 'private' && JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', vid)[0]) === rowsBefore[vid]);
      check(`  … and it is not publicly retrievable`, (await pub(ctx, `/api/robotaxi-vehicles/${vid}`)).status === 404 && (await pub(ctx, `/api/robotaxi-vehicles/${vid}/sightings`)).status === 404);
    }
    check('no rejected PATCH public created an audit approval row (or any row)', rows(ctx).length === 0);

    // Validation and authorization order is unchanged around the new refusal.
    check('unauthenticated PATCH public -> 401 (not 409)', (await patch(undefined, { visibility: 'public' }, eligible)).status === 401);
    check('ordinary user PATCH public -> 403 (not 409), revealing nothing', await (async () => { const r = await patch('other', { visibility: 'public' }, eligible); const t = await r.text(); return r.status === 403 && !/review_required|ELG0100/.test(t); })());
    check('malformed id -> 400 invalid_vehicle_id', (await patch('mod', { visibility: 'public' }, 'not-a-uuid')).status === 400);
    check('unknown visibility -> 400 invalid_visibility', (await patch('mod', { visibility: 'hidden' }, eligible)).status === 400);
    check('a bad reason -> 400 invalid_reason (validated first)', (await patch('mod', { visibility: 'public', reason: 5 }, eligible)).status === 400);
    check('a missing vehicle -> 404 not_found (it does not pretend a review is needed)', (await patch('mod', { visibility: 'public' }, MISSING)).status === 404);
    check('none of those changed anything', rows(ctx).length === 0 && all.every(v => vis(ctx, v) === 'private'));

    // The shared write has no way to skip the approval guard.
    let threw = false; try { await db.setRobotaxiVehicleVisibility(ctx.d1, eligible, 'public'); } catch (e) { threw = /only set private/.test(e.message); }
    check('the low-level setter refuses to set public at all (it cannot be a back door)', threw && vis(ctx, eligible) === 'private');
    const bypass = await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: dupA, moderatorId: 'mod', target: 'public', requireApprovalEligibility: false });
    check('there is no option to skip the approval guard: passing requireApprovalEligibility:false still refuses a duplicate plate', bypass.applied === false && vis(ctx, dupA) === 'private' && rows(ctx).length === 0);

    // The review endpoint remains the authoritative way.
    const viaReview = await approve(ctx, 'mod', eligible, 'Reviewed.'); const rj = await viaReview.json();
    check('POST /review approve_cybercab still approves the same vehicle (200)', viaReview.status === 200 && rj.success === true && rj.action === 'approved_public' && vis(ctx, eligible) === 'public');
    check('and it wrote exactly one audit row: moderator, timestamp, reason and the decision-time counts', rows(ctx).length === 1 && rows(ctx)[0].moderator_user_id === 'mod' && rows(ctx)[0].action === 'approved_public' && rows(ctx)[0].reason === 'Reviewed.' && rows(ctx)[0].counted_ride_count === 1 && rows(ctx)[0].plate_vehicle_count === 1 && /^\d{4}-\d{2}-\d{2} /.test(rows(ctx)[0].created_at));
    check('the approved vehicle is publicly accessible (vehicle and sightings endpoints)', (await pub(ctx, `/api/robotaxi-vehicles/${eligible}`)).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${eligible}/sightings`)).status === 200);
    check('the duplicate rows are still refused by the review action too', (await approve(ctx, 'mod', dupA)).status === 409 && (await approve(ctx, 'mod', noRides)).status === 409 && (await approve(ctx, 'mod', reviewOnly)).status === 409 && rows(ctx).length === 1);

    // PATCH public on a vehicle that is ALREADY public is also refused, with no write at all.
    const publicRow = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', eligible)[0]);
    const again = await patch('mod', { visibility: 'public' }, eligible);
    check('PATCH public on an already-public vehicle is refused too (409), and writes nothing', again.status === 409 && (await again.json()).error === 'review_required' && JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', eligible)[0]) === publicRow && rows(ctx).length === 1);

    // PATCH private: administrative takedown keeps working, audited.
    const down = await patch('mod', { visibility: 'private', reason: 'Emergency takedown.' }, eligible); const dj = await down.json();
    check('PATCH private still works (200) as an administrative takedown', down.status === 200 && dj.success === true && vis(ctx, eligible) === 'private');
    check('the takedown is audited: returned_private, moderator, reason, prior visibility', rows(ctx).length === 2 && rows(ctx)[1].action === 'returned_private' && rows(ctx)[1].moderator_user_id === 'mod' && rows(ctx)[1].reason === 'Emergency takedown.' && rows(ctx)[1].previous_visibility === 'public');
    check('the takedown takes effect publicly at once', (await pub(ctx, `/api/robotaxi-vehicles/${eligible}`)).status === 404);
    check('the earlier approval row is untouched by the takedown', rows(ctx)[0].action === 'approved_public' && rows(ctx)[0].reason === 'Reviewed.');
    const idem = await patch('mod', { visibility: 'private' }, eligible);
    check('PATCH private on an already-private vehicle stays idempotent (200) and adds no history', idem.status === 200 && rows(ctx).length === 2);
    check('PATCH private on a missing vehicle -> 404', (await patch('mod', { visibility: 'private' }, MISSING)).status === 404);
    check('PATCH private works even for a vehicle that could not be approved (e.g. a flagged-public duplicate)', await (async () => { ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${dupA}'`); const r = await patch('mod', { visibility: 'private' }, dupA); return r.status === 200 && vis(ctx, dupA) === 'private'; })());

    const dupRow = rows(ctx).filter(r => r.robotaxi_vehicle_id === dupA).pop();
    check('that takedown\'s audit row records the decision-time facts for a DUPLICATE plate: plate_vehicle_count 2, its counted ride, prior visibility', !!dupRow && dupRow.action === 'returned_private' && dupRow.previous_visibility === 'public' && dupRow.plate_vehicle_count === 2 && dupRow.counted_ride_count === 1 && dupRow.license_plate === 'DUP0101' && dupRow.moderator_user_id === 'mod');

    // After a takedown the ONLY way back to public is a fresh review.
    check('after a takedown, PATCH public is still refused', (await patch('mod', { visibility: 'public' }, eligible)).status === 409 && vis(ctx, eligible) === 'private');
    check('and a fresh POST /review approves it again, appending a new history row', (await approve(ctx, 'mod', eligible)).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${eligible}`)).status === 200 && rows(ctx).filter(r => r.robotaxi_vehicle_id === eligible).map(r => r.action).join() === 'approved_public,returned_private,approved_public');
  }
  console.log('4c. Race between the handler\'s read and its atomic write (the moderator\'s page was stale)');
  {
    // The handler reads the vehicle, sees it eligible, and only THEN writes. Here the world changes in exactly that gap: the wrapped database runs
    // `mutate` just before the handler's atomic batch. The single-connection test database proves the logic, not D1's parallelism.
    const interleaved = async (setup, mutate, action = 'approve_cybercab') => {
      const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
      ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
      const v = setup(ctx);
      if (action === 'approve_cybercab') await setVin(ctx, 'mod', v, VIN_A).catch(() => {});
      const real = ctx.d1; let fired = false;
      ctx.env.cybercabhunter_db = { prepare: real.prepare.bind(real), exec: real.exec.bind(real), query: real.query.bind(real),
        async batch(statements) { if (!fired) { fired = true; mutate(real, v); } return real.batch(statements); } };
      const resp = await review(ctx, 'mod', v, { action });
      return { ctx, v, fired, status: resp.status, body: await resp.json(), real };
    };
    const eligibleVehicle = ctx => { const v = rawVehicle(ctx, id(200), 'RAC0200'); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' }); return v; };
    const refusedApproval = (label, r, reason) => {
      check(`${label}: the write was reached (the interleaving really happened between the read and the write)`, r.fired === true);
      check(`${label}: refused 409 not_eligible, and the response says success:false`, r.status === 409 && r.body.success === false && r.body.error === 'not_eligible');
      check(`${label}: it names the CURRENT reason (${reason}), not the stale eligible state`, r.body.blocking_reasons.includes(reason) && r.body.vehicle.approval.can_approve === false);
      check(`${label}: the vehicle stays private, is not publicly retrievable, and NO audit row was written`, vis(r.ctx, r.v) === 'private' && rows(r.ctx).length === 0 && r.body.vehicle.visibility === 'private');
    };

    refusedApproval('its only counted ride is deleted', await interleaved(eligibleVehicle, (d, v) => d.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${v}'`)), 'no_counted_rides');
    refusedApproval('its only ride is downgraded to needs_review', await interleaved(eligibleVehicle, (d, v) => d.exec(`UPDATE submissions SET status = 'needs_review' WHERE id IN (SELECT submission_id FROM trips WHERE robotaxi_vehicle_id = '${v}')`)), 'no_counted_rides');
    refusedApproval('its only ride is rejected', await interleaved(eligibleVehicle, (d, v) => d.exec(`UPDATE submissions SET status = 'rejected' WHERE id IN (SELECT submission_id FROM trips WHERE robotaxi_vehicle_id = '${v}')`)), 'no_counted_rides');
    refusedApproval('its only ride is superseded by another trip', await interleaved(eligibleVehicle, (d, v) => { const other = rawVehicle({ d1: d }, id(201), 'OTH0201'); const winner = seedRide(d, { userId: 'rider', vehicleId: other, status: 'pending' }); d.exec(`UPDATE trips SET superseded_by = '${winner}' WHERE robotaxi_vehicle_id = '${v}'`); }), 'no_counted_rides');
    refusedApproval('a second registry row for the same plate appears', await interleaved(eligibleVehicle, d => rawVehicle({ d1: d }, id(202), 'RAC-0200')), 'duplicate_plate');
    check('control: with NO interleaving the same vehicle is approved through the same handler (200) and one audit row is written', await (async () => { const ctx = await makeApp({ rider: 'user', mod: 'moderator' }); const v = eligibleVehicle(ctx); await setVin(ctx, 'mod', v, VIN_A); const r = await review(ctx, 'mod', v, { action: 'approve_cybercab' }); return r.status === 200 && vis(ctx, v) === 'public' && rows(ctx).length === 1; })());

    // Another moderator gets there first.
    const wonByOther = await interleaved(eligibleVehicle, (d, v) => d.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${v}'`));
    check('another moderator approved it in the gap: 409 already_public, success:false, and THIS call wrote no history', wonByOther.status === 409 && wonByOther.body.success === false && wonByOther.body.error === 'already_public' && rows(wonByOther.ctx).length === 0);
    // Someone else takes it down in the gap.
    const takenByOther = await interleaved(ctx => { const v = eligibleVehicle(ctx); ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${v}'`); return v; }, (d, v) => d.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${v}'`), 'return_private');
    check('someone else returned it to private in the gap: 409 already_private, success:false, and THIS call wrote no history', takenByOther.status === 409 && takenByOther.body.success === false && takenByOther.body.error === 'already_private' && rows(takenByOther.ctx).length === 0);

    // Two moderators approving at the same moment.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    const v = eligibleVehicle(ctx);
    await setVin(ctx, 'mod', v, VIN_A);
    const both = await Promise.all([review(ctx, 'mod', v, { action: 'approve_cybercab' }), review(ctx, 'mod2', v, { action: 'approve_cybercab' })]);
    check('two moderators approving concurrently: exactly one 200 and one 409', both.map(r => r.status).sort().join() === '200,409');
    check('and exactly one history row exists (no duplicate audit entry)', rows(ctx).length === 1 && vis(ctx, v) === 'public');
  }
  {
    // Nothing else in the application can write visibility = public.
    // registry-cleanup-sql.js is excluded on purpose: it only PRODUCES SQL text for the operator to read and run by hand (it executes nothing and is
    // not imported by any worker module — see tests/registry-review-tooling.test.mjs), so it is not an application code path.
    const files = fs.readdirSync(`${ROOT}worker`).filter(f => f.endsWith('.js') && f !== 'registry-cleanup-sql.js');
    const strip = src => src.replace(/\/\/.*$/gm, '');
    const writers = files.filter(f => /UPDATE\s+robotaxi_vehicles\s+SET[^;`]*visibility/i.test(strip(fs.readFileSync(`${ROOT}worker/${f}`, 'utf8'))));
    check('visibility on robotaxi_vehicles is written only in db.js (routes and every other module never write it)', JSON.stringify(writers) === '["db.js"]');
    const dbSrc = strip(fs.readFileSync(`${ROOT}worker/db.js`, 'utf8'));
    const updates = [...dbSrc.matchAll(/UPDATE\s+robotaxi_vehicles\s+SET\s+visibility[^`]*`/gi)].map(m => m[0].replace(/\s+/g, ' '));
    check('within db.js exactly two statements write it: the guarded change function and the private-only setter', updates.length === 2);
    const modSrc = strip(fs.readFileSync(`${ROOT}worker/moderation.js`, 'utf8'));
    check('the PATCH handler never calls the change function with a public target from request input', !/target:\s*body\.visibility/.test(modSrc.slice(modSrc.indexOf('export async function apiSetVehicleVisibility'), modSrc.indexOf('export async function apiReviewRegistryVehicle'))) || /review_required/.test(modSrc));
    check('the requireApprovalEligibility option no longer exists anywhere', !/requireApprovalEligibility/.test(dbSrc) && !/requireApprovalEligibility/.test(modSrc));
  }

  console.log('4d. DELETE removes a registry row AND every ride/receipt logged against it — unlike the takedown PATCH, regardless of current visibility');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', other: 'user' });
    const del = (user, vid) => call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${vid}`, user);
    const priv = rawVehicle(ctx, id(300), 'DEL0300'); seedRide(ctx.d1, { userId: 'rider', vehicleId: priv, status: 'pending' });
    const pubV = rawVehicle(ctx, id(301), 'DEL0301', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: pubV, status: 'pending' });

    const r1 = await del('mod', priv);
    check('deleting a private vehicle succeeds (200)', r1.status === 200 && (await r1.json()).id === priv);
    check('the row is gone from the database', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', priv).length === 1 && ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', priv)[0].n === 0);
    check('its trip and submission are deleted too, not just unlinked — this is what actually frees the receipt to be resent', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1 && ctx.d1.query('SELECT COUNT(*) AS n FROM submissions')[0].n === 1);

    const r2 = await del('mod', pubV);
    check('deleting a CURRENTLY PUBLIC vehicle also succeeds (200) — DELETE is not limited to private rows the way PATCH is', r2.status === 200);
    check('it is gone from the database and from the public endpoint alike', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', pubV)[0].n === 0 && (await pub(ctx, `/api/robotaxi-vehicles/${pubV}`)).status === 404);
    check('its trip is gone too', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0);

    check('malformed id -> 400 invalid_vehicle_id, nothing touched', (await del('mod', 'not-a-uuid')).status === 400);
    check('a hostile id string is inert (400, no injection)', (await del('mod', encodeURIComponent("x'; DROP TABLE robotaxi_vehicles;--"))).status === 400 && ctx.d1.query("SELECT name FROM sqlite_master WHERE type='table' AND name='robotaxi_vehicles'").length === 1);
    check('deleting the same vehicle twice: the second call is 404 not_found, not a silent success', (await del('mod', priv)).status === 404);
    check('deleting a vehicle that never existed -> 404', (await del('mod', MISSING)).status === 404);

    // Review history rows deliberately have no foreign key to the vehicle (see migrations/0012's design notes)
    // and are NOT deleted or rewritten when the vehicle they describe is removed — they are a record of what a
    // moderator decided, not a live view of the vehicle.
    const withHistory = rawVehicle(ctx, id(302), 'DEL0302'); seedRide(ctx.d1, { userId: 'rider', vehicleId: withHistory, status: 'pending' });
    await approve(ctx, 'mod', withHistory);
    const historyCountBefore = rows(ctx).filter(r => r.robotaxi_vehicle_id === withHistory).length;
    const totalReviewRowsBefore = rows(ctx).length;
    await del('mod', withHistory);
    check('its review-history row(s) survive the vehicle\'s deletion, unchanged', historyCountBefore === 1 && rows(ctx).filter(r => r.robotaxi_vehicle_id === withHistory).length === 1 && rows(ctx).find(r => r.robotaxi_vehicle_id === withHistory).action === 'approved_public');
    check('deleting a vehicle writes no NEW review-history row of its own (DELETE is not audited there)', rows(ctx).length === totalReviewRowsBefore);
  }

  console.log('4e. Deleting a vehicle frees its receipt(s) to be resent and re-reviewed from scratch');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const importOnce = () => call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.1 mi · 21 min · DEL0400', date: 'August 5, 2026' }) }] });
    const vehicleByPlate = async plate => (await (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles?plate=${plate}`, 'mod')).json()).vehicles;

    const first = await (await importOnce()).json();
    check('the first import creates a new trip', first.run.added === 1 && first.results[0].outcome === 'created');
    const before = await vehicleByPlate('DEL0400');
    await approve(ctx, 'mod', before[0].id);
    check('the trip and submission exist before the delete', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1 && ctx.d1.query('SELECT COUNT(*) AS n FROM submissions')[0].n === 1);

    const del = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${before[0].id}`, 'mod');
    check('the delete succeeds', del.status === 200);
    check('the trip, its submission and its ingestion log rows are ALL gone, not just the vehicle', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) AS n FROM submissions')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) AS n FROM receipt_ingestions')[0].n === 0);

    const resend = await (await importOnce()).json();
    check('resending the SAME receipt is now a brand-new "created" trip, not a duplicate stuck behind the old, deleted vehicle', resend.run.added === 1 && resend.run.duplicates === 0 && resend.results[0].outcome === 'created');
    const after = await vehicleByPlate('DEL0400');
    check('a fresh, private vehicle exists again, ready for a moderator to review from scratch', after.length === 1 && after[0].visibility === 'private' && after[0].id !== before[0].id);
  }
  {
    // Deleting a vehicle reaches every rider who logged a ride on it, not just one account.
    const ctx = await makeApp({ r1: 'user', r2: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(310), 'DEL0310');
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending' });
    seedRide(ctx.d1, { userId: 'r2', vehicleId: v, status: 'pending' });
    check('two different riders both have a trip on this vehicle before the delete', ctx.d1.query('SELECT COUNT(*) AS n FROM trips WHERE robotaxi_vehicle_id = ?', v)[0].n === 2);
    const r = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'mod');
    check('the delete succeeds across both riders in one call', r.status === 200);
    check('both riders\' trips and submissions are gone', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) AS n FROM submissions')[0].n === 0);
  }
  {
    // A superseded duplicate trip on the vehicle is removed along with the trip that superseded it.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(311), 'DEL0311');
    const winner = seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending', supersededBy: winner });
    check('setup: two trips on the vehicle, one superseded by the other', ctx.d1.query('SELECT COUNT(*) AS n FROM trips WHERE robotaxi_vehicle_id = ?', v)[0].n === 2);
    const r = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'mod');
    check('the delete succeeds', r.status === 200);
    check('both the winning trip and the superseded duplicate are gone', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 0);
  }
  {
    // R2 evidence behind a deleted trip's receipt is removed too, not left orphaned.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(312), 'DEL0312');
    const tripId = seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    const evidenceKey = `evidence/${tripId}.eml`;
    await ctx.env.EVIDENCE_BUCKET.put(evidenceKey, 'raw receipt bytes');
    ctx.d1.exec(`UPDATE submissions SET evidence_ref = '${evidenceKey}' WHERE id = 'sub-${tripId}'`);
    check('the evidence object exists before the delete', ctx.env.EVIDENCE_BUCKET._objects.has(evidenceKey));
    const r = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'mod');
    check('the delete succeeds', r.status === 200);
    check('the evidence object is removed from R2 along with the trip', !ctx.env.EVIDENCE_BUCKET._objects.has(evidenceKey));
  }
  {
    // A vehicle with no rides at all deletes cleanly (nothing to purge).
    const ctx = await makeApp({ mod: 'moderator' });
    const v = rawVehicle(ctx, id(313), 'DEL0313');
    const r = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'mod');
    check('deleting a rideless vehicle still succeeds', r.status === 200 && (await r.json()).id === v);
  }
  {
    // Auth still applies to the delete route.
    const ctx = await makeApp({ rider: 'user', other: 'user' });
    const v = rawVehicle(ctx, id(315), 'DEL0315');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });
    check('unauthenticated delete -> 401, nothing touched', (await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, undefined)).status === 401);
    const ordinary = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${v}`, 'other');
    check('an ordinary (non-moderator) user gets 403, nothing touched', ordinary.status === 403);
    check('the vehicle and its trip both still exist', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?', v)[0].n === 1 && ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1);
  }

  console.log('5. The moderator payload: factual, complete, and free of private data');
  {
    const ctx = await makeApp({ 'rider-secret': 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(80), 'PAY0080');
    seedRide(ctx.d1, { userId: 'rider-secret', vehicleId: v, status: 'pending', source: 'receipt_email', rideDate: '2026-06-01', pickupDescription: 'SECRET PICKUP', dropoffDescription: 'SECRET DROPOFF', fare: 7777 });
    seedRide(ctx.d1, { userId: 'rider-secret', vehicleId: v, status: 'needs_review', rideDate: '2026-06-02' });
    seedRide(ctx.d1, { userId: 'rider-secret', vehicleId: v, status: 'rejected', rideDate: '2026-06-03' });
    const p = await one(ctx, 'PAY0080');
    check('it reports the counted, needs_review, rejected and total counts', p.counted_ride_count === 1 && p.needs_review_ride_count === 1 && p.rejected_ride_count === 1 && p.total_trip_count === 3);
    check('it reports the existing verification_status field, unchanged by anything here', p.verification_status === 'unverified');
    check('it keeps the existing provenance, dates and timestamps', p.counted_rides_by_source.receipt_email === 1 && p.first_counted_ride_date === '2026-06-01' && p.first_seen_at === '2026-05-01 10:00:00' && typeof p.created_at === 'string');
    check('a needs_review ride alongside a counted ride is a note, not a blocker', p.approval.can_approve === true && p.approval.notes.includes('needs_review_ride_present') && p.approval.notes.includes('eligible_counted_ride_present'));
    const text = JSON.stringify(await list(ctx, '?scope=private'));
    check('no rider identity, address or fare is exposed', !/rider-secret|SECRET|7777|pickup|dropoff|@/i.test(text));
    check('the only user id present is the moderator\'s, and only inside latest_review', !/user_id/.test(text.replace(/"moderator_user_id"/g, '')));
    check('no score, confidence, trust or ranking field exists', !/score|confidence|trust|rank|likely|authentic|genuine/i.test(text));
    check('the approval object lists only codes, never sentences of judgment', p.approval.blocking_reasons.every(c => /^[a-z_]+$/.test(c)) && p.approval.notes.every(c => /^[a-z_]+$/.test(c)));

    const a = await approve(ctx, 'mod', v);
    const after = await one(ctx, 'PAY0080');
    check('approving changed no ride, trip or submission data', (await a.json()).success === true && ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 3);
    check('approving changed only visibility (and updated_at) on the vehicle row', after.first_seen_at === p.first_seen_at && after.last_seen_at === p.last_seen_at && after.verification_status === 'unverified' && after.license_plate === 'PAY0080');
  }
  {
    // Scopes.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const withRide = rawVehicle(ctx, id(90), 'SCP0090'); seedRide(ctx.d1, { userId: 'rider', vehicleId: withRide, status: 'pending' });
    const noRide = rawVehicle(ctx, id(91), 'SCP0091');
    const pubV = rawVehicle(ctx, id(92), 'SCP0092', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: pubV, status: 'pending' });
    const plates = async qs => (await list(ctx, qs)).vehicles.map(v => v.license_plate).sort().join();
    check('default scope: private vehicles that already have a counted ride', await plates('') === 'SCP0090');
    check('scope=private: every private vehicle, including ones with no counted rides', await plates('?scope=private') === 'SCP0090,SCP0091');
    check('scope=public: only public vehicles', await plates('?scope=public') === 'SCP0092');
    check('an unknown scope falls back to the default (never widens the list)', await plates('?scope=everything') === 'SCP0090');
    check('listing is read-only', vis(ctx, withRide) === 'private' && rows(ctx).length === 0);
  }

  console.log('6. Scope of this phase');
  {
    const ctx = await makeApp({ mod: 'moderator' }); ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
    check('there is still no bulk-approve route, and /vehicles is only a static page, not a Worker route (the public list itself lives in vehicle-registry.test.mjs)', (await call(ctx, 'GET', '/vehicles', null)).status === 404 && (await call(ctx, 'POST', '/api/moderation/robotaxi-vehicles/approve-all', 'mod', {})).status === 404 && (await call(ctx, 'POST', '/api/moderation/robotaxi-vehicles/review', 'mod', {})).status === 404);
    check('the review route accepts only POST', (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${MISSING}/review`, 'mod')).status === 404 && (await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${MISSING}/review`, 'mod', { action: 'approve_cybercab' })).status === 404);
    const migrations = fs.readdirSync(`${ROOT}migrations`).filter(f => f.endsWith('.sql')).sort();
    check('exactly one migration was added for this phase (0012), additive only', migrations.includes('0012_robotaxi_vehicle_reviews.sql') && !/\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(fs.readFileSync(`${ROOT}migrations/0012_robotaxi_vehicle_reviews.sql`, 'utf8').replace(/^--.*$/gm, '')));
    check('the migration creates exactly the review table with the two allowed actions', /CREATE TABLE robotaxi_vehicle_reviews/.test(fs.readFileSync(`${ROOT}migrations/0012_robotaxi_vehicle_reviews.sql`, 'utf8')) && /CHECK \(action IN \('approved_public', 'returned_private'\)\)/.test(fs.readFileSync(`${ROOT}migrations/0012_robotaxi_vehicle_reviews.sql`, 'utf8')));
    // countedRideExistsSql/publicVehicleEligibleSql moved to worker/ride-status.js (Candidate B: Rider
    // Data reuses them too, and that would have meant a circular import if they'd stayed in worker/db.js,
    // which already imports worker/db-rides.js). worker/db.js now imports them rather than defining them —
    // confirm both: the definition itself hasn't drifted, AND worker/db.js still uses the real import, not
    // a re-implementation of its own.
    const rideStatusSrc = fs.readFileSync(`${ROOT}worker/ride-status.js`, 'utf8');
    const dbSrc = fs.readFileSync(`${ROOT}worker/db.js`, 'utf8');
    check('the public eligibility gate is unchanged: still visibility public AND a counted, non-superseded ride', /visibility = 'public' AND \$\{countedRideExistsSql\(alias\)\}/.test(rideStatusSrc) && /WHERE t\.robotaxi_vehicle_id = \$\{alias\}\.id AND \$\{COUNTED_RIDES_WHERE\}/.test(rideStatusSrc));
    check('worker/db.js imports the real gate rather than defining its own copy', /import \{[^}]*publicVehicleEligibleSql[^}]*\}\s*from\s*'\.\/ride-status\.js'/.test(dbSrc) && !/^function publicVehicleEligibleSql/m.test(dbSrc));
  }

  console.log('7. VIN: a moderator-entered fact (POST .../vin), independent of approval');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', other: 'user' });
    const v = rawVehicle(ctx, id(400), 'VIN0400'); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });

    check('unauthenticated -> 401, nothing written', (await setVin(ctx, undefined, v, VIN_A)).status === 401);
    check('an ordinary user -> 403, nothing written', (await setVin(ctx, 'other', v, VIN_A)).status === 403);
    check('so far no vin is recorded', (await one(ctx, 'VIN0400')).vin === null);

    const beforeRow = JSON.stringify(ctx.d1.query('SELECT visibility, verification_status, first_seen_at, last_seen_at FROM robotaxi_vehicles WHERE id = ?', v)[0]);
    const before = await one(ctx, 'VIN0400');
    check('before saving: vin is null and Approve Cybercab is not allowed', before.vin === null && before.can_approve_cybercab === false);
    const r = await setVin(ctx, 'mod', v, VIN_A); const j = await r.json();
    check('a moderator can save a VIN (200), and it is echoed back', r.status === 200 && j.success === true && j.vehicle.vin === VIN_A);
    check('it is stored uppercase and trimmed', (await setVin(ctx, 'mod', rawVehicle(ctx, id(401), 'VIN0401'), `  ${VIN_A.toLowerCase()}  `).then(x => x.json())).vehicle.vin === VIN_A);

    const after = await one(ctx, 'VIN0400');
    check('saving a VIN does not grant visibility: the vehicle is still private', after.visibility === 'private' && vis(ctx, v) === 'private');
    check('saving a VIN does not approve anything: it wrote NO robotaxi_vehicle_reviews row', rows(ctx).length === 0);
    check('saving a VIN does not touch ride/trip data', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1);
    check('saving a VIN changed nothing else on the vehicle row (only vin/vin_set_by_user_id/vin_set_at/updated_at)', JSON.stringify(ctx.d1.query('SELECT visibility, verification_status, first_seen_at, last_seen_at FROM robotaxi_vehicles WHERE id = ?', v)[0]) === beforeRow);
    check('eligibility (publicly_eligible / approval) is exactly what it was before, apart from the new can_approve_cybercab gate', after.publicly_eligible === before.publicly_eligible && after.approval.state === before.approval.state && after.approval.can_approve === before.approval.can_approve);
    check('now Approve Cybercab is allowed (existing guard already passed, and a vin is now present)', after.can_approve_cybercab === true);
    check('the vin does not leak into the public API before approval', (await pub(ctx, `/api/robotaxi-vehicles/${v}`)).status === 404);

    check('an existing VIN cannot be silently overwritten: 409 vin_already_set, value unchanged', await (async () => {
      const r2 = await setVin(ctx, 'mod', v, VIN_B); const j2 = await r2.json();
      return r2.status === 409 && j2.error === 'vin_already_set' && (await one(ctx, 'VIN0400')).vin === VIN_A;
    })());
    check('overwrite is refused even for a different moderator', await (async () => {
      await ctx.env.TESLA_SESSIONS.put('session:session-mod3', JSON.stringify({ user_id: 'mod3' }));
      ctx.d1.exec(`INSERT INTO users (id, role) VALUES ('mod3', 'moderator')`);
      const r2 = await setVin(ctx, 'mod3', v, VIN_B);
      return r2.status === 409 && (await one(ctx, 'VIN0400')).vin === VIN_A;
    })());

    const bad = async (label, resp, status, error) => { const r = await resp; const j = await r.json(); check(`${label} -> ${status} ${error}`, r.status === status && j.error === error); };
    const fresh = rawVehicle(ctx, id(402), 'VIN0402');
    await bad('a non-JSON body', setVin(ctx, 'mod', fresh, undefined, 'not json'), 400, 'invalid_body');
    await bad('a missing vin field', setVin(ctx, 'mod', fresh, undefined), 400, 'invalid_body');
    await bad('a non-string vin', setVin(ctx, 'mod', fresh, 12345678901234567), 400, 'invalid_body');
    await bad('too short', setVin(ctx, 'mod', fresh, 'SHORT123'), 400, 'invalid_vin');
    await bad('too long', setVin(ctx, 'mod', fresh, VIN_A + 'X'), 400, 'invalid_vin');
    await bad('contains a disallowed letter (O)', setVin(ctx, 'mod', fresh, 'O'.repeat(17)), 400, 'invalid_vin');
    await bad('a malformed vehicle id', setVin(ctx, 'mod', 'not-a-uuid', VIN_A), 400, 'invalid_vehicle_id');
    await bad('a well-formed but missing vehicle', setVin(ctx, 'mod', MISSING, VIN_A), 404, 'not_found');
    check('none of the invalid attempts wrote a vin', (await one(ctx, 'VIN0402')).vin === null);

    // A deleted vehicle cannot gain a VIN through this or any other path — the row is simply gone.
    const gone = rawVehicle(ctx, id(403), 'VIN0403');
    await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${gone}`, 'mod');
    check('saving a VIN for a deleted vehicle -> 404, not resurrected', (await setVin(ctx, 'mod', gone, VIN_A)).status === 404);

    // The VIN persists across an approve/return-to-private cycle and is never touched by either.
    await approveCybercab(ctx, 'mod', v);
    check('vin is unchanged after Approve Cybercab', (await one(ctx, 'VIN0400')).vin === VIN_A);
    await giveBack(ctx, 'mod', v);
    check('vin is unchanged after returning to private', (await one(ctx, 'VIN0400')).vin === VIN_A);
  }

  console.log('7c. Regression: a vehicle that is already public cannot have a vin attached afterward (closes the bypass where a vin — and so Cybercab2.png — could reach the public site without Approve Cybercab ever running)');
  {
    // The ordinary/ungated approval action that used to make this reachable
    // through normal moderation no longer exists at all (approve_cybercab is
    // now the only way to grant public visibility, and it requires a vin
    // first — so "public with no vin" can no longer happen through the API).
    // The guard being tested here is defense-in-depth for any OTHER way a
    // vehicle might already be public with no vin — e.g. a legacy row from
    // before this registry required one — so it's set up directly, exactly
    // like this file's other "flagged public" fixtures (see hiddenApproved
    // in section 3 above).
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(405), 'VIN0405', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: v, status: 'pending' });

    check('setup: the vehicle is public with no vin', vis(ctx, v) === 'public' && (await one(ctx, 'VIN0405')).vin === null);
    const auditBefore = rows(ctx).length;

    // 4-5: attempt the VIN endpoint on the now-public vehicle -> 409 already_public.
    const r = await setVin(ctx, 'mod', v, VIN_A); const j = await r.json();
    check('the VIN endpoint refuses an already-public vehicle: 409 already_public', r.status === 409 && j.error === 'already_public' && j.vehicle.visibility === 'public');

    // 6: the vehicle still has no vin.
    check('the vehicle still has no vin after the refusal', (await one(ctx, 'VIN0405')).vin === null);

    // 7: the public response carries no VIN/image signal.
    const pr = await pub(ctx, `/api/robotaxi-vehicles/${v}`);
    const prBody = JSON.parse(pr.text);
    check('the public response has vin: null — no VIN/image signal reaches the public site', pr.status === 200 && prBody.vehicle.vin === null && !pr.text.includes(VIN_A));

    // 8: no extra review row or other vehicle-state change from the rejected request.
    check('no review-history row was written by the rejected VIN request', rows(ctx).length === auditBefore);
    check('visibility, ride/trip counts and everything else are untouched by the refusal', vis(ctx, v) === 'public' && ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 1);

    // The refusal is not a one-time fluke: repeating it behaves identically.
    check('a repeated attempt is refused the same way', (await setVin(ctx, 'mod', v, VIN_B)).status === 409);
  }

  console.log('8. Approve Cybercab: the existing approval guard, PLUS a VIN already on file — evaluateVehicleApproval itself is untouched');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const eligible = rawVehicle(ctx, id(410), 'CYB0410'); seedRide(ctx.d1, { userId: 'rider', vehicleId: eligible, status: 'pending' });

    check('without a vin: approve_cybercab is refused 409 not_eligible with reason no_vin (guard itself already passes)', await (async () => {
      const r = await approveCybercab(ctx, 'mod', eligible); const j = await r.json();
      return r.status === 409 && j.error === 'not_eligible' && j.blocking_reasons.join() === 'no_vin' && vis(ctx, eligible) === 'private';
    })());
    check('approve_public is no longer a recognized action at all: 400 invalid_action, nothing changed', await (async () => {
      const other = rawVehicle(ctx, id(411), 'PUB0411'); seedRide(ctx.d1, { userId: 'rider', vehicleId: other, status: 'pending' });
      const r = await review(ctx, 'mod', other, { action: 'approve_public' }); const j = await r.json();
      return r.status === 400 && j.error === 'invalid_action' && vis(ctx, other) === 'private';
    })());
    check('a vehicle that is missing BOTH a counted ride and a vin reports both reasons together', await (async () => {
      const empty = rawVehicle(ctx, id(412), 'CYB0412');
      const r = await approveCybercab(ctx, 'mod', empty); const j = await r.json();
      return r.status === 409 && j.blocking_reasons.sort().join() === ['no_counted_rides', 'no_vin'].sort().join();
    })());
    check('evaluateVehicleApproval itself never mentions vin: ordinary approval state/can_approve for the vehicle above are unaffected by having no vin', (await one(ctx, 'CYB0410')).approval.state === 'eligible_for_approval' && (await one(ctx, 'CYB0410')).approval.can_approve === true && !('vin' in (await one(ctx, 'CYB0410')).approval));
    check('no history row was written by any refused attempt so far (missing vin, invalid_action, or missing both)', rows(ctx).length === 0);

    await setVin(ctx, 'mod', eligible, VIN_A);
    const auditBefore = rows(ctx).length;
    const r = await approveCybercab(ctx, 'mod', eligible); const j = await r.json();
    check('with the existing guard passing AND a vin on file, approve_cybercab succeeds (200)', r.status === 200 && j.success === true);
    check('it made the vehicle public', vis(ctx, eligible) === 'public' && j.vehicle.approval.state === 'public' && j.vehicle.publicly_eligible === true);
    check('it did not touch the vin', j.vehicle.vin === VIN_A);
    check('it wrote exactly one audit row, recorded as the SAME approved_public action — no new review action value was introduced', rows(ctx).length === auditBefore + 1 && rows(ctx)[rows(ctx).length - 1].action === 'approved_public' && rows(ctx)[rows(ctx).length - 1].moderator_user_id === 'mod');
    check('it did not touch ride/trip counts', ctx.d1.query('SELECT COUNT(*) AS n FROM trips')[0].n === 2); // eligible's ride + PUB0411's ride
    check('approve_cybercab sets model to Cybercab and color to Gold, and fills the blank service_area from the vehicle\'s own counted ride', j.vehicle.publicly_eligible === true && ctx.d1.query('SELECT model, color, service_area FROM robotaxi_vehicles WHERE id = ?', eligible)[0].model === 'Cybercab' && ctx.d1.query('SELECT model, color, service_area FROM robotaxi_vehicles WHERE id = ?', eligible)[0].color === 'Gold' && ctx.d1.query('SELECT model, color, service_area FROM robotaxi_vehicles WHERE id = ?', eligible)[0].service_area === 'Dallas');
    check('a vehicle never approved through any path (PUB0411, above) still has no model/color set — the field-fill is exclusive to approve_cybercab succeeding', ctx.d1.query('SELECT model, color FROM robotaxi_vehicles WHERE id = ?', id(411))[0].model === null && ctx.d1.query('SELECT model, color FROM robotaxi_vehicles WHERE id = ?', id(411))[0].color === null);
    check('the vehicle is now publicly reachable and its vin is exposed publicly (only the vin itself, no provenance)', await (async () => {
      const pr = await pub(ctx, `/api/robotaxi-vehicles/${eligible}`); const body = pr.text;
      return pr.status === 200 && body.includes(VIN_A) && !/vin_set_by_user_id|vin_set_at/.test(body);
    })());

    check('approve_cybercab on an already-public vehicle -> 409 already_public', (await approveCybercab(ctx, 'mod', eligible)).status === 409);

    // The existing guard (duplicate plate) still applies to approve_cybercab, unchanged.
    const dupA = rawVehicle(ctx, id(420), 'DUP0420'); const dupB = rawVehicle(ctx, id(421), 'dup-0420');
    for (const d of [dupA, dupB]) seedRide(ctx.d1, { userId: 'rider', vehicleId: d, status: 'pending' });
    await setVin(ctx, 'mod', dupA, VIN_B);
    const dupResp = await approveCybercab(ctx, 'mod', dupA); const dupBody = await dupResp.json();
    check('a duplicate plate is still refused for approve_cybercab even with a vin on file', dupResp.status === 409 && dupBody.blocking_reasons.includes('duplicate_plate') && vis(ctx, dupA) === 'private');

    // Validation: approve_cybercab is a recognized action value.
    check('approve_cybercab is accepted as a valid action (not invalid_action)', await (async () => {
      const noVehicle = await review(ctx, 'mod', MISSING, { action: 'approve_cybercab' });
      return noVehicle.status === 404; // reaches the not_found check, not invalid_action -> proves the action itself validated fine
    })());
  }

  console.log('9. Approve Cybercab\'s model/color/service_area write: always-overwrite vs fill-only, and picking the EARLIEST counted ride');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });

    // model/color are unconditionally overwritten, even if a community sighting had already set something else.
    const relabeled = rawVehicle(ctx, id(430), 'CYB0430');
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET model = 'Model Y', color = 'Pearl White' WHERE id = '${relabeled}'`);
    seedRide(ctx.d1, { userId: 'rider', vehicleId: relabeled, status: 'pending', serviceArea: 'Austin' });
    await setVin(ctx, 'mod', relabeled, VIN_A);
    await approveCybercab(ctx, 'mod', relabeled);
    const relabeledRow = ctx.d1.query('SELECT model, color, service_area FROM robotaxi_vehicles WHERE id = ?', relabeled)[0];
    check('model/color are overwritten to Cybercab/Gold even if a prior (e.g. sighting-derived) value existed', relabeledRow.model === 'Cybercab' && relabeledRow.color === 'Gold');
    check('service_area is fill-ONLY: an existing value is never overwritten (there was none here, so it fills from the ride)', relabeledRow.service_area === 'Austin');

    // service_area is fill-only: an EXISTING value survives untouched.
    const keepsArea = rawVehicle(ctx, id(431), 'CYB0431');
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET service_area = 'Miami' WHERE id = '${keepsArea}'`);
    seedRide(ctx.d1, { userId: 'rider', vehicleId: keepsArea, status: 'pending', serviceArea: 'Austin' });
    await setVin(ctx, 'mod', keepsArea, VIN_B);
    await approveCybercab(ctx, 'mod', keepsArea);
    check('an existing service_area is never overwritten by approve_cybercab, unlike model/color', ctx.d1.query('SELECT service_area FROM robotaxi_vehicles WHERE id = ?', keepsArea)[0].service_area === 'Miami');

    // Multiple counted rides in different areas: the EARLIEST counted ride's area wins, not the latest.
    const multi = rawVehicle(ctx, id(432), 'CYB0432');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: multi, status: 'pending', serviceArea: 'Houston', rideDate: '2026-05-01' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: multi, status: 'pending', serviceArea: 'Phoenix', rideDate: '2026-07-01' });
    await setVin(ctx, 'mod', multi, '5YJSA1E27FF101185');
    await approveCybercab(ctx, 'mod', multi);
    check('with multiple counted rides, the EARLIEST one\'s service_area is used to fill the blank field', ctx.d1.query('SELECT service_area FROM robotaxi_vehicles WHERE id = ?', multi)[0].service_area === 'Houston');

    // A needs_review (uncounted) ride with an earlier date must not win over a real counted ride.
    const uncounted = rawVehicle(ctx, id(433), 'CYB0433');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: uncounted, status: 'needs_review', serviceArea: 'Denver', rideDate: '2026-01-01' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: uncounted, status: 'pending', serviceArea: 'Seattle', rideDate: '2026-08-01' });
    await setVin(ctx, 'mod', uncounted, '5YJSA1E27FF101186');
    await approveCybercab(ctx, 'mod', uncounted);
    check('an uncounted (needs_review) ride never supplies the fill value, even if it is chronologically earlier', ctx.d1.query('SELECT service_area FROM robotaxi_vehicles WHERE id = ?', uncounted)[0].service_area === 'Seattle');

    check('return_private never touches model/color/service_area', await (async () => {
      await giveBack(ctx, 'mod', relabeled);
      const row = ctx.d1.query('SELECT model, color, service_area FROM robotaxi_vehicles WHERE id = ?', relabeled)[0];
      return row.model === 'Cybercab' && row.color === 'Gold' && row.service_area === 'Austin';
    })());
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
