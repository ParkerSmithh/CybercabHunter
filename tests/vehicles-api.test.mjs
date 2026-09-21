// Tests for GET /api/robotaxi-vehicles/:id (worker/vehicles.js) — the
// public, read-only vehicle-intelligence endpoint added in Phase 3B. Real
// SQL via the migration-loaded SQLite harness, and the REAL Worker router
// (worker/index.js), so "no session required" is proven at the actual
// routing layer, not just by calling the handler function directly.
// db.getPublicRobotaxiVehicle / db.getRobotaxiVehicleHistory are exercised
// as-is; see tests/vehicle-identity.test.mjs for their own dedicated tests
// (untouched by this file).
// Run: node tests/vehicles-api.test.mjs

import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, approveVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

// No Authorization header anywhere in this file — every call below is
// exactly what an anonymous visitor's browser would send.
const call = (env, path) => worker.fetch(new Request(`https://x${path}`, {}), env, {});

async function run() {
  console.log('1. Public access: no session, no Authorization header, works over the real router');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id, { withRide: true });
    const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${id}`);
    check('200 with no Authorization header at all', resp.status === 200);
    const body = await resp.json();
    check('the vehicle is returned', body.vehicle.id === id && body.vehicle.license_plate === 'XJR2195');
  }

  console.log('2. Valid approved vehicle whose only counted ride lacks details: an honest history with nulls, never invented values');
  {
    // Phase 3E: a vehicle with NO counted rides is no longer public at all
    // (see tests/registry-trust.test.mjs). What "honest nulls" now means is a
    // counted ride that simply has no distance/date/area recorded.
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'ZZZ0000');
    seedRide(d1, { userId: 'u1', vehicleId: id, distance: null, rideDate: null, serviceArea: null });
    approveVehicle(d1, id);
    const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${id}`);
    const body = await resp.json();
    check('200', resp.status === 200);
    check('vehicle fields present, unknowns honestly null (never invented)', body.vehicle.license_plate === 'ZZZ0000' && body.vehicle.model === null && body.vehicle.color === null);
    check('history shows the one ride, and missing totals are null (not zero/fabricated)', body.history.trip_count === 1 && body.history.first_ride_date === null && body.history.total_distance === null);
  }

  console.log('3. Valid vehicle WITH history: counted rides aggregate correctly, exactly matching db.getRobotaxiVehicleHistory');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, { userId: 'u1', vehicleId: id, rideDate: '2026-06-09', distance: 2.8, fare: 692, serviceArea: 'Dallas' });
    seedRide(d1, { userId: 'u1', vehicleId: id, rideDate: '2026-06-15', distance: 3.4, fare: 810, serviceArea: 'Dallas' });
    seedRide(d1, { userId: 'u1', vehicleId: id, rideDate: '2026-01-01', distance: 50, fare: 5000, status: 'rejected' }); // never counted
    const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${id}`);
    const body = await resp.json();
    check('trip_count only counts the 2 counted rides, not the rejected one', body.history.trip_count === 2);
    check('first/last ride date span only the counted rides', body.history.first_ride_date === '2026-06-09' && body.history.last_ride_date === '2026-06-15');
    check('total_distance sums only counted rides', Math.abs(body.history.total_distance - 6.2) < 1e-9);
    check('service_areas reflects only counted rides', body.history.service_areas === 'Dallas');
    const direct = await db.getRobotaxiVehicleHistory(d1, id);
    check('the endpoint\'s history figures match db.getRobotaxiVehicleHistory exactly (thin layer, not a redefinition)',
      body.history.trip_count === direct.trip_count && body.history.first_ride_date === direct.first_ride_date &&
      body.history.last_ride_date === direct.last_ride_date && body.history.service_areas === direct.service_areas);
  }

  console.log('4. Not found / invalid id: 404 for a valid-shaped but nonexistent id, 400 for a malformed one');
  {
    const d1 = createTestD1();
    const missing = await call({ cybercabhunter_db: d1 }, '/api/robotaxi-vehicles/11111111-1111-1111-1111-111111111111');
    check('a well-formed but nonexistent id is a clean 404, not a 200 with nulls or a 500', missing.status === 404);
    const missingBody = await missing.json();
    check('the 404 body follows the existing not_found convention', missingBody.success === false && missingBody.error === 'not_found');

    for (const bad of ['not-a-uuid', 'XJR2195', "x' OR '1'='1", '12345', 'a'.repeat(300)]) {
      const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${encodeURIComponent(bad)}`);
      check(`malformed id "${bad.slice(0, 20)}" is a clean 400, not a 500 or a false 404`, resp.status === 400);
    }
    // Nothing after the trailing slash doesn't match this route at all — it
    // falls through to the static asset handler, same as every other
    // dynamic :id route in this app (e.g. /api/trips/), not a 500.
    const emptyEnv = { cybercabhunter_db: d1, ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
    const emptyResp = await call(emptyEnv, '/api/robotaxi-vehicles/');
    check('an empty id segment falls through cleanly, no crash', emptyResp.status !== 500);
  }

  console.log('5. Privacy: the response never contains rider identity, private ride text, VIN, or session/account material');
  {
    const d1 = createTestD1(); seedUser(d1, 'user-first'); seedUser(d1, 'user-second');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, {
      userId: 'user-first', vehicleId: id, rideDate: '2026-06-09',
      pickupDescription: '4301 Hanover St, Dallas, TX 75225', dropoffDescription: 'NorthPark Center, Dallas'
    });
    seedRide(d1, { userId: 'user-second', vehicleId: id, rideDate: '2026-07-01' });
    const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${id}`);
    const blob = JSON.stringify(await resp.json());
    check('no user_id field of any shape', !/user_id|"userId"/i.test(blob));
    check('no rider id string leaks (neither rider)', !/user-first|user-second/.test(blob));
    check('no pickup/dropoff address text', !/Hanover|NorthPark|pickup_description|dropoff_description/i.test(blob));
    check('no VIN field', !/\bvin\b/i.test(blob));
    check('no Tesla/Google account or session/token material', !/access_token|refresh_token|session|tesla_account_identifier|google_sub|email/i.test(blob));
    check('no fare/money figure — a rider\'s own payment amount is deliberately excluded from this public response', !/total_fare_cents|fare_amount_cents/i.test(blob));
  }

  console.log('6. Cross-user isolation: a vehicle several different riders rode returns vehicle-level facts, crediting no one');
  {
    const d1 = createTestD1(); seedUser(d1, 'rider-a'); seedUser(d1, 'rider-b'); seedUser(d1, 'rider-c');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, { userId: 'rider-a', vehicleId: id, rideDate: '2026-06-01', distance: 2, serviceArea: 'Dallas' });
    seedRide(d1, { userId: 'rider-b', vehicleId: id, rideDate: '2026-06-15', distance: 3, serviceArea: 'Austin' });
    seedRide(d1, { userId: 'rider-c', vehicleId: id, rideDate: '2026-07-01', distance: 4, serviceArea: 'Dallas' });
    const resp = await call({ cybercabhunter_db: d1 }, `/api/robotaxi-vehicles/${id}`);
    const body = await resp.json();
    check('all three riders\' counted trips are aggregated together', body.history.trip_count === 3);
    check('the date span covers all three riders, not just one', body.history.first_ride_date === '2026-06-01' && body.history.last_ride_date === '2026-07-01');
    check('distances from every rider are summed', Math.abs(body.history.total_distance - 9) < 1e-9);
    check('both cities show up, aggregated, with no rider attached to either', body.history.service_areas.split(',').sort().join() === 'Austin,Dallas');
    check('none of the three rider ids appear anywhere in the response', !/rider-a|rider-b|rider-c/.test(JSON.stringify(body)));
  }

  console.log('7. This route is the exception, not the rule: a neighboring authenticated route on the same request still 401s');
  {
    const d1 = createTestD1();
    const resp = await worker.fetch(new Request('https://x/api/profile'), { cybercabhunter_db: d1 }, {});
    check('a genuinely private endpoint still requires a session (the vehicle route\'s public-ness is a deliberate exception, not a routing bug)', resp.status === 401);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
