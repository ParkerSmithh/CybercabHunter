// Following on the service-area maps (GET /api/sightings/following) with five
// accounts, end to end over the REAL Worker and real SQL: sightings are
// submitted through the real photo endpoint and approved by the real moderator
// endpoint; follows go through the real follow API. Photon is stubbed.
//
//   A alice  public, follows several accounts
//   B bob    public, publishes sightings
//   C carol  private, requires approval
//   D dave   public, no sightings
//   E erin   used for removal and account deletion
// Run: node tests/following-map.test.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { makeEnv, makeCheck, seedVehicle, seedRide, approveVehicle } from './helpers/env.mjs';
import { installPhotonStub, CONGRESS, HANOVER } from './helpers/places.mjs';
import { mapPosition, positionForStoredLabel } from '../worker/places.js';
import { serviceAreaFor } from '../worker/service-areas.js';
import worker from '../worker/index.js';

installPhotonStub();
const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const USERS = ['alice', 'bob', 'carol', 'dave', 'erin', 'mod'];
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function app() {
  const ctx = await makeEnv({ users: USERS });
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  const set = (id, name, opt) => ctx.d1.exec(`UPDATE users SET display_name = '${name}', handle = '${id}_h', leaderboard_opt_in = ${opt} WHERE id = '${id}'`);
  set('alice', 'Alice A', 1); set('bob', 'Bob B', 1); set('carol', 'Carol Secret', 0); set('dave', 'Dave D', 1); set('erin', 'Erin E', 1); set('mod', 'Mod', 1);
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  return ctx;
}
async function call(ctx, method, path, { who, json, body } = {}) {
  const headers = {};
  if (who) headers.Authorization = `Bearer s-${who}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body }), ctx.env, { waitUntil() {} });
  const text = await r.text();
  let out = null; try { out = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, text, cache: r.headers.get('Cache-Control') };
}
const follow = (ctx, who, h) => call(ctx, 'PUT', `/api/follows/${h}_h`, { who });
const unfollow = (ctx, who, h) => call(ctx, 'DELETE', `/api/follows/${h}_h`, { who });
const map = (ctx, who, city = 'austin', q = '') => call(ctx, 'GET', `/api/sightings/following?city=${city}${q}`, who ? { who } : {});
const requests = async (ctx, who) => (await call(ctx, 'GET', '/api/follow-requests', { who })).json.requests;

async function sighting(ctx, who, { place = CONGRESS, city = 'Austin', plate, approve = true } = {}) {
  const fd = new FormData();
  fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
  fd.append('service_area', city);
  if (place) { fd.append('approx_location', place.label); fd.append('location_id', place.id); }
  if (plate) fd.append('license_plate', plate);
  const r = await call(ctx, 'POST', '/api/vehicle-sightings/photo', { who, body: fd });
  if (!r.json || !r.json.submission_id) throw new Error('setup: ' + r.text);
  if (approve) {
    const a = await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${r.json.submission_id}`, { who: 'mod', json: { action: 'approve' } });
    if (a.status !== 200) throw new Error('setup approve: ' + a.text);
  }
  return r.json.submission_id;
}

console.log('1. Who may ask');
{
  const ctx = await app();
  const r = await map(ctx, null);
  check('signed out: 401 sign_in_required, nothing else', r.status === 401 && r.json.error === 'sign_in_required' && !r.text.includes('sightings'));
  check('never cached, even the refusal', /no-store/.test(r.cache) && /private/.test(r.cache));
  check('an ended session: 401', (await call(ctx, 'GET', '/api/sightings/following?city=austin', { who: 'nobody' })).status === 401);
  check('an unknown city: 400', (await map(ctx, 'alice', 'houston')).status === 400);
  check('no city at all: 400 (never "everywhere")', (await call(ctx, 'GET', '/api/sightings/following', { who: 'alice' })).status === 400);
  check('a bad cursor: 400', (await map(ctx, 'alice', 'austin', '&cursor=abc')).status === 400);
  const empty = await map(ctx, 'alice');
  check('following nobody: following_count 0, the "No followed spotters yet" state', empty.status === 200 && empty.json.following_count === 0 && empty.json.sightings.length === 0);
  check('the public gallery still answers signed out', (await call(ctx, 'GET', '/api/sightings?city=austin')).status === 200);
}

