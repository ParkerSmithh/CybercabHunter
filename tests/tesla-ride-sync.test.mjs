// Tesla Ride Sync end to end (worker/tesla-rides.js) on the real-SQL D1 test
// database: the ownerapi connect flow (authorize URL, pasted callback, token
// exchange, encrypted storage), the preview, importing the rider's ticked
// rides, dedupe (same source and across sources), private-only vehicles with a
// reported VIN, and auto-sync. Tesla is a mocked fetch.
// Run: node tests/tesla-ride-sync.test.mjs

import { teslaRides } from '../worker/tesla-rides.js';
import worker from '../worker/index.js';
import { tokenCrypto } from '../worker/crypto.js';
import { db } from '../worker/db.js';
import { makeEnv, makeCheck, seedRide, seedVehicle, approveVehicle } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;

const KEY = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
})();

async function setup(users = ['u1']) {
  const ctx = await makeEnv({ users });
  ctx.env.TESLA_TOKEN_ENCRYPTION_KEY = KEY;
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:sess-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}
const req = (path, user, opts = {}) => new Request(`https://x${path}`, {
  ...opts,
  headers: { ...(user ? { Authorization: `Bearer sess-${user}` } : {}), 'Content-Type': 'application/json', ...(opts.headers || {}) }
});
const post = (path, user, body) => req(path, user, { method: 'POST', body: JSON.stringify(body) });

// A Tesla ride as the ride-history endpoint returns it.
function ride(id, startIso, o = {}) {
  const end = new Date(Date.parse(startIso) + 15 * 60000).toISOString();
  return {
    rideId: id, rideStartedAt: startIso, rideCompletedAt: end,
    pickupLocationName: o.from || '1100 S Congress Ave, Austin, TX 78704',
    pickupLocationLatitude: 30.2533, pickupLocationLongitude: -97.7489, pickupLocationTimezone: 'America/Chicago',
    dropoffLocationName: o.to || 'Domain Northside, Austin, TX 78758',
    dropoffLocationLatitude: 30.4027, dropoffLocationLongitude: -97.7253, dropoffLocationTimezone: 'America/Chicago',
    totalDistanceMiles: o.miles === undefined ? 6.2 : o.miles, totalDurationSeconds: 900,
    totalDue: o.fare === undefined ? 11.88 : o.fare, currencyCode: 'USD',
    licensePlate: o.plate === undefined ? 'XVF251' : o.plate, vin: o.vin === undefined ? '7SAYGDEE5TF000123' : o.vin,
    vehicleModel: 'Cybercab', isValid: true, billingUserId: 'billing-secret'
  };
}

// Mock Tesla: the token endpoint and the ride-history endpoint.
function mockTesla(state) {
  state.tokenCalls = []; state.historyCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.href === 'https://auth.tesla.com/oauth2/v3/token') {
      const body = new URLSearchParams(opts.body);
      state.tokenCalls.push(body);
      if (state.tokenStatus && state.tokenStatus !== 200) return new Response('{}', { status: state.tokenStatus });
      const n = state.tokenCalls.length;
      return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 28800 });
    }
    if (u.pathname === '/mobile-app/ride/history') {
      const auth = (opts.headers || {}).Authorization;
      state.historyCalls.push({ host: u.origin, auth });
      if (state.rejectToken && auth === `Bearer ${state.rejectToken}`) return new Response('', { status: 401 });
      return Response.json({ code: 200, data: { rides: state.rides } });
    }
    throw new Error(`unexpected fetch ${u.href}`);
  };
}

// Connect user `u` through the real routes (worker/index.js): start, then paste.
async function connect(env, u, state) {
  const start = await worker.fetch(req('/api/tesla/rides/connect', u), env, {});
  const { authorize_url } = await start.json();
  const st = new URL(authorize_url).searchParams.get('state');
  const resp = await worker.fetch(post('/api/tesla/rides/callback', u, { callback_url: `tesla://auth/callback?code=CODE-${u}&state=${st}&issuer=https%3A%2F%2Fauth.tesla.com%2Foauth2%2Fv3` }), env, {});
  return { resp, body: await resp.json(), authorizeUrl: new URL(authorize_url), state: st };
}

