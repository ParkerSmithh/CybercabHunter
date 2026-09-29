// Tests for Locations on photo sightings, restricted to the chosen service
// area (worker/service-areas.js, worker/places.js, worker/sightings.js):
// area-limited suggestions (GET /api/places?area=), server-side checks that
// the picked place is real AND inside the chosen City's metro box (even when
// the page is bypassed), the public street+city display, the private
// registry vehicle for a new plate, and the drawer's City-first flow (jsdom).
// Photon is stubbed by helpers/places.mjs.
// Run: node tests/sighting-location.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { installPhotonStub, placeIdFor, photon, HANOVER, LEVITTOWN, CONGRESS, SEGMENT, EDGE_IN_AUSTIN, EDGE_OUT_AUSTIN, EDGE_IN_DALLAS, EDGE_OUT_DALLAS } from './helpers/places.mjs';
import { publicLocation } from '../worker/places.js';
import { SERVICE_AREAS, serviceAreaFor, isInServiceArea } from '../worker/service-areas.js';
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
const place = p => ({ approx_location: p.label, location_id: p.id });

async function search(ctx, q, area) {
  const res = await req(ctx, 'GET', `/api/places?q=${encodeURIComponent(q)}${area ? `&area=${area}` : ''}`, { user: 'rider' });
  return { status: res.status, json: await res.json() };
}

const stored = ctx => ({ subs: ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n, objects: ctx.env.EVIDENCE_BUCKET._objects.size });
const nothingStored = ctx => stored(ctx).subs === 0 && stored(ctx).objects === 0;

