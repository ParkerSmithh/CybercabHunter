// Community page: the discovered-vehicles leaderboard and public rider profiles
// (worker/community.js, public/community.html + js/community.js, public/rider.html
// + js/rider.js, the opt-in on the profile page).
//   - discovery = earliest of the first counted ride / the approved human sighting
//     that created the vehicle; the Muse system account never earns credit
//   - only publicly eligible vehicles count; credit moves or drops live
//   - rank order, shared ranks on ties (1, 1, 3), the top-6 cut
//   - privacy: only opted-in riders are identified; never an email or internal id
// Real SQL (every migration) + the REAL Worker router; pages run in jsdom.
// Run: node tests/community.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const SYS = 'muse-system';
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EMAIL = n => `rider-${n}@example.com`;

async function makeApp(users = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina']) {
  const ctx = await makeEnv({ users: [...users, SYS, 'mod'] });
  ctx.env.MUSE_CONNECTOR_USER_ID = SYS;
  ctx.env.ASSETS = { fetch: async req => new Response(`asset:${new URL(req.url).pathname}`) };
  for (const u of [...users, 'mod']) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
    ctx.d1.prepare(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES (?, ?, ?, ?)`).bind(`g-${u}`, u, `sub-${u}`, EMAIL(u))._exec();
  }
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  return ctx;
}
// Opt a rider in (name, handle, photo) — the only way anyone is identified.
const optIn = (ctx, id, { name = id[0].toUpperCase() + id.slice(1), handle = id, avatar = `https://lh3.googleusercontent.com/a/${id}` } = {}) =>
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = ?, handle = ?, avatar_url = ? WHERE id = ?`).bind(name, handle, avatar, id)._exec();

let vn = 0;
// A registry vehicle. 'receipt' vehicles are backed by their counted rides;
// 'sighting' ones by a VIN. Public unless said otherwise.
function vehicle(ctx, { origin = 'receipt', visibility = 'public', plate } = {}) {
  vn += 1;
  const id = uuid(vn);
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin, vin, model, color, service_area) VALUES (?, ?, ?, ?, ?, 'Cybercab', 'Gold', 'Austin')`)
    .bind(id, plate || `PLT${vn}`, visibility, origin, origin === 'sighting' ? `VIN${vn}` : null)._exec();
  return id;
}
let rn = 0;
function ride(ctx, userId, vehicleId, minute, status = 'approved') {
  rn += 1;
  return seedRide(ctx.d1, { id: `ride-${rn}`, userId, vehicleId, status, rideKey: `rk-${rn}`, createdAt: `2026-09-01 10:${String(minute).padStart(2, '0')}:00` });
}
let sn = 0;
// A sighting linked to a vehicle, submitted at `minute`.
function sighting(ctx, userId, vehicleId, minute, status = 'approved') {
  sn += 1;
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at) VALUES (?, ?, 'vehicle_sighting', ?, 'photo', ?, ?)`)
    .bind(`sig-${sn}`, userId, status, `evidence/${userId}/${sn}.jpg`, `2026-09-01 10:${String(minute).padStart(2, '0')}:00`)._exec();
  ctx.d1.prepare(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, service_area, verification_status) VALUES (?, ?, ?, ?, 'Austin', 'verified')`)
    .bind(`obs-${sn}`, vehicleId, userId, `sig-${sn}`)._exec();
  return `sig-${sn}`;
}
const get = async (ctx, path, session) => {
  const r = await worker.fetch(new Request(`https://x${path}`, { headers: session ? { Authorization: `Bearer ${session}` } : {} }), ctx.env, {});
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
  return { status: r.status, json, raw };
};
const board = async (ctx, id = 'discovered') => (await get(ctx, `/api/community/leaderboard?board=${id}`)).json;
const counts = b => b.entries.map(e => `${e.rank}:${e.count}`).join(' ');

