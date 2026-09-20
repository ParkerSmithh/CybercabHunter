// Tests for the receipt -> vehicle identity relationship
// (db.findOrCreateRobotaxiVehicleByPlate, db.getRobotaxiVehicleHistory).
// Real SQL via the migration-loaded SQLite harness.
// Run: node tests/vehicle-identity.test.mjs
//
// Note: "plate is never used as external_ride_id" is covered by
// tests/receipt-pipeline.test.mjs (the extraction layer never writes the
// plate into that field) — not re-tested here at the wrong layer.

import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';

const t = makeCheck();
const { check } = t;

async function run() {
  console.log('1. New plate creates a new provisional vehicle');
  {
    const d1 = createTestD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    check('a vehicle id was returned', !!id);
    check('exactly one vehicle row exists', d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
    check('the plate is stored on the new row', d1.query('SELECT license_plate p FROM robotaxi_vehicles WHERE id = ?', id)[0].p === 'XJR2195');
  }

  console.log('2. Same plate reused — no duplicate vehicle, last_seen_at advances');
  {
    const d1 = createTestD1();
    const id1 = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    d1.exec(`UPDATE robotaxi_vehicles SET last_seen_at = '2000-01-01 00:00:00'`);
    const id2 = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    check('same plate resolves to the same vehicle id (idempotent)', id1 === id2);
    check('still exactly one vehicle row (no duplicate created)', d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
    check('last_seen_at advances on the repeat sighting', d1.query('SELECT last_seen_at s FROM robotaxi_vehicles')[0].s !== '2000-01-01 00:00:00');
  }

  console.log('3. Different plates never merge into one vehicle');
  {
    const d1 = createTestD1();
    const idA = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'AAA1111');
    const idB = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'BBB2222');
    check('different plates produce different vehicle ids', idA !== idB);
    check('two distinct vehicle rows exist', d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 2);
  }

  console.log('3b. Plate spelling differences (case, hyphen, space) are the same car');
  {
    const d1 = createTestD1();
    const a = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    const b = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'xjr-2195');
    const c = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR 2195');
    check('all spellings resolve to one vehicle', a === b && b === c);
    check('only one registry row', d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
    d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate) VALUES ('legacy', 'ABC-1234')`);
    const legacy = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'ABC1234');
    check('an existing hyphenated registry plate is matched, not duplicated', legacy === 'legacy');
  }

  console.log('4. Vehicle history for a vehicle with no trips yet');
  {
    const d1 = createTestD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    const history = await db.getRobotaxiVehicleHistory(d1, id);
    check('trip_count is 0, not null, when no rides are known', history.trip_count === 0);
    check('first/last ride date and totals are null (no rides), not fabricated', history.first_ride_date === null && history.last_ride_date === null && history.total_distance === null);
  }

  console.log('5. Vehicle history aggregates only THIS vehicle\'s counted trips, with no private fields leaked');
  {
    const d1 = createTestD1();
    seedUser(d1, 'user-1'); seedUser(d1, 'user-2');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    const other = seedVehicle(d1, { id: 'other', plate: 'ZZZ9999' });
    seedRide(d1, { userId: 'user-1', vehicleId: id, rideDate: '2026-06-09', distance: 2.8, fare: 692, serviceArea: 'Dallas', pickupDescription: 'secret address A' });
    seedRide(d1, { userId: 'user-2', vehicleId: id, rideDate: '2026-07-01', distance: 3.4, fare: 810, serviceArea: 'Dallas', pickupDescription: 'secret address B' });
    seedRide(d1, { userId: 'user-1', vehicleId: other, rideDate: '2099-01-01', distance: 99, fare: 9999, serviceArea: 'Austin' });
    // Not counted: a rejected ride, a needs_review ride, a superseded duplicate.
    seedRide(d1, { userId: 'user-1', vehicleId: id, rideDate: '2026-01-01', distance: 50, fare: 5000, status: 'rejected' });
    seedRide(d1, { userId: 'user-1', vehicleId: id, rideDate: '2026-01-02', distance: 50, fare: 5000, status: 'needs_review' });
    seedRide(d1, { id: 'dup', userId: 'user-1', vehicleId: id, rideDate: '2026-06-09', distance: 2.8, fare: 692, supersededBy: 'trip-1' });

    const history = await db.getRobotaxiVehicleHistory(d1, id);
    check("trip_count only counts this vehicle's COUNTED trips", history.trip_count === 2);
    check("first_ride_date is the earliest counted trip", history.first_ride_date === '2026-06-09');
    check("last_ride_date is the latest counted trip", history.last_ride_date === '2026-07-01');
    check('total_distance sums only counted trips', Math.abs(history.total_distance - 6.2) < 1e-9);
    check('total_fare_cents sums only counted trips', history.total_fare_cents === 1502);
    check("service_areas reflects only this vehicle's trips", history.service_areas === 'Dallas');
    const keys = Object.keys(history);
    check('response contains no user_id field', !keys.includes('user_id'));
    check('response contains no pickup/dropoff text field', !keys.some(k => /pickup|dropoff/i.test(k)));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
