// Tests for GET /api/trips (worker/trips.js + db.getTripsPage): pagination,
// ordering, user isolation, and the privacy whitelist. Real SQL.
// Run: node tests/trips-query.test.mjs

import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { apiListTrips } from '../worker/trips.js';

const t = makeCheck();
const { check } = t;

const list = async (d1, userId, qs = '') =>
  (await apiListTrips(new Request(`https://x/api/trips${qs}`), { cybercabhunter_db: d1 }, userId)).json();

async function run() {
  console.log('1. Pagination: page size, page number, totals');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    for (let i = 1; i <= 5; i++) seedRide(d1, { rideDate: `2026-06-0${i}`, pickupTime: '08:00' });
    const p1 = await list(d1, 'u1', '?page=1&page_size=2');
    const p3 = await list(d1, 'u1', '?page=3&page_size=2');
    check('page 1 holds 2 rides', p1.trips.length === 2);
    check('pagination reports total 5, 3 pages', p1.pagination.total === 5 && p1.pagination.total_pages === 3 && p1.pagination.page === 1 && p1.pagination.page_size === 2);
    check('the last page holds the remaining 1 ride', p3.trips.length === 1);
    check('newest ride date first', p1.trips[0].ride_date === '2026-06-05' && p1.trips[1].ride_date === '2026-06-04');
    const beyond = await list(d1, 'u1', '?page=9&page_size=2');
    check('a page past the end is empty, not an error', beyond.trips.length === 0 && beyond.pagination.total === 5);
    const all = new Set([...p1.trips, ...(await list(d1, 'u1', '?page=2&page_size=2')).trips, ...p3.trips].map(r => r.id));
    check('paging covers every ride exactly once', all.size === 5);
  }

  console.log('2. Sane bounds on page parameters');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    for (let i = 1; i <= 3; i++) seedRide(d1, { rideDate: `2026-06-0${i}`, pickupTime: '08:00' });
    check('junk parameters fall back to defaults', (await list(d1, 'u1', '?page=abc&page_size=xyz')).pagination.page === 1);
    check('page_size is capped at 50', (await list(d1, 'u1', '?page_size=100000')).pagination.page_size === 50);
    check('page_size floors at 1', (await list(d1, 'u1', '?page_size=0')).pagination.page_size === 1);
    check('negative page floors at 1', (await list(d1, 'u1', '?page=-4')).pagination.page === 1);
  }

  console.log('3. A user with no rides gets an empty list, a normal 200');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const body = await list(d1, 'u1');
    check('empty trips array', Array.isArray(body.trips) && body.trips.length === 0);
    check('total 0, one (empty) page', body.pagination.total === 0 && body.pagination.total_pages === 1);
  }

  console.log("4. User isolation: a rider never receives another rider's rides, whatever the request says");
  {
    const d1 = createTestD1(); seedUser(d1, 'u1'); seedUser(d1, 'u2');
    seedRide(d1, { id: 'mine', userId: 'u1', pickupTime: '08:00' });
    seedRide(d1, { id: 'theirs', userId: 'u2', pickupTime: '09:00' });
    const body = await list(d1, 'u1', '?user_id=u2&userId=u2');
    check("only u1's ride is returned", body.trips.length === 1 && body.trips[0].id === 'mine');
    check("a user_id in the query string has no effect", body.pagination.total === 1);
  }

  console.log('5. Privacy: only whitelisted ride fields ever leave the API');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    seedVehicle(d1, { id: 'v1', plate: 'XJR2195' });
    seedRide(d1, { vehicleId: 'v1', pickupDescription: '4301 Hanover St, Dallas, TX 75225', dropoffDescription: 'NorthPark Center, Dallas', duration: 14 });
    d1.exec(`UPDATE trips SET dropoff_time = '13:18', receipt_hash = 'deadbeef', source_message_id = '<secret@id>'`);
    const body = await list(d1, 'u1');
    const ride = body.trips[0];
    const keys = Object.keys(ride).sort().join();
    check('exactly the expected fields', keys === 'city,currency,currency_source,distance,distance_unit,duration_derived,duration_minutes,fare_amount_cents,id,revision,ride_date,source,status,vehicle_plate');
    const blob = JSON.stringify(body);
    check('no pickup/dropoff address text', !/Hanover|NorthPark|pickup|dropoff/i.test(blob));
    check('no exact ride times', !/13:04|13:18|pickup_time|dropoff_time/i.test(blob));
    check('no receipt hash or message id', !/deadbeef|secret@id|receipt_hash|source_message_id/i.test(blob));
    check('no user id', !/user_id/i.test(blob) && !blob.includes('"u1"'));
    check("the rider's own plate IS shown (they saw it on the receipt)", ride.vehicle_plate === 'XJR2195');
  }

  console.log('6. Missing values stay NULL in the API; status labels reflect review state; superseded duplicates are hidden');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    seedRide(d1, { id: 'a', distance: null, fare: null, status: 'pending', pickupTime: '08:00' });
    seedRide(d1, { id: 'b', status: 'needs_review', pickupTime: '09:00', rideDate: '2026-06-10' });
    seedRide(d1, { id: 'c', status: 'rejected', pickupTime: '10:00', rideDate: '2026-06-11' });
    seedRide(d1, { id: 'd', supersededBy: 'a', pickupTime: '08:00' });
    const body = await list(d1, 'u1');
    const byId = Object.fromEntries(body.trips.map(r => [r.id, r]));
    check('a superseded duplicate is not listed', !byId.d && body.pagination.total === 3);
    check('missing distance and fare are null, not 0', byId.a.distance === null && byId.a.fare_amount_cents === null);
    check('statuses: counted / under_review / rejected', byId.a.status === 'counted' && byId.b.status === 'under_review' && byId.c.status === 'rejected');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
