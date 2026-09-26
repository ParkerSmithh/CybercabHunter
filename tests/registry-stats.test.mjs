// Real public statistics for the homepage: GET /api/registry/stats (worker/vehicles.js, db.getPublicRegistryStats)
// and js/home-stats.js, plus the removal of the invented numbers and the invented leaderboard.
//   - the two numbers use the SAME public gate as the registry list (public AND a counted ride)
//   - private / ineligible vehicles, pending/rejected/unverified sightings, review-only rides never change them
//   - the response is an explicit two-field whitelist, cached 60s, public, GET only
//   - a failed request shows a dash, never 0 (a REAL zero shows 0)
// Real SQL (every migration) + the REAL Worker router; the homepage script runs in jsdom.
// Run: node tests/registry-stats.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function vehicle(ctx, n, plate, visibility = 'private') {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, first_seen_at, last_seen_at) VALUES (?, ?, ?, '2026-08-01 00:00:00', '2026-09-01 00:00:00')`).bind(uuid(n), plate, visibility)._exec();
  return uuid(n);
}
const ride = (ctx, vid, o = {}) => seedRide(ctx.d1, { userId: 'rider', vehicleId: vid, status: 'pending', ...o });
// A sighting: a submission + its observation, in any status / verification state.
let sn = 0;
function sighting(ctx, vid, status, verification) {
  sn += 1;
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES (?, 'rider', 'vehicle_sighting', ?)`).bind(`sg${sn}`, status)._exec();
  ctx.d1.prepare(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, service_area, verification_status) VALUES (?, ?, 'rider', ?, 'Austin', ?)`).bind(`ob${sn}`, vid, `sg${sn}`, verification)._exec();
}
async function makeApp() {
  const ctx = await makeEnv({ users: ['rider'] });
  ctx.env.ASSETS = { fetch: async () => new Response('static asset', { status: 404 }) };
  await ctx.env.TESLA_SESSIONS.put('session:session-rider', JSON.stringify({ user_id: 'rider' }));
  return ctx;
}
const call = (ctx, path, init = {}) => worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
const stats = async (ctx, init) => { const r = await call(ctx, '/api/registry/stats', init); let body = null, raw = ''; try { raw = await r.clone().text(); body = JSON.parse(raw); } catch {} return { r, body, raw }; };

