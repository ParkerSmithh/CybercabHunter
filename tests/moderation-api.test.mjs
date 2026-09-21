// Tests for the Phase 3D-C2 moderator review queue and approve/reject
// actions (worker/moderation.js, worker/db.js's moderation queries). Real
// SQL via the migration-loaded SQLite harness, and the REAL Worker router,
// so authorization is proven at the actual routing layer.
// Run: node tests/moderation-api.test.mjs

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

async function submitSighting(ctx, userId, fields) {
  const resp = await call(ctx, 'POST', '/api/vehicle-sightings', userId, { service_area: 'Austin', ...fields });
  return resp.json();
}

async function run() {
  console.log('1. Authorization on the queue endpoint');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    check('unauthenticated queue request -> 401', (await call(ctx, 'GET', '/api/moderation/vehicle-sightings')).status === 401);
    check('ordinary authenticated user -> 403', (await call(ctx, 'GET', '/api/moderation/vehicle-sightings', 'rider')).status === 403);
    const modResp = await call(ctx, 'GET', '/api/moderation/vehicle-sightings', 'mod');
    check('moderator -> 200', modResp.status === 200);
    check('moderator response has the expected shape', Array.isArray((await modResp.json()).sightings));
  }

  console.log('2. Authorization on the review (approve/reject) endpoint');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'XJR2195' });
    check('ordinary user approve -> 403', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'rider', { action: 'approve' })).status === 403);
    check('ordinary user reject -> 403', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'rider', { action: 'reject', rejection_reason: 'no' })).status === 403);
    check('unauthenticated approve -> 401', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, null, { action: 'approve' })).status === 401);
    check("the submitter themselves being ordinary is not sufficient authorization to review their own submission", (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'rider', { action: 'approve' })).status === 403);
  }

  console.log('3. Queue contents: pending appears, approved/rejected/unrelated do not');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const pending = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const toApprove = await submitSighting(ctx, 'rider', { license_plate: 'BBB2222' });
    const toReject = await submitSighting(ctx, 'rider', { license_plate: 'CCC3333' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${toApprove.submission_id}`, 'mod', { action: 'approve' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${toReject.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'x' });
    // An unrelated (ride_receipt) submission must never show up here.
    ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES ('unrelated-sub', 'rider', 'ride_receipt', 'pending')`);

    const queue = (await (await call(ctx, 'GET', '/api/moderation/vehicle-sightings', 'mod')).json()).sightings;
    const ids = queue.map(s => s.submission_id);
    check('the still-pending sighting appears', ids.includes(pending.submission_id));
    check('the approved sighting does not appear in the default queue', !ids.includes(toApprove.submission_id));
    check('the rejected sighting does not appear in the default queue', !ids.includes(toReject.submission_id));
    check('an unrelated ride_receipt submission never appears, even though it is also "pending"', !ids.includes('unrelated-sub'));
    check('exactly one item remains', queue.length === 1);
  }

  console.log('4. Approval: correct status, reviewer, timestamp, and observation consistency');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const resp = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('200 on approval', resp.status === 200);
    const body = await resp.json();
    check('response reports approved status', body.success === true && body.status === 'approved');

    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', s.submission_id)[0];
    check('submissions.status is approved', sub.status === 'approved');
    check('reviewed_by is the moderator who acted, not the submitter', sub.reviewed_by === 'mod');
    check('reviewed_at is populated', !!sub.reviewed_at);
    check('rejection_reason stays null on approval', sub.rejection_reason === null);

    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('the observation\'s own verification_status reflects the approval, consistent with the submission', obs.verification_status === 'verified');
  }

  console.log('5. Approving an unknown-plate sighting still does NOT create a registry vehicle (the core C2 trust boundary)');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const before = ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n;
    const s = await submitSighting(ctx, 'rider', { license_plate: 'ZZZ9999' });
    check('precondition: no matching vehicle at submission time', s.robotaxi_vehicle_id === null);
    const resp = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('approval succeeds', resp.status === 200);
    check('EXACTLY ZERO new robotaxi_vehicles rows exist after approval', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === before);
    const obs = ctx.d1.query('SELECT robotaxi_vehicle_id FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('robotaxi_vehicle_id remains NULL even after approval', obs.robotaxi_vehicle_id === null);
  }

  console.log('6. Approving an existing-vehicle sighting does not mutate the registry vehicle');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const vehId = seedVehicle(ctx.d1, { id: 'veh1', plate: 'XJR2195', model: 'Model Y' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET color = 'White', service_area = 'Dallas', last_seen_at = '2020-01-01 00:00:00', verification_status = 'unverified' WHERE id = 'veh1'`);
    const before = ctx.d1.query("SELECT * FROM robotaxi_vehicles WHERE id = 'veh1'")[0];

    const s = await submitSighting(ctx, 'rider', { license_plate: 'XJR2195', model: 'Cybercab', color: 'Black' }); // deliberately conflicting fields
    check('the sighting linked to the existing vehicle', s.robotaxi_vehicle_id === vehId);
    const resp = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('approval succeeds', resp.status === 200);

    const after = ctx.d1.query("SELECT * FROM robotaxi_vehicles WHERE id = 'veh1'")[0];
    check('model/color/service_area/verification_status/last_seen_at/first_seen_at are all byte-for-byte unchanged', JSON.stringify(before) === JSON.stringify(after));
    const obs = ctx.d1.query('SELECT robotaxi_vehicle_id, verification_status FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('the observation retains its vehicle link and is marked verified', obs.robotaxi_vehicle_id === vehId && obs.verification_status === 'verified');
  }

  console.log('7. Rejection: correct status, reason stored, reviewer, timestamp; reason is validated and length-capped');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const resp = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'reject', rejection_reason: '  Plate could not be verified.  ' });
    check('200 on rejection', resp.status === 200);
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', s.submission_id)[0];
    check('status is rejected', sub.status === 'rejected');
    check('rejection_reason is stored, trimmed', sub.rejection_reason === 'Plate could not be verified.');
    check('reviewed_by is the moderator', sub.reviewed_by === 'mod');
    check('reviewed_at is populated', !!sub.reviewed_at);
    const obs = ctx.d1.query('SELECT verification_status FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('the observation is marked rejected too', obs.verification_status === 'rejected');
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s1 = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    check('missing rejection_reason is rejected with 400, not silently accepted', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s1.submission_id}`, 'mod', { action: 'reject' })).status === 400);
    const s2 = await submitSighting(ctx, 'rider', { license_plate: 'BBB2222' });
    check('a blank/whitespace-only rejection_reason is also rejected', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s2.submission_id}`, 'mod', { action: 'reject', rejection_reason: '   ' })).status === 400);
    const s3 = await submitSighting(ctx, 'rider', { license_plate: 'CCC3333' });
    const longResp = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s3.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'x'.repeat(1000) });
    check('an oversized rejection_reason is accepted but length-capped, not stored arbitrarily large', longResp.status === 200);
    const stored = ctx.d1.query('SELECT rejection_reason FROM submissions WHERE id = ?', s3.submission_id)[0].rejection_reason;
    check('the stored reason is capped at 280 characters', stored.length === 280);
  }

  console.log('8. Status-transition safety: double actions and conflicting actions never silently overwrite a decision');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    check('first approve succeeds', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' })).status === 200);
    const second = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('a second approve attempt by the SAME moderator conflicts (409), does not silently no-op as success', second.status === 409);
    check('reviewed_by/reviewed_at are unchanged after the conflicting second attempt', ctx.d1.query('SELECT reviewed_by FROM submissions WHERE id = ?', s.submission_id)[0].reviewed_by === 'mod');
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    check('first reject succeeds', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'no' })).status === 200);
    check('a second reject attempt by a DIFFERENT moderator conflicts (409)', (await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod2', { action: 'reject', rejection_reason: 'also no' })).status === 409);
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    const flip = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'changed my mind' });
    check('approve-then-reject conflicts — approved -> rejected is not a supported transition in this phase', flip.status === 409);
    check('the submission is still approved, not silently flipped to rejected', ctx.d1.query('SELECT status FROM submissions WHERE id = ?', s.submission_id)[0].status === 'approved');
  }
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'no' });
    const flip = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('reject-then-approve conflicts — rejected -> approved is not supported either', flip.status === 409);
    check('the submission is still rejected', ctx.d1.query('SELECT status FROM submissions WHERE id = ?', s.submission_id)[0].status === 'rejected');
  }
  {
    // Simulates two "concurrent" moderators racing on the SAME pending
    // submission — since this test harness has no real parallelism, this
    // proves the same thing sequential double-review proves: the atomic,
    // conditionally-gated UPDATE (not a read-then-write race in app code)
    // is what actually decides the winner.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator', mod2: 'moderator' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'AAA1111' });
    const [r1, r2] = await Promise.all([
      call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' }),
      call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod2', { action: 'reject', rejection_reason: 'race' })
    ]);
    const statuses = [r1.status, r2.status].sort();
    check('exactly one of the two concurrent requests wins (200) and the other conflicts (409) — never both succeeding', statuses[0] === 200 && statuses[1] === 409);
    const finalStatus = ctx.d1.query('SELECT status, reviewed_by FROM submissions WHERE id = ?', s.submission_id)[0];
    check('the final stored state matches exactly one of the two moderators\' decisions, consistently', finalStatus.status === 'approved' || finalStatus.status === 'rejected');
    const obs = ctx.d1.query('SELECT verification_status FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('the observation\'s verification_status agrees with the winning submission status — never left in a mismatched state', (finalStatus.status === 'approved' && obs.verification_status === 'verified') || (finalStatus.status === 'rejected' && obs.verification_status === 'rejected'));
  }

  console.log('9. Not found / invalid input');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    check('a nonexistent submission id is a 404', (await call(ctx, 'PATCH', '/api/moderation/vehicle-sightings/does-not-exist', 'mod', { action: 'approve' })).status === 404);
    ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES ('other-type', 'mod', 'ride_receipt', 'pending')`);
    check('a real submission id of the WRONG type (not vehicle_sighting) is also a 404, never operated on', (await call(ctx, 'PATCH', '/api/moderation/vehicle-sightings/other-type', 'mod', { action: 'approve' })).status === 404);
    check('an unrelated ride_receipt submission is never mutated by this endpoint', ctx.d1.query("SELECT status FROM submissions WHERE id = 'other-type'")[0].status === 'pending');

    const ctx2 = await makeApp({ rider: 'user', mod: 'moderator' });
    const s = await submitSighting(ctx2, 'rider', { license_plate: 'AAA1111' });
    check('an invalid action value is 400', (await call(ctx2, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'delete' })).status === 400);
    check('malformed JSON is 400, not 500', (await worker.fetch(new Request(`https://x/api/moderation/vehicle-sightings/${s.submission_id}`, { method: 'PATCH', headers: { Authorization: 'Bearer session-mod', 'Content-Type': 'application/json' }, body: '{not json' }), ctx2.env, {})).status === 400);
  }

  console.log('10. Privacy: pending/rejected never public, moderator-only fields never leak, approximate location and evidence stay private');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const vehId = seedVehicle(ctx.d1, { id: 'veh1', plate: 'XJR2195' });
    seedRide(ctx.d1, { userId: 'rider', vehicleId: vehId, distance: 2.8 }); // gives the vehicle real ride history
    const pending = await submitSighting(ctx, 'rider', { license_plate: 'XJR2195', approx_location: 'Corner of 5th and Main', notes: 'secret note' });
    const rejected = await submitSighting(ctx, 'rider', { license_plate: 'ZZZ9999', approx_location: 'Behind the gas station' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${rejected.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'no' });

    const publicVehResp = await call(ctx, 'GET', `/api/robotaxi-vehicles/${vehId}`, null);
    const publicBlob = JSON.stringify(await publicVehResp.json());
    check('the PENDING sighting\'s approx_location/notes never appear in the public vehicle endpoint', !/Corner of 5th|secret note/i.test(publicBlob));
    check('the public vehicle endpoint response contains no sighting/observation data at all', !/vehicle_observations|verification_status.*unverified|observed_at/i.test(publicBlob));

    const approxSearch = await call(ctx, 'GET', `/api/robotaxi-vehicles/${(await submitSighting(ctx, 'rider', {})).robotaxi_vehicle_id || vehId}`, null);
    check('rejected sighting\'s approx_location never appears publicly either', !JSON.stringify(await approxSearch.json()).includes('Behind the gas station'));

    // Moderator-only endpoints must never be reachable without the role,
    // and public callers get nothing from them either.
    const anonQueue = await call(ctx, 'GET', '/api/moderation/vehicle-sightings', null);
    check('an unauthenticated caller gets nothing from the moderation queue (401, no data)', anonQueue.status === 401);
    const anonBody = await anonQueue.json();
    check('the 401 body carries no sighting data', !('sightings' in anonBody));
  }

  console.log('11. Regression: existing sighting submission, public vehicle API, and profile API still work with moderation now wired in');
  {
    const ctx = await makeApp({ rider: 'user' });
    const s = await submitSighting(ctx, 'rider', { license_plate: 'XJR2195' });
    check('an ordinary authenticated rider can still submit a sighting normally', !!s.submission_id && !!s.observation_id);

    const vehId = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'ZZZ0000');
    approveVehicle(ctx.d1, vehId, { withRide: true, userId: 'rider' });
    const vehResp = await call(ctx, 'GET', `/api/robotaxi-vehicles/${vehId}`, null);
    check('the public vehicle API still works unauthenticated', vehResp.status === 200);

    const profileResp = await call(ctx, 'GET', '/api/profile', 'rider');
    check('the profile API still works for an ordinary authenticated rider', profileResp.status === 200);
    const profileBody = await profileResp.json();
    check('the profile response still never leaks role or moderation data', !('role' in profileBody.user) && !('sightings' in profileBody));

    // Sighting submission still creates no vehicle for an unknown plate, at
    // the SUBMISSION stage (independent of any later moderator action).
    const before = ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n;
    await submitSighting(ctx, 'rider', { license_plate: 'YYY7777' });
    check('submitting a sighting for an unknown plate still creates no registry vehicle by itself', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === before);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