async function run() {
  console.log('1. The shared service-area definition');
  {
    check('Austin and Dallas, in that order', SERVICE_AREAS.map(a => a.name).join() === 'Austin,Dallas');
    const austin = serviceAreaFor('Austin'), dallas = serviceAreaFor('dallas');
    check('Austin metro box: -98.05..-97.45, 30.05..30.60, TX', JSON.stringify(austin.bbox) === JSON.stringify({ minLon: -98.05, minLat: 30.05, maxLon: -97.45, maxLat: 30.60 }) && austin.state === 'TX');
    check('Dallas metro box: -97.20..-96.45, 32.55..33.15, TX', JSON.stringify(dallas.bbox) === JSON.stringify({ minLon: -97.20, minLat: 32.55, maxLon: -96.45, maxLat: 33.15 }) && dallas.state === 'TX');
    check('lookup by key or name, any case/spacing; unsupported -> null', serviceAreaFor(' AUSTIN ') === austin && serviceAreaFor('dallas') === dallas && serviceAreaFor('Houston') === null && serviceAreaFor('') === null);
    check('box edges count as inside; just past them does not', isInServiceArea(austin, -98.05, 30.05) && isInServiceArea(austin, -97.45, 30.60) && !isInServiceArea(austin, -98.0501, 30.3) && !isInServiceArea(dallas, -96.4499, 32.8) && isInServiceArea(dallas, -96.45, 33.15));
    const list = await (await req(await makeApp(), 'GET', '/api/service-areas')).json();
    check('GET /api/service-areas lists them (key + name only), for the pages to build from', JSON.stringify(list) === JSON.stringify({ areas: [{ key: 'austin', name: 'Austin' }, { key: 'dallas', name: 'Dallas' }] }));
  }

  console.log('2. GET /api/places — suggestions only from the chosen area');
  {
    const ctx = await makeApp();
    check('signed out: 401', (await req(ctx, 'GET', '/api/places?q=hahn&area=austin')).status === 401);
    const noArea = await search(ctx, 'congress');
    check('no area: 400 invalid_service_area', noArea.status === 400 && noArea.json.error === 'invalid_service_area');
    check('an unsupported area: 400 invalid_service_area', (await search(ctx, 'congress', 'houston')).status === 400);
    check('under 3 characters: no search, empty list', (await search(ctx, 'ab', 'austin')).json.places.length === 0);
    photon.calls.length = 0;
    const austin = await search(ctx, 'congress', 'austin');
    check('Austin: Congress Avenue is offered', austin.status === 200 && austin.json.places[0].id === CONGRESS.id && austin.json.places[0].label === CONGRESS.label);
    check('the search sent Photon the Austin metro box', photon.calls[0].searchParams.get('bbox') === '-98.05,30.05,-97.45,30.6');
    check('each suggestion carries only id, label and city (no coordinates)', austin.json.places.every(p => Object.keys(p).sort().join() === 'city,id,label'));
    check('Austin: the Levittown, NY address is NOT offered', !(await search(ctx, '4016 hahn', 'austin')).json.places.some(p => p.id === LEVITTOWN.id));
    check('Austin: a Dallas address is NOT offered', !(await search(ctx, '4016 hanover', 'austin')).json.places.some(p => p.id === HANOVER.id));
    const dallas = await search(ctx, '4016 hanover', 'dallas');
    check('Dallas: the Dallas address is offered', dallas.json.places.some(p => p.id === HANOVER.id));
    check('Dallas: an Austin place is NOT offered', !(await search(ctx, 'congress', 'dallas')).json.places.some(p => p.id === CONGRESS.id));
    photon.ignoreBbox = true;   // a provider that returns places outside the box anyway
    const leaky = await search(ctx, 'hahn congress edgeoutaustin', 'austin');
    photon.ignoreBbox = false;
    check('even if the provider ignores the box, out-of-area results are dropped', !leaky.json.places.some(p => [LEVITTOWN.id, EDGE_OUT_AUSTIN.id].includes(p.id)) && leaky.json.places.some(p => p.id === CONGRESS.id));
    photon.failing = true;
    const down = await search(ctx, 'congress', 'austin');
    photon.failing = false;
    check('the place search being down: 502 places_unavailable', down.status === 502 && down.json.error === 'places_unavailable');
  }

  console.log('3. The server enforces City + Location, whatever the page sends');
  {
    const ctx = await makeApp();
    const levittown = await submit(ctx, { service_area: 'Austin', ...place(LEVITTOWN) });
    check('Austin + Levittown, NY: 400 location_outside_area, nothing stored', levittown.status === 400 && levittown.json.error === 'location_outside_area' && nothingStored(ctx));
    const dallasInAustin = await submit(ctx, { service_area: 'Austin', ...place(HANOVER) });
    check('Austin + a Dallas address: 400 location_outside_area', dallasInAustin.status === 400 && dallasInAustin.json.error === 'location_outside_area');
    const austinInDallas = await submit(ctx, { service_area: 'Dallas', ...place(CONGRESS) });
    check('Dallas + an Austin place: 400 location_outside_area', austinInDallas.status === 400 && austinInDallas.json.error === 'location_outside_area');
    const noCity = await submit(ctx, place(CONGRESS));
    check('a Location without a City: 400 invalid_service_area', noCity.status === 400 && noCity.json.error === 'invalid_service_area');
    const unsupported = await submit(ctx, { service_area: 'Houston', ...place(CONGRESS) });
    check('an unsupported City: 400 invalid_service_area', unsupported.status === 400 && unsupported.json.error === 'invalid_service_area');
    const fake = await submit(ctx, { service_area: 'Austin', approx_location: 'somewhere made up', location_id: 'N:123456' });
    check('a place id that does not exist: 400 invalid_location', fake.status === 400 && fake.json.error === 'invalid_location');
    check('a malformed place id: 400 invalid_location', (await submit(ctx, { service_area: 'Austin', approx_location: 'x y z', location_id: '../etc' })).json.error === 'invalid_location');
    check('typed text without a picked place: 400 invalid_location', (await submit(ctx, { service_area: 'Austin', approx_location: 'my made up place' })).json.error === 'invalid_location');
    photon.ignoreBbox = true;   // the provider returns the out-of-box place during verification too
    const leaky = await submit(ctx, { service_area: 'Austin', ...place(LEVITTOWN) });
    photon.ignoreBbox = false;
    check('the server checks coordinates itself: an out-of-area place is rejected even if the provider returns it', leaky.status === 400 && leaky.json.error === 'location_outside_area');
    check('edge just outside the Austin box: rejected', (await submit(ctx, { service_area: 'Austin', ...place(EDGE_OUT_AUSTIN) })).json.error === 'location_outside_area');
    check('edge just outside the Dallas box: rejected', (await submit(ctx, { service_area: 'Dallas', ...place(EDGE_OUT_DALLAS) })).json.error === 'location_outside_area');
    photon.failing = true;
    const down = await submit(ctx, { service_area: 'Austin', ...place(CONGRESS) });
    photon.failing = false;
    check('the place search being down: 502 location_unavailable', down.status === 502 && down.json.error === 'location_unavailable');
    check('none of the rejected submissions stored a photo or a record', nothingStored(ctx));

    const okAustin = await submit(ctx, { service_area: 'austin', ...place(CONGRESS) });
    const okDallas = await submit(ctx, { service_area: 'Dallas', approx_location: '4016 hanover st', location_id: HANOVER.id });
    const edgeA = await submit(ctx, { service_area: 'Austin', ...place(EDGE_IN_AUSTIN) });
    const edgeD = await submit(ctx, { service_area: 'Dallas', ...place(EDGE_IN_DALLAS) });
    check('Austin + an Austin place: accepted', okAustin.status === 201);
    check('Dallas + a Dallas address: accepted', okDallas.status === 201);
    check('edge just inside each box: accepted', edgeA.status === 201 && edgeD.status === 201);
    const row = id => ctx.d1.query('SELECT o.service_area, o.approx_location FROM vehicle_observations o WHERE o.id = ?', id)[0];
    check('stored with the canonical City and the place search\'s own label (not the typed text)', row(okAustin.json.observation_id).service_area === 'Austin' && row(okDallas.json.observation_id).approx_location === HANOVER.label);
    check('no coordinates are stored anywhere in the record', !JSON.stringify(ctx.d1.query('SELECT * FROM vehicle_observations')).match(/-9[678]\.\d{3}|3[023]\.\d{3}/));
    check('a sighting with no Location still needs no City (both optional)', (await submit(ctx, {})).status === 201);

    // A street split into same-named segments: the picked segment is found
    // again by re-running the visitor's own search, not by its label.
    const bySearch = await submit(ctx, { service_area: 'Austin', ...place(SEGMENT), location_query: 'cong ave' });
    check('a street segment is verified by re-running the search that offered it', bySearch.status === 201 && ctx.d1.query('SELECT approx_location FROM vehicle_observations WHERE id = ?', bySearch.json.observation_id)[0].approx_location === SEGMENT.label);
    check('(a search by its label alone would not find that segment)', (await submit(ctx, { service_area: 'Austin', ...place(SEGMENT) })).json.error === 'invalid_location');
    const trick = await submit(ctx, { service_area: 'Austin', ...place(LEVITTOWN), location_query: '4016 hahn' });
    check('the search text cannot widen the area: Levittown is still rejected', trick.status === 400 && trick.json.error === 'location_outside_area');
  }

  console.log('4. Public display: street + city, never the house number');
  {
    const ctx = await makeApp();
    const ok = await submit(ctx, { service_area: 'Dallas', ...place(HANOVER) });
    await req(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${ok.json.submission_id}`, { user: 'mod', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    const gallery = await (await req(ctx, 'GET', '/api/sightings?city=dallas')).json();
    check('the public gallery shows "Hanover Street, Dallas" in Dallas', gallery.sightings[0].location === HANOVER.publicLabel && gallery.sightings[0].city === 'Dallas' && !JSON.stringify(gallery).includes('4016'));
    check('publicLocation: drops a house number, keeps street/place + city', publicLocation('4016 Hanover Street, Dallas, TX') === 'Hanover Street, Dallas' && publicLocation('12B Main St, Austin, TX') === 'Main St, Austin' && publicLocation('NorthPark Center, Dallas, TX') === 'NorthPark Center, Dallas' && publicLocation('Dallas, TX') === 'Dallas, TX' && publicLocation('7-Eleven, Austin, TX') === '7-Eleven, Austin' && publicLocation('') === null);
  }

  console.log('5. A plate not in the registry creates a private registry vehicle for moderator review');
  {
    const ctx = await makeApp();
    const first = await submit(ctx, { license_plate: 'new-9001', service_area: 'Austin' });
    const v = ctx.d1.query('SELECT * FROM robotaxi_vehicles');
    check('one registry vehicle, PRIVATE, origin "sighting", with the normalized plate and city', v.length === 1 && v[0].license_plate === 'NEW9001' && v[0].visibility === 'private' && v[0].origin === 'sighting' && v[0].service_area === 'Austin');
    check('the sighting is linked to it and stays pending', ctx.d1.query('SELECT s.status FROM submissions s WHERE s.id = ?', first.json.submission_id)[0].status === 'pending');
    check('it is not public', (await req(ctx, 'GET', `/api/robotaxi-vehicles/${v[0].id}`)).status === 404);
    const modList = await (await req(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', { user: 'mod' })).json();
    check('it is in the moderation page\'s registry list', (modList.vehicles || []).some(x => x.id === v[0].id));
    const dup = await submit(ctx, { license_plate: 'NEW 9001' });
    check('the same plate again right away: a duplicate, still one vehicle', dup.json.duplicate === true && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 1);
  }

  console.log('6. The drawer: City first, then only that City\'s places');
  {
    const ctx = await makeApp();
    const HTML = fs.readFileSync(`${ROOT}public/sightings.html`, 'utf8');
    const COMBINED = `${fs.readFileSync(`${ROOT}public/js/calc.js`, 'utf8')}\n${fs.readFileSync(`${ROOT}public/js/main.js`, 'utf8')}\nCCC.init();`;
    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/sightings', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-rider');
    const sent = [], searches = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      if (path.startsWith('/api/places')) searches.push(path);
      let body = init.body;
      if (body instanceof w.FormData) {
        const fd = new FormData(), fields = {};
        for (const [k, v] of body.entries()) {
          fd.append(k, typeof v === 'string' ? v : new File([new Uint8Array(await v.arrayBuffer())], v.name, { type: v.type }));
          fields[k] = typeof v === 'string' ? v : '[file]';
        }
        sent.push(fields);
        body = fd;
      }
      return worker.fetch(new Request(`https://x${path}`, { ...init, body }), ctx.env, {});
    };
    w.eval(COMBINED);
    const wait = async (cond, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end && !cond()) await new Promise(r => setTimeout(r, 10)); return cond(); };
    d.getElementById('openSightingDrawer').click();
    const city = d.getElementById('sightingServiceArea'), loc = d.getElementById('sightingLoc'), locId = d.getElementById('sightingLocId'), options = d.getElementById('sightingLocOptions');
    await wait(() => city.options.length > 1);
    const type = text => { loc.value = text; loc.dispatchEvent(new w.Event('input', { bubbles: true })); };
    const choose = value => { city.value = value; city.dispatchEvent(new w.Event('change', { bubbles: true })); };
    const key = k => loc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

    check('City options come from the service areas', [...city.options].map(o => o.textContent).join('|') === 'Choose a city|Austin|Dallas');
    check('Location is disabled until a City is chosen', loc.disabled && loc.placeholder === 'Choose a city first');
    choose('Austin');
    check('choosing Austin enables Location, for Austin', !loc.disabled && loc.placeholder === 'Search an address or place in Austin');
    type('4016 hahn');
    await wait(() => !options.classList.contains('hidden'));
    check('searches are sent for the chosen area only', searches[searches.length - 1].includes('area=austin'));
    check('Austin: the Levittown, NY address is not offered', ![...options.querySelectorAll('[role="option"]')].some(o => /Levittown/.test(o.textContent)));
    type('congress');
    await wait(() => [...options.querySelectorAll('[role="option"]')].some(o => o.textContent === CONGRESS.label));
    key('ArrowDown'); key('Enter');
    check('an Austin place can be picked', loc.value === CONGRESS.label && locId.value === CONGRESS.id);
    check('picking a place never changes the City', city.value === 'Austin');
    choose('Dallas');
    check('changing the City clears the picked Location', loc.value === '' && locId.value === '' && loc.placeholder === 'Search an address or place in Dallas');
    type('4016 hanover');
    await wait(() => [...options.querySelectorAll('[role="option"]')].some(o => o.textContent === HANOVER.label));
    check('Dallas searches are sent for Dallas', searches[searches.length - 1].includes('area=dallas'));
    options.querySelector('[role="option"]').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    check('the Dallas address is picked', locId.value === HANOVER.id && city.value === 'Dallas');
    choose('');
    check('clearing the City clears and disables Location again', loc.value === '' && locId.value === '' && loc.disabled);

    const input = d.getElementById('sightingPhoto');
    Object.defineProperty(input, 'files', { configurable: true, value: [new w.File([PNG], 'p.png', { type: 'image/png' })] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    choose('Dallas');
    type('4016 hanover');
    await wait(() => options.querySelectorAll('[role="option"]').length > 0);
    options.querySelector('[role="option"]').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    check('the sighting is submitted with the City, the picked place and the search that offered it', await wait(() => sent.length === 1) && sent[0].service_area === 'Dallas' && sent[0].location_id === HANOVER.id && sent[0].location_query === '4016 hanover');
    check('...and stored', await wait(() => ctx.d1.query('SELECT approx_location FROM vehicle_observations').length === 1) && ctx.d1.query('SELECT service_area, approx_location FROM vehicle_observations')[0].approx_location === HANOVER.label);
    check('the form resets: City cleared, Location disabled again', await wait(() => city.value === '' && loc.value === '' && loc.disabled));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
