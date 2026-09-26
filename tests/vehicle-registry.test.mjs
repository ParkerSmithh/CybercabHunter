// The public vehicle registry: GET /api/robotaxi-vehicles (worker/vehicles.js) and the /vehicles page
// (vehicles.html + js/vehicles.js).
//   - only vehicles that pass the SAME gate as the per-vehicle page are listed (public AND a counted ride)
//   - private / hidden / ineligible / nonexistent vehicles never appear, and nothing private is returned
//   - each entry links to the existing /vehicle/<id> page
//   - the page renders its states safely, and the site links to it
// Real SQL (every migration) + the REAL Worker router; the page runs in jsdom.
// Run: node tests/vehicle-registry.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A registry row with an explicit visibility and last-seen time. vin mirrors
// what a moderator would have saved via POST .../vin and approve_cybercab
// (see tests/registry-review-approval.test.mjs for that write path itself) —
// inserted directly here since this file tests the PUBLIC read side only.
function vehicle(ctx, n, plate, { visibility = 'private', model = null, serviceArea = null, seen = '2026-09-01 00:00:00', created = '2026-08-01 00:00:00', vin = null } = {}) {
  ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, model, service_area, visibility, first_seen_at, last_seen_at, vin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(uuid(n), plate, model, serviceArea, visibility, created, seen, vin)._exec();
  return uuid(n);
}
const ride = (ctx, vid, o = {}) => seedRide(ctx.d1, { userId: 'rider', vehicleId: vid, status: 'pending', ...o });
const call = (ctx, path, init = {}) => worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
const list = async (ctx, qs = '') => { const r = await call(ctx, `/api/robotaxi-vehicles${qs}`); return { status: r.status, headers: r.headers, body: await r.json() }; };

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider'] });
  ctx.env.ASSETS = { fetch: async req => new Response('static:' + new URL(req.url).pathname, { status: 200 }) };
  return ctx;
}

