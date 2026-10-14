import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, seedRide } from './helpers/env.mjs';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { getSiteStatCounters } from '../worker/site-stats.js';
import worker from '../worker/index.js';

const migration = readFileSync(new URL('../migrations/0034_site_stat_counters.sql', import.meta.url), 'utf8');
const counts = sql => getSiteStatCounters(sql);
const vehicle = (sql, id, visibility = 'public') => sql.prepare(`INSERT INTO robotaxi_vehicles(id, license_plate, visibility, origin, approval_basis) VALUES (?, ?, ?, 'sighting', 'manual')`).bind(id, id, visibility)._exec();
const detection = (sql, id, source = null) => sql.prepare(`INSERT INTO camera_detections(id,camera_id,camera_name,lat,lng,observed_at,source_submission_id) VALUES (?,?,'test',30,-97,?,?)`).bind(id, id, `2026-10-10T00:00:${id === 'camera-1' ? '01' : '02'}Z`, source)._exec();

// Backfill uses the current queries and remembers historical events without
// reintroducing expired content or counting it again after re-approval.
const old = createTestD1({ migrateThrough: '0033_news_investor_blocklist.sql' });
seedUser(old, 'rider');
vehicle(old, 'legacy');
seedRide(old, { userId: 'rider', vehicleId: 'legacy', rideKey: 'physical' });
seedRide(old, { userId: 'rider', vehicleId: 'legacy', rideKey: 'physical-copy' });
old.exec(`INSERT INTO submissions(id,user_id,submission_type,status,evidence_type,evidence_ref) VALUES('legacy-s','rider','vehicle_sighting','approved','photo','stored');
INSERT INTO vehicle_observations(id,user_id,submission_id,observed_at,evidence_ref,public_id) VALUES('legacy-o','rider','legacy-s',datetime('now'),'stored','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');`);
old.exec(migration);
assert.deepEqual(await counts(old), { sightings_all_time: 1, cybercabs_spotted: 1, rides_total: 2 });
old.exec("UPDATE submissions SET status='pending' WHERE id='legacy-s'; UPDATE submissions SET status='approved' WHERE id='legacy-s'");
assert.equal((await counts(old)).sightings_all_time, 1);

const lifetimeBackfill = readFileSync(new URL('../migrations/0035_sightings_lifetime_backfill.sql', import.meta.url), 'utf8');
old.exec("DELETE FROM submissions WHERE id='legacy-s'");
old.exec(lifetimeBackfill);
assert.equal((await counts(old)).sightings_all_time, 2, 'backfill includes the historical camera and deleted approved sighting');
old.exec("UPDATE site_stat_counters SET value=10 WHERE key='sightings_all_time'");
old.exec(lifetimeBackfill);
assert.equal((await counts(old)).sightings_all_time, 10, 'backfill never decreases an existing total');
old.exec("DELETE FROM site_stat_counters WHERE key='sightings_all_time'");
old.exec(lifetimeBackfill);
assert.equal((await counts(old)).sightings_all_time, 2, 'backfill creates a missing lifetime row');

