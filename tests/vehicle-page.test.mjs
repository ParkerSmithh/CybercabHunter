// Tests for the public vehicle page (vehicle.html + js/vehicle.js) and the
// /vehicle/:id worker route that serves it. The REAL js/vehicle.js runs in
// jsdom against the REAL Worker code and real SQL (node:sqlite + the
// project's migrations) — fetch() is routed straight into worker.fetch, so
// what the page shows is what the public API actually returned.
// Layout/CSS is verified separately with a headless-browser probe (see the
// responsive section at the bottom of this file's report, not exercised by
// jsdom itself).
// Run: node tests/vehicle-page.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { seedRide, approveVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}vehicle.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}js/vehicle.js`, 'utf8');

// Opens the page for a given vehicle id (as if navigated to /vehicle/<id>
// directly). `intercept(url, init)` may return a Response (or throw) to
// simulate a failing server; otherwise the request goes to the real Worker.
async function openPage(env, vehicleId, intercept) {
  const url = vehicleId == null ? 'https://cybercabhunter.com/vehicle.html' : `https://cybercabhunter.com/vehicle/${vehicleId}`;
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url, pretendToBeVisual: true });
  const w = dom.window;
  const requests = [];
  w.fetch = async (fetchUrl, init = {}) => {
    const path = String(fetchUrl).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
    requests.push({ path, headers: init.headers || {} });
    if (intercept) { const r = await intercept(path, init); if (r) return r; }
    return worker.fetch(new Request(`https://x${path}`, init), env, {});
  };
  w.eval(JS);
  const d = w.document;
  const page = {
    w, d, requests,
    text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    visible: id => !d.getElementById(id).classList.contains('hidden'),
    click: el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  await page.waitFor(() => !page.visible('vehicleLoading'), 'page to settle past loading');
  return page;
}

