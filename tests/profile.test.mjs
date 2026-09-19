// Tests for GET /api/profile (worker/profile.js + db.getUserProfile).
// A fake D1 simulates prepare/bind/first/all AND batch() against small
// in-memory users/trips/robotaxi_vehicles/submissions arrays — no live D1
// needed. Run: node tests/profile.test.mjs

import { db } from '../worker/db.js';
import { apiGetProfile, apiUpdateProfile } from '../worker/profile.js';

let pass = 0, fail = 0;
function check(label, condition) {
  if (condition) { pass++; console.log(`  ok — ${label}`); }
  else { fail++; console.log(`  FAIL — ${label}`); }
}

function fakeD1({ users = [], trips = [], vehicles = [], submissions = [] } = {}) {
  function runQuery(sql, args) {
    if (/FROM users WHERE id = \?/.test(sql)) {
      const [id] = args;
      return { results: users.filter(u => u.id === id) };
    }
    if (/COUNT\(\*\) AS trip_count/.test(sql)) {
      const [userId] = args;
      const rows = trips.filter(t => t.user_id === userId);
      if (rows.length === 0) {
        return { results: [{ trip_count: 0, first_ride_date: null, last_ride_date: null, total_distance: null, avg_distance: null, rides_with_distance: 0, longest_ride_distance: null, unique_vehicles: 0 }] };
      }
      const dates = rows.map(r => r.ride_date).filter(Boolean).sort();
      const withDistance = rows.filter(r => r.distance != null);
      return {
        results: [{
          trip_count: rows.length,
          first_ride_date: dates[0] ?? null,
          last_ride_date: dates[dates.length - 1] ?? null,
          total_distance: withDistance.reduce((s, r) => s + r.distance, 0),
          avg_distance: withDistance.length ? withDistance.reduce((s, r) => s + r.distance, 0) / withDistance.length : null,
          rides_with_distance: withDistance.length,
          longest_ride_distance: withDistance.length ? Math.max(...withDistance.map(r => r.distance)) : null,
          unique_vehicles: new Set(rows.map(r => r.robotaxi_vehicle_id).filter(Boolean)).size
        }]
      };
    }
    if (/GROUP BY service_area/.test(sql)) {
      const [userId] = args;
      const rows = trips.filter(t => t.user_id === userId && t.service_area);
      const counts = new Map();
      for (const r of rows) counts.set(r.service_area, (counts.get(r.service_area) || 0) + 1);
      return { results: [...counts.entries()].map(([service_area, ride_count]) => ({ service_area, ride_count })).sort((a, b) => b.ride_count - a.ride_count) };
    }
    if (/GROUP BY provider/.test(sql)) {
      const [userId] = args;
      const rows = trips.filter(t => t.user_id === userId);
      const counts = new Map();
      for (const r of rows) counts.set(r.provider, (counts.get(r.provider) || 0) + 1);
      return { results: [...counts.entries()].map(([provider, ride_count]) => ({ provider, ride_count })).sort((a, b) => b.ride_count - a.ride_count) };
    }
    if (/ROW_NUMBER\(\) OVER/.test(sql)) {
      const [userId] = args;
      // Rank each vehicle's trips by created_at; rn=1 is the discoverer.
      const byVehicle = new Map();
      for (const t of trips) {
        if (!t.robotaxi_vehicle_id) continue;
        if (!byVehicle.has(t.robotaxi_vehicle_id)) byVehicle.set(t.robotaxi_vehicle_id, []);
        byVehicle.get(t.robotaxi_vehicle_id).push(t);
      }
      const discovered = [];
      for (const [vehicleId, vTrips] of byVehicle) {
        const earliest = [...vTrips].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (earliest.user_id === userId) {
          const v = vehicles.find(v => v.id === vehicleId);
          if (v) discovered.push(v);
        }
      }
      return { results: discovered.sort((a, b) => (a.first_seen_at || '').localeCompare(b.first_seen_at || '')) };
    }
    if (/FROM submissions WHERE user_id = \?/.test(sql)) {
      const [userId] = args;
      return { results: [{ count: submissions.filter(s => s.user_id === userId).length }] };
    }
    if (/fare_amount_cents FROM trips/.test(sql)) {
      const [userId] = args;
      const rows = trips
        .filter(t => t.user_id === userId && t.fare_amount_cents != null)
        .map(t => ({ currency: t.currency || 'USD', fare_amount_cents: t.fare_amount_cents }))
        .sort((a, b) => a.currency.localeCompare(b.currency) || a.fare_amount_cents - b.fare_amount_cents);
      return { results: rows };
    }
    if (/LEFT JOIN robotaxi_vehicles/.test(sql)) {
      const [userId] = args;
      const rows = trips.filter(t => t.user_id === userId).sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (rows.length === 0) return { results: [] };
      const v = vehicles.find(v => v.id === rows[0].robotaxi_vehicle_id);
      return { results: [{ model: v ? v.model : null }] };
    }
    throw new Error('Unrecognized query in fakeD1: ' + sql);
  }

  function runMutation(sql, args) {
    if (/UPDATE users SET/.test(sql)) {
      const [displayName, handle, bio, profileVisibility, userId] = args;
      if (handle) {
        const conflict = users.find(u => u.handle === handle && u.id !== userId);
        if (conflict) throw new Error('D1_ERROR: UNIQUE constraint failed: users.handle');
      }
      const user = users.find(u => u.id === userId);
      if (user) Object.assign(user, { display_name: displayName, handle, bio, profile_visibility: profileVisibility });
      return { success: true };
    }
    throw new Error('Unrecognized mutation in fakeD1: ' + sql);
  }

  return {
    prepare(sql) {
      const s = { sql, args: [] };
      s.bind = (...args) => { s.args = args; return s; };
      s.first = async () => runQuery(s.sql, s.args).results[0] || null;
      s.all = async () => runQuery(s.sql, s.args);
      s.run = async () => runMutation(s.sql, s.args);
      return s;
    },
    async batch(stmts) {
      return stmts.map(s => runQuery(s.sql, s.args));
    }
  };
}

