// Tests for POST /api/vehicle-sightings (worker/sightings.js) — Phase 3D-A,
// the backend write path only. Real SQL via the migration-loaded SQLite
// harness, and the REAL Worker router, so auth-gating is proven at the
// actual routing layer. No frontend file is touched or exercised here.
// Run: node tests/sightings-api.test.mjs

import { makeEnv, seedVehicle, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

async function makeApp(users = ['u1']) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}

function post(ctx, body, userId) {
  const headers = { Origin: 'https://cybercabhunter.com', 'Content-Type': 'application/json' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  return worker.fetch(new Request('https://x/api/vehicle-sightings', { method: 'POST', headers, body: JSON.stringify(body) }), ctx.env, {});
}

const vehicleRowCount = ctx => ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n;
const observationsFor = (ctx, userId) => ctx.d1.query('SELECT * FROM vehicle_observations WHERE user_id = ? ORDER BY created_at DESC', userId);
const submissionRow = (ctx, id) => ctx.d1.query('SELECT * FROM submissions WHERE id = ?', id)[0];

async function run() {
  console.log('1. Authentication: anonymous is refused, authenticated succeeds');
  {
    const ctx = await makeApp();
    const anon = await post(ctx, { service_area: 'Dallas' }, null);
    check('anonymous POST is refused with the project\'s normal 401 shape', anon.status === 401);
    const anonBody = await anon.json();
    check('the 401 body matches every other private endpoint\'s shape', anonBody.authenticated === false);
    check('nothing was written for the anonymous attempt', ctx.d1.query('SELECT COUNT(*) n FROM vehicle_observations')[0].n === 0);

    const resp = await post(ctx, { service_area: 'Dallas' }, 'u1');
    check('an authenticated request succeeds (201)', resp.status === 201);
  }

  console.log('2. Ownership: user_id always comes from the session, never the request body, and riders stay isolated');
  {
    const ctx = await makeApp(['u1', 'u2']);
    const resp = await post(ctx, { service_area: 'Dallas', user_id: 'u2' }, 'u1'); // attempt to spoof
    check('the request succeeds despite the spoof attempt in the body', resp.status === 201);
    const obs = observationsFor(ctx, 'u1');
    check('the observation is owned by the AUTHENTICATED user (u1), not the spoofed body value', obs.length === 1 && obs[0].user_id === 'u1');
    check('nothing was written under the spoofed user_id', observationsFor(ctx, 'u2').length === 0);

    await post(ctx, { service_area: 'Austin' }, 'u2');
    check('two different riders\' sightings remain isolated from each other', observationsFor(ctx, 'u1').length === 1 && observationsFor(ctx, 'u2').length === 1);
    check("u1's own sighting was not affected by u2's submission", observationsFor(ctx, 'u1')[0].service_area === 'Dallas');
  }

  console.log('3. Submission record: vehicle_sighting / pending, moderation fields left honestly null');
  {
    const ctx = await makeApp();
    const resp = await post(ctx, { service_area: 'Dallas' }, 'u1');
    const body = await resp.json();
    const sub = submissionRow(ctx, body.submission_id);
    check('submission_type is vehicle_sighting', sub.submission_type === 'vehicle_sighting');
    check('status starts pending', sub.status === 'pending');
    check('reviewed_at/reviewed_by/rejection_reason are all null — no moderation is pretended to exist', sub.reviewed_at === null && sub.reviewed_by === null && sub.rejection_reason === null);
    check('the submission belongs to the authenticated rider', sub.user_id === 'u1');
  }

  console.log('4. Observation record: fields preserved exactly, verification_status unverified');
  {
    const ctx = await makeApp();
    const resp = await post(ctx, {
      license_plate: 'xjr-2195', service_area: 'Dallas', model: 'Model Y', color: 'White', notes: 'Saw it downtown'
    }, 'u1');
    const body = await resp.json();
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
    check('user_id is the authenticated rider', obs.user_id === 'u1');
    check('submission_id matches the created submission', obs.submission_id === body.submission_id);
    check('service_area/model/color/notes are preserved as given', obs.service_area === 'Dallas' && obs.model === 'Model Y' && obs.color === 'White' && obs.notes === 'Saw it downtown');
    check('the plate is stored normalized (matches the project\'s existing normalization)', obs.license_plate === 'XJR2195');
    check('verification_status is unverified', obs.verification_status === 'unverified');
    check('evidence_ref is null — no photo upload in this phase', obs.evidence_ref === null);
    check('an observed_at was set from the column default since none was supplied', !!obs.observed_at);
  }

  console.log('5. Existing vehicle match: links to it, never mutates it, never creates a duplicate row');
  {
    const ctx = await makeApp();
    const vehId = seedVehicle(ctx.d1, { id: 'veh1', plate: 'XJR2195', model: 'Model Y', firstSeenAt: '2020-01-01 00:00:00' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET last_seen_at = '2020-01-01 00:00:00', verification_status = 'unverified' WHERE id = 'veh1'`);
    const before = ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', vehId)[0];

    const resp = await post(ctx, { license_plate: 'XJR2195', service_area: 'Dallas' }, 'u1');
    const body = await resp.json();
    check('the observation points at the existing vehicle', body.robotaxi_vehicle_id === vehId);
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
    check('the observation row itself records the match', obs.robotaxi_vehicle_id === vehId);

    const after = ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', vehId)[0];
    check('the vehicle\'s identity fields are byte-for-byte unchanged', after.model === before.model && after.color === before.color && after.service_area === before.service_area && after.license_plate === before.license_plate);
    check('verification_status is unchanged', after.verification_status === before.verification_status);
    check('last_seen_at (receipt-derived) is NOT mutated by a sighting — this is the key trust boundary', after.last_seen_at === before.last_seen_at && after.last_seen_at === '2020-01-01 00:00:00');
    check('first_seen_at is unchanged too', after.first_seen_at === before.first_seen_at);
    check('exactly one vehicle row exists — no duplicate was created', vehicleRowCount(ctx) === 1);
  }

  console.log('6. Unknown plate: observation is created, robotaxi_vehicle_id is NULL, and — critically — no new vehicle row is ever created');
  {
    const ctx = await makeApp();
    const before = vehicleRowCount(ctx);
    check('precondition: zero vehicles exist yet', before === 0);

    const resp = await post(ctx, { license_plate: 'ZZZ9999', service_area: 'Austin' }, 'u1');
    check('the sighting is still recorded successfully (201)', resp.status === 201);
    const body = await resp.json();
    check('robotaxi_vehicle_id is null in the response', body.robotaxi_vehicle_id === null);

    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
    check('robotaxi_vehicle_id is NULL in the stored row', obs.robotaxi_vehicle_id === null);
    check('the observed plate is preserved even though it matched nothing', obs.license_plate === 'ZZZ9999');
    check('EXACTLY ZERO new robotaxi_vehicles rows were created — the registry is untouched', vehicleRowCount(ctx) === before && vehicleRowCount(ctx) === 0);
  }

  console.log('7. Plate normalization: case/hyphen/space variants resolve to the same existing vehicle (no fuzzy matching, exact reuse of existing normalization)');
  {
    // A distinct rider per variant, so the accidental-duplicate guard
    // (same user + same plate) never masks whether normalization itself
    // resolved each spelling to the existing vehicle.
    const users = ['ua', 'ub', 'uc', 'ud'];
    const ctx = await makeApp(users);
    const vehId = seedVehicle(ctx.d1, { id: 'veh1', plate: 'XJR2195' });
    const variants = { ua: 'xjr2195', ub: 'xjr-2195', uc: 'XJR 2195', ud: 'Xjr-21 95' };
    for (const u of users) {
      const resp = await post(ctx, { license_plate: variants[u], service_area: 'Dallas' }, u);
      const body = await resp.json();
      check(`"${variants[u]}" resolves to the existing vehicle, not a new one`, body.robotaxi_vehicle_id === vehId);
    }
    check('still exactly one vehicle row after all four spelling variants', vehicleRowCount(ctx) === 1);
  }

  console.log('8. Duplicate handling: an accidental immediate re-submit of the same plate by the same rider does not create a second pair of rows');
  {
    const ctx = await makeApp();
    const first = await post(ctx, { license_plate: 'XJR2195', service_area: 'Dallas' }, 'u1');
    const firstBody = await first.json();
    check('the first submission is created normally', first.status === 201 && firstBody.duplicate === false);

    const second = await post(ctx, { license_plate: 'xjr-2195', service_area: 'Dallas' }, 'u1');
    const secondBody = await second.json();
    check('the immediate re-submit is recognized as a duplicate (200, not 201)', second.status === 200 && secondBody.duplicate === true);
    check('the duplicate response reuses the SAME submission/observation ids', secondBody.submission_id === firstBody.submission_id && secondBody.observation_id === firstBody.observation_id);
    check('exactly one observation exists — nothing extra was written', observationsFor(ctx, 'u1').length === 1);
    check('exactly one submissions row exists for this rider', ctx.d1.query("SELECT COUNT(*) n FROM submissions WHERE user_id = 'u1'")[0].n === 1);

    // A different rider reporting the SAME plate is a real, separate sighting.
    const ctx2 = await makeApp(['u1', 'u2']);
    await post(ctx2, { license_plate: 'XJR2195', service_area: 'Dallas' }, 'u1');
    const other = await post(ctx2, { license_plate: 'XJR2195', service_area: 'Dallas' }, 'u2');
    const otherBody = await other.json();
    check('a different rider reporting the same plate is NOT treated as a duplicate', other.status === 201 && otherBody.duplicate === false);

    // No plate provided: no dedupe check is attempted at all (nothing reliable to compare).
    const ctx3 = await makeApp();
    const noPlate1 = await post(ctx3, { service_area: 'Dallas' }, 'u1');
    const noPlate2 = await post(ctx3, { service_area: 'Dallas' }, 'u1');
    check('two plate-less sightings from the same rider are both recorded, not collapsed into one', (await noPlate1.json()).observation_id !== (await noPlate2.json()).observation_id);
  }

  console.log('9. Privacy: the response never contains user id, email, private account info, or approx_location');
  {
    const ctx = await makeApp();
    const resp = await post(ctx, { license_plate: 'XJR2195', service_area: 'Dallas', approx_location: 'Corner of 5th and Main' }, 'u1');
    const body = await resp.json();
    const blob = JSON.stringify(body);
    check('no user_id in the response', !/user_id|"userId"/i.test(blob));
    check('no rider id string leaks', !/\bu1\b/.test(blob));
    check('no email/session/account material', !/email|session|access_token|refresh_token/i.test(blob));
    check('approx_location is NOT echoed back, even though it was accepted and stored', !('approx_location' in body) && !/Corner of 5th/i.test(blob));
    check('the response contains only success/duplicate/ids/vehicle-match — a minimal shape', Object.keys(body).sort().join() === 'duplicate,observation_id,robotaxi_vehicle_id,submission_id,success');
    // but it really was stored, just not returned:
    const obs = ctx.d1.query('SELECT approx_location FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
    check('approx_location WAS stored server-side (not silently dropped)', obs.approx_location === 'Corner of 5th and Main');
  }

  console.log('10. Validation');
  {
    const ctx = await makeApp();
    check('missing plate is allowed (nullable column)', (await post(ctx, { service_area: 'Dallas' }, 'u1')).status === 201);
    check('blank plate is treated the same as missing, not an error', (await post(ctx, { license_plate: '   ', service_area: 'Dallas' }, 'u1')).status === 201);
    check('a malformed plate (normalizes to nothing) is rejected', (await post(ctx, { license_plate: '!!!---', service_area: 'Dallas' }, 'u1')).status === 400);
    check('an oversized plate is rejected', (await post(ctx, { license_plate: 'X'.repeat(50), service_area: 'Dallas' }, 'u1')).status === 400);
    check('missing service_area is rejected', (await post(ctx, {}, 'u1')).status === 400);
    check('blank service_area is rejected', (await post(ctx, { service_area: '   ' }, 'u1')).status === 400);
    {
      const resp = await post(ctx, { service_area: 'Dallas', notes: 'x'.repeat(500) }, 'u1');
      const body = await resp.json();
      const obs = ctx.d1.query('SELECT notes FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
      check('an oversized notes string is length-capped rather than rejected outright', obs.notes.length === 280);
    }
    {
      const resp = await post(ctx, { service_area: 'x'.repeat(500) }, 'u1');
      const body = await resp.json();
      const obs = ctx.d1.query('SELECT service_area FROM vehicle_observations WHERE id = ?', body.observation_id)[0];
      check('an oversized service_area is length-capped, not rejected', obs.service_area.length === 100);
    }

    const badJson = await worker.fetch(new Request('https://x/api/vehicle-sightings', {
      method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-u1', 'Content-Type': 'application/json' }, body: '{not json'
    }), ctx.env, {});
    check('malformed JSON returns 400, not 500', badJson.status === 400);

    check('a literal null body is 400, not a crash', (await worker.fetch(new Request('https://x/api/vehicle-sightings', { method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-u1', 'Content-Type': 'application/json' }, body: 'null' }), ctx.env, {})).status === 400);

    check('an invalid observed_at (not a real date) is rejected', (await post(ctx, { service_area: 'Dallas', observed_at: 'not-a-date' }, 'u1')).status === 400);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    check('an obviously-future observed_at is rejected', (await post(ctx, { service_area: 'Dallas', observed_at: tomorrow }, 'u1')).status === 400);
    const justNow = new Date().toISOString();
    check('a plausible recent observed_at is accepted', (await post(ctx, { service_area: 'Dallas', observed_at: justNow }, 'u1')).status === 201);
    check('optional fields (model/color/notes/approx_location/observed_at) can all be omitted entirely', (await post(ctx, { service_area: 'Dallas' }, 'u1')).status === 201);
  }

  console.log('11. Oversized request body is rejected before parsing (matches the project\'s existing byte-limit pattern)');
  {
    const ctx = await makeApp();
    function streamBody(str) {
      const bytes = new TextEncoder().encode(str);
      return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    }
    const huge = JSON.stringify({ service_area: 'Dallas', notes: 'x'.repeat(50_000) });
    const req = new Request('https://x/api/vehicle-sightings', {
      method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-u1', 'Content-Type': 'application/json' },
      body: streamBody(huge), duplex: 'half'
    });
    const resp = await worker.fetch(req, ctx.env, {});
    check('an oversized body is rejected with 413, before touching the database', resp.status === 413);
    check('nothing was written for the oversized attempt', ctx.d1.query('SELECT COUNT(*) n FROM vehicle_observations')[0].n === 0);
  }

  console.log('12. Database failure surfaces as a clean server error, never a raw exception');
  {
    const ctx = await makeApp();
    const brokenEnv = { ...ctx.env, cybercabhunter_db: { batch: async () => { throw new Error('db exploded'); }, prepare: ctx.env.cybercabhunter_db.prepare.bind(ctx.env.cybercabhunter_db) } };
    const resp = await worker.fetch(new Request('https://x/api/vehicle-sightings', {
      method: 'POST', headers: { Origin: 'https://cybercabhunter.com', Authorization: 'Bearer session-u1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_area: 'Dallas' })
    }), brokenEnv, {});
    check('a database failure returns a clean 500, not a stack trace', resp.status === 500);
    const body = await resp.json();
    check('the error body has no exception text', !/Error: db exploded|at\s+\S+\.js:\d+/i.test(JSON.stringify(body)));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
