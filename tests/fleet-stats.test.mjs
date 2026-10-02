// Live Fleet & Fares stats (worker/fleet-stats.js, GET /api/fleet-stats), the
// Zones page panel and the Fleet ETA estimate.
//   - the Austin Cybercab count follows the public registry (adds, approvals,
//     takedowns); active = approved sighting or counted ride in 30 days
//   - fares from seeded rides: median, mean, per-mile, one per physical ride;
//     private vehicles, other cities, rejected rides, non-USD never count
//   - too little data -> null -> "—" on the pages, never a made-up number
//   - stored by the daily job (cron) and read from storage
// Real SQL (every migration) + the REAL Worker router; pages run in jsdom.
// Run: node tests/fleet-stats.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { computeFareStats, recomputeFleetStats, FLEET_STATS_CRON, FARE_MIN_RIDES } from '../worker/fleet-stats.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider', 'mod'] });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  return ctx;
}
let vn = 0;
function vehicle(ctx, { visibility = 'public', area = 'Austin', origin = 'sighting', vin = true } = {}) {
  vn += 1;
  const id = `${String(vn).padStart(8, '0')}-0000-4000-8000-${String(vn).padStart(12, '0')}`;   // the registry's UUID id format
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin, vin, service_area, model) VALUES (?, ?, ?, ?, ?, ?, 'Cybercab')`)
    .bind(id, `PLT${vn}`, visibility, origin, vin ? `VIN${vn}` : null, area)._exec();
  return id;
}
let rn = 0;
function ride(ctx, vehicleId, { fare = 1000, miles = 3, status = 'pending', unit = 'mi', currency = 'USD', rideKey, date = null, area = 'Austin', user = 'rider' } = {}) {
  rn += 1;
  const id = seedRide(ctx.d1, { id: `r-${rn}`, userId: user, vehicleId, status, fare, distance: miles, currency, rideKey: rideKey || `rk-${rn}`, serviceArea: area, rideDate: date || '2026-09-01' });
  ctx.d1.exec(`UPDATE trips SET distance_unit = '${unit}' WHERE id = '${id}'`);
  return id;
}
let sn = 0;
function sighting(ctx, vehicleId, { status = 'approved', daysAgo = 1 } = {}) {
  sn += 1;
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status) VALUES (?, 'rider', 'vehicle_sighting', ?)`).bind(`s-${sn}`, status)._exec();
  ctx.d1.exec(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, verification_status, observed_at) VALUES ('o-${sn}', '${vehicleId}', 'rider', 's-${sn}', 'verified', datetime('now', '-${daysAgo} days'))`);
}
const stats = async ctx => (await worker.fetch(new Request('https://x/api/fleet-stats?city=austin'), ctx.env, {})).json();

async function run() {
  console.log('1. The Austin Cybercab count follows the public registry');
  {
    const ctx = await makeApp();
    check('an empty registry: 0', (await stats(ctx)).cybercabs === 0);
    vehicle(ctx); vehicle(ctx);
    check('two public Austin vehicles: 2', (await stats(ctx)).cybercabs === 2);
    const pending = vehicle(ctx, { visibility: 'private' });
    vehicle(ctx, { area: 'Dallas' });
    vehicle(ctx, { vin: false });                      // a sighting vehicle with no VIN isn't publicly eligible
    check('private, Dallas and not-yet-eligible vehicles are not counted', (await stats(ctx)).cybercabs === 2);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${pending}'`);
    check('approving (making public) a vehicle adds it at once — no deploy', (await stats(ctx)).cybercabs === 3);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${pending}'`);
    check('a takedown removes it again', (await stats(ctx)).cybercabs === 2);
    const receiptCar = vehicle(ctx, { origin: 'receipt', vin: false });
    check('a receipt vehicle counts only once it has a counted ride', (await stats(ctx)).cybercabs === 2 && (ride(ctx, receiptCar), (await stats(ctx)).cybercabs === 3));
  }

  console.log('2. Active Cybercabs: approved sighting or counted ride within 30 days');
  {
    const ctx = await makeApp();
    const a = vehicle(ctx); sighting(ctx, a, { daysAgo: 3 });
    const b = vehicle(ctx); sighting(ctx, b, { daysAgo: 40 });
    const c = vehicle(ctx); sighting(ctx, c, { status: 'pending', daysAgo: 1 });
    const d = vehicle(ctx); ride(ctx, d, { date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) });
    const e = vehicle(ctx); ride(ctx, e, { date: '2026-01-01' });
    const hidden = vehicle(ctx, { visibility: 'private' }); sighting(ctx, hidden, { daysAgo: 1 });
    const s = await stats(ctx);
    check('recent approved sighting (a) and recent ride (d) are active; old, pending-only and private are not', s.active_cybercabs === 2 && s.cybercabs === 5, JSON.stringify(s));
    check('the window is reported (30 days)', s.active_window_days === 30);
  }

  console.log('3. Fare stats from seeded rides');
  {
    const ctx = await makeApp();
    const car = vehicle(ctx);
    [[1000, 2], [1200, 3], [1400, 4], [1600, 5], [2000, 6]].forEach(([fare, miles]) => ride(ctx, car, { fare, miles }));
    // None of these may change the numbers:
    ride(ctx, vehicle(ctx, { visibility: 'private' }), { fare: 99900, miles: 1 });    // private vehicle
    ride(ctx, vehicle(ctx, { area: 'Dallas' }), { fare: 99900, miles: 1 });          // another city
    ride(ctx, car, { fare: 99900, miles: 1, status: 'rejected' });                    // rejected
    ride(ctx, car, { fare: null, miles: 3 });                                          // no fare
    ride(ctx, car, { fare: 99900, miles: 0 });                                         // no distance
    ride(ctx, car, { fare: 99900, miles: 3, currency: 'EUR' });                        // not USD
    const f = await computeFareStats(ctx.d1, 'Austin');
    check('5 rides counted (every excluded row ignored)', f.rides === 5, JSON.stringify(f));
    check('median fare $14.00', f.median_fare === 14);
    check('average fare $14.40', f.average_fare === 14.4);
    check('per mile = total fares / total miles = $72 / 20 mi = $3.60', f.per_mile === 3.6);
    check('median ride distance 4 mi', f.median_miles === 4);
    const shared = ride(ctx, car, { fare: 3000, miles: 10, rideKey: 'shared' }); ride(ctx, car, { fare: 3000, miles: 10, rideKey: 'shared', user: 'mod' });
    check('two riders logging the same physical ride count once', (await computeFareStats(ctx.d1, 'Austin')).rides === 6 && !!shared);
    ride(ctx, car, { fare: 1000, miles: 8.04672, unit: 'km' });
    const km = await computeFareStats(ctx.d1, 'Austin');
    check('kilometres are converted to miles', km.rides === 7 && Math.abs(km.per_mile - (72 + 30 + 10) / (20 + 10 + 5)) < 0.01, JSON.stringify(km));
  }

  console.log('4. Too little data -> no number ("—")');
  {
    const ctx = await makeApp();
    const car = vehicle(ctx);
    for (let i = 0; i < FARE_MIN_RIDES - 1; i++) ride(ctx, car, { fare: 1000 + i, miles: 3 });
    const s = await stats(ctx);
    check(`fewer than ${FARE_MIN_RIDES} rides: every fare stat is null, with the sample size`, s.fares.median_fare === null && s.fares.average_fare === null && s.fares.per_mile === null && s.fares.rides === FARE_MIN_RIDES - 1 && s.fares.min_rides === FARE_MIN_RIDES);
    const none = await makeApp();
    const z = await stats(none);
    check('no rides at all: nulls and 0 rides, no sources', z.fares.rides === 0 && z.fares.median_fare === null && z.fares.sources.length === 0);
  }

  console.log('5. Stored by the daily job, read from storage');
  {
    const ctx = await makeApp();
    const car = vehicle(ctx);
    for (let i = 0; i < 5; i++) ride(ctx, car, { fare: 1000, miles: 4 });
    await recomputeFleetStats(ctx.env, Date.parse('2026-09-30T11:00:00Z'));
    const stored = JSON.parse(await ctx.env.TESLA_SESSIONS.get('fleet_stats:austin:fares'));
    check('the job stores the fare model with its computed date', stored.median_fare === 10 && stored.computed_at === '2026-09-30T11:00:00.000Z');
    for (let i = 0; i < 5; i++) ride(ctx, car, { fare: 3000, miles: 4 });
    check('the page reads the stored values (new rides show after the next run)', (await stats(ctx)).fares.median_fare === 10);
    await worker.scheduled({ cron: FLEET_STATS_CRON }, ctx.env, { waitUntil: p => p });
    await new Promise(r => setTimeout(r, 20));
    check('the daily cron recomputes: the numbers move with no deploy', (await stats(ctx)).fares.median_fare === 20 && (await stats(ctx)).fares.rides === 10);
    check('wrangler.jsonc schedules exactly that cron', read('wrangler.jsonc').includes(`"${FLEET_STATS_CRON}"`));
    const fresh = await makeApp();
    const c2 = vehicle(fresh); for (let i = 0; i < 5; i++) ride(fresh, c2, { fare: 1500, miles: 5 });
    check('before the first run, the first request computes and stores it', (await stats(fresh)).fares.median_fare === 15 && !!(await fresh.env.TESLA_SESSIONS.get('fleet_stats:austin:fares')));
  }

  console.log('6. Privacy');
  {
    const ctx = await makeApp();
    const hidden = vehicle(ctx, { visibility: 'private' });
    for (let i = 0; i < 6; i++) ride(ctx, hidden, { fare: 5000, miles: 2 });
    sighting(ctx, hidden, { daysAgo: 1 });
    const r = await worker.fetch(new Request('https://x/api/fleet-stats?city=austin'), ctx.env, {});
    const raw = await r.text();
    const s = JSON.parse(raw);
    check('a private vehicle adds to no count and no fare', s.cybercabs === 0 && s.active_cybercabs === 0 && s.fares.rides === 0 && s.fares.median_fare === null);
    check('the response names no vehicle, plate, ride or user', !/-0000-4000-8000-|PLT|VIN|"r-\d|rider|user/i.test(raw));
    check('the private vehicle page still 404s', (await worker.fetch(new Request(`https://x/api/robotaxi-vehicles/${hidden}`), ctx.env, {})).status === 404);
    check('only Austin is served (other cities: 400)', (await worker.fetch(new Request('https://x/api/fleet-stats?city=dallas'), ctx.env, {})).status === 400);
    check('edge-cacheable', /public, max-age=300/.test(r.headers.get('Cache-Control')));
  }

  console.log('7. The pages');
  async function page(file, respond, path = `/${file}`) {
    const html = read(`public/${file}`).replace(/<script src="https?:[^"]*"><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://cybercabhunter.com${path}`, pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.ResizeObserver = class { observe() {} };
    w.maplibregl = { Map: class { on() {} fitBounds() {} resize() {} }, Marker: class { setLngLat() { return this; } setPopup() { return this; } addTo() { return this; } getPopup() { return { setHTML() {} }; } remove() {} }, Popup: class { setHTML() { return this; } }, LngLatBounds: class { extend() { return this; } } };
    w.fetch = async u => respond(String(u));
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => !/tailwind\.config|scrollRestoration/.test(s)).join('\n');
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\n${inline}`);
    await new Promise(r => setTimeout(r, 1700));
    return { w, d: w.document };
  }
  const full = { city: 'austin', cybercabs: 45, active_cybercabs: 12, active_window_days: 30, fares: { rides: 6, min_rides: 5, median_fare: 12.5, average_fare: 13.78, per_mile: 3.1, median_miles: 4, computed_at: '2026-09-30T11:00:00Z', sources: ['cybercabhunter_rides'] } };
  const thin = { ...full, fares: { rides: 2, min_rides: 5, median_fare: null, average_fare: null, per_mile: null, median_miles: null, computed_at: '2026-09-30T11:00:00Z', sources: ['cybercabhunter_rides'] } };
  const api = body => u => (u.startsWith('/api/fleet-stats') ? Response.json(body) : (u.startsWith('/api/camera-sightings') ? Response.json([]) : new Response('{}', { status: 404 })));
  {
    const z = await page('infrastructure.html', api(full));
    const txt = id => z.d.getElementById(id).textContent;
    check('Zones: the live count and fares are shown', txt('fleetCountOut') === '45' && txt('medianFareOut') === '$12.50' && txt('avgFareOut') === '$13.78' && txt('perMileOut') === '$3.10', [txt('fleetCountOut'), txt('medianFareOut'), txt('avgFareOut'), txt('perMileOut')].join());
    check('Zones: "Based on 6 rides · updated Sep 30, 2026"', txt('fareBasis') === 'Based on 6 rides · updated Sep 30, 2026', txt('fareBasis'));
    check('Zones: no hard-coded fleet or fare numbers remain', !/animateCounter\([^)]*(45|8\.77|10\.81|3\.53)/.test(read('public/infrastructure.html')));
    z.w.close();
    const t2 = await page('infrastructure.html', api(thin));
    const el = id => t2.d.getElementById(id);
    check('Zones, too little data: "—" with a "not enough ride data yet" tooltip (no $ number)', ['medianFareOut', 'avgFareOut', 'perMileOut'].every(id => el(id).textContent === '—' && el(id).title === 'Not enough ride data yet') && !/\$\d/.test(el('perMileOut').parentElement.textContent));
    check('Zones, too little data: the count still shows; the basis line explains', el('fleetCountOut').textContent === '45' && /need at least 5 logged rides — 2 so far/.test(el('fareBasis').textContent));
    t2.w.close();
    const down = await page('infrastructure.html', () => { throw new TypeError('down'); });
    check('Zones, API down: every tile "—"', ['fleetCountOut', 'medianFareOut', 'avgFareOut', 'perMileOut'].every(id => down.d.getElementById(id).textContent === '—'));
    down.w.close();

    const e = await page('simulation.html', api(full), '/simulation?view=eta');
    const set = (id, v) => { const x = e.d.getElementById(id); x.value = String(v); x.dispatchEvent(new e.w.Event('input', { bubbles: true })); };
    check('ETA: Active Cybercabs is the live active count', e.d.getElementById('cybercabCount').value === '12');
    set('tripMiles', 6);
    const expected = Math.round(6 * ((3.1 + 12.5 / 4) / 2) * 100) / 100;   // 18.68
    check(`ETA: the estimate = miles × average(per-mile, median fare ÷ median miles) = $${expected.toFixed(2)}`, e.d.getElementById('cybercabFare').textContent === `$${expected.toFixed(2)}`, e.d.getElementById('cybercabFare').textContent);
    check('ETA: labelled an estimate, with its sample and data date', /estimate/i.test(e.d.getElementById('cybercabFare').parentElement.textContent) && e.d.getElementById('cybercabFareNote').textContent === 'From 6 logged rides · data from Sep 30, 2026');
    e.w.close();
    const e2 = await page('simulation.html', api(thin), '/simulation?view=eta');
    const s2 = id => e2.d.getElementById(id);
    s2('tripMiles').value = '6'; s2('tripMiles').dispatchEvent(new e2.w.Event('input', { bubbles: true }));
    check('ETA, too little data: no estimate ("—"), and it says why', s2('cybercabFare').textContent === '—' && /Not enough ride data yet \(2 of 5 rides\)/.test(s2('cybercabFareNote').textContent));
    e2.w.close();
    const e3 = await page('simulation.html', () => { throw new TypeError('down'); }, '/simulation?view=eta');
    check('ETA, API down: no fleet count, no ETA, no estimate — all "—"', e3.d.getElementById('cybercabCount').value === '' && e3.d.getElementById('cybercabEta').textContent === '—' && e3.d.getElementById('cybercabFare').textContent === '—');
    e3.w.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