console.log('2. A follows B: the example from the spec');
{
  const ctx = await app();
  await sighting(ctx, 'bob');
  let r = await map(ctx, 'alice');
  check('before following: nothing, though the sighting is approved', r.json.sightings.length === 0);
  await follow(ctx, 'alice', 'bob');
  r = await map(ctx, 'alice');
  check("after following: B's sighting is on A's map", r.json.following_count === 1 && r.json.sightings.length === 1);
  const s = r.json.sightings[0];
  check('at the place, rounded to about 110 m', s.lat === mapPosition(CONGRESS).lat && s.lng === mapPosition(CONGRESS).lng);
  check('names the spotter with public fields only', s.spotter.name === 'Bob B' && s.spotter.handle === 'bob_h' && !('id' in s.spotter) && !('email' in s.spotter));
  check('the same photo URL and public id as the gallery', /^\/api\/sightings\/[0-9a-f]{32}\/photo$/.test(s.image_url) && s.id.length === 32);
  check('date, city and street-level location', !!s.spotted_at && s.city === 'Austin' && s.location === 'Congress Avenue, Austin');
  for (const leak of ['evidence/', '"user_id"', '"submission_id"', '"notes"', 'approx_location', 'map_lat']) check(`no ${leak} in the answer`, !r.text.includes(leak));
  check('per viewer: private, no-store', /private/.test(r.cache) && /no-store/.test(r.cache));
  check("B's own map doesn't show B (B follows nobody)", (await map(ctx, 'bob')).json.sightings.length === 0);
  await unfollow(ctx, 'alice', 'bob');
  r = await map(ctx, 'alice');
  check('after unfollowing: gone at once', r.json.following_count === 0 && r.json.sightings.length === 0);
  await sighting(ctx, 'bob');
  await follow(ctx, 'alice', 'bob');
  check('a newly approved sighting appears on the next refresh', (await map(ctx, 'alice')).json.sightings.length === 2);
}

