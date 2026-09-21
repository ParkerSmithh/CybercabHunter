// Tests for the "Community Sightings" section of the public vehicle page
// (vehicle.html + js/vehicle.js, Phase 3D-D). The REAL page script runs in
// jsdom against the REAL Worker and real SQL; sightings are created through
// the real submit endpoint and approved through the real moderator endpoint.
// Layout (overflow at 390–1280px) is verified separately with a headless
// browser — jsdom does no layout.
// Run: node tests/vehicle-sightings-ui.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, approveVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}vehicle.html`, 'utf8');
const JS = fs.readFileSync(`${ROOT}js/vehicle.js`, 'utf8');

async function makeApp(users) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role && role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  return ctx;
}

function call(ctx, method, path, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}

async function approvedSighting(ctx, userId, fields, date) {
  const s = await (await call(ctx, 'POST', '/api/vehicle-sightings', userId, { service_area: 'Dallas', ...fields })).json();
  if (date) {
    ctx.d1.exec(`UPDATE submissions SET submitted_at = '${date} 15:30:45' WHERE id = '${s.submission_id}'`);
    ctx.d1.exec(`UPDATE vehicle_observations SET created_at = '2000-01-01 00:00:00' WHERE submission_id = '${s.submission_id}'`);
  }
  await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${s.submission_id}`, 'mod', { action: 'approve' });
  return s;
}

// `intercept(path, init)` may return a Response / a promise / throw to simulate server behavior.
async function openPage(env, vehicleId, intercept, { settle = true } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: `https://cybercabhunter.com/vehicle/${vehicleId}`, pretendToBeVisual: true });
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
    entries: () => [...d.querySelectorAll('#vSightingsList > li')],
    async waitFor(cond, label, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); }
      console.log(`    (timed out waiting for: ${label})`);
      return false;
    }
  };
  if (settle) {
    await page.waitFor(() => page.visible('vehicleLoaded') || page.visible('vehicleNotFound') || page.visible('vehicleError'), 'vehicle to load');
    await page.waitFor(() => !page.visible('vSightingsLoading'), 'sightings to settle');
  }
  return page;
}

const sightingsPath = id => `/api/robotaxi-vehicles/${id}/sightings`;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

