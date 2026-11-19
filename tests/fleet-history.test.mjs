import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { apiFleetHistory, buildFleetHistory, recomputeFleetHistory } from '../worker/fleet-history.js';

test('backfills three hand-checked dates without inventing gaps or assigning unknown cities', async () => {
  const db = createTestD1();
  seedUser(db, 'private-test-user');
  db.exec('DELETE FROM camera_detections');
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const stamp = day => day + 'T18:00:00Z';
  for (const [id, city, day, visibility] of [
    ['vehicle-a','Austin','2026-10-09','public'],
    ['vehicle-d','Dallas','2026-10-11','public'],
    ['vehicle-p','Austin','2026-10-09','private']
  ]) {
    await run(`INSERT INTO robotaxi_vehicles (id,license_plate,model,service_area,visibility,origin,approval_basis,approval_basis_set_at,created_at)
      VALUES (?,?,'Cybercab',?,?,'sighting','manual',?,'2026-09-05 18:00:00')`, id, id, city, visibility, stamp(day));
  }
  for (const [id, city, day, status] of [
    ['observation-a','Austin','2026-10-09','approved'],
    ['observation-u',null,'2026-10-10','approved'],
    ['observation-d','Dallas, TX','2026-10-11','approved'],
    ['observation-p','Dallas','2026-10-09','pending'],
    ['observation-r','Austin','2026-10-09','rejected']
  ]) {
    await run(`INSERT INTO submissions (id,user_id,submission_type,status,evidence_type,reviewed_at)
      VALUES (?,'private-test-user','vehicle_sighting',?,'photo',?)`, id, status, stamp(day));
    await run(`INSERT INTO vehicle_observations (id,user_id,submission_id,observed_at,service_area,approx_location)
      VALUES (?,'private-test-user',?, ?, ?,'LEAVE PRIVATE')`, id, id, stamp(day), city);
  }
  for (const [city, day] of [['austin','2026-10-09'], ['dallas','2026-10-11']]) {
    await run(`INSERT INTO camera_detections (id,camera_id,camera_name,lat,lng,observed_at,city)
      VALUES (?,?,'LEAVE PRIVATE',30,-97,?,?)`, city, city, stamp(day), city);
  }
  for (const [day, count] of [['2026-10-09',30], ['2026-10-11',34]]) await run(
    `INSERT INTO dmv_snapshots (snapshot_date,total,cybercab_count,model_y_count,authorization_number,raw_json,polled_at)
       VALUES (?,?,?,0,'auth','[]',?)`, day, count, count, stamp(day));
  const env = { cybercabhunter_db: db };
  const now = Date.parse('2026-10-12T18:00:00Z');
  const get = async city => apiFleetHistory(new Request('https://example.org/api/fleet-history?city=' + city), env);
  assert.equal((await get('all')).status, 503);
  await recomputeFleetHistory(env, now);
  await recomputeFleetHistory(env, now);
  const response = await get('all');
  const raw = await response.text();
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.doesNotMatch(raw, /private-test-user|LEAVE PRIVATE|vehicle-a/);
  const all = JSON.parse(raw);
  assert.deepEqual(all.rows, [
    ['2026-10-09',1,1,1,1,30],
    ['2026-10-10',1,2,1,0,null],
    ['2026-10-11',2,3,1,1,34]
  ]);
  const austin = await (await get('austin')).json();
  const dallas = await (await get('dallas')).json();
  assert.deepEqual(austin.rows.at(-1), ['2026-10-11',1,1,0,0,null]);
  assert.deepEqual(dallas.rows, [['2026-10-11',1,1,1,1,null]]);
  assert.equal(all.rows.at(-1)[1], austin.rows.at(-1)[1] + dallas.rows.at(-1)[1]);
  assert.equal(all.rows.at(-1)[2], austin.rows.at(-1)[2] + dallas.rows.at(-1)[2] + 1);
  assert.ok(dallas.milestones.some(mark => mark.day === '2026-10-11'));
  assert.equal(db.query('SELECT count(*) AS n FROM fleet_history_snapshots')[0].n, 7);
  db.exec("UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = 'vehicle-a'");
  await recomputeFleetHistory(env, now);
  assert.equal((await (await get('all')).json()).rows[0][1], null);
  assert.equal(db.query("SELECT registry_count FROM fleet_history_snapshots WHERE day='2026-10-09' AND city='all'")[0].registry_count, null);
});

test('milestone day comes from the ordered approval history', () => {
  const sightings = Array.from({ length: 1001 }, (_, index) => ({
    reviewed_at: index < 999 ? '2026-10-08T18:00:00Z' : '2026-10-09T18:00:00Z', city: 'Austin', evidence_type: 'photo'
  }));
  const history = buildFleetHistory({ registry: [], sightings, detections: [], dmv: [], headline: 1100 }, '2026-10-10');
  assert.deepEqual(history.all.milestones.at(-1), { day: '2026-10-09', label: '1,000th dated approved sighting' });
  assert.equal(history.all.headline_sightings, 1100);
  assert.deepEqual(history.dallas.rows, []);
});
