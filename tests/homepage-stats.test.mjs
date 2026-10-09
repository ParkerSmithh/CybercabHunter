// GET /api/homepage-stats?city= (worker/homepage-stats.js) and the homepage
// rows that read it (js/home-rows.js): every figure against a small, known
// database worked out by hand; the counting rules shared with the rest of the
// site; privacy (an opted-out rider, a private vehicle, a pending sighting);
// "no data" as null, not 0; and the page wiring.
// Run: node tests/homepage-stats.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { TRAFFIC_CAMERAS, cameraCity } from '../worker/traffic-cameras.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const NOW = Date.now();
const today = new Date(NOW - 3 * 864e5).toISOString().slice(0, 10);

async function makeApp() {
  const ctx = await makeEnv({ users: ['alice', 'bob', 'carol'] });
  ctx.env.MUSE_CONNECTOR_USER_ID = 'muse-system';
  return ctx;
}
const optIn = (ctx, id, name, handle) => ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = ?, handle = ? WHERE id = ?`).bind(name, handle, id)._exec();
const optOut = (ctx, id, name) => ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 0, display_name = ? WHERE id = ?`).bind(name, id)._exec();
function vehicle(ctx, n, { plate, city = 'Austin', model = 'Cybercab', color = 'Gold', visibility = 'public', created } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, service_area, model, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(n), plate || `PLT${n}`, visibility, city, model, color, created || `2026-09-0${n} 00:00:00`)._exec();
  return uuid(n);
}
let rn = 0;
const ride = (ctx, user, vid, o = {}) => seedRide(ctx.d1, { userId: user, vehicleId: vid, serviceArea: 'Austin', rideKey: `rk-${++rn}`, rideDate: today, createdAt: `2026-09-10 10:${String(rn).padStart(2, '0')}:00`, status: 'approved', ...o });
let sn = 0;
function sighting(ctx, { status = 'approved', city = 'Austin', location = 'Congress Ave, Austin', hoursAgo = 2 } = {}) {
  sn += 1;
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at) VALUES (?, 'carol', 'vehicle_sighting', ?, 'photo', ?, ?)`)
    .bind(`sig-${sn}`, status, `evidence/carol/${sn}.jpg`, sqlTime(NOW - hoursAgo * 3600e3))._exec();
  ctx.d1.prepare(`INSERT INTO vehicle_observations (id, user_id, submission_id, service_area, approx_location, observed_at, evidence_ref, public_id, verification_status) VALUES (?, 'carol', ?, ?, ?, ?, ?, ?, 'unverified')`)
    .bind(`obs-${sn}`, `sig-${sn}`, city, location, sqlTime(NOW - hoursAgo * 3600e3), `evidence/carol/${sn}.jpg`, `${String(sn).padStart(32, 'a')}`.slice(-32))._exec();
}
function detection(ctx, n, { city = 'austin', hoursAgo = 1 } = {}) {
  ctx.d1.prepare(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city) VALUES (?, ?, 'CAM', 30.27, -97.74, ?, ?)`)
    .bind(`det-${n}`, `cam-${n}`, iso(NOW - hoursAgo * 3600e3), city)._exec();
}
const get = async (ctx, city) => {
  const r = await worker.fetch(new Request(`https://x/api/homepage-stats${city ? `?city=${city}` : ''}`), ctx.env, {});
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch (e) { /* not JSON */ }
  return { status: r.status, cache: r.headers.get('Cache-Control'), json, raw };
};