async function run() {
  console.log('1. Discovery credit');
  {
    const ctx = await makeApp();
    ['alice', 'bob'].forEach(u => optIn(ctx, u));
    const v1 = vehicle(ctx); ride(ctx, 'bob', v1, 5); ride(ctx, 'alice', v1, 1);         // alice rode first
    const v2 = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, 'bob', v2, 2); ride(ctx, 'alice', v2, 3);   // bob's sighting created it, before alice's ride
    const v3 = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, 'bob', v3, 9); ride(ctx, 'alice', v3, 4);   // alice's ride beat bob's sighting
    const b = await board(ctx);
    const by = n => b.entries.find(e => e.name === n);
    check('first counted ride wins over later rides', by('Alice') && by('Bob'));
    check('the earliest of ride / creating sighting wins: Alice 2 (v1, v3), Bob 1 (v2)', by('Alice').count === 2 && by('Bob').count === 1, counts(b));
  }
  {
    const ctx = await makeApp();
    optIn(ctx, 'carol'); optIn(ctx, 'dave');
    const v = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, 'carol', v, 1, 'pending');
    check('a pending creating sighting earns nothing', (await board(ctx)).entries.length === 0);
    const w = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, 'carol', w, 1); sighting(ctx, 'dave', w, 2);
    const b = await board(ctx);
    check('only the sighting that CREATED the vehicle (its first) earns credit, not later ones', b.entries.length === 1 && b.entries[0].name === 'Carol' && b.entries[0].count === 1);
    const pendingRide = vehicle(ctx); ride(ctx, 'carol', pendingRide, 1, 'pending');
    check('a pending ride counts (the existing counted-ride rule)', (await board(ctx)).entries[0].count === 2);
    const rejected = vehicle(ctx); ride(ctx, 'dave', rejected, 1, 'approved'); ride(ctx, 'dave', rejected, 2, 'rejected');
    check('...a rejected one does not', (await board(ctx)).entries.find(e => e.name === 'Dave').count === 1);
  }

  console.log('2. The system account never earns credit');
  {
    const ctx = await makeApp();
    optIn(ctx, 'alice');
    const created = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, SYS, created, 1); sighting(ctx, 'alice', created, 2);
    const rodeFirst = vehicle(ctx); ride(ctx, SYS, rodeFirst, 1); ride(ctx, 'alice', rodeFirst, 5);
    const sysOnly = vehicle(ctx); ride(ctx, SYS, sysOnly, 1);
    const b = await board(ctx);
    check('a vehicle the system account created has no sighting credit (a later human sighting did not create it)', b.entries.length === 1);
    check('its rides are skipped: the next human rider gets the credit', b.entries[0].name === 'Alice' && b.entries[0].count === 1, counts(b));
    check('the system account never appears', !b.entries.some(e => e.count === 3 || e.count === 2));
  }

  console.log('3. Private vehicles never count');
  {
    const ctx = await makeApp();
    optIn(ctx, 'alice');
    ride(ctx, 'alice', vehicle(ctx, { visibility: 'private' }), 1);
    const hidden = vehicle(ctx, { origin: 'sighting', visibility: 'private' }); sighting(ctx, 'alice', hidden, 1);
    const noVin = vehicle(ctx, { origin: 'sighting' }); ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = NULL WHERE id = '${noVin}'`); sighting(ctx, 'alice', noVin, 1);
    check('private (and not publicly eligible) vehicles earn no credit', (await board(ctx)).entries.length === 0);
    const pub = vehicle(ctx); ride(ctx, 'alice', pub, 2);
    let b = await board(ctx);
    check('a public one does', b.entries.length === 1 && b.entries[0].count === 1);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${pub}'`);
    check('making it private drops the credit on the next read', (await board(ctx)).entries.length === 0);
    const rider = await get(ctx, '/api/riders/alice');
    check('the public profile lists no private vehicles', rider.json.discovered.count === 0 && !/PLT/.test(rider.raw));
  }

  console.log('4. Ranking: order, shared ranks, the top-10 cut');
  {
    const ctx = await makeApp();
    const plan = { alice: 5, bob: 3, carol: 3, dave: 2, erin: 1, frank: 1, gina: 1 };
    let m = 0;
    for (const [u, n] of Object.entries(plan)) { optIn(ctx, u); for (let i = 0; i < n; i++) ride(ctx, u, vehicle(ctx), ++m); }
    const b = await board(ctx);
    check('count descending, ties share a rank (1, 2, 2, 4, 5, 5, 5)', counts(b) === '1:5 2:3 2:3 4:2 5:1 5:1 5:1', counts(b));
    check('totals count EVERY credited spotter and vehicle (7 spotters, 16 vehicles)', b.totals && b.totals.spotters === 7 && b.totals.vehicles === 16);
    check('no "How discovery works" panel on the page', !/HOW DISCOVERY WORKS/i.test(fs.readFileSync(new URL('../public/community.html', import.meta.url), 'utf8')));
    check('within a tie, whoever reached the count first is listed first (Bob before Carol; Erin, Frank, Gina)',
      b.entries[1].name === 'Bob' && b.entries[2].name === 'Carol' && b.entries.slice(4).map(e => e.name).join() === 'Erin,Frank,Gina');
    check('the response names its board and lists the five boards, Top Overall first',
      b.board === 'discovered' && b.label === 'Most Vehicles Discovered' && b.boards.map(x => x.id).join() === 'overall,discovered,miles,rides,vehicles' && b.boards[0].label === 'Top Overall');
    check('no board asked for: Top Overall', (await board(ctx, '')).board === 'overall');
    check('an unknown board: 400', (await get(ctx, '/api/community/leaderboard?board=nope')).status === 400);
    const r = await worker.fetch(new Request('https://x/api/community/leaderboard'), ctx.env, {});
    check('edge-cacheable for 5 minutes', /public, max-age=300/.test(r.headers.get('Cache-Control')));
    const many = Array.from({ length: 12 }, (_, i) => ({ uid: `u${String(i).padStart(2, '0')}`, handle: `u${i}`, discovered: 12 - i, rides: 0, miles: 0, unique_vehicles: 0, cities: 0, reached_at: '2026' }));
    const { rankBoard } = await import('../worker/community.js');
    check('only the top 10 are returned', rankBoard(many, { value: x => x.discovered, include: () => true, tie: () => 0 }).length === 10);
    const empty = await makeApp();
    check('nobody has discovered anything: an empty board, not an error', (await board(empty)).entries.length === 0 && (await board(empty)).totals.spotters === 0);
  }

  console.log('4b. The other boards: Top Overall, Most Miles, Most Rides, Most Vehicles Ridden');
  {
    const ctx = await makeApp();
    ['alice', 'bob', 'carol'].forEach(u => optIn(ctx, u));
    const dist = (id, mi, city) => ctx.d1.exec(`UPDATE trips SET distance = ${mi}, service_area = '${city}' WHERE id = '${id}'`);
    // Alice: discovers v1, v2 (first rider); 3 counted rides in 2 vehicles, 2 cities, 25.5 mi.
    const v1 = vehicle(ctx), v2 = vehicle(ctx);
    dist('ride-' + (ride(ctx, 'alice', v1, 1), rn), 10, 'Austin');
    dist('ride-' + (ride(ctx, 'alice', v1, 2), rn), 5.5, 'Austin');
    dist('ride-' + (ride(ctx, 'alice', v2, 3), rn), 10, 'Dallas');
    // Bob: 4 counted rides in v1/v2 (no discoveries), 1 city, 120 mi; one rejected ride ignored.
    for (let i = 0; i < 4; i++) dist('ride-' + (ride(ctx, 'bob', i % 2 ? v2 : v1, 10 + i), rn), 30, 'Austin');
    dist('ride-' + (ride(ctx, 'bob', v1, 20, 'rejected'), rn), 500, 'Austin');
    // Carol: discovers v3 by sighting only; no rides.
    const v3 = vehicle(ctx, { origin: 'sighting' }); sighting(ctx, 'carol', v3, 0);
    // Dave (not opted in): the most of everything, and must be in no board.
    for (let i = 0; i < 6; i++) dist('ride-' + (ride(ctx, 'dave', vehicle(ctx), 30 + i), rn), 99, 'Austin');

    const o = await board(ctx, 'overall');
    const by = (b, n) => b.entries.find(e => e.name === n);
    // By hand: Alice 10*2 + 3*3 + 2*2 + 5*2 + round(25.5/10)=3 -> 46; Bob 0 + 12 + 4 + 5 + 12 -> 33; Carol 10 -> 10.
    check('Top Overall, by hand: Alice 46, Bob 33, Carol 10 (ranked in that order)', counts(o) === '1:46 2:33 3:10' && o.entries.map(e => e.name).join() === 'Alice,Bob,Carol', counts(o));
    check('...with the raw figures behind each score', JSON.stringify(['discovered', 'rides', 'miles', 'unique_vehicles', 'cities'].map(k => by(o, 'Alice')[k])) === '[2,3,25.5,2,2]' && JSON.stringify(['discovered', 'rides', 'miles', 'unique_vehicles', 'cities'].map(k => by(o, 'Bob')[k])) === '[0,4,120,2,1]');
    check('...a rider with only a discovery is on it, with 0s for the rest', by(o, 'Carol') && by(o, 'Carol').rides === 0 && by(o, 'Carol').miles === 0);
    check('...and no formula is sent with it (removed on owner request)', o.label === 'Top Overall' && !o.help && !/Score =/.test(JSON.stringify(o)));
    const mi = await board(ctx, 'miles'), rd = await board(ctx, 'rides'), vr = await board(ctx, 'vehicles');
    check('Most Miles: Bob 120, Alice 25.5 (rejected rides ignored)', counts(mi) === '1:120 2:25.5' && mi.entries[0].name === 'Bob');
    check('Most Rides: Bob 4, Alice 3', counts(rd) === '1:4 2:3' && rd.entries[0].name === 'Bob');
    check('Most Vehicles Ridden: Alice 2, Bob 2 (a tie shares rank 1), Carol not on it', counts(vr) === '1:2 1:2' && !by(vr, 'Carol'));
    check('Carol (no rides) is on no ride board', ![mi, rd, vr].some(b => by(b, 'Carol')));
    const all = [o, mi, rd, vr, await board(ctx, 'discovered')];
    check('a rider who is not opted in is in NO board, and leaves no gap in the ranks', all.every(b => !b.entries.some(e => e.score === 594 || e.count === 6 || e.name === 'Dave' || e.name === 'Private spotter') && b.entries.every((e, i) => e.rank <= i + 1)));
  }

  console.log('5. Privacy');
  {
    const ctx = await makeApp();
    optIn(ctx, 'alice');
    ctx.d1.exec(`UPDATE users SET display_name = 'Bob Secret', handle = 'bobby', avatar_url = 'https://lh3.googleusercontent.com/a/bob', profile_visibility = 'public' WHERE id = 'bob'`);
    ctx.d1.exec(`UPDATE users SET display_name = 'Nohandle Nora', handle = NULL WHERE id = 'carol'`); optIn(ctx, 'carol', { name: 'Nohandle Nora', handle: null });
    ride(ctx, 'alice', vehicle(ctx), 1); ride(ctx, 'bob', vehicle(ctx), 2); ride(ctx, 'bob', vehicle(ctx), 3); ride(ctx, 'carol', vehicle(ctx), 4);
    const res = await get(ctx, '/api/community/leaderboard');
    check('not opted in (even with profile_visibility "public"): not on the board at all, and ranks start at 1 without them',
      !res.json.entries.some(e => e.name === 'Private spotter' || e.count === 2) && res.json.entries.every(e => e.rank === 1));
    check('...and nothing about them is anywhere in the response', !/Bob Secret|bobby|googleusercontent\.com\/a\/bob/.test(res.raw));
    const alice = res.json.entries.find(e => e.name === 'Alice');
    check('opted in with a handle: name, handle, photo and a profile link', alice.handle === 'alice' && /^https:\/\//.test(alice.avatar_url) && alice.profile === true);
    const nora = res.json.entries.find(e => e.name === 'Nohandle Nora');
    check('opted in without a handle: named, but no profile page', nora && nora.handle === null && nora.profile === false);
    check('no email and no internal user id in the leaderboard', !/@example\.com|"(alice|bob|carol)"|user_id|"uid"/.test(res.raw.replace(/"handle":"alice"/, '')));

    const profile = await get(ctx, '/api/riders/alice');
    check('an opted-in rider\'s profile: name, @handle, photo, bio, month joined, discovered vehicles',
      profile.status === 200 && profile.json.rider.name === 'Alice' && profile.json.rider.handle === 'alice' && /^\d{4}-\d{2}$/.test(profile.json.rider.joined) && profile.json.discovered.count === 1 && profile.json.discovered.vehicles[0].id);
    check('the profile carries no email, user id, fares, ride dates or review status',
      !/@example\.com|"id":"alice"|fare|ride_date|pickup|dropoff|status|receipt|submission/.test(profile.raw));
    const privateOne = await get(ctx, '/api/riders/bobby');
    const unknown = await get(ctx, '/api/riders/nobody_here');
    check('not opted in -> 404, identical to an unknown handle (existence not revealed)', privateOne.status === 404 && unknown.status === 404 && privateOne.raw === unknown.raw);

    // Ride figures on a public profile: counts and city names only.
    const austinCab = vehicle(ctx);
    seedRide(ctx.d1, { id: 'ride-austin', userId: 'alice', vehicleId: austinCab, status: 'approved', rideKey: 'rk-austin', serviceArea: 'Austin', fare: 1234, createdAt: '2026-09-01 11:00:00' });
    seedRide(ctx.d1, { id: 'ride-austin-2', userId: 'alice', vehicleId: austinCab, status: 'approved', rideKey: 'rk-austin-2', serviceArea: 'Austin', createdAt: '2026-09-01 11:01:00' });
    seedRide(ctx.d1, { id: 'ride-review', userId: 'alice', vehicleId: austinCab, status: 'needs_review', rideKey: 'rk-review', serviceArea: 'Houston', createdAt: '2026-09-01 11:02:00' });
    ctx.d1.prepare(`INSERT INTO cybercab_reviews (id, user_id, robotaxi_vehicle_id, rating, body, created_at) VALUES ('rv1', 'alice', ?, 4, 'Quiet and smooth.', '2026-09-20 10:00:00')`).bind(austinCab)._exec();
    const counted = await get(ctx, '/api/riders/alice');
    check('public profile ride counts: 3 counted rides in 2 different Cybercabs (the under-review ride is not counted)', counted.json.rides.count === 3 && counted.json.rides.vehicles === 2);
    check('...and rides per city name, busiest first', JSON.stringify(counted.json.rides.cities) === JSON.stringify([{ name: 'Austin', rides: 2 }, { name: 'Dallas', rides: 1 }]));
    check('no fares, dates, times, addresses or pickup/dropoff ever appear', !/1234|12\.34|692|6\.92|2026-06-09|13:04|Hanover|NorthPark|fare|ride_date|pickup|dropoff|distance|duration|Houston/.test(counted.raw));
    check('their reviews: count, average given and the most recent', counted.json.reviews.count === 1 && counted.json.reviews.average === 4 && counted.json.reviews.recent[0].body === 'Quiet and smooth.' && counted.json.reviews.recent[0].vehicle.id === austinCab);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${austinCab}'`);
    check('a review of a vehicle no longer public drops off the profile', (await get(ctx, '/api/riders/alice')).json.reviews.count === 0);
    check('malformed handles are 404s', (await get(ctx, '/api/riders/%3Cscript%3E')).status === 404 && (await get(ctx, '/api/riders/' + 'a'.repeat(40))).status === 404);
    check('handles are case-insensitive', (await get(ctx, '/api/riders/ALICE')).status === 200);
    ctx.d1.exec(`UPDATE users SET avatar_url = 'javascript:alert(1)' WHERE id = 'alice'`);
    check('only https photo URLs are ever passed on', (await board(ctx)).entries.find(e => e.name === 'Alice').avatar_url === null);
  }

  console.log('6. Credit moves or drops live');
  {
    const ctx = await makeApp();
    ['alice', 'bob'].forEach(u => optIn(ctx, u));
    const v = vehicle(ctx);
    const aliceRide = ride(ctx, 'alice', v, 1); ride(ctx, 'bob', v, 2);
    const name = async () => (await board(ctx)).entries.map(e => `${e.name}:${e.count}`).join(',');
    check('before: Alice discovered it', await name() === 'Alice:1');
    ctx.d1.exec(`UPDATE submissions SET status = 'rejected' WHERE id = 'sub-${aliceRide}'`);
    check('the winning ride is rejected -> credit moves to the next rider', await name() === 'Bob:1');
    ctx.d1.exec(`UPDATE submissions SET status = 'approved' WHERE id = 'sub-${aliceRide}'`);
    ctx.d1.exec(`DELETE FROM trips WHERE id = '${aliceRide}'`);
    check('the winning ride is deleted -> credit moves too', await name() === 'Bob:1');

    const s = vehicle(ctx, { origin: 'sighting' });
    const aliceSighting = sighting(ctx, 'alice', s, 1); ride(ctx, 'bob', s, 3);
    check('(Alice\'s sighting created the second vehicle)', await name() === 'Bob:1,Alice:1' || await name() === 'Alice:1,Bob:1');
    ctx.d1.exec(`UPDATE submissions SET status = 'rejected' WHERE id = '${aliceSighting}'`);
    check('the winning sighting is rejected -> credit moves to the rider', await name() === 'Bob:2');

    const del = await worker.fetch(new Request(`https://x/api/moderation/robotaxi-vehicles/${s}`, { method: 'DELETE', headers: { Authorization: 'Bearer session-mod' } }), ctx.env, {});
    check('deleting a vehicle (moderator) drops its discovery credit', del.status === 200 && await name() === 'Bob:1', `${del.status} ${await name()}`);
  }

  console.log('7. Community profile: on by default, the Profile switch turns it off');
  {
    const ctx = await makeApp(['alice']);
    const me = async () => (await get(ctx, '/api/profile', 'session-alice')).json.user;
    const { db } = await import('../worker/db.js');
    const g = await db.findOrCreateUserByGoogleIdentity(ctx.d1, { googleSub: 'new-google', email: 'new@example.com', name: 'New Rider', avatarUrl: 'https://lh3.googleusercontent.com/a/new' });
    const tsl = await db.findOrCreateUserByTeslaIdentifier(ctx.d1, 'tesla-new');
    const flag = id => ctx.d1.query('SELECT leaderboard_opt_in AS f FROM users WHERE id = ?', id)[0].f;
    check('new accounts (Google and Tesla sign-in) start ON', flag(g) === 1 && flag(tsl) === 1);

    // migrations/0021: existing accounts switch on — unless changed since the Community launch.
    ctx.d1.exec(`INSERT INTO users (id, display_name, updated_at) VALUES ('old1', 'Old One', '2026-09-20 10:00:00'), ('recent', 'Turned Off', '2026-09-30 19:00:00')`);
    ctx.d1.exec(fs.readFileSync(`${ROOT}migrations/0021_community_profiles_default_on.sql`, 'utf8'));
    check('the migration turns existing accounts on', flag('old1') === 1);
    check('...but not one changed since the Community launch (e.g. someone who switched it off)', flag('recent') === 0);

    const patch = body => worker.fetch(new Request('https://x/api/profile', { method: 'PATCH', headers: { Authorization: 'Bearer session-alice', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ctx.env, {});
    await patch({ display_name: 'Alice', handle: 'alice', bio: '', profile_visibility: 'private', leaderboard_opt_in: false });
    check('turning the switch off opts out (profile_visibility untouched)', (await me()).leaderboard_opt_in === false && (await me()).profile_visibility === 'private');
    await patch({ display_name: 'Alice', handle: 'alice', bio: '', profile_visibility: 'private' });
    check('an older page that omits the field keeps the current setting (still off)', (await me()).leaderboard_opt_in === false);
    await patch({ display_name: 'Alice', handle: 'alice', bio: '', profile_visibility: 'private', leaderboard_opt_in: true });
    await patch({ display_name: 'Alice', handle: 'alice', bio: '', profile_visibility: 'private', leaderboard_opt_in: 'no' });
    check('...and a non-boolean value keeps it too (still on)', (await me()).leaderboard_opt_in === true);
    const html = read('public/profile.html');
    check('the switch says it is on by default and how to turn it off', /Show my name, photo and ride counts on the Community leaderboard and a public profile\. On by default\. Turn it off to be left off the leaderboard\./.test(html));
    check('the page sends leaderboard_opt_in from the switch, and keeps profile_visibility as it was', /leaderboard_opt_in: isPublic/.test(html) && /profile_visibility: currentUser\.profile_visibility === 'public'/.test(html));
    check('opted in without a username: a prompt to set one', /id="communityHandleHint"[^>]*>Set a username to get a public profile page\./.test(html));
    const privacy = read('public/privacy.html');
    check('the privacy page states what is public by default, and how to turn it off',
      /unless you turn it off, your display name, username, profile picture/.test(privacy) && /on by default for every account/.test(privacy) && /to be left off the Community leaderboard entirely \(you are not listed or ranked\)/.test(privacy) && /the total miles of those rides/.test(privacy) &&
      !/Your name, email, receipt contents, fares and addresses are not shown publicly/.test(privacy) && /Your email, receipt contents, fares, ride dates and times, and addresses are never shown publicly/.test(privacy));
  }

  console.log('7b. Usernames from Google names');
  {
    const { db, handleBaseFromName } = await import('../worker/db.js');
    check('the base: lowercased, accents and symbols removed, 3-20 characters',
      handleBaseFromName('Blair Hayes') === 'blairhayes' && handleBaseFromName('José Núñez') === 'josenunez' && handleBaseFromName("Mary-Jane O'Neil") === 'maryjaneoneil' &&
      handleBaseFromName('Al') === 'alrider' && handleBaseFromName('李雷') === 'rider' && handleBaseFromName('A Very Long Name That Exceeds Twenty').length === 20);
    const ctx = await makeApp([]);
    const handleOf = id => ctx.d1.query('SELECT handle FROM users WHERE id = ?', id)[0].handle;
    const signIn = (sub, name) => db.findOrCreateUserByGoogleIdentity(ctx.d1, { googleSub: sub, email: `${sub}@example.com`, name, avatarUrl: null });
    const a = await signIn('s-a', 'Blair Hayes');
    check('a new Google account gets a username from its Google name', handleOf(a) === 'blairhayes');
    const b = await signIn('s-b', 'Blair Hayes');
    check('a taken name gets digits added (still a valid username)', /^blairhayes\d{4}$/.test(handleOf(b)) && handleOf(b) !== handleOf(a));
    ctx.d1.exec(`INSERT INTO users (id, display_name) VALUES ('old-google', 'Old Rider')`);
    ctx.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc-old', 'old-google', 's-old', 'old@example.com')`);
    await signIn('s-old', 'Old Rider');
    check('an existing account without a username gets one at its next sign-in', handleOf('old-google') === 'oldrider');
    ctx.d1.exec(`UPDATE users SET handle = 'mychoice' WHERE id = '${a}'`);
    await signIn('s-a', 'Blair Hayes');
    check('a username the rider chose is never replaced', handleOf(a) === 'mychoice');
    await ctx.env.TESLA_SESSIONS.put('session:session-a', JSON.stringify({ user_id: a }));
    const r = await worker.fetch(new Request('https://x/api/profile', { method: 'PATCH', headers: { Authorization: 'Bearer session-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name: 'Blair', handle: 'blair_h', bio: '', profile_visibility: 'public', leaderboard_opt_in: true }) }), ctx.env, {});
    check('...and they can change it on Profile as before', r.status === 200 && handleOf(a) === 'blair_h');
    check('a generated username makes the profile page work', (await get(ctx, '/api/riders/oldrider')).status === 404 && (ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'old-google'`), (await get(ctx, '/api/riders/oldrider')).status === 200));

    // migrations/0022 (existing accounts, now).
    const m = await makeApp([]);
    m.d1.exec(`INSERT INTO users (id, display_name, handle) VALUES ('g1', 'Blair Hayes', NULL), ('g2', 'José Núñez', NULL), ('g3', 'Keep Mine', 'kept'), ('t1', 'Tesla Only', NULL), ('g4', 'Kept', NULL)`);
    for (const id of ['g1', 'g2', 'g3', 'g4']) m.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc-${id}', '${id}', 'sub-${id}', '${id}@example.com')`);
    m.d1.exec(fs.readFileSync(`${ROOT}migrations/0022_usernames_from_google_names.sql`, 'utf8'));
    const h = id => m.d1.query('SELECT handle FROM users WHERE id = ?', id)[0].handle;
    check('the backfill: Google accounts with a plain name get it now', h('g1') === 'blairhayes');
    check('...never overwrites, skips non-Google accounts, and skips clashes and accented names (those get one at sign-in)',
      h('g3') === 'kept' && h('t1') === null && h('g4') === null && h('g2') === null);
  }

  console.log('8. Pages and routing');
  {
    const ctx = await makeApp(['alice']);
    const page = await worker.fetch(new Request('https://x/rider/alice'), ctx.env, {});
    check('/rider/<handle> serves rider.html (as /rider)', (await page.text()) === 'asset:/rider');
    const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html') && read(`public/${f}`).includes('data-nav="sightings"'));
    check('every page with the nav links to Community in the header AND the bottom bar',
      pages.length === 14 && pages.every(f => (read(`public/${f}`).match(/href="\/community" data-nav="community"/g) || []).length === 2));
    check('the bottom bar has 6 items (News joined it)', pages.every(f => (read(`public/${f}`).split('id="mobileBottomNav"')[1].split('</nav>')[0].match(/<a /g) || []).length === 6));
  }

  console.log('9. Community page (jsdom)');
  async function open(path, file, script, respond) {
    const html = read(`public/${file}`).replace(/<script src="https?:[^"]*"><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://cybercabhunter.com${path}`, pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.fetch = async u => respond(String(u));
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read(`public/js/${script}`)}`);
    await new Promise(r => setTimeout(r, 60));
    return { w, d: w.document };
  }
  {
    const ctx = await makeApp();
    optIn(ctx, 'alice'); optIn(ctx, 'carol', { name: 'Carol', handle: null, avatar: null });
    ride(ctx, 'alice', vehicle(ctx), 1); ride(ctx, 'alice', vehicle(ctx), 2); ride(ctx, 'bob', vehicle(ctx), 3); ride(ctx, 'carol', vehicle(ctx), 4);
    const api = u => (u.startsWith('/api/') ? worker.fetch(new Request(`https://x${u}`), ctx.env, {}) : new Response('{}', { status: 404 }));
    const { w, d } = await open('/community', 'community.html', 'community.js', api);
    const rows = [...d.querySelectorAll('#boardList > li')];
    check('the board shows its rows (Bob, not opted in, is not one of them)', rows.length === 2 && !d.getElementById('boardList').classList.contains('hidden') && !/Private spotter/.test(d.getElementById('boardList').textContent));
    const tabs = [...d.querySelectorAll('#boardTabs button')];
    check('five tabs in one row, in order, Top Overall selected (gold)', tabs.map(t => t.textContent).join('|') === 'Top Overall|Most Vehicles Discovered|Most Miles|Most Rides|Most Vehicles Ridden' && tabs[0].getAttribute('aria-selected') === 'true' && tabs.every(t => t.classList.contains('board-tab')) && /flex-nowrap/.test(d.getElementById('boardTabs').className) && /overflow-x-auto/.test(d.getElementById('boardTabs').className));
    check('the title is the board label, and Top Overall shows no formula line', d.getElementById('boardTitle').textContent === 'TOP OVERALL' && d.getElementById('boardHelp').classList.contains('hidden') && !/Score =/.test(d.body.textContent));
    const first = rows[0].querySelector('a');
    check('1st place: gold highlight, links to /rider/alice, photo shown', first && first.getAttribute('href') === '/rider/alice' && /border-\[rgba\(212,175,55,0\.45\)\]/.test(first.className) && first.querySelector('img'));
    // Alice: 2 discovered, 2 rides of 2.8 mi (the seed's default) in 2 cars, 1 city:
    // 20 + 6 + 4 + 5 + round(5.6 / 10) = 36.
    check('rows show rank, name, score in pts and the breakdown', /Alice/.test(rows[0].textContent) && /36\s*pts/.test(rows[0].textContent.replace(/\s+/g, ' ')) && /2 found · 2 rides · 2 cars · 1 city · 5\.6 mi/.test(rows[0].textContent.replace(/\u00a0/g, ' ')));
    tabs[3].click();
    await new Promise(r => setTimeout(r, 60));
    const rideRows = [...d.querySelectorAll('#boardList > li')];
    check('switching tabs swaps the list without a reload: Most Rides, in rides', d.getElementById('boardTitle').textContent === 'MOST RIDES' && tabs[3].getAttribute('aria-selected') === 'true' && tabs[0].getAttribute('aria-selected') === 'false' && /2\s*rides/.test(rideRows[0].textContent.replace(/\s+/g, ' ')) && w.location.pathname === '/community');
    tabs[1].click();
    await new Promise(r => setTimeout(r, 60));
    const carol = rows.find(r => /Carol/.test(r.textContent));
    const avatarSlot = row => row.querySelector('span.w-10');
    check('opted in without a username: initials, no link', carol && !carol.querySelector('a') && !carol.querySelector('img') && avatarSlot(carol).textContent.trim() === 'C');
    const img = first.querySelector('img');
    img.dispatchEvent(new w.Event('error'));
    check('a photo that fails to load falls back to initials', !first.querySelector('img') && avatarSlot(rows[0]).textContent.trim() === 'A', avatarSlot(rows[0]).innerHTML);
    check('Community is the active nav item', d.querySelector('a[data-nav="community"]').classList.contains('text-gold'));
    w.close();

    const empty = await open('/community', 'community.html', 'community.js', async () => Response.json({ board: 'discovered', label: 'Most Vehicles Discovered', boards: [{ id: 'discovered', label: 'x' }], entries: [] }));
    check('nobody yet: the honest empty state', !empty.d.getElementById('boardEmpty').classList.contains('hidden') && empty.d.getElementById('boardList').classList.contains('hidden'));
    empty.w.close();
    const failed = await open('/community', 'community.html', 'community.js', async () => { throw new TypeError('down'); });
    check('a failed load: the error state', !failed.d.getElementById('boardError').classList.contains('hidden'));
    failed.w.close();
    const two = await open('/community', 'community.html', 'community.js', async () => Response.json({ board: 'discovered', label: 'Most Vehicles Discovered', boards: [{ id: 'discovered', label: 'A' }, { id: 'sightings', label: 'B' }], entries: [] }));
    check('with two boards, the tab buttons appear', !two.d.getElementById('boardTabs').classList.contains('hidden') && two.d.querySelectorAll('#boardTabs button').length === 2);
    two.w.close();

    const prof = await open('/rider/alice', 'rider.html', 'rider.js', api);
    check('rider page: name, @handle, count and vehicle links', prof.d.getElementById('riderName').textContent === 'Alice' && prof.d.getElementById('riderHandle').textContent === '@alice' &&
      prof.d.getElementById('riderCount').textContent === '2' && prof.d.querySelectorAll('#riderVehicles a[href^="vehicle/"]').length === 2);
    const ptext = id => prof.d.getElementById(id).textContent.replace(/\s+/g, ' ').trim();
    check('rider page: the public counts (2 rides, 2 Cybercabs, 1 city, 2 discovered, no reviews)', ptext('riderRides') === '2' && ptext('riderVehiclesRidden') === '2' && ptext('riderCitiesCount') === '1' && ptext('riderDiscovered') === '2' && ptext('riderReviewCount') === '0' && ptext('riderReviewAvg') === '—');
    check('rider page: cities with their share of rides', /Dallas/.test(ptext('riderCities')) && /2 rides · 100%/.test(ptext('riderCities')));
    check('rider page: a profile header (cover, photo, name, @handle, bio with its "No bio yet." placeholder)', ptext('riderBio') === 'No bio yet.' && /class="profile-cover /.test(read('public/rider.html')) && /id="riderAvatar" class="profile-avatar /.test(read('public/rider.html')));
    prof.w.close();
    const hidden = await open('/rider/bob', 'rider.html', 'rider.js', api);
    check('a private or unknown rider: "This spotter\'s profile is private."', !hidden.d.getElementById('riderPrivate').classList.contains('hidden') && hidden.d.getElementById('riderProfile').classList.contains('hidden'));
    hidden.w.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
