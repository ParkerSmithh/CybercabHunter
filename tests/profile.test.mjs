// Tests for GET /api/profile (worker/profile.js + db.getUserProfile) and
// PATCH /api/profile. Real SQL via the migration-loaded SQLite harness.
// Run: node tests/profile.test.mjs

import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import { apiGetProfile, apiUpdateProfile } from '../worker/profile.js';

const t = makeCheck();
const { check } = t;

function world() {
  const d1 = createTestD1();
  return d1;
}

async function run() {
  console.log('1. Ride summary aggregates correctly for a user with multiple trips');
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedVehicle(d1, { id: 'v1', plate: 'AAA1111' }); seedVehicle(d1, { id: 'v2', plate: 'BBB2222' });
    seedRide(d1, { rideDate: '2026-06-09', distance: 2.8, serviceArea: 'Dallas', vehicleId: 'v1' });
    seedRide(d1, { rideDate: '2026-07-01', distance: 5.0, serviceArea: 'Dallas', vehicleId: 'v2', pickupTime: '09:00' });
    seedRide(d1, { rideDate: '2026-08-01', distance: null, serviceArea: 'Austin', vehicleId: null });
    const profile = await db.getUserProfile(d1, 'u1');
    check('trip_count counts all counted trips, even one with no distance', profile.rideSummary.trip_count === 3);
    check('total_distance ignores the null-distance trip, not treats it as 0', profile.rideSummary.total_distance === 7.8);
    check('rides_with_distance reports coverage (2 of 3)', profile.rideSummary.rides_with_distance === 2);
    check('longest_ride_distance is correct', profile.rideSummary.longest_ride_distance === 5.0);
    check('unique_vehicles counts distinct non-null vehicle ids only', profile.rideSummary.unique_vehicles === 2);
    check('first/last ride date correct', profile.rideSummary.first_ride_date === '2026-06-09' && profile.rideSummary.last_ride_date === '2026-08-01');
  }

  console.log('2. Cities and providers grouped correctly');
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedRide(d1, { serviceArea: 'Dallas', rideDate: '2026-06-01', pickupTime: '08:00' });
    seedRide(d1, { serviceArea: 'Dallas', rideDate: '2026-06-02', pickupTime: '08:00' });
    seedRide(d1, { serviceArea: 'Austin', rideDate: '2026-06-03', pickupTime: '08:00' });
    const profile = await db.getUserProfile(d1, 'u1');
    check('cities grouped with correct counts, busiest first', profile.cities.map(c => `${c.service_area}:${c.ride_count}`).join() === 'Dallas:2,Austin:1');
    check('providers currently all tesla, ready for future providers', profile.providers.length === 1 && profile.providers[0].provider === 'tesla' && profile.providers[0].ride_count === 3);
  }

  console.log('3. Vehicle discovery credits only the earliest rider, not later riders of the same vehicle');
  {
    const d1 = world(); seedUser(d1, 'user-first'); seedUser(d1, 'user-second');
    seedVehicle(d1, { id: 'v1', plate: 'XJR2195' });
    seedRide(d1, { userId: 'user-first', vehicleId: 'v1', createdAt: '2026-06-09 13:00:00' });
    seedRide(d1, { userId: 'user-second', vehicleId: 'v1', createdAt: '2026-07-01 13:00:00', rideDate: '2026-07-01' });
    const first = await db.getUserProfile(d1, 'user-first');
    const second = await db.getUserProfile(d1, 'user-second');
    check('the earliest rider is credited with discovering the vehicle', first.discoveredVehicles.length === 1 && first.discoveredVehicles[0].id === 'v1');
    check('a later rider of the same vehicle is NOT credited as its discoverer', second.discoveredVehicles.length === 0);
    check('but BOTH riders rode it — vehicles ridden is separate from vehicles discovered', first.rideSummary.unique_vehicles === 1 && second.rideSummary.unique_vehicles === 1);
  }

  console.log("4. Contribution count matches this user's own counted submissions only");
  {
    const d1 = world(); seedUser(d1, 'u1'); seedUser(d1, 'u2');
    seedRide(d1, { userId: 'u1', pickupTime: '08:00' }); seedRide(d1, { userId: 'u1', pickupTime: '09:00' }); seedRide(d1, { userId: 'u2' });
    const profile = await db.getUserProfile(d1, 'u1');
    check('contribution count scoped to the requesting user', profile.contributionCount === 2);
  }

  console.log('4b. Spending totals/median/average computed per currency, ignoring trips with no recorded fare');
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedRide(d1, { fare: 429, currency: 'USD', pickupTime: '08:00' });
    seedRide(d1, { fare: 762, currency: 'USD', pickupTime: '09:00' });
    seedRide(d1, { fare: null, pickupTime: '10:00' }); // no receipt fare — excluded, not treated as $0
    seedRide(d1, { fare: 500, currency: 'EUR', currencySource: 'extracted', pickupTime: '11:00' });
    const profile = await db.getUserProfile(d1, 'u1');
    check('two currencies reported, USD first (higher total)', profile.spending.length === 2 && profile.spending[0].currency === 'USD');
    const usd = profile.spending[0];
    check('USD fare_count excludes the null-fare trip', usd.fareCount === 2);
    check('USD total is the sum of only the recorded fares', usd.totalCents === 1191);
    check('USD average is correct', usd.avgCents === 1191 / 2);
    check('USD median of two values is their mean', usd.medianCents === (429 + 762) / 2);
    const eur = profile.spending[1];
    check('EUR kept separate from USD, not merged', eur.currency === 'EUR' && eur.totalCents === 500 && eur.fareCount === 1);
    check('currency provenance is reported per currency', usd.currencySource === 'assumed' && eur.currencySource === 'extracted');
  }

  console.log('4c. Median with an odd number of fares picks the true middle value');
  {
    const d1 = world(); seedUser(d1, 'u1');
    [100, 900, 500].forEach((f, i) => seedRide(d1, { fare: f, pickupTime: `0${i + 1}:00` }));
    const profile = await db.getUserProfile(d1, 'u1');
    check('median of [100,500,900] is 500, not skewed by outliers', profile.spending[0].medianCents === 500);
  }

  console.log('4d. A user with no recorded fares gets an empty spending array, not an error or a fabricated $0');
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedRide(d1, { fare: null });
    const profile = await db.getUserProfile(d1, 'u1');
    check('empty spending array', Array.isArray(profile.spending) && profile.spending.length === 0);
  }

  console.log("4e. firstVehicleModel reflects the vehicle from this rider's earliest ride, honestly null when unknown");
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedVehicle(d1, { id: 'v1', plate: 'AAA1111', model: 'Model Y' }); seedVehicle(d1, { id: 'v2', plate: 'BBB2222' });
    seedRide(d1, { vehicleId: 'v2', rideDate: '2026-06-01', pickupTime: '08:00' });   // later, unknown model
    seedRide(d1, { vehicleId: 'v1', rideDate: '2026-05-10', pickupTime: '08:00' });   // EARLIEST ride date, known model
    check("the earliest RIDE (by ride date, not arrival order) decides the model", (await db.getUserProfile(d1, 'u1')).firstVehicleModel === 'Model Y');

    const d2 = world(); seedUser(d2, 'u1'); seedVehicle(d2, { id: 'v2', plate: 'BBB2222' });
    seedRide(d2, { vehicleId: 'v2' });
    check('unknown model reported as null, never guessed', (await db.getUserProfile(d2, 'u1')).firstVehicleModel === null);

    const d3 = world(); seedUser(d3, 'u1');
    check('no rides at all -> null, not an error', (await db.getUserProfile(d3, 'u1')).firstVehicleModel === null);
  }

  console.log('5. User with no data at all gets an honest empty profile, not an error');
  {
    const d1 = world(); seedUser(d1, 'u1');
    const profile = await db.getUserProfile(d1, 'u1');
    check('trip_count is 0, not an error', profile.rideSummary.trip_count === 0);
    check('first/last ride date and distance totals are null, not fabricated', profile.rideSummary.first_ride_date === null && profile.rideSummary.last_ride_date === null && profile.rideSummary.total_distance === null);
    check('no vehicles discovered', profile.discoveredVehicles.length === 0);
    check('empty monthly activity, cities, vehicles', profile.monthlyActivity.length === 0 && profile.cities.length === 0 && profile.vehicleStats.length === 0);
  }

  console.log('6. apiGetProfile assembles the full response and reports display_name/handle honestly as null when unset');
  {
    const d1 = world(); seedUser(d1, 'u1');
    seedRide(d1, { serviceArea: 'Dallas' });
    const resp = await apiGetProfile({}, { cybercabhunter_db: d1 }, 'u1');
    const body = await resp.json();
    check('response has user block with honest null name/handle (no fabricated name)', body.user.display_name === null && body.user.handle === null);
    check('response has joined_at from users.created_at', !!body.user.joined_at);
    check('response includes every statistic block', ['rideSummary', 'cities', 'providers', 'discoveredVehicles', 'contributions', 'spending', 'monthlyActivity', 'coverage', 'vehicleStats', 'modelBreakdown', 'underReview'].every(k => k in body));
    const blob = JSON.stringify(body);
    check('the profile response carries no pickup/dropoff addresses', !/Hanover|NorthPark|pickup_description|dropoff_description/i.test(blob));
  }

  console.log('6b. apiGetProfile.discoveredVehicles stays scoped to the authenticated rider — no other rider\'s identity or ride data leaks in');
  {
    const d1 = world(); seedUser(d1, 'user-first'); seedUser(d1, 'user-second');
    seedVehicle(d1, { id: 'v1', plate: 'XJR2195', model: 'Model Y' });
    seedRide(d1, {
      userId: 'user-first', vehicleId: 'v1', createdAt: '2026-06-09 13:00:00',
      pickupDescription: '4301 Hanover St, Dallas, TX 75225', dropoffDescription: 'NorthPark Center, Dallas'
    });
    seedRide(d1, { userId: 'user-second', vehicleId: 'v1', createdAt: '2026-07-01 13:00:00', rideDate: '2026-07-01' });

    const firstResp = await apiGetProfile({}, { cybercabhunter_db: d1 }, 'user-first');
    const firstBody = await firstResp.json();
    check("the discovering rider's own response credits them with the vehicle", firstBody.discoveredVehicles.length === 1 && firstBody.discoveredVehicles[0].id === 'v1');
    check('the entry carries only whitelisted vehicle fields — no user_id, no other rider identity', Object.keys(firstBody.discoveredVehicles[0]).sort().join() === 'color,discovered_ride_date,id,license_plate,model,public_eligible,service_area,verification_status');
    // v1 is visibility='public' (seedVehicle's schema default) with a counted ride (the one just seeded) — genuinely eligible, not a guess.
    check('public_eligible is a real boolean, and true here since the vehicle is public with a counted ride', firstBody.discoveredVehicles[0].public_eligible === true);
    // The discovering ride's OWN ride_date (seedRide's default), NOT a registry/ingestion timestamp like
    // first_seen_at — this is the field this whole test section exists to guard against regressing.
    check('discovered_ride_date is the discovering RIDE\'s own date, not a registry/ingestion timestamp', firstBody.discoveredVehicles[0].discovered_ride_date === '2026-06-09');

    const secondResp = await apiGetProfile({}, { cybercabhunter_db: d1 }, 'user-second');
    const secondBody = await secondResp.json();
    check('a later rider of the same vehicle sees it in neither response as their own discovery', secondBody.discoveredVehicles.length === 0);

    const blob = JSON.stringify(firstBody) + JSON.stringify(secondBody);
    check('no pickup/dropoff address text leaks through this field either', !/Hanover|NorthPark|pickup_description|dropoff_description/i.test(blob));
    check("no user id (this rider's or the other rider's) appears in the discovery entries", !/user-first|user-second|"user_id"/i.test(JSON.stringify(firstBody.discoveredVehicles) + JSON.stringify(secondBody.discoveredVehicles)));
  }

  console.log('7. apiGetProfile returns 401 when the user does not exist (mirrors requireUserId failure upstream)');
  {
    const d1 = world();
    const resp = await apiGetProfile({}, { cybercabhunter_db: d1 }, 'ghost-user');
    check('401 when no matching user row exists', resp.status === 401);
  }

  console.log('8. apiUpdateProfile saves display_name/handle/bio/profile_visibility for the authenticated user');
  {
    const d1 = world(); seedUser(d1, 'u1');
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ display_name: 'Ada Rider', handle: 'AdaR_23', bio: 'I hunt cybercabs.', profile_visibility: 'public' }) }),
      { cybercabhunter_db: d1 }, 'u1'
    );
    const body = await resp.json();
    check('reports success with the saved fields', resp.status === 200 && body.success === true);
    check('handle is normalized to lowercase', body.user.handle === 'adar_23');
    const row = d1.query('SELECT * FROM users WHERE id = ?', 'u1')[0];
    check('the user row is actually updated', row.display_name === 'Ada Rider' && row.handle === 'adar_23' && row.bio === 'I hunt cybercabs.' && row.profile_visibility === 'public');
  }

  console.log('9. apiUpdateProfile rejects a handle already taken by a different user (real unique index)');
  {
    const d1 = world(); seedUser(d1, 'u1'); seedUser(d1, 'u2');
    d1.exec(`UPDATE users SET handle = 'taken' WHERE id = 'u2'`);
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ handle: 'taken', profile_visibility: 'private' }) }),
      { cybercabhunter_db: d1 }, 'u1'
    );
    const body = await resp.json();
    check('409 with a clean handle_taken error, not a raw D1 error', resp.status === 409 && body.error === 'handle_taken');
    check('user 1 was not modified', d1.query('SELECT handle FROM users WHERE id = ?', 'u1')[0].handle === null);
  }

  console.log('10. apiUpdateProfile rejects a malformed handle without touching the row');
  {
    const d1 = world(); seedUser(d1, 'u1');
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ handle: 'a b!', profile_visibility: 'private' }) }),
      { cybercabhunter_db: d1 }, 'u1'
    );
    const body = await resp.json();
    check('400 invalid_handle', resp.status === 400 && body.error === 'invalid_handle');
    check('row untouched', d1.query('SELECT handle FROM users WHERE id = ?', 'u1')[0].handle === null);
  }

  console.log('11. apiUpdateProfile defaults an unrecognized profile_visibility value to private, never a fabricated "public"');
  {
    const d1 = world(); seedUser(d1, 'u1');
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ profile_visibility: 'sure why not' }) }),
      { cybercabhunter_db: d1 }, 'u1'
    );
    const body = await resp.json();
    check('anything other than the literal "public" is saved as private', body.user.profile_visibility === 'private' && d1.query('SELECT profile_visibility v FROM users WHERE id = ?', 'u1')[0].v === 'private');
  }

  console.log('12. apiUpdateProfile returns 401 for a nonexistent user, matching apiGetProfile');
  {
    const d1 = world();
    const resp = await apiUpdateProfile(new Request('https://x/api/profile', { method: 'PATCH', body: '{}' }), { cybercabhunter_db: d1 }, 'ghost-user');
    check('401 when no matching user row exists', resp.status === 401);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
