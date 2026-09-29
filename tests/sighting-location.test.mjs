// Tests for real-place Locations and new-plate registry entries on photo
// sightings: GET /api/places (worker/places.js, Photon stubbed by
// helpers/places.mjs), server-side verification of the picked place, the
// public street+city display, the private registry vehicle created for a
// plate that isn't registered yet, and the drawer's autocomplete (jsdom).
// Run: node tests/sighting-location.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { installPhotonStub, placeIdFor, photon, HANOVER } from './helpers/places.mjs';
import { publicLocation } from '../worker/places.js';
import worker from '../worker/index.js';

installPhotonStub();

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider', 'mod'] });
  for (const id of ['rider', 'mod']) await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  return ctx;
}

const req = (ctx, method, path, { user, body, headers = {} } = {}) => {
  const h = { ...headers };
  if (user) h.Authorization = `Bearer session-${user}`;
  return worker.fetch(new Request(`https://x${path}`, { method, headers: h, body }), ctx.env, {});
};

async function submit(ctx, fields) {
  const fd = new FormData();
  fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  const res = await req(ctx, 'POST', '/api/vehicle-sightings/photo', { user: 'rider', body: fd });
  return { status: res.status, json: await res.json() };
}

const stored = ctx => ({ subs: ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n, objects: ctx.env.EVIDENCE_BUCKET._objects.size });