const ctx = await makeEnv({ users: ['rider', 'mod', 'other'] });
ctx.d1.exec("UPDATE users SET role='moderator' WHERE id='mod'");
for (const id of ['rider','mod']) await ctx.env.TESLA_SESSIONS.put(`session:${id}`, JSON.stringify({user_id:id}));
async function call(method, path, user, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if(user) headers.Authorization = `Bearer ${user}`;
  if(body && !(body instanceof FormData)) { headers['Content-Type']='application/json'; body=JSON.stringify(body); }
  return worker.fetch(new Request(`https://x${path}`,{method,headers,body}),ctx.env,{});
}
const fd = new FormData();
fd.append('photo', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64')], 'test.png', {type:'image/png'}));
fd.append('service_area','Austin');
const submitted = await call('POST','/api/vehicle-sightings/photo','rider',fd);
assert.equal(submitted.status,201);
const { submission_id: id } = await submitted.json();
// migrations/0042: only approved PHOTO sightings by people count (the seeded
// camera-watch capture from 0019 and registry imports never do).
assert.equal((await counts(ctx.d1)).sightings_all_time,0,'a pending photo and a camera-watch capture are not sightings');
assert.equal((await call('PATCH',`/api/moderation/vehicle-sightings/${id}`,'mod',{action:'approve'})).status,200);
assert.equal((await counts(ctx.d1)).sightings_all_time,1);
const cityCount = () => (ctx.d1.prepare("SELECT value FROM site_stat_counters WHERE key='sightings_all_time:austin'")._exec().results[0] || { value: 0 }).value;
assert.equal(cityCount(),1,'the approved photo counts for its city too');
await call('PATCH',`/api/moderation/vehicle-sightings/${id}`,'mod',{action:'approve'});
assert.equal((await counts(ctx.d1)).sightings_all_time,1);
detection(ctx.d1,'map-copy',id);
assert.equal((await counts(ctx.d1)).sightings_all_time,1,'a map copy is not a second sighting');
assert.equal((await call('GET','/api/sightings?stats=1')).status,200);
assert.equal((await call('DELETE',`/api/moderation/vehicle-sightings/${id}/photo`,'mod')).status,200);
let gallery = await (await call('GET','/api/sightings?stats=1')).json();
assert.equal(gallery.sightings.length,0);
assert.equal(gallery.seen,0);
assert.equal(gallery.stats.total,0,'window stats stay live');
assert.equal(gallery.sightings_all_time,1);
assert.equal(gallery.stats.sightings_all_time,1);
const austin = await (await call('GET','/api/sightings?stats=1&city=austin')).json();
assert.equal(austin.stats.sightings_all_time_city,1,'the city filter gets its own lifetime count');
assert.equal((await (await call('GET','/api/sightings?stats=1&city=dallas')).json()).stats.sightings_all_time_city,0);
assert.equal(cityCount(),1,'a deleted photo keeps its lifetime city count');
assert.equal(ctx.d1.prepare('SELECT COUNT(*) AS n FROM camera_detections WHERE source_submission_id=?').bind(id)._exec().results[0].n,0,'map copy removed');
detection(ctx.d1,'camera-1');
assert.equal((await counts(ctx.d1)).sightings_all_time,1,'a camera-watch capture is not a sighting (0042)');
ctx.d1.exec(`INSERT INTO submissions(id,user_id,submission_type,status) VALUES('registry-import','other','vehicle_sighting','approved')`);
assert.equal((await counts(ctx.d1)).sightings_all_time,1,'a registry import (no photo) is not a sighting (0042)');

vehicle(ctx.d1,'car','private');
assert.equal((await counts(ctx.d1)).cybercabs_spotted,0);
ctx.d1.exec("UPDATE robotaxi_vehicles SET visibility='public' WHERE id='car'");
assert.equal((await counts(ctx.d1)).cybercabs_spotted,1);
ctx.d1.exec("UPDATE robotaxi_vehicles SET visibility='private' WHERE id='car'; UPDATE robotaxi_vehicles SET visibility='public' WHERE id='car'");
assert.equal((await counts(ctx.d1)).cybercabs_spotted,1);
const trip = seedRide(ctx.d1,{userId:'rider',vehicleId:'car',rideKey:'physical-new'});
seedRide(ctx.d1,{userId:'other',vehicleId:'car',rideKey:'physical-new'});
assert.equal((await counts(ctx.d1)).rides_total,1,'two receipts for one physical ride count once');
ctx.d1.prepare("UPDATE trips SET ride_key='corrected' WHERE id=?").bind(trip)._exec();
ctx.d1.prepare("UPDATE submissions SET status='approved' WHERE id=?").bind(`sub-${trip}`)._exec();
assert.equal((await counts(ctx.d1)).rides_total,1,'editing a counted ride or approving pending ride does not recount');
const review = seedRide(ctx.d1,{userId:'rider',vehicleId:'car',rideKey:'review',status:'needs_review'});
assert.equal((await counts(ctx.d1)).rides_total,1);
ctx.d1.prepare("UPDATE submissions SET status='approved' WHERE id=?").bind(`sub-${review}`)._exec();
assert.equal((await counts(ctx.d1)).rides_total,2);
ctx.d1.exec("DELETE FROM trips WHERE robotaxi_vehicle_id='car'; DELETE FROM robotaxi_vehicles WHERE id='car'");
assert.deepEqual(await counts(ctx.d1), {sightings_all_time:1,cybercabs_spotted:1,rides_total:2});
assert.equal((await (await call('GET','/api/robotaxi-vehicles')).json()).vehicles.length,0);
assert.deepEqual(await (await call('GET','/api/registry/stats')).json(),{public_vehicles:1,recorded_rides:2,sightings_all_time:1});
assert.throws(()=>ctx.d1.exec("UPDATE site_stat_counters SET value=-1"));
assert.throws(()=>ctx.d1.exec("UPDATE site_stat_counters SET value=NULL"));
assert.throws(()=>ctx.d1.exec("UPDATE site_stat_counters SET value=0.5"));
ctx.d1.exec("DELETE FROM site_stat_counters WHERE key='rides_total'");
assert.equal((await counts(ctx.d1)).rides_total,0);
assert.equal(ctx.d1.query("SELECT value FROM site_stat_counters WHERE key='rides_total'")[0].value,0);
ctx.d1.exec('BEGIN');
vehicle(ctx.d1,'rollback');
ctx.d1.exec('ROLLBACK');
assert.equal((await counts(ctx.d1)).cybercabs_spotted,1,'event and counter roll back atomically');
console.log('Lifetime counters: backfill, API approval/deletion, map cleanup, idempotency, ride deduplication, constraints, missing rows and rollback passed.');