async function run() {
  // The world: Austin vehicles A1, A2 (Gold), A3 (Silver) and a private P;
  // nothing in Dallas.
  //   alice (opted in) rode A1 first ($10, 4 mi, 10 min) and A2 first ($20, 6 mi, 20 min)
  //   bob (opted OUT) rode A1 later ($15, 5 mi, pending) and A3 first ($8, 2 mi)
  //   a rejected $90 ride on A2, and a ride on the private P: neither counts
  const ctx = await makeApp();
  optIn(ctx, 'alice', 'Alice', 'alice'); optOut(ctx, 'bob', 'Bob Secret');
  const A1 = vehicle(ctx, 1, { plate: 'AUS0001' }), A2 = vehicle(ctx, 2, { plate: 'AUS0002' }), A3 = vehicle(ctx, 3, { plate: 'AUS0003', color: 'Silver' });
  const P = vehicle(ctx, 4, { plate: 'PRIV004', visibility: 'private' });
  ride(ctx, 'alice', A1, { fare: 1000, distance: 4, duration: 10 });
  ride(ctx, 'alice', A2, { fare: 2000, distance: 6, duration: 20 });
  ride(ctx, 'bob', A1, { fare: 1500, distance: 5, status: 'pending' });
  ride(ctx, 'bob', A3, { fare: 800, distance: 2 });
  ride(ctx, 'bob', A2, { fare: 9000, distance: 30, status: 'rejected' });
  ride(ctx, 'alice', P, { fare: 5000, distance: 50 });
  sighting(ctx, { hoursAgo: 2 }); sighting(ctx, { hoursAgo: 53, location: 'S Congress Ave' }); sighting(ctx, { status: 'pending', hoursAgo: 1 });
  detection(ctx, 1, { hoursAgo: 1 }); detection(ctx, 2, { hoursAgo: 3 }); detection(ctx, 3, { hoursAgo: 30 });

  console.log('1. The endpoint');
  {
    const r = await get(ctx, 'austin');
    check('200, edge-cached for 5 minutes', r.status === 200 && /public, max-age=300/.test(r.cache));
    check('an unknown city is refused (400)', (await get(ctx, 'houston')).status === 400);
    check('no city asked for: Austin', (await get(ctx, '')).json.city === 'austin');
    check('the response carries the rows and the hero, and no fleet / spotter data (those rows were removed)', ['hero', 'area', 'rides', 'sightings', 'cameras'].every(k => k in r.json) && !('fleet' in r.json) && !('spotters' in r.json));
  }

  const A = (await get(ctx, 'austin')).json, D = (await get(ctx, 'dallas')).json;

  console.log('2. Ride stats (counted rides only; the city ride sample behind the Fleet fares)');
  {
    // Counted, on public Austin vehicles: $10/4mi/10min, $20/6mi/20min, $15/5mi, $8/2mi.
    const r = A.rides;
    check('4 rides (rejected and private-vehicle rides left out)', r.rides === 4, r.rides);
    check('17 miles in all', r.miles === 17, r.miles);
    check('average fare $13.25 = (10 + 20 + 15 + 8) / 4', r.average_fare === 13.25, r.average_fare);
    check('per mile $3.12 = $53 / 17 mi', r.per_mile === 3.12, r.per_mile);
    check('average trip 4.3 mi (17 / 4 = 4.25)', r.average_miles === 4.3, r.average_miles);
    check('average duration 15 min (only the two rides that have one)', r.average_minutes === 15, r.average_minutes);
    check('weekly fares: one week, $13.25 over 4 rides', r.weekly_fares.length === 1 && r.weekly_fares[0].average_fare === 13.25 && r.weekly_fares[0].rides === 4);
    check('Dallas: no rides is 0 rides and NULL figures (shown "—"), not zeros', D.rides.rides === 0 && D.rides.miles === null && D.rides.average_fare === null && D.rides.per_mile === null && D.rides.average_miles === null && D.rides.average_minutes === null && D.rides.weekly_fares.length === 0);
  }

  console.log('3. Hero (the Cars page city rule; public vehicles only)');
  {
    check('Austin hero: 3 vehicles (the private one left out), 4 physical rides', A.hero.city.vehicles === 3 && A.hero.city.rides === 4, JSON.stringify(A.hero));
    check('no all-cities totals in the response (the page no longer shows them)', !('all' in A.hero));
    check('Dallas hero: 0 / 0', D.hero.city.vehicles === 0 && D.hero.city.rides === 0);
    check('the private vehicle is nowhere in the response', !/PRIV004/.test(JSON.stringify(A)));
    check('area: published zone facts and the documented vehicle count', A.area.square_miles === 264 && A.area.in_service_since === '2025-06-22' && A.area.vehicles === 3 && D.area.square_miles === 81);
  }

  console.log('4. Sightings (approved public photo sightings only)');
  {
    const s = A.sightings;
    check('2 approved (the pending one left out)', s.total === 2, s.total);
    check('last 24 hours: 1; last 7 days: 2', s.last_24h === 1 && s.last_7_days === 2, `${s.last_24h} / ${s.last_7_days}`);
    check('busiest hour: none claimed from two different hours', s.peak_hour === null);
    check('top spots by public label', s.top_spots.map(x => `${x.location}:${x.count}`).join() === 'Congress Ave, Austin:1,S Congress Ave:1');
    check('latest: newest first, public fields only', s.latest.length === 2 && s.latest[0].location === 'Congress Ave, Austin' && s.latest.every(x => Object.keys(x).join() === 'id,image_url,city,location,plate,cybercab,spotted_at,time_zone'));
    check('Dallas: none', D.sightings.total === 0 && D.sightings.latest.length === 0);
  }

  console.log('5. Camera watch');
  {
    const c = A.cameras;
    check('cameras monitored = the city\'s cameras in traffic-cameras.json', c.monitored === TRAFFIC_CAMERAS.filter(x => cameraCity(x) === 'austin').length && D.cameras.monitored === TRAFFIC_CAMERAS.filter(x => cameraCity(x) === 'dallas').length);
    check('2 detections in the last 24 h (not the one 30 h ago), over 24 hourly buckets', c.detections_24h === 2 && c.hourly.length === 24 && c.hourly.reduce((n, h) => n + h.count, 0) === 2);
    check('last detection: the newest one', c.last_detection_at === iso(NOW - 3600e3));
    check('Dallas: no detections, no last detection (null, not a time)', D.cameras.detections_24h === 0 && D.cameras.last_detection_at === null);
  }

  console.log('6. Privacy');
  {
    const raw = (await get(ctx, 'austin')).raw;
    check('no rider is named (the opted-out Bob nor anyone else)', !/Bob Secret|Alice|"bob"|"alice"/.test(raw));
    check('no user ids or emails anywhere in the response', !/"(alice|bob|carol)"|@example\.com|user_id|"uid"/.test(raw));
  }

  console.log('7. The homepage');
  {
    const html = read('public/index.html');
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const zonesSection = main.slice(main.indexOf('id="map"'), main.indexOf('id="cityRows"'));
    check('the service-area facts are part of SERVICE ZONES (above the minimap and chart); Ride stats and Sightings follow; no Fleet, Top spotters or Camera row', /id="rowArea"/.test(zonesSection) && zonesSection.indexOf('id="rowArea"') < zonesSection.indexOf('id="homeZoneAustin"') && ['rowRides', 'rowSightings'].every(id => main.includes(`id="${id}"`)) && !/rowFleet|rowSpotters|rowCameras/.test(html));
    check('the city tabs tell the stats bar and the rows', /window\.setHomeStatsCity\(city\)/.test(html) && /window\.setHomeRowsCity\(city\)/.test(html));
    check('no Cybercab showcase band on the homepage (removed on owner request)', !/data-cc-doors|cybercab-doors\.js|home-cc/.test(html));
    check('Fleet ROI\'s door component is as it was (no autoplay code)', !/data-cc-autoplay/.test(read('public/js/cybercab-doors.js')));
    // The rows, rendered from this database, switching Austin -> Dallas -> Austin.
    const dom = new JSDOM(html.replace(/<script src="https?:[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.setInterval = () => 0;
    w.fetch = async u => worker.fetch(new Request(`https://x${String(u)}`), ctx.env, {});
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\n${read('public/js/home-stats.js')}\n${read('public/js/home-rows.js')}`);
    const settle = () => new Promise(r => setTimeout(r, 150));
    await settle();
    const text = id => d.getElementById(id).textContent.replace(/\s+/g, ' ');
    check('Austin rows render the database figures', /Rides 4/i.test(text('rowRides')) && /\$13\.25/.test(text('rowRides')) && /All approved 2/i.test(text('rowSightings')));
    check('headings: RIDE STATS and SIGHTINGS ACTIVITY (the facts sit under SERVICE ZONES, no heading of their own)', ['rowRides', 'rowSightings'].map(id => d.querySelector(`#${id} h2`).textContent).join() === 'RIDE STATS,SIGHTINGS ACTIVITY' && !d.querySelector('#rowArea h2') && /Service area · AUSTIN/i.test(text('rowArea')));
    check('Sightings and the camera check are ONE section: one heading, one LIVE badge, one note; no "Camera watch / Experimental" label', d.querySelectorAll('#rowSightings h2, #rowSightings h3').length === 1 && d.querySelectorAll('#rowSightings .hr-live').length === 1 && d.querySelectorAll('#rowSightings details.hr-about').length === 1 && !/Camera watch|Experimental/.test(text('rowSightings')) && /The camera check is automated and experimental:/.test(text('rowSightings')) && /Cameras monitored/i.test(text('rowSightings')));
    const tilesAll = [...d.querySelectorAll('[data-row] .glass.rounded-xl')];
    check('every small stat tile carries the border glow; the larger cards do not', tilesAll.length >= 10 && tilesAll.every(el => el.hasAttribute('data-glow')) && [...d.querySelectorAll('#cityRows .glass.rounded-2xl')].every(el => !el.hasAttribute('data-glow')));
    check('the hero shows Austin, with no all-cities line', d.getElementById('statVehicles').textContent === '3' && !d.getElementById('statVehiclesAll') && !/All cities/.test(html));
    // The Tracker-style detail (owner's section 5)
    const tilesEls = [...d.querySelectorAll('[data-row] [data-glow]')];
    check('every stat tile has a sub-metric line, never a bare number', tilesEls.length === 17 && tilesEls.every(el => el.children[2] && el.children[2].textContent.trim().length > 0), tilesEls.filter(el => !(el.children[2] && el.children[2].textContent.trim())).map(el => el.children[0].textContent).join());
    check('sub-metrics from the data: rides in 30 days, median fare, week-over-week sightings', /4 in the last 30 days/.test(text('rowRides')) && /Median \$12\.50 · 4 rides/.test(text('rowRides')) && /Up from 0 previous 24 h|vs previous 24 h/.test(text('rowSightings')));
    const charts = [...d.querySelectorAll('#cityRows [data-chart-body]')].map(el => el.dataset.chartBody);
    check('three charts, each with time-range buttons (fares 90D / 6M / 1Y / All, default 90D)', charts.join() === 'fares,sightings,detections' && [...d.querySelectorAll('[data-chart="fares"]')].map(b => b.dataset.range).join() === '90D,6M,1Y,All' && d.querySelector('[data-chart="fares"][aria-pressed="true"]').dataset.range === '90D');
    d.querySelector('[data-chart="sightings"][data-range="7D"]').click();
    check('a range button redraws its chart (sightings: 7 daily bars) and moves the selection', d.querySelectorAll('[data-chart-body="sightings"] .hr-bars > span').length === 7 && d.querySelector('[data-chart="sightings"][aria-pressed="true"]').dataset.range === '7D');
    d.querySelector('[data-chart="sightings"][data-range="24H"]').click();
    check('a LIVE badge on Sightings Activity, with "updated … ago"; no Experimental badge', d.querySelectorAll('#rowSightings .hr-live').length === 1 && /Live · updated/.test(text('rowSightings')) && !/Experimental/.test(text('rowSightings')));
    check('footnotes name each source', /Zone facts as published/.test(text('rowArea')) && /From contributed ride receipts\./.test(text('rowRides')) && /From approved sightings\./.test(text('rowSightings')) && /From automated camera detections\./.test(text('rowSightings')));
    check('every block has an "About these numbers" note', ['#rowArea', '#rowRides', '#rowSightings'].every(id => d.querySelectorAll(`${id} details.hr-about`).length === 1));
    check('header "See all" links to Fleet ETA and Sightings', ['#rowRides a[href="/simulation?view=eta"]', '#rowSightings a[href="/sightings"]'].every(sel => d.querySelector(sel)));
    check('latest sightings as a list: thumbnail, "Cybercab seen at …", time ago, linked', /Cybercab seen at Congress Ave, Austin/.test(text('rowSightings')) && d.querySelector('#rowSightings ol a img') && /\dh ago/.test(text('rowSightings')));
    check('no extra map thumbnail (the minimap beside the facts opens the full map)', !d.querySelector('.hr-map'));
    w.setHomeRowsCity('dallas'); w.setHomeStatsCity('dallas');
    await settle();
    check('Dallas: every row switches (empty states, "—", no Austin numbers left)', /No contributed ride receipts in Dallas yet/.test(text('rowRides')) && !/\$13\.25/.test(text('rowRides')) && /No approved sightings in Dallas yet/.test(text('rowSightings')) && /81/.test(text('rowArea')) && d.getElementById('statVehicles').textContent === '0');
    w.setHomeRowsCity('austin'); w.setHomeStatsCity('austin');
    await settle();
    check('back to Austin: the Austin figures again', /\$13\.25/.test(text('rowRides')) && /All approved 2/i.test(text('rowSightings')) && d.getElementById('statVehicles').textContent === '3');
    w.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
