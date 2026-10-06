// Tests for approving registry vehicles without a VIN, and the approval basis
// that records the difference (migrations/0025_vehicle_approval_basis.sql):
//   - approve_manual: a moderator approves a pending vehicle with no VIN
//   - the VIN stays optional and editable before and after approval
//   - VIN format validation is unchanged
//   - approval_basis: 'vin-verified' vs 'manual', distinguished publicly
//   - verify_vin: the explicit manual -> vin-verified upgrade
//   - the backfill: approved + VIN -> vin-verified, nothing public goes private
//   - approve_cybercab (the daily pipeline's path) is unchanged
// Real SQL and the real Worker.
// Run: node tests/vehicle-approval-basis.test.mjs

import fs from 'node:fs';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import { createTestD1 } from './helpers/d1-sqlite.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;

async function makeApp() {
  const users = { rider: 'user', mod: 'moderator', other: 'user' };
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [uid, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${uid}`, JSON.stringify({ user_id: uid }));
    if (role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${uid}'`);
  }
  return ctx;
}
function call(ctx, method, p, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}
const review = async (ctx, vid, action, user = 'mod') => {
  const r = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/review`, user, { action });
  return { status: r.status, json: await r.json() };
};
const setVin = async (ctx, vid, vin, user = 'mod') => {
  const r = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/vin`, user, { vin });
  return { status: r.status, json: await r.json() };
};
const pubOne = async (ctx, vid) => {
  const r = await call(ctx, 'GET', `/api/robotaxi-vehicles/${vid}`, null);
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
};
const pubList = async ctx => (await (await call(ctx, 'GET', '/api/robotaxi-vehicles', null)).json()).vehicles;
const row = (ctx, vid) => ctx.d1.query('SELECT visibility, vin, approval_basis, approval_basis_set_by_user_id, model FROM robotaxi_vehicles WHERE id = ?', vid)[0];
const reviews = (ctx, vid) => ctx.d1.query('SELECT action FROM robotaxi_vehicle_reviews WHERE robotaxi_vehicle_id = ?', vid);