async function run() {
  console.log('1. Worker routing: /vehicle/:id serves vehicle.html\'s content without a redirect');
  {
    // A stand-in for the real static-assets binding that behaves like Cloudflare's default
    // html handling ("auto-trailing-slash"): the extensionless path serves the file with a 200,
    // while the ".html" path is answered with a 307 redirect to the extensionless one. (A stub
    // that returned the page for ANY path is what let a 307 slip through to production.)
    const requested = [];
    const ASSETS = { fetch: async req => {
      const path = new URL(req.url).pathname;
      requested.push(path);
      if (path === '/vehicle') return new Response('<html>vehicle shell</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      if (path === '/vehicle.html') return new Response(null, { status: 307, headers: { Location: new URL('/vehicle', req.url).href } });
      return new Response('not found', { status: 404 });
    } };
    const fakeEnv = { ASSETS };
    const ids = ['0ac4f010-b852-4ae3-a064-7b2b92b7d6db', '1cda265e-c1e3-4b72-9db4-3ff13a6aeaef', '2412b9ff-c5cc-4dd2-a889-9252e60e9edd', '5b040cd5-4d98-430b-9c38-cae74ed6a691', '0c617f6a-969a-4610-8025-f4f2e4f395ea'];
    for (const id of ids) {
      requested.length = 0;
      const resp = await worker.fetch(new Request(`https://cybercabhunter.com/vehicle/${id}`), fakeEnv, {});
      check(`/vehicle/${id.slice(0, 8)}…: 200, served without a 3xx redirect and with no Location header`, resp.status === 200 && resp.headers.get('Location') === null);
      check('it asked the assets for the canonical /vehicle (not /vehicle.html, which redirects)', requested.join() === '/vehicle');
      check('the response body is the page shell', (await resp.text()).includes('vehicle shell'));
    }
    const noRedirectPast = await worker.fetch(new Request('https://cybercabhunter.com/vehicle/0ac4f010-b852-4ae3-a064-7b2b92b7d6db?ref=share'), fakeEnv, {});
    check('a query string on the page URL does not break it', noRedirectPast.status === 200);
    const bare = await worker.fetch(new Request('https://cybercabhunter.com/vehicle'), fakeEnv, {});
    check('the existing /vehicle route still falls through to the static page (200)', bare.status === 200 && (await bare.text()).includes('vehicle shell'));
    const dotHtml = await worker.fetch(new Request('https://cybercabhunter.com/vehicle.html'), fakeEnv, {});
    check('/vehicle.html is untouched by the Worker (the assets\' own redirect to /vehicle)', dotHtml.status === 307 && dotHtml.headers.get('Location') === 'https://cybercabhunter.com/vehicle');
    const post = await worker.fetch(new Request('https://cybercabhunter.com/vehicle/0ac4f010-b852-4ae3-a064-7b2b92b7d6db', { method: 'POST' }), fakeEnv, {});
    check('only GET is routed to the page (a POST is not served the shell)', !(post.status === 200 && (await post.text()).includes('vehicle shell')));
  }
  {
    // An unrelated path is unaffected by the new route.
    let calledAssets = false;
    const fakeEnv = { ASSETS: { fetch: async () => { calledAssets = true; return new Response('root', { status: 200 }); } } };
    const resp = await worker.fetch(new Request('https://x/community.html'), fakeEnv, {});
    check('a normal static page still falls through to ASSETS unchanged', resp.status === 200 && calledAssets);
  }

  console.log('2. Rendering: vehicle identity — a simplified header (plate + eyebrow only; VIN when present), no model/color/provider/service-area/verification/first-seen/last-seen clutter');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id, { withRide: true });
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    check('the loaded view is shown, no error/not-found/invalid state', page.visible('vehicleLoaded') && !page.visible('vehicleError') && !page.visible('vehicleNotFound') && !page.visible('vehicleInvalid'));
    check('license plate renders', page.text('vLicensePlate') === 'XJR2195');
    check('an ordinary vehicle with no vin keeps the generic "Robotaxi Vehicle" eyebrow label (never "Cybercab" unless a moderator actually verified one)', page.text('vEyebrow') === 'Robotaxi Vehicle');
    check('no VIN is shown, and no Cybercab image, for a vehicle with no vin', !page.visible('vVinInline') && !page.visible('vCybercabImage'));
    check('the header no longer shows model, provider, color, service area, verification, or first/last seen — that clutter was removed', !/Not independently verified|Provider|Model not confirmed|First Seen|Last Seen/.test(page.d.getElementById('vehicleLoaded').textContent));
  }

  console.log('2b. Rendering: model/color/service_area may still be populated in the database (Candidate A / approve_cybercab), but the simplified header never displays them — a regression guard against that clutter quietly coming back');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id, { withRide: true });
    d1.exec(`UPDATE robotaxi_vehicles SET model = 'Model Y', color = 'Pearl White', service_area = 'Austin' WHERE id = '${id}'`);
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    check('populated model/color/service_area values do not leak into the simplified header', !/Model Y|Pearl White|Austin/.test(page.d.getElementById('vehicleLoaded').textContent));
    check('the plate and eyebrow still render normally alongside the now-unused fields', page.text('vLicensePlate') === 'XJR2195' && page.text('vEyebrow') === 'Robotaxi Vehicle');
  }

  console.log('3. Rendering: recorded ride history, including a vehicle with zero rides (honest, not fabricated)');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, { userId: 'u1', vehicleId: id, rideDate: '2026-06-09', distance: 2.8, serviceArea: 'Dallas' });
    seedRide(d1, { userId: 'u1', vehicleId: id, rideDate: '2026-06-15', distance: 3.4, serviceArea: 'Dallas' });
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    check('rides recorded shows the real count', page.text('vTripCount') === '2');
    check('recorded distance sums correctly', page.text('vTotalDistance') === '6.2 mi');
    check('first/latest recorded ride render as dates', page.text('vFirstRide') === 'Jun 9, 2026' && page.text('vLastRide') === 'Jun 15, 2026');
    check('the service-areas note lists the recorded city', /Dallas/.test(page.text('vServiceAreasNote')));
  }
  {
    // Phase 3E: a vehicle with NO counted rides is not public at all, so it
    // can no longer be shown with a "0 rides" history — it is simply not found.
    // What remains is a counted ride that has no distance/date/area recorded.
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'ZZZ0000');
    approveVehicle(d1, id);
    const none = await openPage({ cybercabhunter_db: d1 }, id);
    check('an approved vehicle with no counted rides is not public: the page shows not-found, not a "0 rides" vehicle', none.visible('vehicleNotFound') && !none.visible('vehicleLoaded'));

    seedRide(d1, { userId: 'u1', vehicleId: id, distance: null, rideDate: null, serviceArea: null });
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    check('a vehicle whose counted ride has no details still loads normally (not an error)', page.visible('vehicleLoaded'));
    check('rides recorded shows the real count of 1', page.text('vTripCount') === '1');
    check('distance/first/last ride show the missing-data dash, never 0 or a fake date', page.text('vTotalDistance') === '—' && page.text('vFirstRide') === '—' && page.text('vLastRide') === '—');
    check('the service-areas note says none is recorded, not a blank line', /No service area recorded/i.test(page.text('vServiceAreasNote')));
  }
  {
    // Multiple service areas across different riders — the GROUP_CONCAT list.
    const d1 = createTestD1(); seedUser(d1, 'rider-a'); seedUser(d1, 'rider-b');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, { userId: 'rider-a', vehicleId: id, rideDate: '2026-06-01', serviceArea: 'Dallas' });
    seedRide(d1, { userId: 'rider-b', vehicleId: id, rideDate: '2026-06-02', serviceArea: 'Austin' });
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    check('multiple service areas are both listed', /Dallas/.test(page.text('vServiceAreasNote')) && /Austin/.test(page.text('vServiceAreasNote')));
  }

  console.log('4. API behavior: 404, malformed id, and network/server failure each get their own distinct UI');
  {
    const d1 = createTestD1();
    const page = await openPage({ cybercabhunter_db: d1 }, '11111111-1111-1111-1111-111111111111');
    check('a well-formed but nonexistent id shows "Vehicle not found", not an error or invalid-link message', page.visible('vehicleNotFound') && !page.visible('vehicleError') && !page.visible('vehicleInvalid'));
    check('the not-found state offers a way back, not a raw API error dump', /back to cybercab hunter/i.test(page.d.getElementById('vehicleNotFound').textContent) && !/"success":false|"error":"not_found"/.test(page.d.getElementById('vehicleNotFound').innerHTML));
  }
  {
    const d1 = createTestD1();
    const page = await openPage({ cybercabhunter_db: d1 }, 'not-a-real-uuid');
    check('a malformed id (API 400) shows the invalid-link state, not a crash or a generic error', page.visible('vehicleInvalid') && !page.visible('vehicleError'));
  }
  {
    const page = await openPage({}, null); // vehicle.html loaded directly, no /vehicle/:id segment at all
    check('loading the page with no id in the URL at all also shows the invalid-link state, with no network request made', page.visible('vehicleInvalid') && page.requests.length === 0);
  }
  {
    const d1 = createTestD1();
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    const page = await openPage({ cybercabhunter_db: d1 }, id, () => { throw new TypeError('network down'); });
    check('a network failure shows a friendly error state, not a stack trace', page.visible('vehicleError') && /check your connection/i.test(page.text('vehicleErrorDetail')));
    check('no internal exception text leaks into the error message', !/TypeError|network down|at\s+\S+\.js:\d+/i.test(page.text('vehicleErrorDetail')));
  }
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id, { withRide: true });
    let calls = 0;
    // First call fails (simulating a server hiccup); the retry click's call
    // is let through to the real worker, simulating the server recovering.
    const intercept = (path) => {
      // Only the vehicle endpoint itself, not the separate /sightings one.
      if (!/\/api\/robotaxi-vehicles\/[^/]+$/.test(path)) return null;
      calls += 1;
      return calls === 1 ? new Response('{"success":false}', { status: 500 }) : null;
    };
    const page = await openPage({ cybercabhunter_db: d1 }, id, intercept);
    check('a 500 from the server shows the error state with a clean, non-raw message', page.visible('vehicleError') && /code 500/.test(page.text('vehicleErrorDetail')) && !/"success":false/.test(page.text('vehicleErrorDetail')));
    page.click(page.d.getElementById('vehicleRetry'));
    await page.waitFor(() => page.visible('vehicleLoaded'), 'retry to succeed');
    check('clicking Try again re-fetches and, once it succeeds, shows the loaded vehicle', page.visible('vehicleLoaded') && page.text('vLicensePlate') === 'XJR2195');
    check('the retry actually made a second request', calls === 2);
  }

  console.log('5. Privacy: only the public endpoint is ever called, and no private/rider material appears anywhere on the page');
  {
    const d1 = createTestD1(); seedUser(d1, 'user-first'); seedUser(d1, 'user-second');
    const id = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'XJR2195');
    approveVehicle(d1, id);
    seedRide(d1, {
      userId: 'user-first', vehicleId: id, fare: 692,
      pickupDescription: '4301 Hanover St, Dallas, TX 75225', dropoffDescription: 'NorthPark Center, Dallas'
    });
    seedRide(d1, { userId: 'user-second', vehicleId: id, fare: 810, rideDate: '2026-07-01' });
    const page = await openPage({ cybercabhunter_db: d1 }, id);
    await page.waitFor(() => !page.visible('vSightingsLoading'), 'sightings section to settle');
    check('exactly one request was made to the public vehicle endpoint', page.requests.filter(r => r.path === `/api/robotaxi-vehicles/${id}`).length === 1);
    check('the only other request is the public sightings endpoint — nothing else is called', page.requests.length === 2 && page.requests[1].path === `/api/robotaxi-vehicles/${id}/sightings`);
    check('no Authorization header was ever sent — this page never authenticates', page.requests.every(r => !r.headers.Authorization));
    check('no private endpoints were called (/api/profile, /api/trips, /api/tesla/*)', !page.requests.some(r => /\/api\/(profile|trips|tesla|me)\b/.test(r.path)));
    const rendered = page.d.body.innerHTML;
    check('no rider id string leaks into the rendered page', !/user-first|user-second/.test(rendered));
    check('no pickup/dropoff address text leaks into the rendered page', !/Hanover|NorthPark/i.test(rendered));
    check('no fare/dollar figure appears anywhere on the page', !/\$6\.92|\$8\.10|692|810/.test(rendered.replace(/2026|2795/g, '')));
    // This vehicle was never given a vin (approveVehicle above passes none),
    // so the inline VIN/image must stay hidden and empty — a "VIN" LABEL existing
    // in the page's static markup is fine (see 5b below for a vehicle that
    // DOES have one), but no vin VALUE, and no session/token material, may
    // ever appear.
    check('the inline VIN and Cybercab image stay hidden for a vehicle with no vin', !page.visible('vVinInline') && !page.visible('vCybercabImage') && page.text('vVin') === '');
    check('no session/token material appears anywhere on the page', !/access_token|refresh_token|\bsession\b/i.test(rendered));
  }

  console.log('5b. VIN: shown only when the vehicle has one — Cybercab Hunter never derives or decodes it, only displays what a moderator saved');
  {
    const d1 = createTestD1(); seedUser(d1, 'u1');
    const noVinId = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'ORD0011');
    approveVehicle(d1, noVinId, { withRide: true });
    const noVinPage = await openPage({ cybercabhunter_db: d1 }, noVinId);
    check('an ordinary approved vehicle with no vin: existing behavior is completely unchanged — VIN and image both hidden, eyebrow stays "Robotaxi Vehicle"', noVinPage.visible('vehicleLoaded') && !noVinPage.visible('vVinInline') && !noVinPage.visible('vCybercabImage') && noVinPage.text('vEyebrow') === 'Robotaxi Vehicle');

    const VIN = '5YJSA1E14FF101183';
    const cybercabId = await db.findOrCreateRobotaxiVehicleByPlate(d1, 'CYB0010');
    approveVehicle(d1, cybercabId, { withRide: true });
    d1.exec(`UPDATE robotaxi_vehicles SET vin = '${VIN}' WHERE id = '${cybercabId}'`);
    const page = await openPage({ cybercabhunter_db: d1 }, cybercabId);
    check('a vehicle with a vin: it is shown inline (next to the plate), rendering the exact value', page.visible('vVinInline') && page.text('vVin') === VIN);
    check('the eyebrow label says "Cybercab" once a moderator-verified vin is present', page.text('vEyebrow') === 'Cybercab');
    check('the generic Cybercab image is shown alongside it', page.visible('vCybercabImage'));
    const img = page.d.getElementById('vCybercabImage');
    check('the image points at the one shared, existing Cybercab2.png file — never a per-vehicle image', img.getAttribute('src') === 'Cybercab2.png');
    check('the alt text does not claim to be a photo of this specific vehicle', !new RegExp(VIN).test(img.getAttribute('alt') || '') && (img.getAttribute('alt') || '').length > 0);
    check('the plate still renders normally alongside the VIN', page.text('vLicensePlate') === 'CYB0010');
    check('still no session/token material leaks, even with a vin present', !/access_token|refresh_token|\bsession\b/i.test(page.d.body.innerHTML));
  }

  console.log('6. XSS: hostile-looking vehicle fields render as inert text, never as markup');
  {
    const d1 = createTestD1();
    const hostile = '<img src=x onerror=alert(1)>';
    const hostileId = '12345678-1234-1234-1234-1234567890ab'; // must be UUID-shaped or the endpoint 400s before ever rendering
    // Direct SQL insert bypasses findOrCreateRobotaxiVehicleByPlate's plate
    // normalization AND the moderator vin endpoint's format validation on
    // purpose (a raw INSERT can hold any string) — the page itself, not an
    // upstream sanitizer, must be what makes this safe.
    const esc = s => s.replace(/'/g, "''");
    d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, vin, first_seen_at, last_seen_at, visibility)
             VALUES ('${hostileId}', '${esc(hostile)}', '${esc(hostile)}', datetime('now'), datetime('now'), 'public')`);
    seedUser(d1, 'u1');
    seedRide(d1, { userId: 'u1', vehicleId: hostileId, status: 'pending' }); // public eligibility needs a counted ride
    const page = await openPage({ cybercabhunter_db: d1 }, hostileId);
    check('the page loads normally rather than erroring on hostile content', page.visible('vehicleLoaded'));
    check('no actual <img onerror> element was created from the hostile string — it never became markup (the page has 2 legitimate logo <img> tags, neither with onerror)', page.d.querySelectorAll('img[onerror]').length === 0);
    check('the hostile plate renders as literal, inert text content', page.text('vLicensePlate') === hostile);
    check('the hostile vin renders as literal, inert text content too, shown inline next to the plate', page.visible('vVinInline') && page.text('vVin') === hostile);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