async function run() {
  console.log('1. API: the two numbers follow the public gate exactly');
  {
    const ctx = await makeApp();
    const A = vehicle(ctx, 1, 'AAA1111', 'public'), B = vehicle(ctx, 2, 'BBB2222', 'public');
    ride(ctx, A); ride(ctx, A, { status: 'approved', rideKey: 'a2' }); ride(ctx, B);        // 3 counted rides on public vehicles
    // Everything below must NOT change either number:
    ride(ctx, A, { status: 'needs_review', rideKey: 'a3' });                                // review-only ride
    ride(ctx, A, { status: 'rejected', rideKey: 'a4' });                                    // rejected ride
    const live = ride(ctx, B, { rideKey: 'b2' }); ctx.d1.exec(`UPDATE trips SET superseded_by = '${live}' WHERE id = '${ride(ctx, B, { rideKey: 'b3' })}'`); // superseded duplicate (its twin 'live' IS counted)
    const PRIV = vehicle(ctx, 3, 'PRIV333', 'private'); ride(ctx, PRIV); ride(ctx, PRIV, { rideKey: 'p2' });   // private vehicle with counted rides
    const NORIDE = vehicle(ctx, 4, 'NORIDE4', 'public');                                    // public but no counted ride
    const REVIEWONLY = vehicle(ctx, 5, 'REVIEW5', 'public'); ride(ctx, REVIEWONLY, { status: 'needs_review', rideKey: 'r5' });
    const REJONLY = vehicle(ctx, 6, 'REJECT6', 'public'); ride(ctx, REJONLY, { status: 'rejected', rideKey: 'r6' });
    const beforeSightings = (await stats(ctx)).body;
    for (const [s, v] of [['pending', 'unverified'], ['rejected', 'unverified'], ['needs_review', 'unverified'], ['approved', 'unverified'], ['approved', 'verified']]) sighting(ctx, A, s, v);
    sighting(ctx, PRIV, 'approved', 'verified');

    const { r, body } = await stats(ctx);
    check('200', r.status === 200);
    check('public_vehicles counts only eligible vehicles (A, B)', body.public_vehicles === 2, `got ${body.public_vehicles}`);
    check('recorded_rides counts only counted rides on those vehicles: A 2 + B 2 = 4 (the superseded duplicate, review-only, rejected and private-vehicle rides are excluded)', body.recorded_rides === 4, `got ${body.recorded_rides}`);
    check('sightings (pending, rejected, needs_review, approved-but-unverified, approved+verified, and one on a private vehicle) change neither number', JSON.stringify(beforeSightings) === JSON.stringify(body) && Object.keys(body).join() === 'public_vehicles,recorded_rides');

    // The stats must equal what the public registry list shows.
    const list = await (await call(ctx, '/api/robotaxi-vehicles')).json();
    check('public_vehicles equals the registry list total', body.public_vehicles === list.total);
    check('recorded_rides equals the sum of the list entries\' counted rides', body.recorded_rides === list.vehicles.reduce((n, v) => n + v.trip_count, 0));

    // The gate reacts to state changes.
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${B}'`);
    let s2 = (await stats(ctx)).body;
    check('returning a vehicle to private removes it and its rides', s2.public_vehicles === 1 && s2.recorded_rides === 2, JSON.stringify(s2));
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${A}' AND submission_id IN (SELECT id FROM submissions WHERE status IN ('pending', 'approved'))`);
    s2 = (await stats(ctx)).body;
    check('a public vehicle that loses all its counted rides drops out (its review-only and rejected rides do not keep it)', s2.public_vehicles === 0 && s2.recorded_rides === 0, JSON.stringify(s2));
  }

  console.log('2. API: response shape, caching, access');
  {
    const ctx = await makeApp();
    const A = vehicle(ctx, 1, 'AAA1111', 'public'); ride(ctx, A);
    const anon = await stats(ctx);
    check('exactly the two whitelisted fields, in this shape', Object.keys(anon.body).join() === 'public_vehicles,recorded_rides' && Number.isInteger(anon.body.public_vehicles) && Number.isInteger(anon.body.recorded_rides));
    check('Cache-Control is exactly public, max-age=60', anon.r.headers.get('Cache-Control') === 'public, max-age=60');
    check('JSON content type', /application\/json/.test(anon.r.headers.get('content-type') || ''));
    check('no authentication required (200 with no Authorization header)', anon.r.status === 200);
    const bogus = await stats(ctx, { headers: { Authorization: 'Bearer not-a-real-session' } });
    const signedIn = await stats(ctx, { headers: { Authorization: 'Bearer session-rider' } });
    check('a bogus or a real session makes no difference — the body is identical and user-independent', bogus.raw === anon.raw && signedIn.raw === anon.raw);
    check('no cookies or session data set', !anon.r.headers.get('set-cookie'));
    const text = anon.raw;
    check('nothing private or identifying in the payload', !/user|session|token|fare|address|plate|id"|submission|review|moderat|contributor|visibility|sighting|AAA1111/i.test(text));
    for (const m of ['POST', 'DELETE', 'PATCH']) { const x = await call(ctx, '/api/registry/stats', { method: m }); check(`${m} is not answered with the stats`, !(await x.text()).includes('public_vehicles')); }
    check('the per-vehicle and list routes are unaffected', (await call(ctx, '/api/robotaxi-vehicles')).status === 200 && (await call(ctx, `/api/robotaxi-vehicles/${A}`)).status === 200 && (await call(ctx, '/api/robotaxi-vehicles/stats')).status === 400);
    check('CORS matches the other public routes (allowed origin echoed)', anon.r.headers.get('Access-Control-Allow-Origin') === 'https://cybercabhunter.com');
  }

  console.log('3. API: empty registry and failure behavior');
  {
    const ctx = await makeApp();
    let z = await stats(ctx);
    check('an empty database is a real zero: 200 { 0, 0 }', z.r.status === 200 && z.body.public_vehicles === 0 && z.body.recorded_rides === 0);
    vehicle(ctx, 1, 'PRIV111', 'private'); ride(ctx, uuid(1)); vehicle(ctx, 2, 'NORIDE2', 'public');
    z = await stats(ctx);
    check('only private / ride-less vehicles is also 0 and 0', z.body.public_vehicles === 0 && z.body.recorded_rides === 0);

    const broken = { ...ctx.env, cybercabhunter_db: { prepare() { throw new Error('D1_ERROR: secret internal detail'); } } };
    const r = await worker.fetch(new Request('https://x/api/registry/stats', { headers: { Origin: 'https://cybercabhunter.com' } }), broken, {});
    const txt = await r.text();
    check('a database failure is a 503 with a generic error', r.status === 503 && JSON.parse(txt).error === 'stats_unavailable');
    check('the failure is never cached and leaks no internal detail', r.headers.get('Cache-Control') === 'no-store' && !/D1_ERROR|secret|internal/.test(txt));

    // A missing / null / unusable aggregate result is a FAILURE (503), never a zero.
    const withDb = impl => ({ ...ctx.env, cybercabhunter_db: { prepare: impl } });
    const answer = async db => { const x = await worker.fetch(new Request('https://x/api/registry/stats', { headers: { Origin: 'https://cybercabhunter.com' } }), withDb(db), {}); const raw = await x.text(); let body = null; try { body = JSON.parse(raw); } catch {} return { status: x.status, cache: x.headers.get('Cache-Control'), raw, body }; };
    const isGeneric503 = a => a.status === 503 && a.body && a.body.error === 'stats_unavailable' && a.body.success === false && Object.keys(a.body).sort().join() === 'error,success' && a.cache === 'no-store' && !/public_vehicles|recorded_rides|null|undefined|Error|registry stats|aggregate|usable/.test(a.raw);
    for (const [label, result] of [['null', null], ['undefined', undefined], ['an empty object (no columns)', {}], ['one column missing', { public_vehicles: 3 }], ['null columns', { public_vehicles: null, recorded_rides: null }], ['non-numeric columns', { public_vehicles: 'x', recorded_rides: '5' }], ['negative counts', { public_vehicles: -1, recorded_rides: 0 }], ['fractional counts', { public_vehicles: 1.5, recorded_rides: 2 }]]) {
      const a = await answer(() => ({ first: async () => result }));
      check(`the aggregate query resolving ${label} is a generic 503 (no-store, nothing internal) — never zeros`, isGeneric503(a), `${a.status} ${a.raw.slice(0, 60)}`);
    }
    const rejected = await answer(() => ({ first: async () => { throw new Error('D1_ERROR: connection reset by peer 10.0.0.7'); } }));
    check('the aggregate query rejecting is a generic 503 too, with no internal detail', isGeneric503(rejected) && !/D1_ERROR|10\.0\.0\.7|connection/.test(rejected.raw));

    // ...while a genuine database answer of zero is still a normal 200 with zeroes.
    const zero = await answer(() => ({ first: async () => ({ public_vehicles: 0, recorded_rides: 0 }) }));
    check('a genuine aggregate result of zero is a 200 with zeroes, cached 60s', zero.status === 200 && zero.body.public_vehicles === 0 && zero.body.recorded_rides === 0 && zero.cache === 'public, max-age=60' && Object.keys(zero.body).join() === 'public_vehicles,recorded_rides');
    const normal = await answer(() => ({ first: async () => ({ public_vehicles: 4, recorded_rides: 5 }) }));
    check('a normal aggregate result is a 200 with those numbers', normal.status === 200 && normal.body.public_vehicles === 4 && normal.body.recorded_rides === 5);
    // Direct check at the data layer: the function itself throws instead of inventing zeros.
    const { db } = await import('../worker/db.js');
    let threw = false; try { await db.getPublicRegistryStats({ prepare: () => ({ first: async () => null }) }); } catch { threw = true; }
    check('db.getPublicRegistryStats throws on a null result instead of returning zeros', threw);
    check('and returns the real zeros for a real empty database', JSON.stringify(await db.getPublicRegistryStats(ctx.d1)) === '{"public_vehicles":0,"recorded_rides":0}');
  }

  console.log('4. Homepage markup: nothing hard-coded');
  const HTML = read('index.html'), STATS = read('js/home-stats.js'), CALC = read('js/calc.js'), MAIN = read('js/main.js');
  {
    check('the invented tiles are gone: no "Active Cybercabs", no "Unsupervised Rate", no 45 / 98 targets', !/Active Cybercabs|Unsupervised Rate|data-target="(45|98)"|class="counter"/.test(HTML));
    check('the two real tiles exist and start as an em dash, not 0', /id="statVehicles"[^>]*>—</.test(HTML) && /id="statRides"[^>]*>—</.test(HTML));
    const statsBar = HTML.slice(HTML.indexOf('<!-- ===== Stats bar'), HTML.indexOf('<!-- ===== Live map'));
    check('the two tiles carry the labels "Cybercabs Spotted" and "Total Rides", and no sub-labels', /Cybercabs Spotted/.test(statsBar) && /Total Rides/.test(statsBar) && !/Moderator-approved|On registry vehicles|Vehicles in the Registry|Rides Recorded/.test(statsBar) && !/text-cyan/.test(statsBar));
    check('the page loads the stats script after main.js', /js\/main\.js[^\n]*\n<script src="js\/home-stats\.js/.test(HTML));
    check('no hard-coded numeric targets remain on the stats bar', !/data-target=/.test(HTML.slice(HTML.indexOf('<!-- ===== Stats bar'), HTML.indexOf('<!-- ===== Live map'))));
    check('the homepage no longer contains the old counter observer', !/counterObserver/.test(HTML));
    const bar = HTML.slice(HTML.indexOf('<!-- ===== Stats bar'), HTML.indexOf('<!-- ===== Live map'));
    check('the stats bar has no live region: no aria-live, role=status/alert/log, aria-atomic or aria-relevant', !/aria-live|role="(status|alert|log|timer|marquee)"|aria-atomic|aria-relevant/i.test(bar));
    const statsCode = STATS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // executable code only (the comments explain why there is no live region)
    check('the stats script never adds a live region either', !/aria-live|setAttribute\(\s*['"]role|aria-atomic|\.role\s*=/i.test(statsCode));
  }

  console.log('5. Homepage behavior (real js/home-stats.js against the real Worker)');
  async function home(ctx, { intercept, reducedMotion = true, observer = 'immediate' } = {}) {
    const dom = new JSDOM(HTML.replace(/<script src="https?:[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/', pretendToBeVisual: true });
    const w = dom.window;
    if (observer === 'immediate') w.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0); } unobserve() {} disconnect() {} };
    else if (observer === 'none') w.IntersectionObserver = undefined;
    w.matchMedia = q => ({ matches: reducedMotion && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    const requests = [];
    w.fetch = async (u, init = {}) => {
      const path = String(u).replace(WORKER_ORIGIN, ''); requests.push({ path, headers: init.headers || {} });
      if (intercept) { const x = await intercept(path); if (x) return x; }
      return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com' } }), ctx.env, {});
    };
    w.eval(`${CALC}\n${MAIN}\n${STATS}`);
    await new Promise(r => setTimeout(r, 120));
    const d = w.document;
    return { w, d, requests, v: () => d.getElementById('statVehicles').textContent, r: () => d.getElementById('statRides').textContent };
  }
  {
    const ctx = await makeApp();
    const A = vehicle(ctx, 1, 'AAA1111', 'public'), B = vehicle(ctx, 2, 'BBB2222', 'public'); ride(ctx, A); ride(ctx, A, { rideKey: 'a2' }); ride(ctx, B);
    vehicle(ctx, 3, 'PRIV333', 'private'); ride(ctx, uuid(3));
    const p = await home(ctx);
    check('the tiles show the real numbers: 2 vehicles, 3 rides', p.v() === '2' && p.r() === '3', `${p.v()} / ${p.r()}`);
    check('exactly one request, to the public stats endpoint, with no Authorization header', p.requests.length === 1 && p.requests[0].path === '/api/registry/stats' && !('Authorization' in p.requests[0].headers));
    check('the values are recorded on the tiles', p.d.getElementById('statVehicles').dataset.value === '2' && p.d.getElementById('statRides').dataset.value === '3');
    const big = await home(ctx, { intercept: async path => (path === '/api/registry/stats' ? Response.json({ public_vehicles: 1234, recorded_rides: 56789 }) : null) });
    check('large numbers are formatted with separators', big.v() === '1,234' && big.r() === '56,789');
  }
  {
    const ctx = await makeApp();
    const p = await home(ctx);
    check('a REAL zero (empty registry) is shown as 0', p.v() === '0' && p.r() === '0');
  }
  {
    const ctx = await makeApp();
    vehicle(ctx, 1, 'AAA1111', 'public'); ride(ctx, uuid(1));
    const failing = await home(ctx, { intercept: async () => new Response('{}', { status: 500 }) });
    check('a server error leaves both tiles as a dash — not 0', failing.v() === '—' && failing.r() === '—');
    const down = await home(ctx, { intercept: async () => { throw new TypeError('network down'); } });
    check('a network failure leaves both tiles as a dash — not 0', down.v() === '—' && down.r() === '—');
    const unavailable = await home(ctx, { intercept: async () => Response.json({ success: false, error: 'stats_unavailable' }, { status: 503 }) });
    check('the 503 the API sends when the database is down also leaves dashes', unavailable.v() === '—' && unavailable.r() === '—');
    for (const [label, body] of [['strings', { public_vehicles: '2', recorded_rides: '3' }], ['negative', { public_vehicles: -1, recorded_rides: -5 }], ['fractions', { public_vehicles: 1.5, recorded_rides: 2.5 }], ['null / missing', { public_vehicles: null }], ['not an object', 'oops'], ['NaN-like', { public_vehicles: 'NaN', recorded_rides: {} }]]) {
      const x = await home(ctx, { intercept: async () => Response.json(body) });
      check(`a malformed body (${label}) is never shown as a number`, x.v() === '—' && x.r() === '—');
    }
    const partial = await home(ctx, { intercept: async () => Response.json({ public_vehicles: 7, recorded_rides: 'bad' }) });
    check('one valid and one invalid value: only the valid one is shown', partial.v() === '7' && partial.r() === '—');
    const notJson = await home(ctx, { intercept: async () => new Response('<html>', { status: 200 }) });
    check('a non-JSON reply leaves dashes', notJson.v() === '—' && notJson.r() === '—');
  }
  {
    const ctx = await makeApp();
    vehicle(ctx, 1, 'AAA1111', 'public'); ride(ctx, uuid(1)); ride(ctx, uuid(1), { rideKey: 'x2' });
    const noObserver = await home(ctx, { observer: 'none', reducedMotion: false });
    check('without IntersectionObserver the numbers still appear', noObserver.v() === '1' && noObserver.r() === '2');
    // Animation: still starts as a dash, counts up on scroll, and lands on the exact real number.
    const anim = await home(ctx, { reducedMotion: false });
    const early = anim.v();
    await new Promise(r => setTimeout(r, 1700));
    check('with motion allowed it counts up and ends on the exact real value', anim.v() === '1' && anim.r() === '2' && early !== undefined);
  }

  console.log('5b. Accessibility: the count-up is not announced (no live region), yet it still animates and ends on the real value');
  {
    const ctx = await makeApp();
    for (let i = 1; i <= 3; i++) { const id = vehicle(ctx, i, `LIVE00${i}`, 'public'); ride(ctx, id); ride(ctx, id, { rideKey: `l${i}` }); }
    const p = await home(ctx, { reducedMotion: false });
    const LIVE = '[aria-live], [role="status"], [role="alert"], [role="log"], [role="timer"]';
    const changes = { statVehicles: 0, statRides: 0 };
    for (const id of Object.keys(changes)) new p.w.MutationObserver(m => { changes[id] += m.length; }).observe(p.d.getElementById(id), { childList: true, characterData: true, subtree: true });
    const end = Date.now() + 4000;
    while (Date.now() < end && !(p.v() === '3' && p.r() === '6')) await new Promise(r => setTimeout(r, 25));
    check('the animation really rewrites the tile text many times (this is what must NOT be announced)', changes.statVehicles > 5 && changes.statRides > 5, `vehicles ${changes.statVehicles}, rides ${changes.statRides}`);
    check('...and it lands on the exact real values (3 vehicles, 6 rides)', p.v() === '3' && p.r() === '6');
    for (const id of ['statVehicles', 'statRides']) {
      const el = p.d.getElementById(id);
      check(`${id}: neither the tile nor any ancestor is a live region, and it carries no live attributes`, el.closest(LIVE) === null && !el.hasAttribute('aria-live') && !el.hasAttribute('aria-atomic') && !el.hasAttribute('role'));
    }
    check('nothing in the whole document is a live region that contains the tiles', [...p.d.querySelectorAll(LIVE)].every(r => !r.contains(p.d.getElementById('statVehicles')) && !r.contains(p.d.getElementById('statRides'))));
    // Reduced motion: no count-up at all — one write of the final value.
    const still = await home(ctx, { reducedMotion: true });
    const stillChanges = { n: 0 }; new still.w.MutationObserver(m => { stillChanges.n += m.length; }).observe(still.d.getElementById('statVehicles'), { childList: true, characterData: true, subtree: true });
    await new Promise(r => setTimeout(r, 400));
    check('reduced motion: the final value is shown immediately and never rewritten', still.v() === '3' && still.r() === '6' && stillChanges.n === 0);
  }

  console.log('6. Community page: the invented leaderboard is gone');
  {
    const COMM = read('community.html');
    const names = ['atx_spotter', 'dfw_watcher', 'cabhunter22', 'sillicon_hills', 'railyardryan'];
    const everything = ['community.html', 'index.html', 'js/main.js', 'js/home-stats.js', 'js/vehicles.js', 'js/vehicle.js'].map(read).join('\n');
    check('none of the invented spotter names appear anywhere in the site source', names.every(n => !everything.includes(n)));
    check('none of the invented scores appear', !/\b1820\b|\b1,820\b|\b1390\b|\b1,390\b|\b1204\b|\b1,204\b|\b990\b|\b812\b/.test(COMM));
    check('the leaderboard list and its render script are gone', !/leaderboardList|CCC\.data\.leaderboard/.test(COMM + MAIN));
    check('the page says plainly that nothing is ranked yet, and shows no names or scores', /Nothing is ranked yet/.test(COMM) && /isn't live yet/.test(COMM));
    const dom = new JSDOM(COMM, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community.html', pretendToBeVisual: true });
    dom.window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    let threw = null, leaderboardType = null; try { leaderboardType = dom.window.eval(`${CALC}\n${MAIN}\nCCC.init(); typeof CCC.data.leaderboard;`); } catch (e) { threw = e; }
    check('the page still initializes without errors', threw === null);
    check('the shared data no longer carries a leaderboard', leaderboardType === 'undefined');
    check('the rendered page contains no rank rows or scores', !/#1\b|#2\b/.test(dom.window.document.body.textContent));
  }

  t.finish();
}
run().catch(err => { console.error(err); process.exit(1); });