let n = 0;
const vid = () => `abababab-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function vehicle(ctx, plate, { visibility = 'private', vin = null, origin = 'receipt', rides = 1 } = {}) {
  const id = vid();
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, vin, origin, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .bind(id, plate, visibility, vin, origin)._exec();
  for (let i = 0; i < rides; i++) seedRide(ctx.d1, { userId: 'rider', vehicleId: id, status: 'pending' });
  return id;
}
const VIN_A = '5YJSA1E14FF101183';
const VIN_B = '5YJSA1E27FF101184';

async function run() {
  console.log('1. Approving a pending vehicle with no VIN (approve_manual)');
  {
    const ctx = await makeApp();
    const v = vehicle(ctx, 'MAN0001');
    const m = (await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?plate=MAN0001', 'mod').then(r => r.json())).vehicles[0];
    check('before approval: eligible for approval with no VIN (VIN is not a manual criterion)', m.approval.state === 'eligible_for_approval' && m.approval.can_approve === true && !m.approval.blocking_reasons.includes('no_vin'));
    check('the VIN-gated approve_cybercab flag is unchanged (false without a VIN)', m.can_approve_cybercab === false);
    check('approval_basis starts null (pending)', m.approval_basis === null && row(ctx, v).approval_basis === null);

    check('an ordinary user cannot approve manually (403), nothing changes', (await review(ctx, v, 'approve_manual', 'other')).status === 403 && row(ctx, v).visibility === 'private');
    const r = await review(ctx, v, 'approve_manual');
    check('approve_manual with no VIN succeeds (200)', r.status === 200 && r.json.success === true && r.json.action === 'approved_public');
    check('the vehicle is public, approval_basis manual, attributed to the moderator', row(ctx, v).visibility === 'public' && row(ctx, v).approval_basis === 'manual' && row(ctx, v).approval_basis_set_by_user_id === 'mod');
    check('no VIN was invented or filled in', row(ctx, v).vin === null && r.json.vehicle.vin === null);
    check('it wrote exactly one audit row (approved_public), like any approval', reviews(ctx, v).length === 1 && reviews(ctx, v)[0].action === 'approved_public');
    check('it is publicly visible', (await pubOne(ctx, v)).status === 200);
    check('approving again is refused 409 already_public', (await review(ctx, v, 'approve_manual')).json.error === 'already_public');

    const empty = vehicle(ctx, 'MAN0002', { rides: 0 });
    const refused = await review(ctx, empty, 'approve_manual');
    check('approve_manual still enforces the other rules: a receipt vehicle with no counted ride is refused (no_counted_rides, not no_vin)', refused.status === 409 && refused.json.blocking_reasons.join() === 'no_counted_rides' && row(ctx, empty).visibility === 'private');
    const dupA = vehicle(ctx, 'DUP0001'); vehicle(ctx, 'DUP-0001');
    const dup = await review(ctx, dupA, 'approve_manual');
    check('...and a duplicate plate is refused (duplicate_plate)', dup.status === 409 && dup.json.blocking_reasons.includes('duplicate_plate'));
    check('an unknown action is still refused (400 invalid_action)', (await review(ctx, dupA, 'approve')).json.error === 'invalid_action');
  }

  console.log('2. approve_cybercab (the daily pipeline\'s path) is unchanged');
  {
    const ctx = await makeApp();
    const v = vehicle(ctx, 'CYB0001');
    const noVin = await review(ctx, v, 'approve_cybercab');
    check('without a VIN, approve_cybercab is still refused 409 not_eligible [no_vin]', noVin.status === 409 && noVin.json.blocking_reasons.join() === 'no_vin' && row(ctx, v).visibility === 'private');
    check('saving a VIN never approves by itself', (await setVin(ctx, v, VIN_A)).status === 200 && row(ctx, v).visibility === 'private' && row(ctx, v).approval_basis === null);
    const ok = await review(ctx, v, 'approve_cybercab');
    check('with a VIN, approve_cybercab succeeds and records vin-verified', ok.status === 200 && row(ctx, v).visibility === 'public' && row(ctx, v).approval_basis === 'vin-verified');
    check('it still sets model Cybercab', row(ctx, v).model === 'Cybercab');

    const s = vehicle(ctx, 'SGT0001', { origin: 'sighting', rides: 0 });
    check('a VIN-less sighting vehicle: approve_cybercab still refused', (await review(ctx, s, 'approve_cybercab')).status === 409 && row(ctx, s).visibility === 'private');
  }

  console.log('3. The VIN stays optional and editable — before and after approval');
  {
    const ctx = await makeApp();
    const v = vehicle(ctx, 'EDT0001');
    await review(ctx, v, 'approve_manual');
    const added = await setVin(ctx, v, VIN_A);
    check('adding a VIN after a manual approval succeeds (200)', added.status === 200 && added.json.vehicle.vin === VIN_A && row(ctx, v).vin === VIN_A);
    check('adding the VIN did not change visibility or upgrade the basis (still manual)', row(ctx, v).visibility === 'public' && row(ctx, v).approval_basis === 'manual' && added.json.vehicle.can_verify_vin === true);
    check('the added VIN wrote no review row', reviews(ctx, v).length === 1);
    check('editing it to another valid VIN succeeds', (await setVin(ctx, v, VIN_B)).status === 200 && row(ctx, v).vin === VIN_B);
    const cleared = await setVin(ctx, v, '');
    check('an empty VIN clears it (unknown is valid), and the vehicle stays public', cleared.status === 200 && row(ctx, v).vin === null && row(ctx, v).visibility === 'public');
    check('null clears too', (await setVin(ctx, v, VIN_A)).status === 200 && (await setVin(ctx, v, null)).status === 200 && row(ctx, v).vin === null);
    check('clearing a VIN that is not there is a harmless no-op (200)', (await setVin(ctx, v, '')).status === 200 && row(ctx, v).vin === null);

    const p = vehicle(ctx, 'EDT0002');
    check('a VIN can be saved, edited and cleared on a pending (private) vehicle too', (await setVin(ctx, p, VIN_A)).status === 200 && (await setVin(ctx, p, VIN_B)).status === 200 && (await setVin(ctx, p, '')).status === 200 && row(ctx, p).vin === null && row(ctx, p).visibility === 'private');
    check('an ordinary user cannot set a VIN (403)', (await setVin(ctx, p, VIN_A, 'other')).status === 403 && row(ctx, p).vin === null);
  }

  console.log('4. VIN validation still rejects bad input (17 chars, no I/O/Q)');
  {
    const ctx = await makeApp();
    const priv = vehicle(ctx, 'VAL0001');
    const pub = vehicle(ctx, 'VAL0002'); await review(ctx, pub, 'approve_manual');
    for (const [label, target] of [['pending', priv], ['approved', pub]]) {
      for (const [what, bad] of [['too short', 'SHORT123'], ['too long', VIN_A + 'X'], ['contains I', 'I'.repeat(17)], ['contains O', '5YJSA1E14FF1O1183'], ['contains Q', '5YJSA1E14FF1Q1183'], ['punctuation', '5YJSA1E14FF-01183']]) {
        const r = await setVin(ctx, target, bad);
        check(`${label} vehicle, ${what} -> 400 invalid_vin, nothing saved`, r.status === 400 && r.json.error === 'invalid_vin' && row(ctx, target).vin === null);
      }
      const nonString = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${target}/vin`, 'mod', { vin: 12345 });
      check(`${label} vehicle, a non-string VIN -> 400 invalid_body`, nonString.status === 400 && (await nonString.json()).error === 'invalid_body');
      const missing = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${target}/vin`, 'mod', {});
      check(`${label} vehicle, a missing vin field -> 400 invalid_body (clearing must be explicit)`, missing.status === 400);
    }
    check('lowercase/whitespace is normalized, not rejected', (await setVin(ctx, priv, `  ${VIN_A.toLowerCase()} `)).json.vehicle.vin === VIN_A);
  }

  console.log('5. Upgrading manual -> vin-verified (verify_vin) only with a VIN on file');
  {
    const ctx = await makeApp();
    const v = vehicle(ctx, 'UPG0001');
    check('verify_vin on a pending vehicle is refused 409 not_public', (await review(ctx, v, 'verify_vin')).json.error === 'not_public');
    await review(ctx, v, 'approve_manual');
    const noVin = await review(ctx, v, 'verify_vin');
    check('verify_vin with no VIN on file is refused 409 no_vin, still manual', noVin.status === 409 && noVin.json.error === 'no_vin' && row(ctx, v).approval_basis === 'manual');
    check('an ordinary user cannot verify (403)', (await setVin(ctx, v, VIN_A)).status === 200 && (await review(ctx, v, 'verify_vin', 'other')).status === 403 && row(ctx, v).approval_basis === 'manual');
    const up = await review(ctx, v, 'verify_vin');
    check('with a VIN on file, verify_vin upgrades to vin-verified (200)', up.status === 200 && up.json.action === 'vin_verified' && row(ctx, v).approval_basis === 'vin-verified' && up.json.vehicle.can_verify_vin === false);
    check('the upgrade changed nothing else: still public, same VIN, no extra review row', row(ctx, v).visibility === 'public' && row(ctx, v).vin === VIN_A && reviews(ctx, v).length === 1);
    check('verifying again is refused 409 already_vin_verified', (await review(ctx, v, 'verify_vin')).json.error === 'already_vin_verified');
    check('re-saving the SAME VIN keeps vin-verified', (await setVin(ctx, v, VIN_A)).status === 200 && row(ctx, v).approval_basis === 'vin-verified');
    check('changing the VIN drops it back to manual (the verification was of the old VIN)', (await setVin(ctx, v, VIN_B)).status === 200 && row(ctx, v).approval_basis === 'manual' && row(ctx, v).visibility === 'public');
    await review(ctx, v, 'verify_vin');
    check('clearing the VIN of a vin-verified vehicle drops it to manual, and it stays public', (await setVin(ctx, v, '')).status === 200 && row(ctx, v).approval_basis === 'manual' && row(ctx, v).visibility === 'public' && (await pubOne(ctx, v)).status === 200);

    await review(ctx, v, 'return_private');
    check('returning to private clears the approval basis and hides it (404)', row(ctx, v).approval_basis === null && row(ctx, v).visibility === 'private' && (await pubOne(ctx, v)).status === 404);
  }

  console.log('6. The public API and registry distinguish vin-verified from manual');
  {
    const ctx = await makeApp();
    const verified = vehicle(ctx, 'PUB0001'); await setVin(ctx, verified, VIN_A); await review(ctx, verified, 'approve_cybercab');
    const manual = vehicle(ctx, 'PUB0002'); await review(ctx, manual, 'approve_manual');
    const manualWithVin = vehicle(ctx, 'PUB0003'); await review(ctx, manualWithVin, 'approve_manual'); await setVin(ctx, manualWithVin, VIN_B);
    const pending = vehicle(ctx, 'PUB0004');

    const list = await pubList(ctx);
    const by = id => list.find(x => x.id === id);
    check('the public list carries approval_basis: vin-verified / manual / manual (VIN added, not verified)', by(verified).approval_basis === 'vin-verified' && by(manual).approval_basis === 'manual' && by(manualWithVin).approval_basis === 'manual');
    check('a manual vehicle with a VIN added later shows the VIN as a plain fact, still not verified', by(manualWithVin).vin === VIN_B);
    check('the pending vehicle is not listed', !by(pending));
    check('the detail endpoint carries approval_basis too', (await pubOne(ctx, verified)).json.vehicle.approval_basis === 'vin-verified' && (await pubOne(ctx, manual)).json.vehicle.approval_basis === 'manual');
    check('no approval provenance (who/when) is public', !/approval_basis_set|vin_set_by|moderator/.test(JSON.stringify(list)));
    check('private vehicles still 404 on the public page', (await pubOne(ctx, pending)).status === 404);


    // The front end: badge only on vin-verified (see also vehicle-registry / vehicle-page tests).
    const vehiclesJs = fs.readFileSync(`${ROOT}public/js/vehicles.js`, 'utf8');
    const vehicleJs = fs.readFileSync(`${ROOT}public/js/vehicle.js`, 'utf8');
    check('no page shows a "VIN verified" badge (vehicle page or all-cars cards)', !/VinVerifiedBadge|✓ VIN verified/.test(vehicleJs) && !vehiclesJs.includes('✓ VIN verified') && !/vinVerifiedBadge/.test(vehiclesJs));
    check('a manual Cybercab still gets the normal Cybercab image and pill', /approval_basis === 'manual'/.test(vehiclesJs) && /approval_basis === 'manual'/.test(vehicleJs));
  }

  console.log('7. Sighting-origin vehicles: a manual approval backs them publicly');
  {
    const ctx = await makeApp();
    const s = vehicle(ctx, 'SGT0002', { origin: 'sighting', rides: 0 });
    const r = await review(ctx, s, 'approve_manual');
    check('approve_manual makes a VIN-less sighting vehicle public as manual', r.status === 200 && row(ctx, s).approval_basis === 'manual');
    check('and it is publicly eligible', (await pubOne(ctx, s)).status === 200 && r.json.vehicle.publicly_eligible === true);
  }

  console.log('8. Migration 0025 and its backfill');
  {
    const src = fs.readFileSync(`${ROOT}migrations/0025_vehicle_approval_basis.sql`, 'utf8');
    const code = src.replace(/--.*$/gm, '');
    check('0025 is its own migration number (no other file shares it)', fs.readdirSync(`${ROOT}migrations`).filter(f => f.startsWith('0025_')).join() === '0025_vehicle_approval_basis.sql');
    check('it only adds columns and backfills approval_basis — no DROP/DELETE, and never touches visibility', !/\b(DROP|DELETE)\b/i.test(code) && !/SET\s+visibility/i.test(code) && (code.match(/ALTER TABLE robotaxi_vehicles ADD COLUMN/g) || []).length === 3);

    // Apply every migration up to 0024, seed production-like rows, then apply 0025 on top.
    const d1 = createTestD1({ migrateThrough: '0024_tesla_ride_sync_import.sql' });
    d1.exec(`INSERT INTO users (id) VALUES ('rider')`);
    const seed = (id, plate, visibility, vin, origin = 'receipt', rides = 1) => {
      d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, vin, origin) VALUES (?, ?, ?, ?, ?)`).bind(id, plate, visibility, vin, origin)._exec();
      for (let i = 0; i < rides; i++) seedRide(d1, { userId: 'rider', vehicleId: id, status: 'pending' });
    };
    seed('pub-vin', 'BF0001', 'public', VIN_A);                  // approved with a VIN -> vin-verified
    seed('pub-novin', 'BF0002', 'public', null);                 // approved before VINs were required -> manual
    seed('pub-emptyvin', 'BF0003', 'public', '');                // an empty string is not a VIN -> manual
    seed('priv-vin', 'BF0004', 'private', VIN_B);                // pending with a VIN -> stays null
    seed('priv-novin', 'BF0005', 'private', null);               // pending -> stays null
    seed('pub-sight-vin', 'BF0006', 'public', VIN_A, 'sighting', 0);   // approved sighting vehicle -> vin-verified
    seed('pub-sight-novin', 'BF0007', 'public', null, 'sighting', 0);  // hidden today (no evidence) -> stays null, stays hidden
    const visBefore = JSON.stringify(d1.query('SELECT id, visibility, vin FROM robotaxi_vehicles ORDER BY id'));
    // The public gate as it stood before 0025 (counted ride, or sighting with a VIN).
    const oldEligible = d1.query(`SELECT v.id FROM robotaxi_vehicles v WHERE v.visibility = 'public' AND (
        EXISTS (SELECT 1 FROM trips t JOIN submissions s ON s.id = t.submission_id WHERE t.robotaxi_vehicle_id = v.id AND s.status IN ('approved', 'pending') AND t.superseded_by IS NULL)
        OR (v.origin = 'sighting' AND v.vin IS NOT NULL AND v.vin <> '')) ORDER BY v.id`).map(r => r.id);

    d1.exec(src);
    const basis = id => d1.query('SELECT approval_basis FROM robotaxi_vehicles WHERE id = ?', id)[0].approval_basis;
    check('approved + VIN backfills to vin-verified', basis('pub-vin') === 'vin-verified' && basis('pub-sight-vin') === 'vin-verified');
    check('approved receipt vehicles without a VIN backfill to manual (no badge)', basis('pub-novin') === 'manual' && basis('pub-emptyvin') === 'manual');
    check('pending vehicles keep their status (approval_basis stays null), VIN or not', basis('priv-vin') === null && basis('priv-novin') === null);
    check('a hidden public sighting vehicle with no VIN is left null', basis('pub-sight-novin') === null);
    check('the backfill changed no visibility or VIN', JSON.stringify(d1.query('SELECT id, visibility, vin FROM robotaxi_vehicles ORDER BY id')) === visBefore);

    const ctx = { env: { cybercabhunter_db: d1, TESLA_SESSIONS: { get: async () => null } } };
    const listed = (await (await worker.fetch(new Request('https://x/api/robotaxi-vehicles?limit=50', { headers: { Origin: 'https://cybercabhunter.com' } }), ctx.env, {})).json()).vehicles.map(v => v.id).sort();
    check('nothing that was public before the migration became private: the public list is exactly the old eligible set', JSON.stringify(listed) === JSON.stringify(oldEligible) && oldEligible.length === 4);

    let rejected = false;
    try { d1.exec(`UPDATE robotaxi_vehicles SET approval_basis = 'guessed' WHERE id = 'pub-vin'`); } catch (e) { rejected = true; }
    check('the CHECK constraint allows only vin-verified / manual / null', rejected);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
