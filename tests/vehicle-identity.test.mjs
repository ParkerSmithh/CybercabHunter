// Tests for the receipt -> vehicle identity relationship
// (db.findOrCreateRobotaxiVehicleByPlate, db.getRobotaxiVehicleHistory).
// A fake D1 simulates just enough of robotaxi_vehicles/trips to exercise
// real find-or-create and aggregate semantics — no live D1 needed.
// Run: node tests/vehicle-identity.test.mjs
//
// Note: "plate is never used as external_ride_id" is already exhaustively
// covered by tests/receipt-pipeline.test.mjs (the extraction layer never
// writes the plate into that field) — not re-tested here to avoid
// duplicating coverage of the same guarantee at the wrong layer.

import { db } from '../worker/db.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
}

function fakeD1() {
  const vehicles = new Map();
  const plateIndex = new Map();
  const trips = [];
  let seq = 0;

  function stmt(sql) {
    const s = { sql, args: [] };
    s.bind = (...args) => { s.args = args; return s; };
    s.first = async () => {
      if (/SELECT id FROM robotaxi_vehicles WHERE license_plate = \?/.test(sql)) {
        const [plate] = s.args;
        const id = plateIndex.get(plate);
        return id ? { id } : null;
      }
      if (/SELECT\s+COUNT\(\*\) AS trip_count/.test(sql)) {
        const [vehicleId] = s.args;
        const matched = trips.filter(t => t.robotaxi_vehicle_id === vehicleId);
        if (matched.length === 0) {
          return { trip_count: 0, first_ride_date: null, last_ride_date: null, total_distance: null, total_fare_cents: null, service_areas: null };
        }
        const dates = matched.map(t => t.ride_date).filter(Boolean).sort();
        const areas = [...new Set(matched.map(t => t.service_area).filter(Boolean))];
        return {
          trip_count: matched.length,
          first_ride_date: dates[0] ?? null,
          last_ride_date: dates[dates.length - 1] ?? null,
          total_distance: matched.reduce((sum, t) => sum + (t.distance || 0), 0),
          total_fare_cents: matched.reduce((sum, t) => sum + (t.fare_amount_cents || 0), 0),
          service_areas: areas.length ? areas.join(',') : null
        };
      }
      return null;
    };
    s.run = async () => {
      if (/INSERT INTO robotaxi_vehicles/.test(sql)) {
        const [id, plate] = s.args;
        vehicles.set(id, { id, license_plate: plate, last_seen_at: `created-${seq}`, updated_at: `created-${seq}` });
        plateIndex.set(plate, id);
      } else if (/UPDATE robotaxi_vehicles SET last_seen_at/.test(sql)) {
        const [id] = s.args;
        const row = vehicles.get(id);
        seq += 1;
        if (row) { row.last_seen_at = `touched-${seq}`; row.updated_at = `touched-${seq}`; }
      }
      return { success: true };
    };
    return s;
  }

  return { prepare: sql => stmt(sql), _vehicles: vehicles, _addTrip: t => trips.push(t) };
}

async function run() {
  console.log('1. New plate creates a new provisional vehicle');
  {
    const sql = fakeD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'XJR2195');
    check('a vehicle id was returned', !!id);
    check('exactly one vehicle row exists', sql._vehicles.size === 1);
    check('the plate is stored on the new row', sql._vehicles.get(id).license_plate === 'XJR2195');
  }

  console.log('2. Same plate reused — no duplicate vehicle, last_seen_at advances');
  {
    const sql = fakeD1();
    const id1 = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'XJR2195');
    const firstSeenAt = sql._vehicles.get(id1).last_seen_at;
    const id2 = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'XJR2195');
    check('same plate resolves to the same vehicle id (idempotent)', id1 === id2);
    check('still exactly one vehicle row (no duplicate created)', sql._vehicles.size === 1);
    check('last_seen_at advances on the repeat sighting', sql._vehicles.get(id1).last_seen_at !== firstSeenAt);
  }

  console.log('3. Different plates never merge into one vehicle');
  {
    const sql = fakeD1();
    const idA = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'AAA1111');
    const idB = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'BBB2222');
    check('different plates produce different vehicle ids', idA !== idB);
    check('two distinct vehicle rows exist', sql._vehicles.size === 2);
  }

  console.log('4. Vehicle history for a vehicle with no trips yet');
  {
    const sql = fakeD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'XJR2195');
    const history = await db.getRobotaxiVehicleHistory(sql, id);
    check('trip_count is 0, not null, when no rides are known', history.trip_count === 0);
    check('first/last ride date are null (no rides), not a fabricated value', history.first_ride_date === null && history.last_ride_date === null);
  }

  console.log('5. Vehicle history aggregates correctly across multiple trips, with no private fields leaked');
  {
    const sql = fakeD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(sql, 'XJR2195');
    sql._addTrip({ robotaxi_vehicle_id: id, user_id: 'user-1', ride_date: '2026-06-09', distance: 2.8, fare_amount_cents: 692, service_area: 'Dallas', pickup_description: 'secret address A' });
    sql._addTrip({ robotaxi_vehicle_id: id, user_id: 'user-2', ride_date: '2026-07-01', distance: 3.4, fare_amount_cents: 810, service_area: 'Dallas', pickup_description: 'secret address B' });
    sql._addTrip({ robotaxi_vehicle_id: 'a-different-vehicle', user_id: 'user-1', ride_date: '2099-01-01', distance: 99, fare_amount_cents: 9999, service_area: 'Austin' });

    const history = await db.getRobotaxiVehicleHistory(sql, id);
    check('trip_count only counts this vehicle\'s trips', history.trip_count === 2);
    check('first_ride_date is the earliest of this vehicle\'s trips', history.first_ride_date === '2026-06-09');
    check('last_ride_date is the latest of this vehicle\'s trips', history.last_ride_date === '2026-07-01');
    check('total_distance sums only this vehicle\'s trips', Math.abs(history.total_distance - 6.2) < 1e-9);
    check('total_fare_cents sums only this vehicle\'s trips', history.total_fare_cents === 1502);
    check('service_areas reflects only this vehicle\'s trips', history.service_areas === 'Dallas');

    const keys = Object.keys(history);
    check('response contains no user_id field', !keys.includes('user_id'));
    check('response contains no pickup/dropoff text field', !keys.some(k => /pickup|dropoff/i.test(k)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