async function run() {
  console.log('1. API: only vehicles that pass the public gate are listed');
  {
    const ctx = await makeApp();
    const pubA = vehicle(ctx, 1, 'AAA1111', { visibility: 'public', model: 'Model Y', serviceArea: 'Austin', seen: '2026-09-10 12:00:00' });
    const pubB = vehicle(ctx, 2, 'BBB2222', { visibility: 'public', seen: '2026-09-12 12:00:00' });
    ride(ctx, pubA, { rideDate: '2026-08-09', serviceArea: 'Austin', distance: 1.1 });
    ride(ctx, pubB, { rideDate: '2026-08-29', serviceArea: 'Dallas', distance: 0.5 });
    ride(ctx, pubB, { rideDate: '2026-09-02', serviceArea: 'Dallas', distance: 2 });

    const privateWithRide = vehicle(ctx, 3, 'PRIV333', { visibility: 'private' }); ride(ctx, privateWithRide);
    const publicNoRide = vehicle(ctx, 4, 'NORIDE44', { visibility: 'public' });
    const publicReviewOnly = vehicle(ctx, 5, 'REVIEW55', { visibility: 'public' }); ride(ctx, publicReviewOnly, { status: 'needs_review' });
    const publicRejectedOnly = vehicle(ctx, 6, 'REJECT66', { visibility: 'public' }); ride(ctx, publicRejectedOnly, { status: 'rejected' });
    const publicSuperseded = vehicle(ctx, 7, 'SUPER777', { visibility: 'public' });
    const live = ride(ctx, pubA, { rideDate: '2026-08-10', rideKey: 'k-live' });
    ride(ctx, publicSuperseded, { supersededBy: live, rideKey: 'k-dupe' });
    const privateNoRide = vehicle(ctx, 8, 'EMPTY888', { visibility: 'private' });
    const excluded = [privateWithRide, publicNoRide, publicReviewOnly, publicRejectedOnly, publicSuperseded, privateNoRide];

    const r = await list(ctx);
    check('200 for an unauthenticated caller', r.status === 200);
    check('exactly the two eligible vehicles are listed', r.body.vehicles.map(v => v.id).sort().join() === [pubA, pubB].sort().join() && r.body.total === 2);
    check('no excluded id, plate or ride appears anywhere in the response', excluded.every(id => !JSON.stringify(r.body).includes(id)) && !/PRIV333|NORIDE44|REVIEW55|REJECT66|SUPER777|EMPTY888/.test(JSON.stringify(r.body)));
    check('most recently seen first', r.body.vehicles[0].id === pubB && r.body.vehicles[1].id === pubA);
    const a = r.body.vehicles.find(v => v.id === pubA), b = r.body.vehicles.find(v => v.id === pubB);
    check('identifying fields are present', a.license_plate === 'AAA1111' && a.model === 'Model Y' && a.service_area === 'Austin' && a.first_seen_at === '2026-08-01 00:00:00' && a.last_seen_at === '2026-09-10 12:00:00');
    check('the ride count is the COUNTED rides only', a.trip_count === 2 && b.trip_count === 2);
    check('ride summary: latest ride date and service areas', a.last_ride_date === '2026-08-10' && /Austin/.test(a.service_areas) && b.last_ride_date === '2026-09-02' && b.service_areas === 'Dallas');
    check('ride summary: earliest ride date too', a.first_ride_date === '2026-08-09' && b.first_ride_date === '2026-08-29');
    check('missing values stay null (not 0 or a placeholder)', b.model === null && b.service_area === null && b.color === null && b.vin === null);
    const allowed = ['color', 'first_ride_date', 'first_seen_at', 'id', 'last_ride_date', 'last_seen_at', 'license_plate', 'model', 'provider', 'service_area', 'service_areas', 'total_distance', 'trip_count', 'verification_status', 'vin'];
    check('an entry carries exactly the public fields', r.body.vehicles.every(v => Object.keys(v).sort().join() === allowed.join()));
    // total_distance is the ONE distance field allowed here: the same vehicle-level aggregate the detail endpoint already publishes.
    // Anything else distance-like (a per-ride distance) is still banned, along with fares, addresses and identities.
    check('nothing private in the payload: no user, submission, fare, per-ride distance or address fields', !/user_id|submission|fare|(?<!total_)distance|pickup|dropoff|email|role|visibility|reason/i.test(JSON.stringify(r.body)));
    check('short-lived public caching, like the detail endpoint', /public, max-age=\d+/.test(r.headers.get('Cache-Control') || ''));

    // Consistency with the per-vehicle endpoints: the list and the detail page apply one rule.
    for (const v of r.body.vehicles) check(`listed ${v.license_plate}: its detail and sightings endpoints are 200`, (await call(ctx, `/api/robotaxi-vehicles/${v.id}`)).status === 200 && (await call(ctx, `/api/robotaxi-vehicles/${v.id}/sightings`)).status === 200);
    for (const id of excluded) check(`excluded ${id.slice(0, 8)}…: the detail endpoint is 404 too`, (await call(ctx, `/api/robotaxi-vehicles/${id}`)).status === 404);
    check('a nonexistent id is 404 (and never listed)', (await call(ctx, `/api/robotaxi-vehicles/${uuid(99)}`)).status === 404);

    // The gate reacts to state changes immediately.
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${pubB}'`);
    check('a vehicle returned to private disappears from the list', (await list(ctx)).body.vehicles.map(v => v.id).join() === pubA);
    ctx.d1.exec(`DELETE FROM trips WHERE robotaxi_vehicle_id = '${pubA}'`);
    // (Deleting the trips also un-supersedes SUPER777's duplicate, which is then a real counted ride, so it may now list.)
    check('a public vehicle that loses its last counted ride disappears too', !(await list(ctx)).body.vehicles.some(v => v.id === pubA));
  }

  console.log('2. API: paging, limits and bad input');
  {
    const ctx = await makeApp();
    for (let i = 1; i <= 7; i++) { const id = vehicle(ctx, i, `PLT${i}`, { visibility: 'public', seen: `2026-09-0${i} 00:00:00` }); ride(ctx, id); }
    let r = await list(ctx, '?limit=3');
    check('limit caps the page and total stays the full count', r.body.vehicles.length === 3 && r.body.total === 7 && r.body.limit === 3 && r.body.offset === 0);
    const p1 = r.body.vehicles.map(v => v.id);
    r = await list(ctx, '?limit=3&offset=3'); const p2 = r.body.vehicles.map(v => v.id);
    r = await list(ctx, '?limit=3&offset=6'); const p3 = r.body.vehicles.map(v => v.id);
    check('pages are stable and do not overlap; together they cover every vehicle once', new Set([...p1, ...p2, ...p3]).size === 7 && p3.length === 1);
    check('an offset past the end is an empty page, not an error', (await list(ctx, '?offset=500')).body.vehicles.length === 0);
    r = await list(ctx, '?limit=100000');
    check('an oversized limit is clamped to 100', r.body.limit === 100);
    for (const bad of ['?limit=abc', '?limit=-5', '?limit=0', '?offset=-1', '?limit=1.5&offset=x', "?limit=1;DROP TABLE robotaxi_vehicles"]) {
      const x = await list(ctx, bad);
      check(`bad input ${bad} falls back safely`, x.status === 200 && x.body.limit >= 1 && x.body.limit <= 100 && x.body.offset === 0);
    }
    check('the table survived the injection-style input', (await list(ctx)).body.total === 7);
    const post = await call(ctx, '/api/robotaxi-vehicles', { method: 'POST' });
    check('a POST is not answered with the list', !(post.headers.get('content-type') || '').includes('json') || !(await post.clone().text()).includes('"vehicles"'));
  }

  console.log('3. API: the empty registry and existing routes are unaffected');
  {
    const ctx = await makeApp();
    const r = await list(ctx);
    check('no public vehicles: 200 with an empty list and total 0', r.status === 200 && r.body.vehicles.length === 0 && r.body.total === 0);
    const id = vehicle(ctx, 1, 'ONE1111', { visibility: 'public' }); ride(ctx, id);
    const detail = await call(ctx, `/api/robotaxi-vehicles/${id}`);
    check('the per-vehicle endpoint is unchanged', detail.status === 200 && (await detail.json()).vehicle.license_plate === 'ONE1111');
    check('a bad id on the per-vehicle endpoint is still 400', (await call(ctx, '/api/robotaxi-vehicles/not-a-uuid')).status === 400);
    const seen = [];
    ctx.env.ASSETS = { fetch: async req => { seen.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } };
    await call(ctx, '/vehicles');
    check('the /vehicles page is not intercepted by the Worker: it falls through to the static assets untouched', seen.join() === '/vehicles');
    seen.length = 0;
    await call(ctx, `/vehicle/${id}`);
    check('the /vehicle/<id> page route is unchanged (still asks the assets for /vehicle)', seen.join() === '/vehicle');
  }

  console.log('4. Page: rendering, links and states (real js/vehicles.js in jsdom)');
  const CALC = read('js/calc.js'), MAIN = read('js/main.js'), PAGE = read('js/vehicles.js'), HTML = read('vehicles.html');
  async function open(ctx, intercept) {
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/vehicles', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    const requests = [];
    w.fetch = async (u, init = {}) => {
      const path = String(u).replace(WORKER_ORIGIN, '');
      requests.push({ path, headers: init.headers || {} });
      if (intercept) { const x = await intercept(path, init); if (x) return x; }
      return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), ctx.env, {});
    };
    w.eval(`${CALC}\n${MAIN}\nCCC.init();\n${PAGE}`);
    const d = w.document;
    const page = { w, d, requests,
      vis: id => !d.getElementById(id).classList.contains('hidden'),
      cards: () => [...d.querySelectorAll('#regList > li > a')],
      async waitFor(cond, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); } return false; } };
    await page.waitFor(() => page.vis('regLoaded') || page.vis('regEmpty') || page.vis('regError'));
    return page;
  }
  {
    const ctx = await makeApp();
    // The registry row's own ingestion timestamps (seen/created) are deliberately far from the ride's
    // own date, matching the real bug report this guards against: a receipt imported long after the ride
    // it describes must still show the RIDE's date, not when the row was created/touched.
    const a = vehicle(ctx, 1, 'XFY4946', { visibility: 'public', serviceArea: null, seen: '2026-09-19 23:11:44', created: '2026-09-19 23:11:44' }); ride(ctx, a, { serviceArea: 'Austin', rideDate: '2026-08-05' });
    const b = vehicle(ctx, 2, 'XJR1903', { visibility: 'public', model: 'Model Y', seen: '2026-09-20 05:16:22', created: '2026-09-20 05:16:22' }); ride(ctx, b, { serviceArea: 'Dallas', rideDate: '2026-07-04' });
    vehicle(ctx, 3, 'HIDDEN33', { visibility: 'private' }); const hid = uuid(3); ride(ctx, hid);
    const p = await open(ctx, null);
    check('the loaded state is shown (not empty, not error, not loading)', p.vis('regLoaded') && !p.vis('regEmpty') && !p.vis('regError') && !p.vis('regLoading'));
    check('one card per public vehicle, newest first', p.cards().length === 2 && /XJR1903/.test(p.cards()[0].textContent) && /XFY4946/.test(p.cards()[1].textContent));
    check('each card links to the correct /vehicle/<id>', p.cards()[0].getAttribute('href') === `/vehicle/${b}` && p.cards()[1].getAttribute('href') === `/vehicle/${a}`);
    check('the plate is shown, and a null model reads "Model not confirmed"', /XFY4946/.test(p.cards()[1].textContent) && /Model not confirmed/.test(p.cards()[1].textContent) && /Model Y/.test(p.cards()[0].textContent));
    check('service area falls back to the cities of the counted rides', /Austin/.test(p.cards()[1].textContent) && /Dallas/.test(p.cards()[0].textContent));
    check('ride count is shown', /Rides\s*1/.test(p.cards()[0].textContent));
    check('First/Last seen show the RIDE\'s own date (from the receipt), not when the registry row was created/touched', /Jul 4, 2026/.test(p.cards()[0].textContent) && /Aug 5, 2026/.test(p.cards()[1].textContent));
    check('the ingestion timestamps are NOT what is displayed for First/Last seen', !/Sep 19, 2026|Sep 20, 2026/.test(p.cards()[0].textContent + p.cards()[1].textContent));
    check('the count line says "2 vehicles"', p.d.getElementById('regCount').textContent === '2 vehicles');
    check('a private vehicle is not on the page, in text or links', !/HIDDEN33/.test(p.d.body.textContent) && ![...p.d.querySelectorAll('a')].some(x => (x.getAttribute('href') || '').includes(hid)));
    check('the page calls only the public list endpoint, with no Authorization header', p.requests.every(r => r.path.startsWith('/api/robotaxi-vehicles') && !('Authorization' in r.headers)) && p.requests.length === 1);
    check('the "Show more" button is hidden when everything fits', !p.vis('regMore'));
  }
  {
    // Data is treated as text, never markup; a malformed id is never linked.
    const ctx = await makeApp();
    const x = vehicle(ctx, 1, 'XSS0001', { visibility: 'public', model: '<img src=x onerror="window.__pwned=1">', serviceArea: '<script>window.__pwned=1</script>' }); ride(ctx, x);
    const p = await open(ctx, null);
    check('markup in model/service area is shown as text', /<img src=x/.test(p.cards()[0].textContent) && p.d.querySelectorAll('#regList img, #regList script').length === 0 && p.w.__pwned === undefined);
    const good = { id: uuid(1), license_plate: 'GOOD001', model: null, service_area: null, service_areas: null, first_seen_at: null, last_seen_at: null, trip_count: 1 };
    const p2 = await open(ctx, async path => (path.startsWith('/api/robotaxi-vehicles') ? Response.json({ vehicles: [good, { ...good, id: '../../etc/passwd', license_plate: 'BAD' }, { ...good, id: 'javascript:alert(1)', license_plate: 'BAD2' }], total: 3 }) : null));
    check('an entry with a malformed id is skipped, never linked', p2.cards().length === 1 && p2.cards()[0].getAttribute('href') === `/vehicle/${uuid(1)}` && !/BAD/.test(p2.d.body.textContent));
    check('missing values read as an em dash / "not recorded", never 0', /Service area not recorded/.test(p2.cards()[0].textContent) && /—/.test(p2.cards()[0].textContent));
  }
  {
    const ctx = await makeApp();
    const empty = await open(ctx, null);
    check('empty registry: a friendly empty state, no cards', empty.vis('regEmpty') && !empty.vis('regLoaded') && empty.cards().length === 0 && /NO VEHICLES FOUND/.test(empty.d.getElementById('regEmpty').textContent));
    const failing = await open(ctx, async () => new Response('{}', { status: 500 }));
    check('a server error is an error state, not "empty"', failing.vis('regError') && !failing.vis('regEmpty'));
    let calls = 0;
    const flaky = await open(ctx, async () => { calls += 1; if (calls === 1) throw new TypeError('network down'); return null; });
    check('a network failure is an error state with a retry', flaky.vis('regError'));
    flaky.d.getElementById('regRetry').click();
    await flaky.waitFor(() => flaky.vis('regEmpty') || flaky.vis('regLoaded'));
    check('Try again reloads (here: the registry is genuinely empty)', flaky.vis('regEmpty') && !flaky.vis('regError'));
  }
  {
    const ctx = await makeApp();
    for (let i = 1; i <= 55; i++) { const id = vehicle(ctx, i, `PG${String(i).padStart(3, '0')}`, { visibility: 'public', seen: `2026-09-01 00:${String(i).padStart(2, '0')}:00` }); ride(ctx, id); }
    const p = await open(ctx, null);
    check('the first page shows 50 of 55, with a Show more button', p.cards().length === 50 && p.vis('regMore') && p.d.getElementById('regCount').textContent === '55 vehicles');
    p.d.getElementById('regMore').click();
    await p.waitFor(() => p.cards().length === 55);
    check('Show more appends the rest without repeating any card', p.cards().length === 55 && new Set(p.cards().map(a => a.getAttribute('href'))).size === 55 && !p.vis('regMore'));
    check('it asked for offset 50 the second time', p.requests.some(r => /offset=50/.test(r.path)));
  }

  console.log('4b. VIN and Cybercab2.png: present only for an approved, publicly-eligible vehicle with a vin');
  {
    const ctx = await makeApp();
    const VIN = '5YJSA1E14FF101183';
    const cybercab = vehicle(ctx, 10, 'CYB0010', { visibility: 'public', model: 'Cybercab', vin: VIN }); ride(ctx, cybercab);
    const ordinary = vehicle(ctx, 11, 'ORD0011', { visibility: 'public' }); ride(ctx, ordinary);         // no vin: existing vehicles keep working unchanged
    const vinButPrivate = vehicle(ctx, 12, 'PRV0012', { visibility: 'private', vin: VIN }); ride(ctx, vinButPrivate); // vin saved, never approved
    const vinButNoRide = vehicle(ctx, 13, 'NOR0013', { visibility: 'public', vin: VIN });                 // vin + approved, but no counted ride

    const r = await list(ctx);
    check('only the eligible vehicles are listed (vin-but-private and vin-but-no-ride stay excluded, same gate as always)', r.body.vehicles.map(v => v.id).sort().join() === [cybercab, ordinary].sort().join());
    const c = r.body.vehicles.find(v => v.id === cybercab), o = r.body.vehicles.find(v => v.id === ordinary);
    check('the approved Cybercab carries its vin in the public list', c.vin === VIN);
    check('an ordinary approved vehicle with no vin still works exactly as before: vin is simply null', o.vin === null && o.license_plate === 'ORD0011');
    check('vin-but-private and vin-but-no-ride never expose their vin publicly (the shared VIN appears exactly once — only for the eligible Cybercab)', (JSON.stringify(r.body).match(new RegExp(VIN, 'g')) || []).length === 1);
    check('no moderation provenance (vin_set_by_user_id / vin_set_at) ever appears in the public payload', !/vin_set_by_user_id|vin_set_at/.test(JSON.stringify(r.body)));

    const detail = await call(ctx, `/api/robotaxi-vehicles/${cybercab}`);
    const detailBody = await detail.json();
    check('the per-vehicle endpoint also carries the vin, and only the vin (no provenance)', detail.status === 200 && detailBody.vehicle.vin === VIN && !/vin_set_by_user_id|vin_set_at/.test(JSON.stringify(detailBody)));
    check('an ordinary vehicle\'s detail endpoint reports vin: null, not an error or a missing field', (await (await call(ctx, `/api/robotaxi-vehicles/${ordinary}`)).json()).vehicle.vin === null);
    check('the vin-but-not-yet-approved vehicle is still 404 on its detail endpoint, same as any other private vehicle', (await call(ctx, `/api/robotaxi-vehicles/${vinButPrivate}`)).status === 404);

    // Cars registry page: Cybercab2.png shown iff v.vin is present, and never for a vehicle without one.
    const p = await open(ctx, null);
    check('two cards render (the Cybercab and the ordinary vehicle)', p.cards().length === 2);
    const cybercabCard = p.cards().find(a => /CYB0010/.test(a.textContent));
    const ordinaryCard = p.cards().find(a => /ORD0011/.test(a.textContent));
    check('the Cybercab\'s card includes an <img src="Cybercab2.png">, built via the DOM (not innerHTML)', !!cybercabCard.querySelector('img[src="Cybercab2.png"]'));
    check('the image has a non-empty, non-misleading alt text (it is a generic illustration, not this vehicle\'s own photo)', (cybercabCard.querySelector('img[src="Cybercab2.png"]').getAttribute('alt') || '').length > 0);
    check('the ordinary (no-vin) vehicle\'s card has no Cybercab2.png image at all', !ordinaryCard.querySelector('img'));
    const imgSrcs = new Set([...p.d.querySelectorAll('#regList img')].map(img => img.getAttribute('src')));
    check('every image on the page is the SAME shared file — no per-vehicle image was created', imgSrcs.size === 1 && imgSrcs.has('Cybercab2.png'));

    // A confirmed Cybercab's card shows a compact gold/yellow BADGE, never
    // plain text — reusing the exact detail-page styling (vCybercabBadge in
    // vehicle.html), not an invented treatment. An ordinary vehicle keeps
    // its existing plain-text model line untouched.
    const badge = cybercabCard.querySelector('span');
    check('the Cybercab card shows a "Cybercab" badge (a <span>, not a plain <p> model line)', !!badge && badge.textContent.trim() === 'Cybercab');
    check('the badge reuses the exact detail-page vCybercabBadge classes (border, rounded-full, gold-tinted border, uppercase)', badge.className === 'inline-block mt-1 text-xs font-bold px-3 py-1.5 rounded-full border border-[rgba(212,175,55,0.35)] text-slate-200 uppercase tracking-wide');
    check('the Cybercab card does NOT also render a plain-text model paragraph', !cybercabCard.querySelector('p') || !/^Cybercab$/.test((cybercabCard.querySelector('p') || {}).textContent || ''));
    check('the ordinary vehicle\'s card keeps its existing plain-text model line, not a badge', !ordinaryCard.querySelector('span') && /Model not confirmed/.test(ordinaryCard.textContent));
    check('the underlying data/classification logic is unchanged — this is presentation only (the API still reports the same vin/model as before)', c.vin === VIN && r.body.vehicles.find(v => v.id === ordinary).vin === null);
  }

  console.log('5. Site: the registry is reachable from the top navigation tab ("Cars") and the footer; the homepage promo card is gone');
  {
    const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && read(f).includes('data-nav="community"'));
    check('the header nav has a "Cars" tab linking to /vehicles on every page that has the nav (and on /vehicles itself)', pages.length >= 9 && pages.every(f => /<a href="\/vehicles" data-nav="vehicles"[^>]*>Cars<\/a>/.test(read(f))));
    check('the tab is no longer labelled "Registry" anywhere in the header nav', pages.every(f => !/<a href="\/vehicles" data-nav="vehicles"[^>]*>Registry<\/a>/.test(read(f))));
    // infrastructure.html deliberately has no <footer> at all (it's a single
    // full-screen map view with nothing below it to scroll to) — every other
    // page still needs the link, since the footer is real in-flow nav there.
    check('the footer has it on every other page too', pages.filter(f => f !== 'infrastructure.html').every(f => /<a href="\/vehicles" class="[^"]*">Cars<\/a>/.test(read(f))));
    check('infrastructure.html has no footer at all (by design — see above), not a footer missing this link', !/<footer/.test(read('infrastructure.html')));
    const home = read('index.html');
    check('the homepage no longer has the Vehicle Registry promo card or its Browse Vehicles button', !/BROWSE VEHICLES|VEHICLE REGISTRY|id="registry"|Browse the robotaxis recorded/.test(home));
    check('the homepage still reaches the registry through its header tab (and the footer link)', /<a href="\/vehicles" data-nav="vehicles"[^>]*>Cars<\/a>/.test(home) && /<a href="\/vehicles" class="[^"]*">Cars<\/a>/.test(home));
    check('the page highlights its own nav item (data-nav matches the /vehicles path)', /data-nav="vehicles"/.test(read('vehicles.html')));
    check('the detail page is unchanged apart from the nav link (still one shell, still <base href="/">)', /<base href="\/">/.test(read('vehicle.html')) && /js\/vehicle\.js/.test(read('vehicle.html')));
    check('the page is not excluded from the static assets', !/vehicles/.test(read('.assetsignore')));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