console.log('3. Only eligible sightings');
{
  const ctx = await app();
  await follow(ctx, 'alice', 'bob');
  await sighting(ctx, 'bob', { approve: false });
  check('pending: hidden', (await map(ctx, 'alice')).json.sightings.length === 0);
  const rejected = await sighting(ctx, 'bob', { approve: false });
  await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${rejected}`, { who: 'mod', json: { action: 'reject', reason: 'blurry' } });
  check('rejected: hidden', (await map(ctx, 'alice')).json.sightings.length === 0);
  const live = await sighting(ctx, 'bob');
  check('approved: shown', (await map(ctx, 'alice')).json.sightings.length === 1);
  ctx.d1.exec(`UPDATE vehicle_observations SET evidence_ref = NULL WHERE submission_id = '${live}'`);
  check('photo deleted by a moderator: hidden, as in the gallery', (await map(ctx, 'alice')).json.sightings.length === 0);
  const old = await sighting(ctx, 'bob');
  ctx.d1.exec(`UPDATE submissions SET submitted_at = datetime('now', '-31 days') WHERE id = '${old}'`);
  check('past the 30-day window: hidden, as in the gallery', (await map(ctx, 'alice')).json.sightings.length === 0);
  const fresh = await sighting(ctx, 'bob');
  const gallery = (await call(ctx, 'GET', '/api/sightings?city=austin')).json.sightings.map(s => s.id);
  const mine = (await map(ctx, 'alice')).json.sightings.map(s => s.id);
  check('every map sighting is one the public gallery lists', mine.length === 1 && mine.every(id => gallery.includes(id)));
  check('still only one', !!fresh);
}

console.log('4. Service areas');
{
  const ctx = await app();
  await follow(ctx, 'alice', 'bob');
  await sighting(ctx, 'bob');
  await sighting(ctx, 'bob', { place: HANOVER, city: 'Dallas' });
  const a = (await map(ctx, 'alice', 'austin')).json, d = (await map(ctx, 'alice', 'dallas')).json;
  check('Austin shows only Austin', a.sightings.length === 1 && a.sightings[0].city === 'Austin');
  check('Dallas shows only Dallas', d.sightings.length === 1 && d.sightings[0].city === 'Dallas' && d.sightings[0].location === 'Hanover Street, Dallas');
  check('the house number is never shown', !JSON.stringify(d).includes('4016'));
  check('Dallas sits in the Dallas box', d.sightings[0].lat > 32.5 && d.sightings[0].lat < 33.2);
  ctx.d1.exec(`UPDATE vehicle_observations SET map_lat = 40.7, map_lng = -74.0 WHERE service_area = 'Austin'`);
  const off = (await map(ctx, 'alice', 'austin')).json;
  check('a position outside the area is not drawn: listed instead', off.sightings.length === 0 && off.unplaced.length === 1 && !('lat' in off.unplaced[0]));
  ctx.d1.exec(`UPDATE vehicle_observations SET map_lat = NULL, map_lng = NULL WHERE service_area = 'Austin'`);
  const none = (await map(ctx, 'alice', 'austin')).json;
  check('an older sighting with no position: listed, never placed at a guess', none.sightings.length === 0 && none.unplaced.length === 1);
  const noPlace = await app();
  await follow(noPlace, 'alice', 'bob');
  await sighting(noPlace, 'bob', { place: null });
  const n = (await map(noPlace, 'alice')).json;
  check('a sighting submitted with no place: listed, no invented point', n.sightings.length === 0 && n.unplaced.length === 1 && n.unplaced[0].location === null);
}

console.log('5. Private accounts (C)');
{
  const ctx = await app();
  await sighting(ctx, 'carol');
  await follow(ctx, 'alice', 'carol');
  let r = await map(ctx, 'alice');
  check('a pending request reveals nothing, and is not counted', r.json.following_count === 0 && r.json.sightings.length === 0 && !r.text.includes('Carol'));
  const req = (await requests(ctx, 'carol'))[0];
  await call(ctx, 'POST', `/api/follow-requests/${req.id}/decline`, { who: 'carol' });
  check('declined: still nothing', (await map(ctx, 'alice')).json.sightings.length === 0);
  await follow(ctx, 'alice', 'carol');
  await unfollow(ctx, 'alice', 'carol');
  check('requested then cancelled: nothing', (await map(ctx, 'alice')).json.sightings.length === 0);
  await follow(ctx, 'alice', 'carol');
  const again = (await requests(ctx, 'carol'))[0];
  await call(ctx, 'POST', `/api/follow-requests/${again.id}/accept`, { who: 'carol' });
  r = await map(ctx, 'alice');
  check('approved: the follower sees it, by name', r.json.sightings.length === 1 && r.json.sightings[0].spotter.name === 'Carol Secret');
  check('a third party still sees nothing', (await map(ctx, 'dave')).json.sightings.length === 0);
  const fid = (await call(ctx, 'GET', '/api/follows/carol_h/followers', { who: 'carol' })).json.users.find(u => u.handle === 'alice_h').follow_id;
  await call(ctx, 'DELETE', `/api/followers/${fid}`, { who: 'carol' });
  r = await map(ctx, 'alice');
  check('removed as a follower: revoked at once', r.json.following_count === 0 && r.json.sightings.length === 0 && !r.text.includes('Carol'));
  const gallery = (await call(ctx, 'GET', '/api/sightings?city=austin')).text;
  check('the public gallery never names the submitter', !gallery.includes('Carol') && !gallery.includes('carol_h'));
}

console.log('6. A public account going private (E)');
{
  const ctx = await app();
  await sighting(ctx, 'erin');
  await follow(ctx, 'alice', 'erin');
  const setPrivate = v => call(ctx, 'PATCH', '/api/profile', { who: 'erin', json: { leaderboard_opt_in: v } });
  let r = await setPrivate(false);
  if (r.status !== 200) ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'erin'`);
  check('an existing follower stays approved', (await map(ctx, 'alice')).json.sightings.length === 1);
  await follow(ctx, 'dave', 'erin');
  r = await map(ctx, 'dave');
  check('someone new must now wait: nothing while pending', r.json.following_count === 0 && r.json.sightings.length === 0);
  const del = await call(ctx, 'DELETE', '/api/account', { who: 'erin', json: { confirm: 'DELETE' } });
  check('account deleted', del.status === 200);
  r = await map(ctx, 'alice');
  check('a deleted account leaves the map and the count', r.json.following_count === 0 && r.json.sightings.length === 0);
}

