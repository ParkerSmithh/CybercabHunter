// Tests for the Cars page order and its sort menu (db.getPublicRobotaxiVehicles
// REGISTRY_SORTS, GET /api/robotaxi-vehicles?sort=, js/vehicles.js):
// Recently Used (default) / Used Least Recently / Most Miles / Most Rides,
// and a car moving to the top when new ride data arrives for it.
// Run: node tests/registry-sort.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function vehicle(ctx, n, plate, { origin = 'receipt', vin = null } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin, vin, first_seen_at, last_seen_at) VALUES (?, ?, 'public', ?, ?, '2026-07-01 00:00:00', '2026-07-01 00:00:00')`)
    .bind(uuid(n), plate, origin, vin)._exec();
  return uuid(n);
}
// A ride whose data arrived at `createdAt` (and hasn't been changed since).
const ride = (ctx, vid, rideDate, distance, createdAt) => {
  const id = seedRide(ctx.d1, { userId: 'rider', vehicleId: vid, status: 'pending', serviceArea: 'Austin', rideDate, distance, createdAt, rideKey: `k-${vid}-${rideDate}-${createdAt}` });   // Austin: the Cars page's default city
  ctx.d1.exec(`UPDATE trips SET updated_at = created_at WHERE id = '${id}'`);
  return id;
};
const plates = async (ctx, qs = '') => {
  const r = await worker.fetch(new Request(`https://x/api/robotaxi-vehicles${qs}`), ctx.env, {});
  const body = await r.json();
  return { status: r.status, body, order: body.vehicles.map(v => v.license_plate).join(' ') };
};

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider'] });
  const aaa = vehicle(ctx, 1, 'AAA0001');
  ride(ctx, aaa, '2026-09-10', 5, '2026-09-10 20:00:00'); ride(ctx, aaa, '2026-09-01', 3, '2026-09-01 20:00:00');     // last Sep 10, 8 mi, 2 rides
  const bbb = vehicle(ctx, 2, 'BBB0002');
  ride(ctx, bbb, '2026-09-20', 1, '2026-09-20 10:00:00');                                                              // last Sep 20, 1 mi, 1 ride
  const ccc = vehicle(ctx, 3, 'CCC0003');
  for (const h of ['01', '02', '03']) ride(ctx, ccc, '2026-08-01', 10, `2026-08-01 ${h}:00:00`);                        // last Aug 1, 30 mi, 3 rides
  const ddd = vehicle(ctx, 4, 'DDD0004');
  ride(ctx, ddd, '2026-09-20', 2, '2026-09-20 18:00:00');                                                              // last Sep 20 too, but its data arrived later
  vehicle(ctx, 5, 'EEE0005', { origin: 'sighting', vin: '5YJ3E1EA0KF000005' });                                        // public, no counted ride
  return { ctx, aaa, bbb, ccc, ddd };
}

async function run() {
  console.log('1. The four orders');
  {
    const { ctx } = await makeApp();
    const recent = await plates(ctx);
    check('default = Recently Used: latest ride first; same day -> newest data first; no rides last', recent.order === 'DDD0004 BBB0002 AAA0001 CCC0003 EEE0005' && recent.body.sort === 'recent');
    check('?sort=recent is the same', (await plates(ctx, '?sort=recent')).order === recent.order);
    check('Used Least Recently: oldest ride first; no rides still last', (await plates(ctx, '?sort=least_recent')).order === 'CCC0003 AAA0001 BBB0002 DDD0004 EEE0005');
    check('Most Miles: 30, 8, 2, 1, then none', (await plates(ctx, '?sort=most_miles')).order === 'CCC0003 AAA0001 DDD0004 BBB0002 EEE0005');
    check('Most Rides: 3, 2, then 1-ride cars by most recent use, then none', (await plates(ctx, '?sort=most_rides')).order === 'CCC0003 AAA0001 DDD0004 BBB0002 EEE0005');
    const bad = await plates(ctx, '?sort=bogus');
    check('an unknown sort falls back to Recently Used', bad.status === 200 && bad.order === recent.order && bad.body.sort === 'recent');
    const p1 = await plates(ctx, '?sort=most_miles&limit=2'), p2 = await plates(ctx, '?sort=most_miles&limit=2&offset=2');
    check('pages follow the chosen order', p1.order === 'CCC0003 AAA0001' && p2.order === 'DDD0004 BBB0002');
    check('search and sort combine', (await plates(ctx, '?q=DDD&sort=least_recent')).order === 'DDD0004');
    check('the ordering-only data time is not in the response', !JSON.stringify(recent.body).includes('last_data_at'));
  }

  console.log('2. New receipt data moves a car to the top');
  {
    const { ctx, ccc, bbb } = await makeApp();
    ride(ctx, ccc, '2026-09-25', 4, '2026-09-26 08:00:00');
    check('a newer ride sends the car to the top of Recently Used', (await plates(ctx)).order.startsWith('CCC0003 '));
    ride(ctx, bbb, '2026-09-25', 2, '2026-09-27 09:00:00');
    check('another car ridden the same day, with newer data, goes above it', (await plates(ctx)).order.startsWith('BBB0002 CCC0003 '));
    ctx.d1.exec(`UPDATE trips SET updated_at = '2026-09-28 12:00:00' WHERE robotaxi_vehicle_id = '${ccc}' AND ride_date = '2026-09-25'`);
    check('updated data for a ride (e.g. its miles) counts as new data too', (await plates(ctx)).order.startsWith('CCC0003 BBB0002 '));
  }

  console.log('3. The Cars page sort menu');
  {
    const { ctx } = await makeApp();
    const html = fs.readFileSync(`${ROOT}public/vehicles.html`, 'utf8');
    const js = fs.readFileSync(`${ROOT}public/js/vehicles.js`, 'utf8');
    async function open(url) {
      const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
      const w = dom.window;
      const calls = [];
      w.fetch = async u => { const path = String(u).replace(/^https:\/\/[^/]+/, ''); calls.push(path); return worker.fetch(new Request(`https://x${path}`), ctx.env, {}); };
      w.eval(js);
      const d = w.document;
      const settle = async () => { await new Promise(r => setTimeout(r, 80)); };
      await settle();
      return { w, d, calls, settle, first: () => d.querySelector('#regList li a').textContent };
    }
    const p = await open('https://cybercabhunter.com/vehicles');
    const select = p.d.getElementById('regSort');
    check('a sort dropdown with Recently Used, Used Least Recently, Most Miles, Most Rides', [...select.options].map(o => o.textContent).join('|') === 'Recently Used|Used Least Recently|Most Miles|Most Rides' && select.value === 'recent');
    check('the page asks for the most recently used first', p.calls[0].includes('sort=recent') && /DDD0004/.test(p.first()));
    select.value = 'most_miles';
    select.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await p.settle();
    check('choosing Most Miles reloads the list in that order', p.calls[p.calls.length - 1].includes('sort=most_miles') && /CCC0003/.test(p.first()) && p.d.querySelectorAll('#regList li').length === 5);
    check('...and the URL remembers it', p.w.location.search === '?sort=most_miles');
    const direct = await open('https://cybercabhunter.com/vehicles?sort=most_rides');
    check('opening ?sort=most_rides starts on Most Rides', direct.d.getElementById('regSort').value === 'most_rides' && direct.calls[0].includes('sort=most_rides'));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