async function run() {
  console.log('1. Ride summary aggregates correctly for a user with multiple trips');
  {
    const sql = fakeD1({
      users: [{ id: 'u1', display_name: null, handle: null, created_at: '2026-01-01' }],
      trips: [
        { user_id: 'u1', provider: 'tesla', ride_date: '2026-06-09', distance: 2.8, service_area: 'Dallas', robotaxi_vehicle_id: 'v1', created_at: '2026-06-09T13:00:00Z' },
        { user_id: 'u1', provider: 'tesla', ride_date: '2026-07-01', distance: 5.0, service_area: 'Dallas', robotaxi_vehicle_id: 'v2', created_at: '2026-07-01T13:00:00Z' },
        { user_id: 'u1', provider: 'tesla', ride_date: '2026-08-01', distance: null, service_area: 'Austin', robotaxi_vehicle_id: null, created_at: '2026-08-01T13:00:00Z' }
      ]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('trip_count counts all trips, even one with no distance', profile.rideSummary.trip_count === 3);
    check('total_distance ignores the null-distance trip, not treats it as 0', profile.rideSummary.total_distance === 7.8);
    check('rides_with_distance reports coverage (2 of 3)', profile.rideSummary.rides_with_distance === 2);
    check('longest_ride_distance is correct', profile.rideSummary.longest_ride_distance === 5.0);
    check('unique_vehicles counts distinct non-null vehicle ids only', profile.rideSummary.unique_vehicles === 2);
    check('first/last ride date correct', profile.rideSummary.first_ride_date === '2026-06-09' && profile.rideSummary.last_ride_date === '2026-08-01');
  }

  console.log('2. Cities and providers grouped correctly');
  {
    const sql = fakeD1({
      trips: [
        { user_id: 'u1', provider: 'tesla', service_area: 'Dallas', ride_date: '2026-06-01', created_at: 'a' },
        { user_id: 'u1', provider: 'tesla', service_area: 'Dallas', ride_date: '2026-06-02', created_at: 'b' },
        { user_id: 'u1', provider: 'tesla', service_area: 'Austin', ride_date: '2026-06-03', created_at: 'c' }
      ]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('cities grouped with correct counts', JSON.stringify(profile.cities) === JSON.stringify([{ service_area: 'Dallas', ride_count: 2 }, { service_area: 'Austin', ride_count: 1 }]));
    check('providers currently all tesla, ready for future providers', profile.providers.length === 1 && profile.providers[0].provider === 'tesla' && profile.providers[0].ride_count === 3);
  }

  console.log('3. Vehicle discovery credits only the earliest rider, not later riders of the same vehicle');
  {
    const sql = fakeD1({
      vehicles: [{ id: 'v1', license_plate: 'XJR2195', model: null, color: null, service_area: 'Dallas', verification_status: 'unverified', first_seen_at: '2026-06-09' }],
      trips: [
        { user_id: 'user-first', robotaxi_vehicle_id: 'v1', created_at: '2026-06-09T13:00:00Z', ride_date: '2026-06-09', provider: 'tesla' },
        { user_id: 'user-second', robotaxi_vehicle_id: 'v1', created_at: '2026-07-01T13:00:00Z', ride_date: '2026-07-01', provider: 'tesla' }
      ]
    });
    const firstRiderProfile = await db.getUserProfile(sql, 'user-first');
    const secondRiderProfile = await db.getUserProfile(sql, 'user-second');
    check('the earliest rider is credited with discovering the vehicle', firstRiderProfile.discoveredVehicles.length === 1 && firstRiderProfile.discoveredVehicles[0].id === 'v1');
    check('a later rider of the same vehicle is NOT credited as its discoverer', secondRiderProfile.discoveredVehicles.length === 0);
  }

  console.log('4. Contribution count matches this user\'s own submissions only');
  {
    const sql = fakeD1({
      submissions: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('contribution count scoped to the requesting user', profile.contributionCount === 2);
  }

  console.log('4b. Spending totals/median/average computed correctly per currency, ignoring trips with no recorded fare');
  {
    const sql = fakeD1({
      trips: [
        { user_id: 'u1', currency: 'USD', fare_amount_cents: 429, created_at: 'a' },
        { user_id: 'u1', currency: 'USD', fare_amount_cents: 762, created_at: 'b' },
        { user_id: 'u1', currency: 'USD', fare_amount_cents: null, created_at: 'c' }, // no receipt fare — excluded, not treated as $0
        { user_id: 'u1', currency: 'EUR', fare_amount_cents: 500, created_at: 'd' }
      ]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('two currencies reported, USD first (higher total)', profile.spending.length === 2 && profile.spending[0].currency === 'USD');
    const usd = profile.spending[0];
    check('USD fare_count excludes the null-fare trip', usd.fareCount === 2);
    check('USD total is the sum of only the recorded fares', usd.totalCents === 1191);
    check('USD average is correct', usd.avgCents === 1191 / 2);
    check('USD median of two values is their mean', usd.medianCents === (429 + 762) / 2);
    const eur = profile.spending[1];
    check('EUR kept separate from USD, not merged', eur.currency === 'EUR' && eur.totalCents === 500 && eur.fareCount === 1);
  }

  console.log('4c. Spending median with an odd number of fares picks the true middle value, not an average');
  {
    const sql = fakeD1({
      trips: [
        { user_id: 'u1', currency: 'USD', fare_amount_cents: 100, created_at: 'a' },
        { user_id: 'u1', currency: 'USD', fare_amount_cents: 900, created_at: 'b' },
        { user_id: 'u1', currency: 'USD', fare_amount_cents: 500, created_at: 'c' }
      ]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('median of [100,500,900] is 500, not skewed by outliers', profile.spending[0].medianCents === 500);
  }

  console.log('4d. A user with no recorded fares gets an empty spending array, not an error or a fabricated $0');
  {
    const sql = fakeD1({ trips: [{ user_id: 'u1', currency: 'USD', fare_amount_cents: null, created_at: 'a' }] });
    const profile = await db.getUserProfile(sql, 'u1');
    check('empty spending array', Array.isArray(profile.spending) && profile.spending.length === 0);
  }

  console.log('4e. firstVehicleModel reflects the vehicle from this rider\'s earliest trip, honestly null when unknown');
  {
    const sql = fakeD1({
      vehicles: [{ id: 'v1', model: 'Model Y' }, { id: 'v2', model: null }],
      trips: [
        { user_id: 'u1', robotaxi_vehicle_id: 'v1', created_at: '2026-05-10T00:00:00Z' },
        { user_id: 'u1', robotaxi_vehicle_id: 'v2', created_at: '2026-06-01T00:00:00Z' }
      ]
    });
    const profile = await db.getUserProfile(sql, 'u1');
    check('first trip\'s vehicle model is reported', profile.firstVehicleModel === 'Model Y');

    const sqlNoModel = fakeD1({
      vehicles: [{ id: 'v2', model: null }],
      trips: [{ user_id: 'u1', robotaxi_vehicle_id: 'v2', created_at: 'a' }]
    });
    const profileNoModel = await db.getUserProfile(sqlNoModel, 'u1');
    check('unknown model reported as null, never guessed', profileNoModel.firstVehicleModel === null);

    const sqlNoTrips = fakeD1({});
    const profileNoTrips = await db.getUserProfile(sqlNoTrips, 'u1');
    check('no trips at all -> null, not an error', profileNoTrips.firstVehicleModel === null);
  }

  console.log('5. User with no data at all gets an honest empty profile, not an error');
  {
    const sql = fakeD1({ users: [{ id: 'u1', display_name: null, handle: null, created_at: '2026-01-01' }] });
    const profile = await db.getUserProfile(sql, 'u1');
    check('trip_count is 0, not an error', profile.rideSummary.trip_count === 0);
    check('first/last ride date are null, not fabricated', profile.rideSummary.first_ride_date === null && profile.rideSummary.last_ride_date === null);
    check('no vehicles discovered', profile.discoveredVehicles.length === 0);
  }

  console.log('6. apiGetProfile assembles the full response and reports display_name/handle honestly as null when unset');
  {
    const sql = fakeD1({
      users: [{ id: 'u1', display_name: null, handle: null, created_at: '2026-01-01' }],
      trips: [{ user_id: 'u1', provider: 'tesla', ride_date: '2026-06-09', distance: 2.8, service_area: 'Dallas', robotaxi_vehicle_id: null, created_at: '2026-06-09T13:00:00Z' }]
    });
    const resp = await apiGetProfile({}, { cybercabhunter_db: sql }, 'u1');
    const body = await resp.json();
    check('response has user block with honest null name/handle (no fabricated name)', body.user.display_name === null && body.user.handle === null);
    check('response has joined_at from users.created_at', body.user.joined_at === '2026-01-01');
    check('response includes rideSummary/cities/providers/discoveredVehicles/contributions', 'rideSummary' in body && 'cities' in body && 'providers' in body && 'discoveredVehicles' in body && 'contributions' in body);
  }

  console.log('7. apiGetProfile returns 401 when the user does not exist (mirrors requireUserId failure upstream)');
  {
    const sql = fakeD1({ users: [] });
    const resp = await apiGetProfile({}, { cybercabhunter_db: sql }, 'ghost-user');
    check('401 when no matching user row exists', resp.status === 401);
  }

  console.log('8. apiUpdateProfile saves display_name/handle/bio/profile_visibility for the authenticated user');
  {
    const users = [{ id: 'u1', display_name: null, handle: null, bio: null, profile_visibility: 'private', created_at: '2026-01-01' }];
    const sql = fakeD1({ users });
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ display_name: 'Ada Rider', handle: 'AdaR_23', bio: 'I hunt cybercabs.', profile_visibility: 'public' }) }),
      { cybercabhunter_db: sql }, 'u1'
    );
    const body = await resp.json();
    check('reports success with the saved fields', resp.status === 200 && body.success === true);
    check('handle is normalized to lowercase', body.user.handle === 'adar_23');
    check('the user row is actually updated', users[0].display_name === 'Ada Rider' && users[0].handle === 'adar_23' && users[0].bio === 'I hunt cybercabs.' && users[0].profile_visibility === 'public');
  }

  console.log('9. apiUpdateProfile rejects a handle already taken by a different user');
  {
    const users = [
      { id: 'u1', display_name: null, handle: null, bio: null, profile_visibility: 'private', created_at: '2026-01-01' },
      { id: 'u2', display_name: null, handle: 'taken', bio: null, profile_visibility: 'private', created_at: '2026-01-01' }
    ];
    const sql = fakeD1({ users });
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ handle: 'taken', profile_visibility: 'private' }) }),
      { cybercabhunter_db: sql }, 'u1'
    );
    const body = await resp.json();
    check('409 with a clean handle_taken error, not a raw D1 error', resp.status === 409 && body.error === 'handle_taken');
    check('user 1 was not modified', users[0].handle === null);
  }

  console.log('10. apiUpdateProfile rejects a malformed handle without touching the row');
  {
    const users = [{ id: 'u1', display_name: null, handle: null, bio: null, profile_visibility: 'private', created_at: '2026-01-01' }];
    const sql = fakeD1({ users });
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ handle: 'a b!', profile_visibility: 'private' }) }),
      { cybercabhunter_db: sql }, 'u1'
    );
    const body = await resp.json();
    check('400 invalid_handle', resp.status === 400 && body.error === 'invalid_handle');
    check('row untouched', users[0].handle === null);
  }

  console.log('11. apiUpdateProfile defaults an unrecognized profile_visibility value to private, never a fabricated "public"');
  {
    const users = [{ id: 'u1', display_name: null, handle: null, bio: null, profile_visibility: 'private', created_at: '2026-01-01' }];
    const sql = fakeD1({ users });
    const resp = await apiUpdateProfile(
      new Request('https://x/api/profile', { method: 'PATCH', body: JSON.stringify({ profile_visibility: 'sure why not' }) }),
      { cybercabhunter_db: sql }, 'u1'
    );
    const body = await resp.json();
    check('anything other than the literal "public" is saved as private', body.user.profile_visibility === 'private' && users[0].profile_visibility === 'private');
  }

  console.log('12. apiUpdateProfile returns 401 for a nonexistent user, matching apiGetProfile');
  {
    const sql = fakeD1({ users: [] });
    const resp = await apiUpdateProfile(new Request('https://x/api/profile', { method: 'PATCH', body: '{}' }), { cybercabhunter_db: sql }, 'ghost-user');
    check('401 when no matching user row exists', resp.status === 401);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