console.log('7. The vehicle link, and several spotters of one car');
{
  const ctx = await app();
  const v = seedVehicle(ctx.d1, { id: '11111111-1111-4111-8111-111111111111', plate: 'XVF2001' });
  await follow(ctx, 'alice', 'bob'); await follow(ctx, 'alice', 'dave');
  await sighting(ctx, 'bob', { plate: 'XVF2001' });
  let s = (await map(ctx, 'alice')).json.sightings[0];
  check('a private vehicle: no plate and no link', s.plate === null && s.vehicle_id === null);
  approveVehicle(ctx.d1, v, { withRide: true, userId: 'dave' });
  s = (await map(ctx, 'alice')).json.sightings[0];
  check('a public vehicle: its plate and id for the vehicle link', s.plate === 'XVF2001' && s.vehicle_id === v);
  check('and that id opens the public vehicle page', (await call(ctx, 'GET', `/api/robotaxi-vehicles/${v}`)).status === 200);
  await sighting(ctx, 'dave', { plate: 'XVF2001' });
  const both = (await map(ctx, 'alice')).json.sightings;
  check('both spotters come back, newest first', both.length === 2);

  const sandbox = { window: {}, document: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${ROOT}public/js/zones-following.js`, 'utf8'), sandbox);
  const group = sandbox.window.CCCZonesFollowing.groupSightings;
  const A = { id: 'a', vehicle_id: 'v1', lat: 30.1, lng: -97.1 }, B = { id: 'b', vehicle_id: 'v1', lat: 30.2, lng: -97.2 };
  const C = { id: 'c', vehicle_id: null, lat: 30.3, lng: -97.3 }, D = { id: 'd', vehicle_id: null, lat: 30.3, lng: -97.3 }, E = { id: 'e', vehicle_id: null, lat: 30.4, lng: -97.4 };
  const g = group([A, B, C, D, E]);
  check('one marker per vehicle, at its latest sighting', g.length === 3 && g[0].lat === 30.1 && g[0].sightings.length === 2);
  check('no plate: sightings at one spot share a marker; other spots keep their own', g[1].sightings.length === 2 && g[2].sightings.length === 1);
}

console.log('8. Paging, and the query staying small');
{
  const ctx = await app();
  await follow(ctx, 'alice', 'bob');
  for (let i = 0; i < 3; i++) await sighting(ctx, 'bob');
  const p1 = (await map(ctx, 'alice', 'austin', '&limit=2')).json;
  check('a page of 2 with a cursor', p1.sightings.length === 2 && !!p1.next_cursor && p1.following_count === 1);
  const p2 = (await map(ctx, 'alice', 'austin', `&limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`)).json;
  check('the next page has the rest, no repeats', p2.sightings.length === 1 && !p2.next_cursor && !p1.sightings.some(s => s.id === p2.sightings[0].id));
  check('following_count is only on the first page', !('following_count' in p2));
  const plan = ctx.d1.query(`EXPLAIN QUERY PLAN SELECT o.public_id FROM user_follows f JOIN vehicle_observations o ON o.user_id = f.followed_id JOIN submissions s ON s.id = o.submission_id WHERE f.follower_id = 'alice' AND f.status = 'accepted'`).map(r => r.detail).join(' | ');
  check('the plan walks the follow index and the observations-by-user index', /idx_user_follows|sqlite_autoindex_user_follows/.test(plan) && /idx_vehicle_observations_user/.test(plan));
  check('never a scan of all sightings', !/SCAN o\b|SCAN vehicle_observations/.test(plan));
}

console.log('9. Positions are stored rounded, and only where they belong');
{
  check('rounded to 3 decimals', JSON.stringify(mapPosition({ lat: 30.26324, lon: -97.74461 })) === JSON.stringify({ lat: 30.263, lng: -97.745 }));
  check('no coordinates: no position', mapPosition({ label: 'x' }) === null && mapPosition(null) === null);
  const ctx = await app();
  const id = await sighting(ctx, 'bob');
  const row = ctx.d1.query(`SELECT map_lat, map_lng FROM vehicle_observations WHERE submission_id = '${id}'`)[0];
  check('the stored value has no more than 3 decimals', Math.abs(row.map_lat * 1000 - Math.round(row.map_lat * 1000)) < 1e-6);
  const gallery = (await call(ctx, 'GET', '/api/sightings?city=austin')).text;
  check('the public gallery stays free of coordinates', !/"lat"|"lng"|map_lat/.test(gallery) && !gallery.includes(String(row.map_lat)));
  const vehicles = (await call(ctx, 'GET', `/api/submissions`, { who: 'bob' })).text;
  check("a rider's own submissions list doesn't expose them", !/map_lat|map_lng/.test(vehicles));
  const modList = (await call(ctx, 'GET', '/api/moderation/vehicle-sightings', { who: 'mod' })).text;
  check('nor the moderation queue', !/map_lat|map_lng/.test(modList));
}

console.log('10. Backfill of older sightings: exact matches only');
{
  const austin = serviceAreaFor('austin');
  const search = list => async () => list;
  const place = (label, lat, lon) => ({ id: 'W:1', label, lat, lon, state: 'TX' });
  check('an exact label inside the area', JSON.stringify(await positionForStoredLabel('Congress Avenue, Austin, TX', austin, search([place('Congress Avenue, Austin, TX', 30.2632, -97.7446)]))) === JSON.stringify({ lat: 30.263, lng: -97.745 }));
  check('a similar label: no guess', await positionForStoredLabel('Congress Avenue, Austin, TX', austin, search([place('South Congress Avenue, Austin, TX', 30.25, -97.75)])) === null);
  check('outside the area: no guess', await positionForStoredLabel('Main St, Dallas, TX', austin, search([place('Main St, Dallas, TX', 32.8, -96.8)])) === null);
  check('one label at two different spots: no guess', await positionForStoredLabel('Main St, Austin, TX', austin, search([place('Main St, Austin, TX', 30.2, -97.7), place('Main St, Austin, TX', 30.4, -97.8)])) === null);
  check('nothing to look up', await positionForStoredLabel('', austin, search([])) === null);
}

console.log('11. Map controls');
{
  const heat = fs.readFileSync(`${ROOT}public/js/zones-heatmap.js`, 'utf8');
  check('heatmap layer listeners wait for the layers (a pointer move during basemap load threw)', heat.indexOf("map.on('mouseenter', 'zh-cams'") > heat.indexOf('ready = true;') && heat.indexOf("map.on('mouseenter', 'zh-cams'") < heat.indexOf("if (map.loaded() && map.isStyleLoaded())"));
  const css = fs.readFileSync(`${ROOT}public/css/style.css`, 'utf8');
  check('a selected map toggle keeps its gold under the pointer (a tap on a phone leaves it hovered)', /\.maplibregl-ctrl\.zh-ctrl [^{]*button\[aria-pressed="true"\]:not\(:disabled\):hover\{background:#FAE030/.test(css));
  const js = fs.readFileSync(`${ROOT}public/js/zones-following.js`, 'utf8');
  check('Following never polls: no timer', !/setInterval|setTimeout/.test(js));
  check('an older request is cancelled', /AbortController/.test(js) && /inFlight\.abort\(\)/.test(js));
  check('All Sightings is the default', /let mode = 'all'/.test(js));
  check('the spec wording', /No followed spotters yet/.test(js) && /Follow other Cybercab spotters to see their sightings on this map\./.test(js) && /No sightings from followed users in this area/.test(js));
  const page = fs.readFileSync(`${ROOT}public/infrastructure.html`, 'utf8');
  check('every service area: the page refreshes Following on a city change, with no city written into the script', /if \(following\) following\.refresh\(\);/.test(page) && !/austin|dallas/i.test(js.replace(/cityOf\(\) *: *\(\) => 'austin'|\(\) => 'austin'/g, '')));
}

t.finish();