async function run() {
  console.log('1. GET /api/places — suggestions from the place search, signed in only');
  {
    const ctx = await makeApp();
    check('signed out: 401', (await req(ctx, 'GET', '/api/places?q=hanover')).status === 401);
    const short = await req(ctx, 'GET', '/api/places?q=ab', { user: 'rider' });
    check('under 3 characters: no search, empty list', short.status === 200 && (await short.json()).places.length === 0);
    photon.calls.length = 0;
    const res = await req(ctx, 'GET', '/api/places?q=4016%20hanover%20street%20dallas', { user: 'rider' });
    const body = await res.json();
    check('a street address comes back as a suggestion, with a readable label', res.status === 200 && body.places[0].id === HANOVER.id && body.places[0].label === HANOVER.label && body.places[0].city === 'Dallas');
    check('each suggestion has only id, label and city', body.places.every(p => Object.keys(p).sort().join() === 'city,id,label'));
    const call = photon.calls[0];
    check('the search is limited to the United States and identifies the site', call && call.searchParams.get('bbox') === '-125.0,24.0,-66.5,49.5');
    check('an over-long query: 400', (await req(ctx, 'GET', `/api/places?q=${'x'.repeat(121)}`, { user: 'rider' })).status === 400);
    photon.failing = true;
    const down = await req(ctx, 'GET', '/api/places?q=hanover', { user: 'rider' });
    check('the place search being down: 502 places_unavailable', down.status === 502 && (await down.json()).error === 'places_unavailable');
    photon.failing = false;
  }

  console.log('2. A submitted Location must be a real, picked place (checked on the server)');
  {
    const ctx = await makeApp();
    const typed = await submit(ctx, { approx_location: 'my made up place' });
    check('typed text without a picked place: 400 invalid_location, nothing stored', typed.status === 400 && typed.json.error === 'invalid_location' && stored(ctx).subs === 0 && stored(ctx).objects === 0);
    const wrong = await submit(ctx, { approx_location: 'Hanover Street', location_id: 'N:999' });
    check('a place id the search does not confirm: 400 invalid_location', wrong.status === 400 && wrong.json.error === 'invalid_location');
    const malformed = await submit(ctx, { approx_location: 'Hanover Street', location_id: '../etc' });
    check('a malformed place id: 400 invalid_location', malformed.status === 400 && malformed.json.error === 'invalid_location');
    photon.failing = true;
    const down = await submit(ctx, { approx_location: 'Hanover Street', location_id: HANOVER.id });
    photon.failing = false;
    check('the place search being down: 502 location_unavailable, nothing stored', down.status === 502 && down.json.error === 'location_unavailable' && stored(ctx).subs === 0 && stored(ctx).objects === 0);
    check('no location at all is still fine (it is optional)', (await submit(ctx, {})).status === 201);

    const ok = await submit(ctx, { approx_location: '4016 hanover st dallas', location_id: HANOVER.id, service_area: 'Dallas' });
    const obs = ctx.d1.query('SELECT approx_location FROM vehicle_observations WHERE id = ?', ok.json.observation_id)[0];
    check('a picked place is accepted and stored with the place search\'s OWN label, not the typed text', ok.status === 201 && obs.approx_location === HANOVER.label);

    // Moderators see the full address; the public gallery never shows the house number.
    await req(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${ok.json.submission_id}`, { user: 'mod', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    const gallery = await (await req(ctx, 'GET', '/api/sightings')).json();
    check('the public gallery shows only the street and city: "Hanover Street, Dallas"', gallery.sightings[0].location === 'Hanover Street, Dallas' && !JSON.stringify(gallery).includes('4016'));
  }
  {
    check('publicLocation: drops a house number, keeps street/place + city', publicLocation('4016 Hanover Street, Dallas, TX') === 'Hanover Street, Dallas' && publicLocation('12B Main St, Austin, TX') === 'Main St, Austin' && publicLocation('NorthPark Center, Dallas, TX') === 'NorthPark Center, Dallas' && publicLocation('Dallas, TX') === 'Dallas, TX' && publicLocation('7-Eleven, Austin, TX') === '7-Eleven, Austin' && publicLocation('') === null);
  }

  console.log('3. A plate not in the registry creates a private registry vehicle for moderator review');
  {
    const ctx = await makeApp();
    const first = await submit(ctx, { license_plate: 'new-9001', service_area: 'Austin' });
    const v = ctx.d1.query('SELECT * FROM robotaxi_vehicles');
    check('one registry vehicle, PRIVATE, origin "sighting", with the normalized plate and city', v.length === 1 && v[0].license_plate === 'NEW9001' && v[0].visibility === 'private' && v[0].origin === 'sighting' && v[0].service_area === 'Austin');
    check('the sighting is linked to it and stays pending', ctx.d1.query('SELECT o.robotaxi_vehicle_id, s.status FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id WHERE s.id = ?', first.json.submission_id)[0].status === 'pending');
    check('it is not public', (await req(ctx, 'GET', `/api/robotaxi-vehicles/${v[0].id}`)).status === 404);
    const modList = await (await req(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', { user: 'mod' })).json();
    check('it is in the moderation page\'s registry list, awaiting a moderator', (modList.vehicles || []).some(x => x.id === v[0].id && x.license_plate === 'NEW9001'));
    check('it is also still in the review queue as a sighting', (await (await req(ctx, 'GET', '/api/moderation/vehicle-sightings', { user: 'mod' })).json()).sightings.some(s => s.submission_id === first.json.submission_id));

    const dup = await submit(ctx, { license_plate: 'NEW 9001' });
    check('the same plate again right away: a duplicate, still one vehicle', dup.json.duplicate === true && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
  }
  {
    const ctx = await makeApp();
    const existing = await submit(ctx, { license_plate: 'REG0001' });
    const vid = ctx.d1.query('SELECT id FROM robotaxi_vehicles')[0].id;
    await new Promise(r => setTimeout(r, 5));
    ctx.d1.exec(`UPDATE vehicle_observations SET created_at = datetime('now', '-10 minutes')`);   // past the 2-minute duplicate window
    const again = await submit(ctx, { license_plate: 'REG0001' });
    check('a plate already in the registry: linked to that vehicle, no new one', again.status === 201 && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1 && ctx.d1.query('SELECT robotaxi_vehicle_id FROM vehicle_observations WHERE id = ?', again.json.observation_id)[0].robotaxi_vehicle_id === vid && existing.status === 201);
    await submit(ctx, {});
    check('no plate: no registry vehicle', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
  }

  console.log('4. The drawer: type, pick from the suggestions, submit');
  {
    const ctx = await makeApp();
    const HTML = fs.readFileSync(`${ROOT}public/sightings.html`, 'utf8');
    const COMBINED = `${fs.readFileSync(`${ROOT}public/js/calc.js`, 'utf8')}\n${fs.readFileSync(`${ROOT}public/js/main.js`, 'utf8')}\nCCC.init();`;
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/sightings', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-rider');
    const sent = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      let body = init.body;
      if (body instanceof w.FormData) {
        const fd = new FormData();
        for (const [k, v] of body.entries()) fd.append(k, typeof v === 'string' ? v : new File([new Uint8Array(await v.arrayBuffer())], v.name, { type: v.type }));
        const fields = {}; for (const [k, v] of body.entries()) fields[k] = typeof v === 'string' ? v : '[file]';
        sent.push(fields);
        body = fd;
      }
      return worker.fetch(new Request(`https://x${path}`, { ...init, body }), ctx.env, {});
    };
    w.eval(COMBINED);
    const wait = async (cond, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 10)); return cond(); };
    d.getElementById('openSightingDrawer').click();
    const loc = d.getElementById('sightingLoc'), locId = d.getElementById('sightingLocId'), options = d.getElementById('sightingLocOptions');
    const type = text => { loc.value = text; loc.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const key = k => loc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

    check('the Location field is a search box with a suggestions list', loc.getAttribute('role') === 'combobox' && loc.getAttribute('aria-controls') === 'sightingLocOptions');
    type('40');
    await new Promise(r => setTimeout(r, 350));
    check('fewer than 3 characters: no suggestions', options.classList.contains('hidden'));
    type('4016 hanover');
    check('suggestions appear while typing', await wait(() => !options.classList.contains('hidden') && options.querySelectorAll('[role="option"]').length > 0));
    check('the street address is offered', options.querySelector('[role="option"]').textContent === HANOVER.label && loc.getAttribute('aria-expanded') === 'true');
    key('ArrowDown');
    check('arrow keys highlight a suggestion', options.querySelector('[role="option"]').getAttribute('aria-selected') === 'true' && loc.getAttribute('aria-activedescendant') === 'sightingLocOption0');
    key('Enter');
    check('Enter picks it: the field shows the place, its id is kept, the list closes', loc.value === HANOVER.label && locId.value === HANOVER.id && options.classList.contains('hidden'));
    check('...and the empty City field is filled from the place', d.getElementById('sightingServiceArea').value === 'Dallas');
    type(HANOVER.label + ' extra');
    check('typing after picking un-picks it', locId.value === '');

    // Submitting typed-but-not-picked text is stopped in the form.
    const input = d.getElementById('sightingPhoto');
    Object.defineProperty(input, 'files', { configurable: true, value: [new w.File([PNG], 'p.png', { type: 'image/png' })] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    type('somewhere I made up');
    d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 50));
    check('a location that was typed but not picked blocks the submit, with a clear message', sent.length === 0 && /Choose the location from the suggestions/.test(d.getElementById('sightingLocError').textContent) && !d.getElementById('sightingLocError').classList.contains('hidden'));

    type('4016 hanover');
    await wait(() => options.querySelectorAll('[role="option"]').length > 0);
    options.querySelector('[role="option"]').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('clicking a suggestion picks it too', locId.value === HANOVER.id && d.getElementById('sightingLocError').classList.contains('hidden'));
    d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    check('the sighting is submitted with the picked place\'s id', await wait(() => sent.length === 1) && sent[0].location_id === HANOVER.id && sent[0].approx_location === HANOVER.label);
    check('...and stored with the verified label', await wait(() => ctx.d1.query('SELECT approx_location FROM vehicle_observations').length === 1) && ctx.d1.query('SELECT approx_location FROM vehicle_observations')[0].approx_location === HANOVER.label);
    check('the form resets, including the picked place', await wait(() => loc.value === '' && locId.value === ''));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