const trips = (d1, u = 'u1') => d1.prepare(`SELECT t.*, s.status AS sub_status, s.evidence_type FROM trips t JOIN submissions s ON s.id = t.submission_id WHERE t.user_id = ? ORDER BY t.ride_date, t.pickup_time`).bind(u).all().then(r => r.results);
const vehicleByPlate = (d1, plate) => d1.prepare(`SELECT * FROM robotaxi_vehicles WHERE license_plate = ?`).bind(plate).first();

const realFetch = globalThis.fetch;
const authorizeUrlHasVoid = u => u.href.includes('void%2Fcallback') || u.href.includes('void/callback');

async function run() {
  const tesla = { rides: [] };
  mockTesla(tesla);

  console.log('1. Connect: the ownerapi authorize URL');
  {
    const { env } = await setup();
    const r = await worker.fetch(req('/api/tesla/rides/connect', 'u1'), env, {});
    const body = await r.json();
    const u = new URL(body.authorize_url);
    check('auth.tesla.com authorize endpoint', u.origin === 'https://auth.tesla.com' && u.pathname === '/oauth2/v3/authorize');
    check('client_id "ownerapi" (never the Fleet client)', u.searchParams.get('client_id') === 'ownerapi');
    check('redirect tesla://auth/callback (Tesla retired the old void/callback for ownerapi)', u.searchParams.get('redirect_uri') === 'tesla://auth/callback' && !authorizeUrlHasVoid(u));
    check('scopes "openid email offline_access phone"', u.searchParams.get('scope') === 'openid email offline_access phone');
    check('PKCE S256 with a challenge, a state, and NO audience', u.searchParams.get('code_challenge_method') === 'S256' && !!u.searchParams.get('code_challenge') && !!u.searchParams.get('state') && !u.searchParams.has('audience'));
    check('the page is told the callback is pasted', body.callback === 'paste');
    check('no Fleet secrets needed: works with none configured', r.status === 200 && !env.TESLA_RIDES_CLIENT_ID);
    const anon = await worker.fetch(req('/api/tesla/rides/connect', null), env, {});
    check('signed out -> 401', anon.status === 401);
  }

  console.log('2. The pasted callback');
  {
    const { env, d1 } = await setup(['u1', 'u2']);
    tesla.rides = [ride('r-old', '2026-09-01T15:00:00Z'), ride('r-new', '2026-09-20T19:30:00Z', { plate: 'NEW777', vin: '7SAYGDEE5TF000999', fare: 22.5 })];
    const start = await worker.fetch(req('/api/tesla/rides/connect', 'u1'), env, {});
    const st = new URL((await start.json()).authorize_url).searchParams.get('state');

    for (const [label, url, code] of [
      ['a non-Tesla URL is refused', `https://evil.example/void/callback?code=c&state=${st}`, 'invalid_callback_url'],
      ['another app scheme is refused', `evil://auth/callback?code=c&state=${st}`, 'invalid_callback_url'],
      ['a tesla:// address that is not the auth callback is refused', `tesla://other/callback?code=c&state=${st}`, 'invalid_callback_url'],
      ['plain text is refused', 'not a url', 'invalid_callback_url'],
      ['Tesla\'s error redirect = cancelled', `tesla://auth/callback?error=access_denied&state=${st}`, 'cancelled'],
      ['no code = refused', `tesla://auth/callback?state=${st}`, 'missing_code_or_state']
    ]) {
      const r = await worker.fetch(post('/api/tesla/rides/callback', 'u1', { callback_url: url }), env, {});
      check(label, r.status === 400 && (await r.json()).error === code);
    }
    check('...and none of those called Tesla', tesla.tokenCalls.length === 0);

    const wrongUser = await worker.fetch(post('/api/tesla/rides/callback', 'u2', { callback_url: `tesla://auth/callback?code=c&state=${st}` }), env, {});
    check('a state issued to another user -> 403, no token exchange', wrongUser.status === 403 && tesla.tokenCalls.length === 0);
    const reuse = await worker.fetch(post('/api/tesla/rides/callback', 'u1', { callback_url: `location: tesla://auth/callback?code=c&state=${st}` }), env, {});
    check('...and that state is spent (single-use; a pasted "location:" header line is understood)', reuse.status === 400 && (await reuse.json()).error === 'invalid_or_expired_state');

    const consoleLine = await worker.fetch(req('/api/tesla/rides/connect', 'u1'), env, {}).then(r => r.json()).then(b => new URL(b.authorize_url).searchParams.get('state'));
    const cl = await worker.fetch(post('/api/tesla/rides/callback', 'u2', { callback_url: `Failed to launch 'tesla://auth/callback?code=c&state=${consoleLine}' because the scheme does not have a registered handler.` }), env, {});
    check('a whole Chrome Console "Failed to launch" message is understood (its state is read: another user -> 403)', cl.status === 403);
    const { resp, body } = await connect(env, 'u1', tesla);
    const tokenReq = tesla.tokenCalls[0];
    check('success: connected', resp.status === 200 && body.success === true && body.connected === true);
    check('code exchanged at auth.tesla.com with client ownerapi, the PKCE verifier and the tesla:// redirect', tokenReq.get('grant_type') === 'authorization_code' && tokenReq.get('client_id') === 'ownerapi' && tokenReq.get('code') === 'CODE-u1' && !!tokenReq.get('code_verifier') && tokenReq.get('redirect_uri') === 'tesla://auth/callback');
    check('no client_secret and no audience sent', !tokenReq.has('client_secret') && !tokenReq.has('audience'));
    check('the ride history was fetched right away with the new token', tesla.historyCalls.at(-1).auth === 'Bearer access-1');
    check('the response IS the preview: both rides, newest first', body.rides.length === 2 && body.rides[0].ride_id === 'r-new' && body.rides[1].ride_id === 'r-old');
    const p = body.rides[0];
    check('preview row: date, route, miles, fare, plate', p.date === '2026-09-20' && p.pickup_time === '14:30' && p.from && p.to && p.miles === 6.2 && p.fare_cents === 2250 && p.plate === 'NEW777' && p.importable === true && p.already_imported === false);
    check('the preview shows no VIN, coordinates or billing data', !/vin|7SAYG|latitude|30\.25|billing/i.test(JSON.stringify(body)));
    check('NOTHING imported yet', (await trips(d1)).length === 0);

    const blob = JSON.parse(await env.TESLA_SESSIONS.get('tesla_rides_tokens:u1'));
    check('tokens stored encrypted in the KV blob', blob.encryptedAccessToken !== 'access-1' && await tokenCrypto.decrypt(blob.encryptedAccessToken, KEY) === 'access-1' && await tokenCrypto.decrypt(blob.encryptedRefreshToken, KEY) === 'refresh-1');
    const row = await d1.prepare('SELECT * FROM tesla_ride_sync_connections WHERE user_id = ?').bind('u1').first();
    check('D1 holds a pointer only, no token material', row.status === 'active' && !JSON.stringify(row).includes('access-1') && !JSON.stringify(row).includes('refresh-1'));
    check('auto-sync is OFF until the rider confirms an import', row.auto_sync_after === null);
    check('no response so far carried a token', !JSON.stringify(body).includes('access-1') && !JSON.stringify(body).includes('refresh-1'));
  }

  console.log('3. Import: only the ticked rides; private vehicles; reported VIN');
  {
    const { env, d1 } = await setup();
    // An already-PUBLIC, approved vehicle for one plate, with a moderator VIN.
    seedVehicle(d1, { id: 'veh-pub', plate: 'PUB123' });
    approveVehicle(d1, 'veh-pub');
    d1.prepare(`UPDATE robotaxi_vehicles SET vin = 'MODERATOR-VIN', verification_status = 'verified' WHERE id = 'veh-pub'`).bind()._exec();
    const before = await d1.prepare(`SELECT visibility, vin, verification_status FROM robotaxi_vehicles WHERE id = 'veh-pub'`).bind().first();

    tesla.rides = [
      ride('r1', '2026-09-01T15:00:00Z', { plate: 'NEW111', vin: 'VIN-NEW111' }),
      ride('r2', '2026-09-03T15:00:00Z', { plate: 'PUB123', vin: 'VIN-FROM-TESLA' }),
      ride('r3', '2026-09-05T15:00:00Z', { plate: 'SKIP99' }),
      ride('r4', '2026-09-06T15:00:00Z', { plate: 'NOTSHOWN', miles: null, fare: null })
    ];
    await connect(env, 'u1', tesla);
    const r = await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: ['r1', 'r2', 'r4', 'not-a-real-id'] }), env, {});
    const body = await r.json();
    check('import succeeds: 3 added (the unknown id is ignored)', r.status === 200 && body.success === true && body.added === 3);
    const rows = await trips(d1);
    check('exactly the ticked rides are stored (r3 left unticked is not)', rows.map(x => x.external_ride_id).sort().join(',') === 'r1,r2,r4');
    check('stored with source "tesla-api" and evidence "tesla_api", counted', rows.every(x => x.source === 'tesla-api' && x.evidence_type === 'tesla_api' && x.sub_status === 'pending'));
    const r1 = rows.find(x => x.external_ride_id === 'r1');
    check('local date/time, fare in cents, miles, minutes', r1.ride_date === '2026-09-01' && r1.pickup_time === '10:00' && r1.fare_amount_cents === 1188 && r1.distance === 6.2 && r1.duration_minutes === 15 && r1.currency_source === 'extracted');
    const r4 = rows.find(x => x.external_ride_id === 'r4');
    check('a ride with no distance or fare stores NULL, never 0', r4.distance === null && r4.fare_amount_cents === null && r4.currency === null);

    const newVeh = await vehicleByPlate(d1, 'NEW111');
    check('an unknown plate becomes a PRIVATE registry vehicle', newVeh && newVeh.visibility === 'private');
    check('the API VIN is kept as reported_vin — NOT as the moderator vin', newVeh.reported_vin === 'VIN-NEW111' && newVeh.reported_vin_source === 'tesla-api' && newVeh.vin === null);
    // A control vehicle made by the same private-only path, outside the sync.
    await db.findOrCreateRobotaxiVehicleByPlateDetailed(d1, 'CONTROL1');
    const control = await vehicleByPlate(d1, 'CONTROL1');
    check('...and its visibility/verification are exactly what the private-only path gives any new plate', newVeh.visibility === control.visibility && newVeh.verification_status === control.verification_status);
    check('the import reports the private vehicles it created (2 new plates; PUB123 existed)', body.private_vehicles_created === 2);

    const after = await d1.prepare(`SELECT visibility, vin, verification_status, reported_vin FROM robotaxi_vehicles WHERE id = 'veh-pub'`).bind().first();
    check('an existing public vehicle: visibility, vin and verification unchanged', after.visibility === before.visibility && after.vin === 'MODERATOR-VIN' && after.verification_status === before.verification_status);
    check('...the ride attaches to it, and the Tesla VIN is only a reported_vin', rows.find(x => x.external_ride_id === 'r2').robotaxi_vehicle_id === 'veh-pub' && after.reported_vin === 'VIN-FROM-TESLA');

    const conn = await d1.prepare('SELECT * FROM tesla_ride_sync_connections WHERE user_id = ?').bind('u1').first();
    check('confirming the import turns auto-sync on, after the newest ride shown', conn.auto_sync_after === '2026-09-06T15:00:00.000Z');

    const again = await (await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: ['r1', 'r2', 'r4'] }), env, {})).json();
    check('importing the same rides again: duplicates, nothing new', again.added === 0 && again.duplicates === 3 && (await trips(d1)).length === 3);

    const prev = await (await worker.fetch(req('/api/tesla/rides/preview', 'u1'), env, {})).json();
    check('the preview now marks them already imported (r3 not)', prev.rides.filter(x => x.already_imported).map(x => x.ride_id).sort().join(',') === 'r1,r2,r4' && !prev.rides.find(x => x.ride_id === 'r3').already_imported);

    const bad = await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: 'r1' }), env, {});
    check('a malformed import request -> 400', bad.status === 400);
    const vinAgain = await vehicleByPlate(d1, 'NEW111');
    check('a reported VIN is never overwritten', vinAgain.reported_vin === 'VIN-NEW111');
  }

  console.log('4. Across sources: a receipt and Tesla Ride Sync never double-count');
  {
    const { env, d1 } = await setup();
    // A forwarded receipt of the same ride: same date, plate and fare, its
    // pickup time 2 minutes off Tesla's start.
    seedRide(d1, { id: 'receipt-trip', rideDate: '2026-09-10', pickupTime: '10:02', fare: 1188, rideKey: 'v1|2026-09-10|10:02|XVF251', distance: null, source: 'receipt_email' });
    // A different ride the same day, same car, same fare, but hours apart.
    seedRide(d1, { id: 'other-trip', rideDate: '2026-09-10', pickupTime: '18:40', fare: 1188, rideKey: 'v1|2026-09-10|18:40|XVF251', source: 'receipt_email' });
    tesla.rides = [ride('rx', '2026-09-10T15:00:00Z', { plate: 'XVF251', fare: 11.88, miles: 6.2 })];
    const { body } = await connect(env, 'u1', tesla);
    check('the preview already knows this ride (from the receipt)', body.rides[0].already_imported === true);
    const imp = await (await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: ['rx'] }), env, {})).json();
    const rows = await trips(d1);
    check('no new ride: the receipt\'s ride is reused', imp.added === 0 && rows.length === 2);
    const merged = rows.find(x => x.id === 'receipt-trip');
    check('the stored receipt ride only gains what it lacked (distance), keeps its own values', merged.distance === 6.2 && merged.fare_amount_cents === 1188 && merged.pickup_time === '10:02');
    check('the ride hours later the same day is untouched', rows.find(x => x.id === 'other-trip').distance === 2.8);
  }

  console.log('5. Auto-sync: only new rides, quiet otherwise, refresh on 401');
  {
    const { env, d1 } = await setup();
    mockTesla(tesla);   // fresh token numbering: this rider's first token is access-1
    tesla.rides = [ride('a1', '2026-09-01T15:00:00Z'), ride('a2', '2026-09-02T15:00:00Z', { plate: 'LEFTOUT' })];
    await connect(env, 'u1', tesla);
    check('before any confirmed import, the scheduled sync skips the rider', (await teslaRides.syncUser(env, 'u1')).skipped === 'not_consented');
    await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: ['a1'] }), env, {});
    check('one ride imported by the rider', (await trips(d1)).length === 1);

    const quiet = await teslaRides.syncUser(env, 'u1');
    const conn = await d1.prepare('SELECT * FROM tesla_ride_sync_connections WHERE user_id = ?').bind('u1').first();
    check('nothing new -> imports nothing and records "no_new_rides"', quiet.imported === 0 && conn.last_sync_result === 'no_new_rides' && (await trips(d1)).length === 1);
    check('...the ride the rider left unticked is NOT imported behind their back', !(await trips(d1)).some(x => x.external_ride_id === 'a2'));

    tesla.rides.push(ride('a3', '2026-09-25T20:00:00Z', { plate: 'FRESH1' }));
    // The stored access token is rejected: the sync refreshes once and retries.
    tesla.rejectToken = 'access-1';
    const callsBefore = tesla.tokenCalls.length;
    const res = await teslaRides.syncUser(env, 'u1');
    tesla.rejectToken = null;
    check('401 -> refresh_token grant to auth.tesla.com, then a retry that works', tesla.tokenCalls.length === callsBefore + 1 && tesla.tokenCalls.at(-1).get('grant_type') === 'refresh_token' && tesla.tokenCalls.at(-1).get('client_id') === 'ownerapi' && tesla.historyCalls.at(-1).auth === 'Bearer access-2');
    check('the new ride is imported, and only it', res.imported === 1 && (await trips(d1)).map(x => x.external_ride_id).sort().join(',') === 'a1,a3');
    const blob = JSON.parse(await env.TESLA_SESSIONS.get('tesla_rides_tokens:u1'));
    check('the rotated refresh token was stored (encrypted)', await tokenCrypto.decrypt(blob.encryptedRefreshToken, KEY) === 'refresh-2');
    check('a private vehicle for the new plate', (await vehicleByPlate(d1, 'FRESH1')).visibility === 'private');

    // runScheduledSync picks only riders not synced recently.
    const sched = await teslaRides.runScheduledSync(env);
    check('the cron skips a rider synced moments ago', sched.due === 0);
    d1.prepare(`UPDATE tesla_ride_sync_connections SET last_sync_at = datetime('now', '-7 hours')`).bind()._exec();
    const sched2 = await teslaRides.runScheduledSync(env);
    check('...and picks them up once they are due', sched2.due === 1 && sched2.synced === 1);

    tesla.tokenStatus = 400;   // the refresh token is dead too
    tesla.rejectToken = 'access-2';
    const dead = await teslaRides.syncUser(env, 'u1');
    tesla.tokenStatus = 200; tesla.rejectToken = null;
    const after = await d1.prepare('SELECT status, last_error FROM tesla_ride_sync_connections WHERE user_id = ?').bind('u1').first();
    check('a dead refresh token -> reconnect required, connection marked error', dead.skipped === 'reconnect_required' && after.status === 'error' && after.last_error === 'refresh_failed');
  }

  console.log('6. Status and disconnect');
  {
    const { env } = await setup();
    tesla.rides = [ride('s1', '2026-09-01T15:00:00Z')];
    await connect(env, 'u1', tesla);
    const s = await (await worker.fetch(req('/api/tesla/rides/status', 'u1'), env, {})).json();
    check('status: configured and connected, auto-sync off, no token data', s.configured === true && s.connected === true && s.auto_sync === false && !/access-|refresh-|tesla_rides_tokens/.test(JSON.stringify(s)));
    await worker.fetch(post('/api/tesla/rides/disconnect', 'u1', {}), env, {});
    check('disconnect deletes the KV token blob', await env.TESLA_SESSIONS.get('tesla_rides_tokens:u1') === null);
    const prev = await worker.fetch(req('/api/tesla/rides/preview', 'u1'), env, {});
    check('after disconnect the preview says not connected', prev.status === 409 && (await prev.json()).preview_error === 'not_connected');
  }

  console.log('7. Tesla unavailable');
  {
    const { env, d1 } = await setup();
    tesla.rides = [];
    await connect(env, 'u1', tesla);
    globalThis.fetch = async () => new Response('', { status: 503 });
    const r = await worker.fetch(post('/api/tesla/rides/import', 'u1', { ride_ids: ['x'] }), env, {});
    check('both hosts down -> 502 tesla_unavailable, nothing stored', r.status === 502 && (await r.json()).error === 'tesla_unavailable' && (await trips(d1)).length === 0);
    mockTesla(tesla);
  }

  globalThis.fetch = realFetch;
  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
