// Phase 2 — rider statistics. Real SQL. Every figure must obey the single
// "which rides count" rule (worker/ride-status.js), keep NULL as NULL, report
// coverage, and keep vehicles RIDDEN separate from vehicles DISCOVERED.
// Run: node tests/phase2-stats.test.mjs

import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { makeEnv, seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { receiptBody, eml, inboundMessage, sentAt } from './helpers/receipts.mjs';
import { handleIncomingEmail } from '../worker/receipt-ingestion.js';
import { db } from '../worker/db.js';

const t = makeCheck();
const { check } = t;
const world = (...users) => { const d1 = createTestD1(); users.forEach(u => seedUser(d1, u)); return d1; };

async function run() {
  console.log('1. One counting rule: pending + approved count; needs_review, rejected and superseded duplicates never do');
  {
    const d1 = world('u1');
    seedVehicle(d1, { id: 'vA', plate: 'AAA1111', model: 'Model Y' });
    seedVehicle(d1, { id: 'vB', plate: 'BBB2222' });
    seedRide(d1, { id: 'r1', status: 'pending',      rideDate: '2026-06-01', fare: 1000, distance: 1, vehicleId: 'vA', serviceArea: 'Dallas' });
    seedRide(d1, { id: 'r2', status: 'approved',     rideDate: '2026-07-01', fare: 2000, distance: 2, vehicleId: 'vA', serviceArea: 'Austin' });
    seedRide(d1, { id: 'r3', status: 'needs_review', rideDate: '2026-08-01', fare: 4000, distance: 4, vehicleId: 'vB', serviceArea: 'Houston' });
    seedRide(d1, { id: 'r4', status: 'rejected',     rideDate: '2026-09-01', fare: 8000, distance: 8, vehicleId: 'vB', serviceArea: 'Houston' });
    seedRide(d1, { id: 'r5', status: 'pending',      rideDate: '2026-06-01', fare: 1000, distance: 1, vehicleId: 'vA', serviceArea: 'Dallas', supersededBy: 'r1' });
    const p = await db.getUserProfile(d1, 'u1');
    check('ride summary counts only the 2 counted rides', p.rideSummary.trip_count === 2);
    check('distance total counts only counted rides', p.rideSummary.total_distance === 3);
    check('cities only from counted rides', p.cities.map(c => c.service_area).sort().join() === 'Austin,Dallas');
    check('monthly activity only from counted rides', p.monthlyActivity.map(m => m.month).join() === '2026-06,2026-07');
    check('spending only from counted rides', p.spending[0].totalCents === 3000 && p.spending[0].fareCount === 2);
    check('vehicles ridden only from counted rides', p.rideSummary.unique_vehicles === 1 && p.vehicleStats.length === 1 && p.vehicleStats[0].vehicle_id === 'vA');
    check('providers only from counted rides', p.providers[0].ride_count === 2);
    check('coverage is computed over the counted rides', p.coverage.rides === 2);
    check('contributions exclude review/rejected/superseded submissions', p.contributionCount === 2);
    check('the review queue is reported separately: exactly one ride under review', p.underReview === 1);
    check('a rejected ride is not "under review" either', p.underReview === 1);
  }

  console.log('2. A moderator rejecting a previously counted ride removes it from every statistic');
  {
    const d1 = world('u1');
    seedRide(d1, { id: 'r1', pickupTime: '08:00', fare: 500 });
    seedRide(d1, { id: 'r2', pickupTime: '09:00', fare: 700 });
    check('both count at first', (await db.getUserProfile(d1, 'u1')).rideSummary.trip_count === 2);
    d1.exec(`UPDATE submissions SET status = 'rejected' WHERE id = 'sub-r2'`);
    const p = await db.getUserProfile(d1, 'u1');
    check('after rejection only one ride counts', p.rideSummary.trip_count === 1 && p.spending[0].totalCents === 500);
  }

  console.log('3. Multiple cities aggregate correctly, with distance and first/latest ride per city');
  {
    const d1 = world('u1');
    seedRide(d1, { serviceArea: 'Dallas', rideDate: '2026-04-02', distance: 3.0, pickupTime: '08:00' });
    seedRide(d1, { serviceArea: 'Dallas', rideDate: '2026-06-09', distance: 2.5, pickupTime: '08:00' });
    seedRide(d1, { serviceArea: 'Dallas', rideDate: '2026-05-01', distance: null, pickupTime: '08:00' });
    seedRide(d1, { serviceArea: 'Austin', rideDate: '2026-08-09', distance: 4.0, pickupTime: '08:00' });
    seedRide(d1, { serviceArea: null,     rideDate: '2026-08-10', distance: 1.0, pickupTime: '08:00' }); // city unknown
    const p = await db.getUserProfile(d1, 'u1');
    const dallas = p.cities.find(c => c.service_area === 'Dallas');
    const austin = p.cities.find(c => c.service_area === 'Austin');
    check('Dallas: 3 rides', dallas.ride_count === 3);
    check('Dallas: distance sums only the rides that recorded one (5.5) and says 2 of 3 did', dallas.total_distance === 5.5 && dallas.rides_with_distance === 2);
    check('Dallas: first and latest ride dates', dallas.first_ride_date === '2026-04-02' && dallas.last_ride_date === '2026-06-09');
    check('Austin: 1 ride, 4 mi', austin.ride_count === 1 && austin.total_distance === 4);
    check('a ride with no city is not invented into a city', p.cities.length === 2);
    check('but it still counts as a ride and coverage says city is known for 4 of 5', p.rideSummary.trip_count === 5 && p.coverage.withCity === 4);
  }

  console.log('4. Monthly activity: per-month rides and distance, honest about missing distance');
  {
    const d1 = world('u1');
    seedRide(d1, { rideDate: '2026-04-10', distance: 2, pickupTime: '08:00' });
    seedRide(d1, { rideDate: '2026-04-20', distance: 3, pickupTime: '08:00' });
    seedRide(d1, { rideDate: '2026-05-05', distance: null, pickupTime: '08:00' });
    seedRide(d1, { rideDate: null, distance: 9, pickupTime: null });            // no date: cannot be placed in a month
    const p = await db.getUserProfile(d1, 'u1');
    const april = p.monthlyActivity.find(m => m.month === '2026-04');
    const may = p.monthlyActivity.find(m => m.month === '2026-05');
    check('April: 2 rides, 5 miles', april.ride_count === 2 && april.total_distance === 5);
    check('May: 1 ride, distance NULL (not 0) because none was recorded', may.ride_count === 1 && may.total_distance === null && may.rides_with_distance === 0);
    check('a ride with no date is left out of the months rather than guessed into one', p.monthlyActivity.length === 2);
    check('but it still counts as a ride overall', p.rideSummary.trip_count === 4 && p.coverage.withDate === 3);
  }

  console.log('5. Vehicles RIDDEN vs vehicles DISCOVERED are separate statistics');
  {
    const d1 = world('me', 'other');
    ['v1', 'v2', 'v3'].forEach((id, i) => seedVehicle(d1, { id, plate: `PLT${i}000` }));
    // `other` rode v1 and v2 first; I discovered only v3, but I rode all three.
    seedRide(d1, { userId: 'other', vehicleId: 'v1', createdAt: '2026-06-01 09:00:00', pickupTime: '07:00' });
    seedRide(d1, { userId: 'other', vehicleId: 'v2', createdAt: '2026-06-01 09:01:00', pickupTime: '07:10' });
    seedRide(d1, { userId: 'me', vehicleId: 'v1', createdAt: '2026-06-02 09:00:00', pickupTime: '08:00' });
    seedRide(d1, { userId: 'me', vehicleId: 'v2', createdAt: '2026-06-02 09:01:00', pickupTime: '08:10' });
    seedRide(d1, { userId: 'me', vehicleId: 'v3', createdAt: '2026-06-02 09:02:00', pickupTime: '08:20' });
    const p = await db.getUserProfile(d1, 'me');
    check('I RODE 3 vehicles', p.rideSummary.unique_vehicles === 3 && p.vehicleStats.length === 3);
    check('I DISCOVERED exactly 1', p.discoveredVehicles.length === 1 && p.discoveredVehicles[0].id === 'v3');
    check('the two numbers are different', p.rideSummary.unique_vehicles !== p.discoveredVehicles.length);
  }

  console.log('6. Same plate across several rides is ONE vehicle; per-vehicle counts and distance add up');
  {
    const d1 = world('u1');
    seedVehicle(d1, { id: 'vA', plate: 'AAA1111' }); seedVehicle(d1, { id: 'vB', plate: 'BBB2222' });
    seedRide(d1, { vehicleId: 'vA', distance: 2, rideDate: '2026-06-01', pickupTime: '08:00' });
    seedRide(d1, { vehicleId: 'vA', distance: 3, rideDate: '2026-06-05', pickupTime: '08:00' });
    seedRide(d1, { vehicleId: 'vA', distance: null, rideDate: '2026-06-09', pickupTime: '08:00' });
    seedRide(d1, { vehicleId: 'vB', distance: 1, rideDate: '2026-06-02', pickupTime: '08:00' });
    seedRide(d1, { vehicleId: null, distance: 1, rideDate: '2026-06-03', pickupTime: '08:00' });   // plate unknown
    const p = await db.getUserProfile(d1, 'u1');
    check('two unique vehicles from five rides', p.rideSummary.unique_vehicles === 2);
    const a = p.vehicleStats.find(v => v.license_plate === 'AAA1111');
    check('vehicle A: 3 rides, 5 miles over the 2 rides that recorded distance', a.ride_count === 3 && a.total_distance === 5 && a.rides_with_distance === 2);
    check('vehicle A first/last ride', a.first_ride_date === '2026-06-01' && a.last_ride_date === '2026-06-09');
    check('most-ridden vehicle listed first', p.vehicleStats[0].license_plate === 'AAA1111');
    check('a ride with no plate is not attributed to any vehicle; coverage says 4 of 5', p.coverage.withVehicle === 4 && p.coverage.rides === 5);
  }

  console.log('7. Model breakdown uses only models that are actually known');
  {
    const d1 = world('u1');
    seedVehicle(d1, { id: 'v1', plate: 'AAA1111', model: 'Model Y' });
    seedVehicle(d1, { id: 'v2', plate: 'BBB2222', model: 'Model Y' });
    seedVehicle(d1, { id: 'v3', plate: 'CCC3333', model: 'Cybercab' });
    seedVehicle(d1, { id: 'v4', plate: 'DDD4444' });                               // model unknown
    ['v1', 'v1', 'v2', 'v3', 'v4'].forEach((v, i) => seedRide(d1, { vehicleId: v, pickupTime: `0${i}:00`, rideDate: `2026-06-0${i + 1}` }));
    const p = await db.getUserProfile(d1, 'u1');
    const y = p.modelBreakdown.find(m => m.model === 'Model Y');
    check('Model Y: 2 vehicles, 3 rides', y.vehicle_count === 2 && y.ride_count === 3);
    check('Cybercab: 1 vehicle, 1 ride', p.modelBreakdown.find(m => m.model === 'Cybercab').ride_count === 1);
    check('the unknown-model vehicle is NOT assigned a model; it is counted separately', p.modelBreakdown.length === 2 && p.unknownModelVehicles === 1);
  }

  console.log('8. Spending: free vs missing fare, average/median over recorded fares, currency provenance');
  {
    const d1 = world('u1');
    [0, 400, 600, 1000].forEach((f, i) => seedRide(d1, { fare: f, pickupTime: `0${i}:00`, rideDate: `2026-06-0${i + 1}` }));
    seedRide(d1, { fare: null, pickupTime: '09:00', rideDate: '2026-06-09' });
    const p = await db.getUserProfile(d1, 'u1');
    const s = p.spending[0];
    check('a recorded $0 is a free ride: exactly one', s.freeCount === 1 && s.paidCount === 3);
    check('the ride with no fare is neither free nor paid: 4 fares recorded of 5 rides', s.fareCount === 4 && p.coverage.rides === 5 && p.coverage.withFare === 4);
    check('total is 2000 cents', s.totalCents === 2000);
    check('average over recorded fares (free included) is 500', s.avgCents === 500);
    check('median over recorded fares is 500', s.medianCents === 500);
    check('the currency is flagged as assumed, not confirmed', s.currency === 'USD' && s.currencySource === 'assumed');
  }

  console.log('9. Statistics are isolated per rider');
  {
    const d1 = world('a', 'b');
    seedRide(d1, { userId: 'a', fare: 1000, pickupTime: '08:00' });
    seedRide(d1, { userId: 'b', fare: 2000, pickupTime: '08:00' });
    seedRide(d1, { userId: 'b', fare: 3000, pickupTime: '09:00' });
    const a = await db.getUserProfile(d1, 'a');
    const b = await db.getUserProfile(d1, 'b');
    check('rider a sees only their own ride and spend', a.rideSummary.trip_count === 1 && a.spending[0].totalCents === 1000);
    check('rider b sees only their own rides and spend', b.rideSummary.trip_count === 2 && b.spending[0].totalCents === 5000);
  }

  console.log('10. Statistics adapt live: a new ride, a corrected ride and a deleted ride are all reflected immediately');
  {
    const d1 = world('u1');
    seedRide(d1, { id: 'r1', fare: 500, distance: 1, pickupTime: '08:00' });
    let p = await db.getUserProfile(d1, 'u1');
    check('one ride', p.rideSummary.trip_count === 1 && p.spending[0].totalCents === 500);
    seedRide(d1, { id: 'r2', fare: 700, distance: 2, pickupTime: '09:00' });
    p = await db.getUserProfile(d1, 'u1');
    check('a new ride arrives: two rides, 1200 spent', p.rideSummary.trip_count === 2 && p.spending[0].totalCents === 1200);
    d1.exec(`UPDATE trips SET fare_amount_cents = 900 WHERE id = 'r2'`);
    p = await db.getUserProfile(d1, 'u1');
    check('a ride is corrected: total follows', p.spending[0].totalCents === 1400);
    d1.exec(`DELETE FROM trips WHERE id = 'r1'`);
    p = await db.getUserProfile(d1, 'u1');
    check('a ride is deleted: statistics drop it', p.rideSummary.trip_count === 1 && p.spending[0].totalCents === 900);
  }

  console.log('11. Time on board: total/average duration, NULL (not zero) when no data, existing stats untouched');
  {
    const d1 = world('u1');
    seedRide(d1, { id: 'r1', duration: 14, fare: 692, distance: 2.8, pickupTime: '08:00', rideDate: '2026-06-01' });
    seedRide(d1, { id: 'r2', duration: 20, fare: 850, distance: 3.4, pickupTime: '09:00', rideDate: '2026-06-02' });
    const p = await db.getUserProfile(d1, 'u1');
    check('total duration sums the two recorded durations', p.rideSummary.total_duration_minutes === 34);
    check('average duration is the mean of the two', p.rideSummary.avg_duration_minutes === 17);
    check('both rides fed the duration figures', p.rideSummary.rides_with_duration === 2);
    check('none of them were derived from timestamps', p.rideSummary.rides_with_derived_duration === 0);
    check('existing ride count/distance/fare stats are unaffected by the new columns', p.rideSummary.trip_count === 2 && Math.abs(p.rideSummary.total_distance - 6.2) < 1e-9 && p.spending[0].totalCents === 1542);
  }
  {
    const d1 = world('u1');
    seedRide(d1, { id: 'r1', duration: 14, pickupTime: '08:00', rideDate: '2026-06-01' });
    seedRide(d1, { id: 'r2', duration: 20, pickupTime: '09:00', rideDate: '2026-06-02' });
    seedRide(d1, { id: 'r3', duration: null, pickupTime: '10:00', rideDate: '2026-06-03' });
    const p = await db.getUserProfile(d1, 'u1');
    check('the NULL-duration ride is excluded from the total (34, not treated as 0)', p.rideSummary.total_duration_minutes === 34);
    check('the NULL-duration ride is excluded from the average too (17, not 34/3)', p.rideSummary.avg_duration_minutes === 17);
    check('rides_with_duration says 2 of 3, matching the exclusion', p.rideSummary.rides_with_duration === 2);
    check('the ride itself is still counted in trip_count even without a duration', p.rideSummary.trip_count === 3);
  }
  {
    const d1 = world('u1');
    seedRide(d1, { id: 'r1', duration: null, pickupTime: '08:00', rideDate: '2026-06-01' });
    seedRide(d1, { id: 'r2', duration: null, pickupTime: '09:00', rideDate: '2026-06-02' });
    const p = await db.getUserProfile(d1, 'u1');
    check('no duration data anywhere: total is NULL, not 0', p.rideSummary.total_duration_minutes === null);
    check('no duration data anywhere: average is NULL, not 0', p.rideSummary.avg_duration_minutes === null);
    check('rides_with_duration is 0', p.rideSummary.rides_with_duration === 0);
    check('the rides themselves still count', p.rideSummary.trip_count === 2);
  }
  {
    // A duration computed from pickup/dropoff timestamps (no "X min" stated
    // on the receipt) is real ingestion, not a hand-seeded row — exercises
    // duration_minutes_derived end to end and confirms the aggregate can
    // still tell how many of the summed rides were derived vs. stated.
    const ctx = await makeEnv({ users: ['u1'] });
    const to = ctx.addressFor('u1');
    const email = async opts => handleIncomingEmail(inboundMessage(eml({ ...opts, to }), to), ctx.env);
    await email({ body: receiptBody({ summary: null }), date: sentAt(0) });                         // derived: 13:04->13:18 = 14 min
    await email({ body: receiptBody({ date: 'June 10, 2026' }), date: sentAt(60) });                 // stated: "14 min" on the summary line
    const p = await db.getUserProfile(ctx.d1, 'u1');
    check('both rides contributed to the total (28 minutes)', p.rideSummary.total_duration_minutes === 28);
    check('exactly one of the two rides had a derived (not receipt-stated) duration', p.rideSummary.rides_with_derived_duration === 1 && p.rideSummary.rides_with_duration === 2);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
