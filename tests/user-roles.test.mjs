// Phase 3D-C1 — the moderator authorization foundation: migrations/0011_user_roles.sql
// and worker/moderation.js's requireModerator. No moderation route, queue,
// or UI exists yet (that's a later phase) — this only proves the server can
// securely tell an ordinary rider apart from a moderator, and that nothing
// about adding this changes any existing public/authenticated behavior.
// Real SQL via the migration-loaded SQLite harness.
// Run: node tests/user-roles.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { makeEnv, seedRide, approveVehicle, makeCheck } from './helpers/env.mjs';
import { requireModerator } from '../worker/moderation.js';
import { apiGetProfile, apiUpdateProfile } from '../worker/profile.js';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const t = makeCheck();
const { check } = t;

function req(path, opts = {}) {
  return new Request(`https://x${path}`, opts);
}

async function run() {
  console.log('1. Migration 0011: existing users are preserved and get the ordinary role, no destructive change');
  {
    // Build the schema as it was immediately before this migration, seed
    // users the way real pre-existing rows would look, then apply 0011
    // directly — mirrors the exact pattern phase2-canonical.test.mjs uses
    // for migration 0009.
    const d1 = createTestD1({ migrateThrough: '0010_receipt_ordering.sql' });
    seedUser(d1, 'legacy-1'); seedUser(d1, 'legacy-2');
    const before = d1.query('SELECT COUNT(*) n FROM users')[0].n;

    d1.exec(readFileSync(join(__dirname, '..', 'migrations', '0011_user_roles.sql'), 'utf8'));

    check('no user row was deleted', d1.query('SELECT COUNT(*) n FROM users')[0].n === before);
    check('foreign keys and integrity hold after the migration', d1.query('PRAGMA foreign_key_check').length === 0 && d1.query('PRAGMA integrity_check')[0].integrity_check === 'ok');
    const rows = d1.query('SELECT id, role FROM users ORDER BY id');
    check('every pre-existing user was backfilled to the ordinary role — nobody is auto-promoted', rows.every(r => r.role === 'user'));
    check('exactly the two seeded users exist, both ordinary', rows.length === 2 && rows[0].role === 'user' && rows[1].role === 'user');
  }

  console.log('2. New users default to the ordinary role; the role column is usable and constrained');
  {
    const d1 = createTestD1(); // all migrations, including 0011
    check('0011 applied cleanly on top of the full migration history', d1.query("SELECT COUNT(*) n FROM pragma_table_info('users') WHERE name = 'role'")[0].n === 1);

    const id = seedUser(d1, 'new-user');
    check('a freshly created user defaults to role=user without anything setting it explicitly', d1.query('SELECT role FROM users WHERE id = ?', id)[0].role === 'user');

    d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'new-user'`);
    check('a moderator role can be represented and stored correctly', d1.query('SELECT role FROM users WHERE id = ?', id)[0].role === 'moderator');

    check('an invalid role value is rejected by the schema\'s own CHECK constraint, not silently accepted', (() => {
      try { d1.exec(`UPDATE users SET role = 'superadmin' WHERE id = 'new-user'`); return false; }
      catch (e) { return /CHECK constraint failed/.test(String(e.message)); }
    })());
    check('the row is unchanged after the rejected update', d1.query('SELECT role FROM users WHERE id = ?', id)[0].role === 'moderator');

    check('an invalid role is rejected on INSERT too', (() => {
      try { d1.exec(`INSERT INTO users (id, role) VALUES ('bad-user', 'root')`); return false; }
      catch (e) { return /CHECK constraint failed/.test(String(e.message)); }
    })());
  }

  console.log('3. requireModerator: authentication and role authorization, using the EXISTING session mechanism unchanged');
  {
    const ctx = await makeEnv({ users: ['rider', 'mod'] });
    await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));
    await ctx.env.TESLA_SESSIONS.put('session:session-mod', JSON.stringify({ user_id: 'mod' }));
    ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);

    const noAuth = await requireModerator(req('/x'), ctx.env);
    check('missing session -> unauthenticated (caller returns 401)', noAuth.error === 'unauthenticated');

    const badAuth = await requireModerator(req('/x', { headers: { Authorization: 'Bearer not-a-real-session' } }), ctx.env);
    check('invalid/expired session -> unauthenticated (caller returns 401)', badAuth.error === 'unauthenticated');

    const ordinary = await requireModerator(req('/x', { headers: { Authorization: 'Bearer session-rider' } }), ctx.env);
    check('an authenticated ORDINARY user is rejected as forbidden (caller returns 403), not treated as unauthenticated', ordinary.error === 'forbidden');

    const moderator = await requireModerator(req('/x', { headers: { Authorization: 'Bearer session-mod' } }), ctx.env);
    check('an authenticated MODERATOR is accepted, with the real (server-resolved) userId returned', moderator.userId === 'mod' && !moderator.error);
  }

  console.log('4. The role can never be supplied or overridden by the caller — only the database\'s stored value ever counts');
  {
    const ctx = await makeEnv({ users: ['rider'] });
    await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));

    const attempts = [
      req('/x?role=moderator', { headers: { Authorization: 'Bearer session-rider' } }),
      req('/x', { headers: { Authorization: 'Bearer session-rider', 'X-Role': 'moderator', 'X-User-Role': 'moderator' } }),
      req('/x', { headers: { Authorization: 'Bearer session-rider', 'Content-Type': 'application/json' }, method: 'POST', body: JSON.stringify({ role: 'moderator', user_id: 'rider', moderator: true }) })
    ];
    for (const r of attempts) {
      const result = await requireModerator(r, ctx.env);
      check('a role claimed via query string, header, or body is completely ignored', result.error === 'forbidden');
    }

    check('the stored role really is still just "user" — nothing was mutated by the attempts', ctx.d1.query("SELECT role FROM users WHERE id = 'rider'")[0].role === 'user');

    // Flipping the DB row is the ONLY thing that changes the outcome.
    ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'rider'`);
    const afterPromotion = await requireModerator(req('/x', { headers: { Authorization: 'Bearer session-rider' } }), ctx.env);
    check('changing the role in the database is reflected immediately on the next check', afterPromotion.userId === 'rider' && !afterPromotion.error);
  }

  console.log('5. No existing API lets a rider self-elevate — role is not a writable field anywhere');
  {
    const ctx = await makeEnv({ users: ['rider'] });
    const resp = await apiUpdateProfile(req('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: 'Alex', role: 'moderator', is_admin: true, is_moderator: true })
    }), ctx.env, 'rider');
    check('the profile update itself still succeeds (unrelated fields are unaffected)', resp.status === 200);
    check('role is completely untouched by a PATCH that tries to smuggle it in', ctx.d1.query("SELECT role FROM users WHERE id = 'rider'")[0].role === 'user');
  }
  {
    // No moderation-shaped route exists in the router at all yet (this
    // phase intentionally adds none) — confirms nothing was wired up that
    // could be reached to self-elevate.
    const ctx = await makeEnv({ users: ['rider'] });
    await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));
    // No moderation route matches, so the router falls through to its final
    // ASSETS.fetch(request) — a fake stand-in is enough to prove that fall-
    // through happens rather than any real endpoint answering.
    const envWithAssets = { ...ctx.env, ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
    const resp = await worker.fetch(req('/api/moderation/vehicle-sightings', { headers: { Authorization: 'Bearer session-rider' } }), envWithAssets, {});
    check('no moderation route exists yet — it falls through to the static-asset handler, not a real endpoint', resp.status !== 200);
  }

  console.log('6. Regression: existing routes, the public registry, and sighting submission all still work exactly as before');
  {
    const ctx = await makeEnv({ users: ['rider'] });
    await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));

    const profileResp = await worker.fetch(req('/api/profile', { headers: { Authorization: 'Bearer session-rider', Origin: 'https://cybercabhunter.com' } }), ctx.env, {});
    check('the existing authenticated /api/profile route still works unchanged', profileResp.status === 200);
    const profileBody = await profileResp.json();
    check('the profile response never leaks the role field, even though users.* now has one', !('role' in profileBody.user));

    const meResp = await worker.fetch(req('/api/me', { headers: { Authorization: 'Bearer session-rider', Origin: 'https://cybercabhunter.com' } }), ctx.env, {});
    const meBody = await meResp.json();
    check('/api/me does not leak role either', !('role' in meBody.user));

    const vehId = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    seedRide(ctx.d1, { userId: 'rider', vehicleId: vehId, distance: 2.8 });
    approveVehicle(ctx.d1, vehId);
    const vehResp = await worker.fetch(req(`/api/robotaxi-vehicles/${vehId}`), ctx.env, {});
    check('the public vehicle endpoint still works, unauthenticated, unchanged', vehResp.status === 200);
    const vehBody = await vehResp.json();
    check('the public vehicle response contains no user/role information whatsoever', !JSON.stringify(vehBody).match(/"role"|"user_id"/));

    const sightResp = await worker.fetch(req('/api/vehicle-sightings', {
      method: 'POST', headers: { Authorization: 'Bearer session-rider', 'Content-Type': 'application/json', Origin: 'https://cybercabhunter.com' },
      body: JSON.stringify({ service_area: 'Austin', license_plate: 'ZZZ0000' })
    }), ctx.env, {});
    check('an ordinary authenticated rider can still submit a sighting normally', sightResp.status === 201);
    const sightBody = await sightResp.json();
    check('a sighting for an unknown plate still creates NO public registry vehicle, even with the role system now active', sightBody.robotaxi_vehicle_id === null);
    check('exactly one vehicle exists (the one seeded above) — the unknown-plate sighting created no second one', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
