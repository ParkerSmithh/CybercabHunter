import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { apiFareHistory, recomputeFareHistory } from '../worker/fare-history.js';

test('approved observations, three hand-checked weeks, minimums, and aggregate-only responses', async () => {
  const db = createTestD1();
  seedUser(db, 'test-rider');
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const add = (id, city, day, dollars, status = 'approved', kind = 'completed', type = 'model_y') =>
    run(`INSERT INTO fare_reports (id,user_id,city,kind,vehicle_type,distance_miles,quoted_fare_cents,
      observed_hour_utc,local_dow,local_hour,status,dedupe_key,pickup_area)
      VALUES (?,'test-rider',?,?,?,2,?,?,1,9,?,?,'DO NOT EXPORT')`, id, city, kind, type,
    dollars * 100, day + 'T15:00:00Z', status, id);
  for (const [city, day, start] of [['austin','2026-10-05',1], ['austin','2026-10-12',11], ['dallas','2026-10-05',21]]) {
    for (let i = 0; i < 10; i++) await add(city + day + i, city, day, start + i);
  }
  for (let i = 0; i < 9; i++) await add('thin' + i, 'dallas', '2026-10-12', 7);
  await add('pending', 'dallas', '2026-10-12', 20, 'pending');
  await add('quote', 'dallas', '2026-10-12', 20, 'approved', 'quote');
  await add('negative', 'dallas', '2026-10-12', -3);
  await run(`INSERT INTO submissions(id,user_id,submission_type,status) VALUES
    ('receipt','test-rider','ride','approved')`);
  for (const id of ['receipt1','receipt2']) await run(`INSERT INTO trips (id,submission_id,user_id,service_area,
    source,ride_date,fare_amount_cents,distance,distance_unit,currency,ride_identifier,pickup_description)
    VALUES (?,'receipt','test-rider','Austin','receipt_email','2026-10-19',1000,2,'mi','USD','same ride','DO NOT EXPORT')`, id);
  const env = { cybercabhunter_db: db };
  await recomputeFareHistory(env, Date.parse('2026-11-01T18:00:00Z'));
  const get = async path => apiFareHistory(new Request('https://example.org' + path), env);
  const austin = await (await get('/api/fare-history?city=austin')).json();
  const dallasResponse = await get('/api/fare-history?city=dallas');
  const raw = await dallasResponse.text();
  const dallas = JSON.parse(raw);
  const bucket = (city, week) => city.ranges['90d'].all.weeks.find(row => row.week === week);
  assert.deepEqual(bucket(austin, '2026-10-05').fare, { n: 10, median: 5.5, p25: 3.25, p75: 7.75 });
  assert.equal(bucket(austin, '2026-10-12').fare.median, 15.5);
  assert.equal(bucket(dallas, '2026-10-05').fare.median, 25.5);
  assert.deepEqual(bucket(dallas, '2026-10-12').fare, { n: 9, median: null, p25: null, p75: null });
  assert.equal(bucket(austin, '2026-10-19').fare.n, 1);
  assert.equal(dallas.ranges.all.cybercab.fare.median, null);
  assert.equal(dallasResponse.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.doesNotMatch(raw, /DO NOT EXPORT|test-rider|2026-10-05T15|receipt1/);
  const { summary } = await (await get('/api/fare-history/summary?city=dallas')).json();
  assert.deepEqual(summary.fare, dallas.ranges['90d'].all.fare);
  assert.deepEqual(summary.per_mile, dallas.ranges['90d'].all.per_mile);
});