async function run() {
  console.log('1. The section renders on the vehicle page with its disclaimer, separate from Recorded Ride History');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195', service_area: 'Dallas' }, '2026-09-18');
    const page = await openPage(ctx.env, v);
    const section = page.d.getElementById('vSightingsSection');
    check('a distinct Community Sightings section exists inside the loaded view', !!section && page.d.getElementById('vehicleLoaded').contains(section));
    check('it has its own heading', /Community Sightings/.test(section.querySelector('h2').textContent));
    check('the copy says these are community reports, separate from recorded rides', /Community-reported observations of this vehicle/.test(section.textContent) && /separate from recorded rides/.test(section.textContent));
    check('the copy warns it does not necessarily mean the vehicle was operating', /do not necessarily indicate that the vehicle was operating at the reported time/.test(section.textContent));
    check('it is not inside the Recorded Ride History card', !page.d.getElementById('vTripCount').closest('.glass').contains(section));

    check('the approved sighting renders as "Dallas · September 18, 2026"', page.entries().length === 1 && /Dallas · September 18, 2026/.test(page.entries()[0].textContent));
    check('each entry is labeled "Community sighting"', /Community sighting/.test(page.entries()[0].textContent));
    check('the list is visible and the other states are not', page.visible('vSightingsList') && !page.visible('vSightingsEmpty') && !page.visible('vSightingsError') && !page.visible('vSightingsLoading'));
    check('the rest of the vehicle page still rendered', page.text('vLicensePlate') === 'XJR2195');
  }

  console.log('2. Multiple entries, newest first; long-form dates do not shift with timezone');
  {
    const ctx = await makeApp({ a: 'user', b: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'a', { license_plate: 'XJR2195', service_area: 'Austin' }, '2026-01-01');
    await approvedSighting(ctx, 'b', { license_plate: 'XJR2195', service_area: 'Houston' }, '2026-12-31');
    const page = await openPage(ctx.env, v);
    check('newest first', /Houston · December 31, 2026/.test(page.entries()[0].textContent) && /Austin · January 1, 2026/.test(page.entries()[1].textContent));
  }

  console.log('3. Empty state');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const page = await openPage(ctx.env, v);
    check('shows "No approved community sightings recorded yet."', page.visible('vSightingsEmpty') && /No approved community sightings recorded yet\./.test(page.text('vSightingsEmpty')));
    check('no list, no error, no skeleton', !page.visible('vSightingsList') && !page.visible('vSightingsError') && !page.visible('vSightingsLoading'));
    check('empty is not an error: the vehicle card is fine', page.visible('vehicleLoaded') && !page.visible('vehicleError'));
  }

  console.log('4. Loading skeleton while the request is in flight');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    let release;
    const gate = new Promise(r => { release = r; });
    const page = await openPage(ctx.env, v, async path => { if (path === sightingsPath(v)) { await gate; return json({ sightings: [] }); } return null; }, { settle: false });
    await page.waitFor(() => page.visible('vehicleLoaded'), 'vehicle card');
    check('the vehicle page is usable while sightings are still loading', page.text('vLicensePlate') === 'XJR2195');
    check('the sightings skeleton is shown meanwhile', page.visible('vSightingsLoading') && !page.visible('vSightingsEmpty') && !page.visible('vSightingsList'));
    release();
    await page.waitFor(() => page.visible('vSightingsEmpty'), 'empty state after load');
    check('the skeleton goes away once loaded', !page.visible('vSightingsLoading'));
  }

  console.log('5. A sightings failure is non-blocking: the rest of the vehicle page keeps working');
  {
    const ctx = await makeApp({ rider: 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider', { license_plate: 'XJR2195' }, '2026-09-18');
    const failures = {
      '500 response': () => new Response('{"success":false}', { status: 500 }),
      'network failure': () => Promise.reject(new TypeError('down')),
      'malformed JSON': () => new Response('<html>oops', { status: 200 }),
      'unexpected shape': () => json({ nope: true })
    };
    for (const [label, make] of Object.entries(failures)) {
      const page = await openPage(ctx.env, v, path => (path === sightingsPath(v) ? make() : null));
      check(`${label}: the section shows its own error state`, page.visible('vSightingsError') && !page.visible('vSightingsList') && !page.visible('vSightingsEmpty'));
      check(`${label}: the whole page did NOT go to the error state and the vehicle still shows`, page.visible('vehicleLoaded') && !page.visible('vehicleError') && page.text('vLicensePlate') === 'XJR2195' && page.text('vTripCount') === '1');
      check(`${label}: no raw server text is shown`, !/oops|success|status/i.test(page.text('vSightingsError')));
    }
    let calls = 0;
    const page = await openPage(ctx.env, v, path => { if (path === sightingsPath(v)) { calls++; return calls === 1 ? new Response('x', { status: 500 }) : null; } return null; });
    check('first attempt failed into the error state', page.visible('vSightingsError'));
    page.click(page.d.getElementById('vSightingsRetry'));
    await page.waitFor(() => page.visible('vSightingsList'), 'retry to succeed');
    check('"Try again" re-fetches only sightings and then shows the entries', calls === 2 && page.entries().length === 1 && page.requests.filter(r => r.path === `/api/robotaxi-vehicles/${v}`).length === 1);
  }

  console.log('6. XSS: hostile strings from the API are inert text');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const hostile = '<img src=x onerror=alert(1)><script>window.__pwned=1</script>';
    const page = await openPage(ctx.env, v, path => (path === sightingsPath(v) ? json({ sightings: [{ date: '2026-09-18', service_area: hostile }, { date: hostile, service_area: 'Dallas' }] }) : null));
    check('no img/script element was created from the API data', page.d.querySelectorAll('#vSightingsList img, #vSightingsList script').length === 0);
    check('the hostile text is shown literally', page.d.getElementById('vSightingsList').textContent.includes(hostile));
    check('nothing executed', page.w.__pwned === undefined);
    check('a malformed date renders nothing for the date rather than "Invalid Date"', !/Invalid Date|NaN/.test(page.d.getElementById('vSightingsList').textContent));
  }

  console.log('7. Long service-area strings are given wrapping rules (layout verified in a real browser separately)');
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    const long = 'A'.repeat(300);
    const page = await openPage(ctx.env, v, path => (path === sightingsPath(v) ? json({ sightings: [{ date: '2026-09-18', service_area: long }] }) : null));
    check('the entry renders the long value', page.entries()[0].textContent.includes(long));
    check('the entry opts in to anywhere-wrapping so it cannot force horizontal scroll', /overflow-wrap:anywhere/.test(page.entries()[0].className));
  }

  console.log('8. Privacy and request hygiene');
  {
    const ctx = await makeApp({ 'rider-secret': 'user', mod: 'moderator' });
    const v = await db.findOrCreateRobotaxiVehicleByPlate(ctx.d1, 'XJR2195');
    approveVehicle(ctx.d1, v, { withRide: true });
    await approvedSighting(ctx, 'rider-secret', {
      license_plate: 'XJR2195', service_area: 'Dallas', approx_location: 'SECRET-LOCATION', notes: 'SECRET-NOTES', model: 'SecretModel', color: 'SecretColor'
    }, '2026-09-18');
    const page = await openPage(ctx.env, v);
    const html = page.d.getElementById('vSightingsSection').innerHTML;
    check('no submitter id, location, notes, model/color, or moderation detail appears in the section', !/rider-secret|SECRET|mod\b|reviewed|evidence/i.test(html.replace(/moderat/gi, '')));
    check('no time of day is shown', !/\d{1,2}:\d{2}/.test(page.text('vSightingsSection')));
    const others = page.requests.filter(r => r.path !== `/api/robotaxi-vehicles/${v}`);
    check('the only extra request is the public sightings endpoint', others.length === 1 && others[0].path === sightingsPath(v));
    check('no request carries an Authorization header', page.requests.every(r => !r.headers.Authorization));
  }
  {
    const ctx = await makeApp({ mod: 'moderator' });
    const page = await openPage(ctx.env, '11111111-1111-1111-1111-111111111111');
    check('a vehicle that 404s never requests sightings and shows the not-found view', page.visible('vehicleNotFound') && !page.requests.some(r => r.path.endsWith('/sightings')));
  }

  console.log('9. Page shell: assets and links must resolve correctly when the page is served at /vehicle/<id>');
  {
    // Regression: vehicle.html is served at /vehicle/<id> by the Worker, so without
    // <base href="/"> its relative js/css/nav URLs resolved to /vehicle/js/vehicle.js
    // etc. — which do not exist. jsdom tests that eval() the script directly cannot
    // notice that; resolving every URL the way a browser would can.
    const id = '0c617f6a-969a-4610-8025-f4f2e4f395ea';
    const dom = new JSDOM(HTML, { url: `https://cybercabhunter.com/vehicle/${id}` });
    const d = dom.window.document;
    const urls = [...d.querySelectorAll('script[src], link[href], a[href], img[src]')]
      .map(el => el.getAttribute('src') || el.getAttribute('href'))
      .filter(u => u && !/^(https?:|mailto:|data:|#)/.test(u))
      .map(u => new URL(u, d.baseURI));
    check('there are relative URLs to check (script, css, nav links, images)', urls.length > 10);
    check('none of them resolve underneath /vehicle/ (which would 404)', urls.every(u => !u.pathname.startsWith('/vehicle/')));
    const script = urls.find(u => /vehicle\.js$/.test(u.pathname));
    check('the page script resolves to the real static file /js/vehicle.js', !!script && script.pathname === '/js/vehicle.js');
    check('the stylesheet resolves to /css/style.css', urls.some(u => u.pathname === '/css/style.css'));
    check('the header has no "Link Tesla Account" button (it made the shared header wider than a 390px viewport)', !d.getElementById('teslaLinkBtn'));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
