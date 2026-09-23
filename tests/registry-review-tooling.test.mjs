// Tests for Phase 3G: legacy registry review tooling.
//   - moderator-facing provenance context on registry vehicles (descriptive,
//     never a score) and its privacy boundaries
//   - the legacy-cleanup / rollback SQL builder and snapshot verifier
//     (worker/registry-cleanup-sql.js), exercised on an in-memory database
//   - the runbook (docs/registry-preflight.md): every SQL block and command it
//     tells the owner to run is EXTRACTED FROM THE DOCUMENT and executed here,
//     so the documentation cannot drift from what was tested
//   - the Phase 3E invariants still hold after a cleanup
// Nothing here touches production: every database is an in-memory SQLite
// built from the project's migrations.
// Run: node tests/registry-review-tooling.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, seedRide, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage } from './helpers/receipts.mjs';
import { db } from '../worker/db.js';
import { LEGACY_INVENTORY_SQL, parseCleanupInventory, buildCleanupStatements, verifyCleanupSnapshots } from '../worker/registry-cleanup-sql.js';
import { REGISTRY_PREFLIGHT } from '../worker/registry-preflight.js';
import { RIDES_FROM, COUNTED_RIDES_WHERE } from '../worker/ride-status.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const DOC = fs.readFileSync(`${ROOT}docs/registry-preflight.md`, 'utf8');

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}
function call(ctx, method, p, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}
async function pub(ctx, p) {
  const r = await call(ctx, 'GET', p, null);
  return { status: r.status, text: await r.text(), cache: r.headers.get('Cache-Control') };
}
function rawVehicle(ctx, id, plate, { visibility = 'private', updatedAt = '2026-05-01 10:00:00', model = null } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, model, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, '2026-05-01 10:00:00', '2026-05-01 10:00:00', ?)`)
    .bind(id, plate, visibility, model, updatedAt)._exec();
  return id;
}
const listVehicles = (ctx, qs = '') => call(ctx, 'GET', `/api/moderation/robotaxi-vehicles${qs}`, 'mod').then(r => r.json());
// Public visibility is granted ONLY by the review action (approve_cybercab,
// the only remaining approval action — it requires a vin, saved here as a
// best-effort/idempotent step); PATCH can only take a vehicle private.
const setVis = async (ctx, id, visibility) => {
  if (visibility !== 'public') return call(ctx, 'PATCH', `/api/moderation/robotaxi-vehicles/${id}`, 'mod', { visibility });
  await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/vin`, 'mod', { vin: '5YJSA1E14FF101183' });
  return call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_cybercab' });
};
const snap = (ctx, table, where = '1=1') => JSON.stringify(ctx.d1.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`));
const id = n => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MISSING = '99999999-9999-4999-8999-999999999999';

// Fenced blocks in the runbook are tagged (```sql inventory, ```sh verify-snapshots, ...).
function docBlock(lang, tag) {
  const re = new RegExp('^[ \\t]*```' + lang + ' ' + tag + '\\n([\\s\\S]*?)^[ \\t]*```', 'm');
  const m = DOC.match(re);
  if (!m) throw new Error(`runbook block not found: ${lang} ${tag}`);
  return m[1].replace(/^ {3}/gm, '').trim();
}
const runDocShell = (tag, env) => {
  try { return { status: 0, out: execFileSync('bash', ['-c', docBlock('sh', tag)], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { status: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

async function run() {
  console.log('1. Provenance: counted rides grouped by how they entered, from the canonical counted-ride definition');
  {
    const ctx = await makeApp({ r1: 'user', r2: 'user', mod: 'moderator' });
    const v = rawVehicle(ctx, id(1), 'PRV0001');
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', source: 'receipt_email', rideDate: '2026-06-10' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'approved', source: 'receipt_email', rideDate: '2026-06-20' });
    seedRide(ctx.d1, { userId: 'r2', vehicleId: v, status: 'pending', source: 'receipt_import', rideDate: '2026-06-15' });
    seedRide(ctx.d1, { userId: 'r2', vehicleId: v, status: 'pending', source: 'manual', rideDate: '2026-06-12' });
    // NOT counted: must appear in no bucket and not move the dates.
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'needs_review', source: 'receipt_email', rideDate: '2026-01-01' });
    seedRide(ctx.d1, { userId: 'r2', vehicleId: v, status: 'rejected', source: 'receipt_import', rideDate: '2026-12-31' });
    const winner = seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', source: 'receipt_email', rideDate: '2026-06-11' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', source: 'receipt_import', rideDate: '2025-01-01', supersededBy: winner });

    const row = (await listVehicles(ctx, '?plate=PRV0001')).vehicles[0];
    check('counted_ride_count is the canonical counted definition (pending+approved, not superseded)', row.counted_ride_count === 5);
    check('receipt_email bucket counts only counted email rides', row.counted_rides_by_source.receipt_email === 3);
    check('receipt_import bucket counts only counted import rides', row.counted_rides_by_source.receipt_import === 1);
    check('any other source lands in "other" (the legacy manual default)', row.counted_rides_by_source.other === 1);
    check('the buckets always sum to the counted total', Object.values(row.counted_rides_by_source).reduce((a, b) => a + b, 0) === row.counted_ride_count);
    check('needs_review, rejected and superseded rides are in no bucket', row.counted_rides_by_source.receipt_email === 3 && row.counted_rides_by_source.receipt_import === 1);
    check('first counted ride date ignores uncounted rides', row.first_counted_ride_date === '2026-06-10');
    check('latest counted ride date ignores uncounted rides', row.last_counted_ride_date === '2026-06-20');

    // One definition of "counted": it must equal what the public history function computes.
    const hist = await db.getRobotaxiVehicleHistory(ctx.d1, v);
    check('agrees with db.getRobotaxiVehicleHistory (no second definition of counted)', hist.trip_count === row.counted_ride_count && hist.first_ride_date === row.first_counted_ride_date && hist.last_ride_date === row.last_counted_ride_date);

    check('current visibility is reported', row.visibility === 'private');
    check('registry timestamps are reported as database facts', row.first_seen_at === '2026-05-01 10:00:00' && row.last_seen_at === '2026-05-01 10:00:00' && typeof row.created_at === 'string');
    const viaPatch = (await (await setVis(ctx, v, 'public')).json()).vehicle;
    check('the review response carries the same provenance', viaPatch.visibility === 'public' && JSON.stringify(viaPatch.counted_rides_by_source) === JSON.stringify(row.counted_rides_by_source) && viaPatch.first_counted_ride_date === row.first_counted_ride_date);
  }
  {
    // Zero counted rides, and a ride with no date.
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const zero = rawVehicle(ctx, id(2), 'ZER0002');
    seedRide(ctx.d1, { userId: 'r1', vehicleId: zero, status: 'needs_review', rideDate: '2026-03-03' });
    const z = (await listVehicles(ctx, '?plate=ZER0002')).vehicles[0];
    check('zero counted rides: every bucket is 0 and the dates are null (not invented)', z.counted_ride_count === 0 && JSON.stringify(z.counted_rides_by_source) === '{"receipt_email":0,"receipt_import":0,"other":0}' && z.first_counted_ride_date === null && z.last_counted_ride_date === null);
    const nod = rawVehicle(ctx, id(3), 'NOD0003');
    seedRide(ctx.d1, { userId: 'r1', vehicleId: nod, status: 'pending', rideDate: null });
    const n = (await listVehicles(ctx, '?plate=NOD0003')).vehicles[0];
    check('a counted ride with no date counts, and its dates stay null', n.counted_ride_count === 1 && n.first_counted_ride_date === null && n.last_counted_ride_date === null);
  }
  {
    // The labels match what the REAL ingestion paths write.
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.8 mi · 14 min · IMP1234', date: 'June 1, 2026' }) }] });
    await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'eml', content: eml({ from: 'robotaxi@tesla.com', to: 'x@y.z', body: receiptBody({ summary: '2.8 mi · 14 min · IMP1234', date: 'June 2, 2026' }) }) }] });
    const to = ctx.addressFor('rider');
    await worker.email(inboundMessage(eml({ from: 'robotaxi@tesla.com', to, body: receiptBody({ summary: '2.8 mi · 14 min · EML1234', date: 'June 3, 2026' }) }), to), ctx.env, {});
    const imp = (await listVehicles(ctx, '?plate=IMP1234')).vehicles[0];
    const em = (await listVehicles(ctx, '?plate=EML1234')).vehicles[0];
    check('pasted-text and .eml imports are both reported as receipt_import (the data cannot tell them apart)', imp.counted_rides_by_source.receipt_import === 2 && imp.counted_rides_by_source.receipt_email === 0);
    check('a forwarded email is reported as receipt_email', em.counted_rides_by_source.receipt_email === 1 && em.counted_rides_by_source.receipt_import === 0);
    check('both were created private (nothing became public by arriving)', imp.visibility === 'private' && em.visibility === 'private');
  }

  console.log('2. Provenance is descriptive, never a score, and exposes no private data');
  {
    const ctx = await makeApp({ 'rider-secret': 'user', mod: 'moderator', other: 'user' });
    const v = rawVehicle(ctx, id(4), 'SEC0004');
    seedRide(ctx.d1, { userId: 'rider-secret', vehicleId: v, status: 'pending', pickupDescription: 'SECRET PICKUP 12 Elm St', dropoffDescription: 'SECRET DROPOFF 9 Oak Ave', fare: 9999 });
    ctx.d1.exec(`UPDATE users SET display_name = 'SECRET NAME', handle = 'secret_handle' WHERE id = 'rider-secret'`);
    const body = await (await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles', 'mod')).text();
    const patched = await (await setVis(ctx, v, 'private')).text();
    for (const [label, text] of [['list', body], ['PATCH', patched]]) {
      check(`${label}: no rider id, name, handle, address, coordinates or fare`, !/rider-secret|SECRET|secret_handle|@|pickup|dropoff|9999|latitude|longitude|lat\b|lng\b/i.test(text));
      check(`${label}: no token, credential, session or receipt-content field`, !/token|password|credential|session|opaque|forwarding|receipt_hash|message_id/i.test(text));
      // The vehicle record's own existing column verification_status ('unverified') is shown on purpose; that exact field/value is the only allowed use of the word.
      check(`${label}: no score, ranking or authenticity language in any field name`, !/score|confidence|trust|verified|authentic|genuine|likely|rank/i.test(text.replace(/"verification_status":"unverified"/g, '')));
    }
    check('the only "email" in the payload is the ingestion-path label receipt_email', !/email/i.test(body.replace(/receipt_email/g, '')));
    const ordinary = await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles', 'other'); const otext = await ordinary.text();
    check('an ordinary user gets 403 and none of the provenance', ordinary.status === 403 && !/counted|receipt_email|SEC0004|first_seen/i.test(otext));
    check('unauthenticated -> 401', (await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles', null)).status === 401);
    const pubText = (await pub(ctx, `/api/robotaxi-vehicles/${v}`)).text;
    check('the public vehicle endpoint carries none of the provenance fields', !/counted_rides_by_source|receipt_email|created_at|publicly_eligible/.test(pubText));
  }
  {
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const a = rawVehicle(ctx, id(5), 'DUPL005', { visibility: 'public' }); const b = rawVehicle(ctx, id(6), 'dupl-005');
    seedRide(ctx.d1, { userId: 'r1', vehicleId: a, status: 'pending' }); seedRide(ctx.d1, { userId: 'r1', vehicleId: b, status: 'pending' });
    const rows = (await listVehicles(ctx, '?plate=DUPL005')).vehicles;
    check('duplicate plates are both listed, each flagged, and provenance shown per row', rows.length === 2 && rows.every(r => r.plate_vehicle_count === 2 && r.counted_ride_count === 1));
    check('listing duplicates resolves nothing (both rows and plates untouched)', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n === 2 && ctx.d1.query("SELECT license_plate FROM robotaxi_vehicles WHERE id = ?", b)[0].license_plate === 'dupl-005');
    const hostilePlate = '<img src=x onerror=alert(1)>';
    const hostile = rawVehicle(ctx, id(7), hostilePlate, { visibility: 'public' }); seedRide(ctx.d1, { userId: 'r1', vehicleId: hostile, status: 'pending' });
    const hv = (await listVehicles(ctx, '?scope=public')).vehicles.find(v => v.id === hostile);
    check('a hostile plate is returned verbatim as JSON data (escaping is the UI\'s job; nothing is interpreted server-side)', !!hv && hv.license_plate === hostilePlate && hv.counted_ride_count === 1);
  }

  console.log('3. Builder: the inventory is validated before any of it becomes SQL');
  {
    const good = { id: id(10), license_plate: 'A1', visibility: 'public', updated_at: '2026-05-01 10:00:00' };
    check('a plain array of rows is accepted', parseCleanupInventory([good]).length === 1);
    check('wrangler --json output ([{ results: [...] }]) is accepted', parseCleanupInventory([{ results: [good], success: true, meta: {} }]).length === 1);
    check('a { results } object is accepted', parseCleanupInventory({ results: [good] }).length === 1);
    const bad = (label, mutate) => { try { parseCleanupInventory([mutate({ ...good })]); check(label, false); } catch (e) { check(label, true); } };
    bad('a non-UUID id is refused', r => ({ ...r, id: 'a1' }));
    bad('an id carrying SQL is refused', r => ({ ...r, id: `${id(10)}'); DROP TABLE robotaxi_vehicles;--` }));
    bad('a prior visibility other than public is refused', r => ({ ...r, visibility: 'private' }));
    bad('a missing updated_at is refused', r => { delete r.updated_at; return r; });
    bad('a malformed updated_at is refused', r => ({ ...r, updated_at: "2026-05-01'; DROP TABLE x;--" }));
    check('a duplicate id is refused', (() => { try { parseCleanupInventory([good, good]); return false; } catch (e) { return true; } })());
    check('a non-inventory value is refused', (() => { try { parseCleanupInventory('nope'); return false; } catch (e) { return true; } })());

    const many = Array.from({ length: 120 }, (_, i) => ({ id: id(1000 + i), license_plate: `P${i}`, visibility: 'public', updated_at: '2026-05-01 10:00:00' }));
    const s = buildCleanupStatements(many);
    check('a large inventory is split into bounded UPDATEs (50 ids each)', s.count === 120 && (s.cleanup.match(/^UPDATE /gm) || []).length === 3);
    check('the rollback is one guarded UPDATE per inventory row', (s.rollback.match(/^UPDATE /gm) || []).length === 120 && (s.rollback.match(/AND visibility = 'private';/g) || []).length === 120);
    check('cleanup and rollback contain only UPDATE statements (no DELETE/INSERT/DROP/ALTER/PRAGMA)', ![s.cleanup, s.rollback].some(x => /\b(DELETE|INSERT|DROP|ALTER|CREATE|PRAGMA|REPLACE INTO)\b/i.test(x.replace(/^--.*$/gm, ''))));
    check('cleanup sets ONLY visibility and updated_at', (s.cleanup.match(/SET ([^\n]*)\n/g) || []).every(l => l.replace(/^SET /, '').trim() === "visibility = 'private', updated_at = datetime('now')"));
    check('cleanup is guarded to rows that are still public', (s.cleanup.match(/WHERE visibility = 'public' AND id IN/g) || []).length === 3);
    const empty = buildCleanupStatements([]);
    check('an empty inventory produces no UPDATE at all (no invalid "IN ()")', empty.count === 0 && !/UPDATE/.test(empty.cleanup) && !/UPDATE/.test(empty.rollback));
  }

  console.log('4. Cleanup and rollback on an in-memory database');
  {
    const ctx = await makeApp({ r1: 'user', r2: 'user', mod: 'moderator' });
    // Two legacy public vehicles, each with counted rides, plus sightings linked both ways.
    const L1 = rawVehicle(ctx, id(21), 'LEG0001', { visibility: 'public', updatedAt: '2026-04-01 08:00:00' });
    const L2 = rawVehicle(ctx, id(22), 'LEG0002', { visibility: 'public', updatedAt: '2026-04-02 09:00:00', model: 'Model Y' });
    const P = rawVehicle(ctx, id(23), 'PRV0023', { visibility: 'private', updatedAt: '2026-04-03 10:00:00' });
    for (const v of [L1, L2, P]) seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', distance: 2.8 });
    seedRide(ctx.d1, { userId: 'r2', vehicleId: L1, status: 'approved', distance: 3.4, rideDate: '2026-06-15' });
    const s1 = await (await call(ctx, 'POST', '/api/vehicle-sightings', 'r1', { license_plate: 'LEG0001', service_area: 'Dallas' })).json();   // direct FK -> L1
    const s2 = await (await call(ctx, 'POST', '/api/vehicle-sightings', 'r2', { license_plate: 'LEG0002', service_area: 'Austin' })).json();
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL, created_at = '2000-01-01' WHERE submission_id = '${s2.submission_id}'`);   // read-time fallback -> L2
    for (const s of [s1, s2]) await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });

    check('before cleanup both legacy vehicles are public, with their sightings', (await pub(ctx, `/api/robotaxi-vehicles/${L1}`)).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${L2}/sightings`)).text.includes('Austin') && (await pub(ctx, `/api/robotaxi-vehicles/${L1}/sightings`)).text.includes('Dallas'));

    // Runbook step D/E, exactly as documented.
    const invRows = ctx.d1.query(docBlock('sql', 'inventory'));
    check('the runbook inventory query returns exactly the public rows, with prior visibility and updated_at', invRows.length === 2 && invRows.every(r => r.visibility === 'public' && /^\d{4}-/.test(r.updated_at)) && !invRows.some(r => r.id === P));
    const before = { vehicles: snap(ctx, 'robotaxi_vehicles'), trips: snap(ctx, 'trips'), obs: snap(ctx, 'vehicle_observations'), subs: snap(ctx, 'submissions'), rows: ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id') };
    const counts = () => ctx.d1.query(docBlock('sql', 'verify-counts'))[0];
    const countsBefore = counts();
    const { cleanup, rollback } = buildCleanupStatements(invRows);
    ctx.d1.exec(cleanup);

    check('1) the legacy public vehicles are now private', ['LEG0001', 'LEG0002'].every(p => ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE license_plate = ?', p)[0].visibility === 'private'));
    const missing = await pub(ctx, `/api/robotaxi-vehicles/${MISSING}`); const hidden = await pub(ctx, `/api/robotaxi-vehicles/${L1}`);
    check('2) the hidden vehicle endpoint is indistinguishable from a nonexistent vehicle (status, body, cache)', hidden.status === 404 && hidden.text === missing.text && hidden.cache === missing.cache);
    const hiddenS = await pub(ctx, `/api/robotaxi-vehicles/${L2}/sightings`); const missingS = await pub(ctx, `/api/robotaxi-vehicles/${MISSING}/sightings`);
    check('2b) so is the sightings endpoint', hiddenS.status === 404 && hiddenS.text === missingS.text && hiddenS.cache === missingS.cache);
    check('3) trips are unchanged, byte for byte', snap(ctx, 'trips') === before.trips);
    check('3b) submissions and rider history are unchanged', snap(ctx, 'submissions') === before.subs);
    check('4) approved sightings stay linked: observations are unchanged (direct FK and the unlinked one alike)', snap(ctx, 'vehicle_observations') === before.obs);
    const c = counts();
    check('the runbook counts query: only public_vehicles changed (to 0)', c.public_vehicles === 0 && ['vehicles', 'trips', 'trips_with_vehicle', 'observations', 'observations_linked', 'approved_sightings'].every(k => c[k] === countsBefore[k]) && countsBefore.public_vehicles === 2);
    const ver = verifyCleanupSnapshots({ before: before.rows, after: ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id'), inventory: invRows });
    check('the snapshot verifier confirms only visibility/updated_at changed on the inventory rows', ver.ok && ver.changedRows === 2);
    check('vehicle rows all remain (nothing deleted), plates and metadata untouched', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n === 3 && ctx.d1.query("SELECT model FROM robotaxi_vehicles WHERE id = ?", L2)[0].model === 'Model Y');

    // 6) the already-private vehicle is untouched by the cleanup.
    check('6) a vehicle that was already private is not changed at all (not even updated_at)', JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', P)[0]) === JSON.stringify(before.rows.find(r => r.id === P)));

    // 5) making it public again restores eligibility only when the Phase 3E gate is met.
    check('5) a moderator re-approving a vehicle with a counted ride makes it public again', (await setVis(ctx, L1, 'public')).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${L1}`)).status === 200);
    check('5b) its approved direct sighting is visible again, untouched', (await pub(ctx, `/api/robotaxi-vehicles/${L1}/sightings`)).text.includes('Dallas'));
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${L2}'`);
    const noRide = await setVis(ctx, L2, 'public');
    check('5c) approval still requires a counted ride: without one the review action refuses (409) and the vehicle stays private and hidden', noRide.status === 409 && (await noRide.json()).error === 'not_eligible' && ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', L2)[0].visibility === 'private' && (await pub(ctx, `/api/robotaxi-vehicles/${L2}`)).status === 404);
  }
  {
    // 7) Rollback restores ONLY inventory rows, only visibility/updated_at.
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const L1 = rawVehicle(ctx, id(31), 'LEG0031', { visibility: 'public', updatedAt: '2026-04-01 08:00:00' });
    const L2 = rawVehicle(ctx, id(32), 'LEG0032', { visibility: 'public', updatedAt: '2026-04-02 09:00:00' });
    const P = rawVehicle(ctx, id(33), 'PRV0033', { visibility: 'private', updatedAt: '2026-04-03 10:00:00' });
    for (const v of [L1, L2, P]) seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending' });
    const original = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id'));
    const inv = ctx.d1.query(LEGACY_INVENTORY_SQL);
    const { cleanup, rollback } = buildCleanupStatements(inv);

    ctx.d1.exec(cleanup); ctx.d1.exec(rollback);
    check('cleanup followed by rollback restores the vehicle table EXACTLY (including updated_at)', JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id')) === original);
    ctx.d1.exec(rollback);
    check('running the rollback a second time changes nothing (idempotent)', JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id')) === original);

    // Realistic mess after cleanup: a moderator approves one, edits another, and a new vehicle appears.
    ctx.d1.exec(cleanup);
    await setVis(ctx, L1, 'public');                                        // moderator re-approved L1
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET model = 'Cybercab' WHERE id = '${L2}'`);   // unrelated edit to L2
    const N = rawVehicle(ctx, id(34), 'NEW0034', { visibility: 'private', updatedAt: '2026-09-01 00:00:00' });
    const Q = rawVehicle(ctx, id(35), 'PUB0035', { visibility: 'public', updatedAt: '2026-09-02 00:00:00' });   // approved after the inventory, NOT in it
    const l1Before = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', L1)[0]);
    const pBefore = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', P)[0]);
    const nBefore = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', N)[0]);
    const qBefore = JSON.stringify(ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', Q)[0]);
    ctx.d1.exec(rollback);
    const now = id_ => ctx.d1.query('SELECT * FROM robotaxi_vehicles WHERE id = ?', id_)[0];
    check('7) rollback restores an inventory vehicle that is still private (L2) to its exact prior state', now(L2).visibility === 'public' && now(L2).updated_at === '2026-04-02 09:00:00');
    check('7b) it keeps an unrelated later edit (the model) — no other column is overwritten', now(L2).model === 'Cybercab');
    check('7c) an inventory vehicle a moderator already made public is left exactly as it is', JSON.stringify(now(L1)) === l1Before);
    check('7d) the vehicle that was already private before cleanup is not touched', JSON.stringify(now(P)) === pBefore);
    check('7e) a vehicle that is NOT in the inventory (new private) is not touched', JSON.stringify(now(N)) === nBefore);
    check('7f) a vehicle approved after the inventory (public, not in it) is not touched', JSON.stringify(now(Q)) === qBefore);
    check('7g) rollback never deletes or adds a row', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n === 5);
  }
  {
    // A documented hazard, asserted so the doc and the behavior cannot disagree.
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const L = rawVehicle(ctx, id(41), 'LEG0041', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'r1', vehicleId: L, status: 'pending' });
    const { cleanup } = buildCleanupStatements(ctx.d1.query(LEGACY_INVENTORY_SQL));
    ctx.d1.exec(cleanup); await setVis(ctx, L, 'public'); ctx.d1.exec(cleanup);
    check('re-running cleanup.sql AFTER a moderator re-approved a vehicle makes it private again (so the runbook says run it exactly once)', ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', L)[0].visibility === 'private');
    check('the runbook warns against approving during the window and describes running it once', /must not approve or change any vehicle/.test(DOC));
  }

  console.log('4c. Rollback after Phase 3H: the runbook\'s caveat is true, and the documented procedure for it works');
  {
    // Cleanup (operator SQL) -> moderators act (Phase 3H) -> what does the runbook's rollback do?
    const scenario = async () => {
      const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
      const TAKEN = rawVehicle(ctx, id(95), 'TKN0095', { visibility: 'public', updatedAt: '2026-04-01 08:00:00' });
      const KEPT = rawVehicle(ctx, id(96), 'KPT0096', { visibility: 'public', updatedAt: '2026-04-02 09:00:00' });
      const UNTOUCHED = rawVehicle(ctx, id(97), 'UNT0097', { visibility: 'public', updatedAt: '2026-04-03 10:00:00' });
      for (const v of [TAKEN, KEPT, UNTOUCHED]) seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending' });
      const { cleanup, rollback } = buildCleanupStatements(ctx.d1.query(LEGACY_INVENTORY_SQL));
      ctx.d1.exec(cleanup);
      await setVis(ctx, TAKEN, 'public'); await setVis(ctx, TAKEN, 'private');   // a moderator approves, then deliberately takes it down
      await setVis(ctx, KEPT, 'public');                                          // a moderator approves and leaves it public
      return { ctx, TAKEN, KEPT, UNTOUCHED, rollback };
    };
    const visOf = (ctx, v) => ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', v)[0].visibility;

    check('the runbook warns that rollback would re-publish a vehicle a moderator withdrew', /re-publish a vehicle a moderator\s+withdrew/.test(DOC) && /Phase 3H caveat/.test(DOC));

    const a = await scenario();
    check('setup: before rollback the withdrawn vehicle is private, the approved one public, the untouched one still private from the cleanup', visOf(a.ctx, a.TAKEN) === 'private' && visOf(a.ctx, a.KEPT) === 'public' && visOf(a.ctx, a.UNTOUCHED) === 'private');
    a.ctx.d1.exec(a.rollback);
    check('the caveat is TRUE: the unmodified rollback re-publishes the vehicle the moderator took down', visOf(a.ctx, a.TAKEN) === 'public' && (await pub(a.ctx, `/api/robotaxi-vehicles/${a.TAKEN}`)).status === 200);

    const b = await scenario();
    const listed = b.ctx.d1.query(docBlock('sql', 'taken-down-by-moderator')).map(r => r.robotaxi_vehicle_id);
    check('the documented query lists exactly the moderator-withdrawn vehicle (not the merely-cleaned-up one, not the approved one)', JSON.stringify(listed) === JSON.stringify([b.TAKEN]));
    check('the documented query is read-only', /^\s*SELECT\b/i.test(docBlock('sql', 'taken-down-by-moderator')) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA)\b/i.test(docBlock('sql', 'taken-down-by-moderator')));
    const edited = b.rollback.split('\n').filter(line => !listed.some(vid => line.includes(vid))).join('\n');
    check('following the runbook (delete each listed vehicle\'s statement) removes exactly one UPDATE line', (b.rollback.match(/^UPDATE /gm) || []).length - (edited.match(/^UPDATE /gm) || []).length === 1);
    b.ctx.d1.exec(edited);
    check('after the documented procedure the withdrawn vehicle STAYS private and is not publicly retrievable', visOf(b.ctx, b.TAKEN) === 'private' && (await pub(b.ctx, `/api/robotaxi-vehicles/${b.TAKEN}`)).status === 404);
    check('the still-cleaned-up vehicle is restored to public with its exact saved updated_at', visOf(b.ctx, b.UNTOUCHED) === 'public' && b.ctx.d1.query('SELECT updated_at u FROM robotaxi_vehicles WHERE id = ?', b.UNTOUCHED)[0].u === '2026-04-03 10:00:00');
    check('the moderator-approved vehicle is untouched by the rollback', visOf(b.ctx, b.KEPT) === 'public');
    check('the review history is unchanged by the rollback (approve + return for one vehicle, approve for the other)', b.ctx.d1.query('SELECT action FROM robotaxi_vehicle_reviews ORDER BY rowid').map(r => r.action).join() === 'approved_public,returned_private,approved_public');
  }

  console.log('5. Snapshot verifier catches what it must');
  {
    const inv = [{ id: id(51), license_plate: 'A', visibility: 'public', updated_at: '2026-05-01 10:00:00' }];
    const row = { id: id(51), license_plate: 'A', visibility: 'public', model: null, updated_at: '2026-05-01 10:00:00' };
    const other = { id: id(52), license_plate: 'B', visibility: 'private', model: null, updated_at: '2026-05-01 10:00:00' };
    const afterOk = [{ ...row, visibility: 'private', updated_at: '2026-09-20 00:00:00' }, other];
    check('the expected change passes', verifyCleanupSnapshots({ before: [row, other], after: afterOk, inventory: inv }).ok);
    const v = (after) => verifyCleanupSnapshots({ before: [row, other], after, inventory: inv });
    check('an extra changed column on an inventory row is flagged', !v([{ ...afterOk[0], model: 'X' }, other]).ok);
    check('an inventory row that stayed public is flagged', !v([{ ...row, updated_at: '2026-09-20 00:00:00' }, other]).ok);
    check('a changed non-inventory row is flagged', !v([afterOk[0], { ...other, visibility: 'public' }]).ok);
    check('a removed row is flagged', v([afterOk[0]]).problems.some(p => /REMOVED/.test(p)));
    check('an added row is flagged', v([afterOk[0], other, { ...other, id: id(53) }]).problems.some(p => /ADDED/.test(p)));
    check('wrangler --json shaped snapshots are accepted', verifyCleanupSnapshots({ before: [{ results: [row, other] }], after: [{ results: afterOk }], inventory: [{ results: inv }] }).ok);
  }

  console.log('6. The runbook: its own commands and SQL, extracted and executed');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybercab-runbook-'));
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const A = rawVehicle(ctx, id(61), 'RUN0061', { visibility: 'public', updatedAt: '2026-04-01 08:00:00' });
    const B = rawVehicle(ctx, id(62), 'RUN0062', { visibility: 'private' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: A, status: 'pending' });
    const wranglerShape = rows => JSON.stringify([{ results: rows, success: true, meta: {} }]);
    const invRows = ctx.d1.query(docBlock('sql', 'inventory'));
    const beforeRows = ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id');
    fs.writeFileSync(`${dir}/inventory.json`, wranglerShape(invRows));
    fs.writeFileSync(`${dir}/snapshot-before.json`, wranglerShape(beforeRows));

    check('the runbook\'s inventory SQL is the same text the tool exports', docBlock('sql', 'inventory') === LEGACY_INVENTORY_SQL);
    check('and the documented wrangler command contains that exact query', DOC.includes(`--command "${LEGACY_INVENTORY_SQL}"`));

    const gen = runDocShell('generate-cleanup', { CLEANUP_DIR: dir });
    // Same condition as before. Only when it FAILS, the label now also carries what the spawned command actually did (exit status and captured
    // output), so a failure in some other environment identifies whether the exit code or the stdout was the part that differed.
    // Node colors the number in console.log('inventory rows:', n) whenever FORCE_COLOR is present in the environment (even empty), so strip
    // ANSI escapes before matching. The condition itself is unchanged: exit status 0 AND exactly the text "inventory rows: 1".
    const genOut = String(gen.out).replace(/\u001b\[[0-9;]*m/g, '');
    const genOk = gen.status === 0 && /inventory rows: 1/.test(genOut);
    check('the documented generate command runs and reports the inventory size' + (genOk ? '' : ` [exit status: ${JSON.stringify(gen.status)}; captured output: ${JSON.stringify(String(gen.out).slice(0, 400))}]`), genOk);
    const cleanupFile = fs.readFileSync(`${dir}/cleanup.sql`, 'utf8'); const rollbackFile = fs.readFileSync(`${dir}/rollback.sql`, 'utf8');
    check('it wrote cleanup.sql and rollback.sql matching the builder', cleanupFile === buildCleanupStatements(invRows).cleanup && rollbackFile === buildCleanupStatements(invRows).rollback);
    ctx.d1.exec(cleanupFile);
    fs.writeFileSync(`${dir}/snapshot-after.json`, wranglerShape(ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id')));
    const ok = runDocShell('verify-snapshots', { CLEANUP_DIR: dir });
    check('the documented verify command prints OK (exit 0) after a correct cleanup', ok.status === 0 && /^OK: only visibility\/updated_at changed on 1 inventory row/.test(ok.out.trim()));
    const tampered = ctx.d1.query('SELECT * FROM robotaxi_vehicles ORDER BY id').map(r => (r.id === A ? { ...r, model: 'TAMPERED' } : r));
    fs.writeFileSync(`${dir}/snapshot-after.json`, wranglerShape(tampered));
    const bad = runDocShell('verify-snapshots', { CLEANUP_DIR: dir });
    check('and exits non-zero, naming the problem, if any other column changed', bad.status === 1 && /PROBLEMS/.test(bad.out) && /model/.test(bad.out));
    const noInv = (() => { fs.writeFileSync(`${dir}/inventory.json`, JSON.stringify([{ results: [{ id: 'not-a-uuid', visibility: 'public', updated_at: '2026-05-01 10:00:00' }] }])); return runDocShell('generate-cleanup', { CLEANUP_DIR: dir }); })();
    check('the documented generate command refuses a malformed inventory (non-zero exit)', noInv.status !== 0);

    const pf = runDocShell('preflight-generate', { CLEANUP_DIR: dir });
    const files = fs.existsSync(`${dir}/preflight`) ? fs.readdirSync(`${dir}/preflight`).sort() : [];
    check('the documented preflight-generate command writes one file per report', pf.status === 0 && files.length === REGISTRY_PREFLIGHT.length && REGISTRY_PREFLIGHT.every(q => files.includes(`${q.id}.sql`)));
    check('each generated preflight file is a single read-only SELECT', files.every(f => { const s = fs.readFileSync(`${dir}/preflight/${f}`, 'utf8'); return /^\s*SELECT/i.test(s) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA)\b/i.test(s) && s.trim().split(';').filter(Boolean).length === 1; }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const deployTime = '2026-09-20 12:00:00';
    const sql = docBlock('sql', 'verify-new-vehicles').replace(':deploy_time', deployTime);
    ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, created_at) VALUES ('${id(71)}', 'OLD0071', 'public', '2026-01-01 00:00:00')`);
    ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, created_at) VALUES ('${id(72)}', 'NEW0072', 'private', '2026-09-21 00:00:00')`);
    check('the "no accidental new public vehicles" query is quiet when new vehicles are private and old public rows pre-date the deploy', ctx.d1.query(sql).length === 0);
    ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, created_at) VALUES ('${id(73)}', 'BAD0073', 'public', '2026-09-21 01:00:00')`);
    check('and it catches a vehicle created after the deploy that is not private', ctx.d1.query(sql).map(r => r.license_plate).join() === 'BAD0073');
  }
  {
    // Structure and safety of the document itself.
    const at = h => DOC.indexOf(h);
    const order = ['## A. Preflight', '## B. Back up production D1', '## C. Deploy the Phase 3E gating code', '## D. Save the rollback inventory', '## E. Set the legacy public rows private', '## F. Verify', '## G. Moderator re-approval', '## H. Rollback'].map(at);
    check('the runbook has sections A through H, in that order', order.every(x => x > 0) && order.every((x, i) => i === 0 || x > order[i - 1]));
    check('it says wrangler d1 execute has no read-only mode and to read each file first', /no read-only mode/.test(DOC) && /open and read each one/.test(DOC));
    check('backup uses the project\'s documented export convention', /wrangler d1 export cybercabhunter_db --remote --output=/.test(DOC) && /docs\/deployment-and-migrations\.md/.test(DOC));
    check('deploy comes before the visibility change, and the deploy command is the package script', at('## C. Deploy') < at('## E. Set') && /npm run deploy/.test(DOC));
    check('it names the inventory as the rollback source of truth', /rollback source of truth/.test(DOC));
    check('it documents the migration 0011 and first-moderator prerequisites', /0011_user_roles\.sql/.test(DOC) && /role = 'moderator'/.test(DOC));
    check('it states provenance is not proof of a Tesla-issued receipt', /Provenance is not proof/.test(DOC) && /does not prove a receipt was genuinely[\s>]+issued by Tesla/.test(DOC));
    check('it does not include any merge, delete-vehicle, unique-index or DROP statement in a SQL block', ![...DOC.matchAll(/```sql[^\n]*\n([\s\S]*?)```/g)].some(m => /\b(DELETE|DROP|ALTER|CREATE UNIQUE|INSERT)\b/i.test(m[1])));
    check('the only write SQL shown is the visibility/updated_at UPDATE (and the by-hand moderator role grant)', [...DOC.matchAll(/\bUPDATE\s+(\w+)\s+SET\s+([^\n]*)/g)].every(m => (m[1] === 'robotaxi_vehicles' && /^visibility = 'private', updated_at = datetime\('now'\)/.test(m[2])) || (m[1] === 'users' && /^role = 'moderator'/.test(m[2]))));
  }

  console.log('7. Phase 3E invariants survive a cleanup');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const L = rawVehicle(ctx, id(81), 'LEG0081', { visibility: 'public' }); seedRide(ctx.d1, { userId: 'rider', vehicleId: L, status: 'pending' });
    const D1 = rawVehicle(ctx, id(82), 'DUPL082', { visibility: 'public' }); const D2 = rawVehicle(ctx, id(83), 'dupl-082', { visibility: 'public' });
    for (const d of [D1, D2]) seedRide(ctx.d1, { userId: 'rider', vehicleId: d, status: 'pending' });
    const platesBefore = ctx.d1.query('SELECT id, license_plate FROM robotaxi_vehicles ORDER BY id');
    ctx.d1.exec(buildCleanupStatements(ctx.d1.query(LEGACY_INVENTORY_SQL)).cleanup);

    // A new receipt for a legacy plate reuses the (now private) row and does not make it public.
    await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.8 mi · 14 min · LEG0081', date: 'June 30, 2026' }) }] });
    check('the receipt pipeline reuses the private legacy vehicle rather than creating another', ctx.d1.query("SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE license_plate = 'LEG0081'")[0].n === 1);
    check('and reusing it does not make it public', ctx.d1.query('SELECT visibility FROM robotaxi_vehicles WHERE id = ?', L)[0].visibility === 'private' && (await pub(ctx, `/api/robotaxi-vehicles/${L}`)).status === 404);
    await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receiptBody({ summary: '2.8 mi · 14 min · BRAND99', date: 'July 1, 2026' }) }] });
    check('a brand-new vehicle created after the cleanup starts private', ctx.d1.query("SELECT visibility FROM robotaxi_vehicles WHERE license_plate = 'BRAND99'")[0].visibility === 'private');

    // Sightings never create vehicles; unknown and ambiguous plates stay private.
    const before = ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n;
    const sUnknown = await (await call(ctx, 'POST', '/api/vehicle-sightings', 'rider', { license_plate: 'NOBODY1', service_area: 'Dallas' })).json();
    const sAmb = await (await call(ctx, 'POST', '/api/vehicle-sightings', 'rider', { license_plate: 'DUPL082', service_area: 'Austin' })).json();
    for (const s of [sUnknown, sAmb]) await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    check('sightings created no registry rows', ctx.d1.query('SELECT COUNT(*) AS n FROM robotaxi_vehicles')[0].n === before);
    const dupA = await setVis(ctx, D1, 'public'); const dupB = await setVis(ctx, D2, 'public');
    check('the duplicated plate cannot be re-approved through the review action (409 duplicate_plate for both rows)', dupA.status === 409 && dupB.status === 409 && (await dupA.json()).blocking_reasons.includes('duplicate_plate'));
    // Defense in depth: even if both rows were somehow flagged public (direct SQL), the sighting fallback still refuses the ambiguous plate.
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id IN ('${D1}', '${D2}')`);
    check('an ambiguous plate stays ambiguous even if both rows are flagged public: its sighting appears on neither duplicate', (await pub(ctx, `/api/robotaxi-vehicles/${D1}/sightings`)).text === '{"sightings":[]}' && (await pub(ctx, `/api/robotaxi-vehicles/${D2}/sightings`)).text === '{"sightings":[]}');
    check('an unknown plate\'s sighting stays private', !(await pub(ctx, `/api/robotaxi-vehicles/${D1}/sightings`)).text.includes('Dallas'));
    check('cleanup merged nothing and rewrote no plate', JSON.stringify(ctx.d1.query('SELECT id, license_plate FROM robotaxi_vehicles WHERE id IN (?, ?, ?) ORDER BY id', L, D1, D2)) === JSON.stringify(platesBefore.filter(r => [L, D1, D2].includes(r.id))));
    check('public eligibility still requires visibility AND a counted ride', (await setVis(ctx, L, 'public')).status === 200 && (await pub(ctx, `/api/robotaxi-vehicles/${L}`)).status === 200);
  }

  console.log('8. Scope: the new tooling is not wired into the app');
  {
    const index = fs.readFileSync(`${ROOT}worker/index.js`, 'utf8');
    const allWorker = fs.readdirSync(`${ROOT}worker`).filter(f => f.endsWith('.js') && !['registry-cleanup-sql.js', 'registry-preflight.js'].includes(f)).map(f => fs.readFileSync(`${ROOT}worker/${f}`, 'utf8')).join('\n');
    check('no worker module IMPORTS the cleanup builder or the preflight (they are operator tooling only; comments may name them)', !/(import|from)[^\n]*registry-(cleanup-sql|preflight)/.test(allWorker) && !/(import|from)[^\n]*registry-(cleanup-sql|preflight)/.test(index) && !/import\([^)]*registry-/.test(allWorker));
    check('the builder holds no database handle and executes nothing', !/\.prepare\(|\.exec\(|\.batch\(|fetch\(/.test(fs.readFileSync(`${ROOT}worker/registry-cleanup-sql.js`, 'utf8').replace(/\/\/.*$/gm, '')));
    check('worker/ stays excluded from the public static assets', /^worker$/m.test(fs.readFileSync(`${ROOT}.assetsignore`, 'utf8')));
    const migrations = fs.readdirSync(`${ROOT}migrations`).filter(f => f.endsWith('.sql')).sort();
    check('Phase 3G itself added no migration: 0011 is immediately followed by 0012, the Phase 3H review-history table (later phases may add more after it)', migrations[10].startsWith('0011_') && migrations[11].startsWith('0012_robotaxi_vehicle_reviews'));
    const ctx = await makeApp({ mod: 'moderator' }); ctx.env.ASSETS = { fetch: async () => new Response('asset', { status: 404 }) };
    for (const p of ['/api/moderation/registry-cleanup', '/api/moderation/registry-rollback', '/api/moderation/registry-preflight']) check(`GET ${p} is not a route`, (await call(ctx, 'GET', p, 'mod')).status === 404 && (await call(ctx, 'POST', p, 'mod', {})).status === 404);
  }

  console.log('9. The GENERATED preflight files are valid SQL that uses the canonical counted-ride definition (regression: a corrupted alias such as "submissionss")');
  {
    // Generate the files exactly as the runbook tells the owner to, then inspect
    // the artifacts themselves — not the JS that builds them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cybercab-preflight-'));
    const gen = runDocShell('preflight-generate', { CLEANUP_DIR: dir });
    const files = fs.existsSync(`${dir}/preflight`) ? fs.readdirSync(`${dir}/preflight`).sort() : [];
    const sqlOf = f => fs.readFileSync(`${dir}/preflight/${f}`, 'utf8');
    check('the documented command generated all eight report files', gen.status === 0 && files.length === 8);

    const ctx = await makeApp({ r1: 'user', mod: 'moderator' });
    const tables = new Set(ctx.d1.query("SELECT name FROM sqlite_master WHERE type = 'table'").map(r => r.name));

    for (const f of files) {
      const sql = sqlOf(f);
      let valid = true, why = '';
      try { ctx.d1.query('EXPLAIN ' + sql.replace(/;\s*$/, '')); } catch (e) { valid = false; why = e.message; }
      check(`${f}: prepares against the real migrated schema${valid ? '' : ' (' + why + ')'}`, valid);

      const referenced = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(m => m[1]);
      const unknown = referenced.filter(name => !tables.has(name));
      check(`${f}: every table after FROM/JOIN is a real table (no mangled names)${unknown.length ? ' — unknown: ' + unknown.join(',') : ''}`, unknown.length === 0);
      check(`${f}: no table name is doubled or suffixed (e.g. submissionss, tripss)`, ![...tables].some(name => new RegExp(`\\b${name}[a-z_]+\\b`).test(sql.replace(new RegExp(`\\b${name}_[a-z_]+`, 'g'), ''))));
    }

    // Wherever a report counts rides it must use RIDES_FROM and COUNTED_RIDES_WHERE VERBATIM.
    const all = files.map(sqlOf).join('\n');
    const joins = all.split('FROM trips t JOIN').slice(1);
    check('every ride join in the generated SQL is exactly the canonical RIDES_FROM', joins.length > 0 && joins.every(rest => rest.startsWith(RIDES_FROM.slice('trips t JOIN'.length))));
    const countedUses = all.split('t.superseded_by IS NULL AND s.status IN (').length - 1;
    check('every counted-ride predicate (status IN (...)) is exactly the canonical COUNTED_RIDES_WHERE', countedUses > 0 && all.split(COUNTED_RIDES_WHERE).length - 1 === countedUses);
    const otherStatus = [...all.matchAll(/t\.superseded_by IS NULL AND s\.status = '([a-z_]+)'/g)].map(m => m[1]).sort();
    check('the only other ride-status predicates are the two documented NOT-counted breakdowns (needs_review, rejected)', JSON.stringify(otherStatus) === '["needs_review","rejected"]');
    check('the two canonical fragments have the expected literal text (guards the constants themselves)', RIDES_FROM === 'trips t JOIN submissions s ON s.id = t.submission_id' && COUNTED_RIDES_WHERE === "t.superseded_by IS NULL AND s.status IN ('pending', 'approved')");
    check('the report that was reported corrupted contains the correct join and no bad token', /FROM trips t JOIN submissions s ON s\.id = t\.submission_id WHERE t\.robotaxi_vehicle_id = v\.id/.test(sqlOf('unlinked_sightings_matching_one_vehicle.sql')) && !/submissionss/.test(all));

    // The generated files count rides exactly as the application does.
    const v = rawVehicle(ctx, id(91), 'GEN0091', { visibility: 'public' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', rideDate: '2026-06-01' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'approved', rideDate: '2026-06-02' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'needs_review', rideDate: '2026-06-03' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'rejected', rideDate: '2026-06-04' });
    const winner = seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', rideDate: '2026-06-05' });
    seedRide(ctx.d1, { userId: 'r1', vehicleId: v, status: 'pending', rideDate: '2026-06-06', supersededBy: winner });
    const hist = await db.getRobotaxiVehicleHistory(ctx.d1, v);
    const inReport = ctx.d1.query(sqlOf('public_vehicles.sql').replace(/;\s*$/, '')).find(r => r.id === v);
    check('public_vehicles.sql counts the same rides as the application (db.getRobotaxiVehicleHistory)', inReport.counted_rides === hist.trip_count && hist.trip_count === 3);
    const oneVeh = ctx.d1.query(sqlOf('unlinked_sightings_matching_one_vehicle.sql').replace(/;\s*$/, ''));
    const s = await (await call(ctx, 'POST', '/api/vehicle-sightings', 'r1', { license_plate: 'GEN0091', service_area: 'Dallas' })).json();
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL WHERE submission_id = '${s.submission_id}'`);
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
    const row = ctx.d1.query(sqlOf('unlinked_sightings_matching_one_vehicle.sql').replace(/;\s*$/, '')).find(r => r.vehicle_id === v);
    check('unlinked_sightings_matching_one_vehicle.sql reports the same counted total (and runs) on real data', oneVeh.length === 0 && !!row && row.counted_rides === hist.trip_count && row.sightings === 1);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
