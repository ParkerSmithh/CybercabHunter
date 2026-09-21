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
const approve = (ctx, user, id, reason) => review(ctx, user, id, { action: 'approve_public', ...(reason !== undefined ? { reason } : {}) });
const giveBack = (ctx, user, id, reason) => review(ctx, user, id, { action: 'return_private', ...(reason !== undefined ? { reason } : {}) });
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
      ['POST review', () => review(ctx, undefined, v, { action: 'approve_public' }), () => review(ctx, 'rider', v, { action: 'approve_public' })],
      ['GET reviews', () => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, undefined), () => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${v}/reviews`, 'rider')],
      ['GET list', () => call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', undefined), () => call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', 'rider')],
      ['PATCH', () => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${v}`, undefined, { visibility: 'public' }), () => call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${v}`, 'rider', { visibility: 'public' })]
    ];
    for (const [name, unauth, ordinary] of routes) {
      check(`${name}: unauthenticated -> 401`, (await unauth()).status === 401);
      const r = await ordinary(); const txt = await r.text();
      check(`${name}: ordinary user -> 403 with no registry data`, r.status === 403 && !/AUT0001|counted|approval|reviews|license_plate/.test(txt));
    }
    check('none of the refused requests changed anything or wrote history', vis(ctx, v) === 'private' && rows(ctx).length === 0);
    check('a bogus bearer token is 401', (await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${v}/review`, { method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{"action":"approve_public"}' }), ctx.env, {})).status === 401);
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
    await bad('an array body', review(ctx, 'mod', v, ['approve_public']), 400, 'invalid_body');
    await bad('a non-string reason', approve(ctx, 'mod', v, 42), 400, 'invalid_reason');
    await bad('an over-long reason (281)', approve(ctx, 'mod', v, 'x'.repeat(281)), 400, 'invalid_reason');
    await bad('a malformed vehicle id', review(ctx, 'mod', 'not-a-uuid', { action: 'approve_public' }), 400, 'invalid_vehicle_id');
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
    check('POST /review approve_public still approves the same vehicle (200)', viaReview.status === 200 && rj.success === true && rj.action === 'approved_public' && vis(ctx, eligible) === 'public');
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
    const interleaved = async (setup, mutate, action = 'approve_public') => {
      const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
      ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
      const v = setup(ctx);
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
    check('control: with NO interleaving the same vehicle is approved through the same handler (200) and one audit row is written', await (async () => { const ctx = await makeApp({ rider: 'user', mod: 'moderator' }); const v = eligibleVehicle(ctx); const r = await review(ctx, 'mod', v, { action: 'approve_public' }); return r.status === 200 && vis(ctx, v) === 'public' && rows(ctx).length === 1; })());

    // Another moderator gets there first.
    const wonByOther = await interleaved(eligibleVehicle, (d, v) => d.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${v}'`));
    check('another moderator approved it in the gap: 409 already_public, success:false, and THIS call wrote no history', wonByOther.status === 409 && wonByOther.body.success === false && wonByOther.body.error === 'already_public' && rows(wonByOther.ctx).length === 0);
    // Someone else takes it down in the gap.
    const takenByOther = await interleaved(ctx => { const v = eligibleVehicle(ctx); ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${v}'`); return v; }, (d, v) => d.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${v}'`), 'return_private');
    check('someone else returned it to private in the gap: 409 already_private, success:false, and THIS call wrote no history', takenByOther.status === 409 && takenByOther.body.success === false && takenByOther.body.error === 'already_private' && rows(takenByOther.ctx).length === 0);

    // Two moderators approving at the same moment.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    const v = eligibleVehicle(ctx);
    const both = await Promise.all([review(ctx, 'mod', v, { action: 'approve_public' }), review(ctx, 'mod2', v, { action: 'approve_public' })]);
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
    check('the review route accepts only POST', (await call(ctx, 'GET', `/api/moderation/robotaxi-vehicles/${MISSING}/review`, 'mod')).status === 404 && (await call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${MISSING}/review`, 'mod', { action: 'approve_public' })).status === 404);
    const migrations = fs.readdirSync(`${ROOT}migrations`).filter(f => f.endsWith('.sql')).sort();
    check('exactly one migration was added for this phase (0012), additive only', migrations.length === 12 && migrations[11] === '0012_robotaxi_vehicle_reviews.sql' && !/\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(fs.readFileSync(`${ROOT}migrations/${migrations[11]}`, 'utf8').replace(/^--.*$/gm, '')));
    check('the migration creates exactly the review table with the two allowed actions', /CREATE TABLE robotaxi_vehicle_reviews/.test(fs.readFileSync(`${ROOT}migrations/0012_robotaxi_vehicle_reviews.sql`, 'utf8')) && /CHECK \(action IN \('approved_public', 'returned_private'\)\)/.test(fs.readFileSync(`${ROOT}migrations/0012_robotaxi_vehicle_reviews.sql`, 'utf8')));
    check('the public eligibility gate is unchanged: still visibility public AND a counted, non-superseded ride', /visibility = 'public' AND \$\{countedRideExistsSql\(alias\)\}/.test(fs.readFileSync(`${ROOT}worker/db.js`, 'utf8')) && /WHERE t\.robotaxi_vehicle_id = \$\{alias\}\.id AND \$\{COUNTED_RIDES_WHERE\}/.test(fs.readFileSync(`${ROOT}worker/db.js`, 'utf8')));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
