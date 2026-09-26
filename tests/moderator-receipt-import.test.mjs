// The moderator receipt-import page (moderation/import-receipt.html +
// js/import-receipt.js) and its endpoint, POST /api/moderation/receipt-import
// (worker/receipt-import.js). The endpoint is the SAME pipeline as
// POST /api/rides/import, as the signed-in moderator; everything after the
// import — private vehicle, VIN, Approve Cybercab, public totals — is the
// existing workflow, exercised here end to end.
// Real SQL (every migration), the REAL Worker router; the pages run in jsdom.
// Run: node tests/moderator-receipt-import.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedVehicle } from './helpers/env.mjs';
import { receiptBody, eml } from './helpers/receipts.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const VIN = '5YJSA1E14FF101183';
const IMPORT = '/api/moderation/receipt-import';

// Display names: two riders share one (the page picks by id, so they can't be
// confused), one user has none (can never be chosen), one has LIKE wildcards.
const NAMES = { mod: 'Parker Mod', rider: 'Alex Rider', rider2: 'Alex Rider', nameless: null, pct: 'Jamie 100%' };
async function makeApp() {
  const users = { mod: 'moderator', rider: 'user', rider2: 'user', nameless: 'user', pct: 'user' };
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
    ctx.d1.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(NAMES[id], id)._exec();
  }
  ctx.env.ASSETS = { fetch: async req => new Response('static:' + new URL(req.url).pathname, { status: 200 }) };
  return ctx;
}

function call(ctx, method, path, userId, body) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (userId) headers.Authorization = `Bearer session-${userId}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://x${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }), ctx.env, {});
}
const json = r => r.json();

const receipt = (o = {}) => {
  const { plate = 'XJR2195', miles = 2.8, ...rest } = o;
  return receiptBody({ summary: `${miles} mi · 14 min · ${plate}`, ...rest });
};
// `userId` is the caller; `riderId` is whose Rider Data the receipt goes to.
const importAs = async (ctx, userId, items, riderId = 'rider') => {
  const r = await call(ctx, 'POST', IMPORT, userId, { rider_user_id: riderId, items });
  return { status: r.status, body: await json(r) };
};
const vehiclesFor = (ctx, plate) => ctx.d1.query(`SELECT * FROM robotaxi_vehicles WHERE UPPER(REPLACE(REPLACE(license_plate,'-',''),' ','')) = ?`, plate);
const stats = async ctx => json(await call(ctx, 'GET', '/api/registry/stats', null));
const publicList = async ctx => (await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))).vehicles;

async function run() {
  console.log('1. Access: the endpoint is moderator-only');
  {
    const ctx = await makeApp();
    const items = [{ kind: 'text', content: receipt() }];
    const anon = await importAs(ctx, null, items);
    check('unauthenticated: 401', anon.status === 401);
    const rider = await importAs(ctx, 'rider', items);
    check('ordinary signed-in user: 403', rider.status === 403 && rider.body.error === 'forbidden');
    check('neither refused call wrote a ride, vehicle or sync run', ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM ride_sync_runs')[0].n === 0);
    const bogus = await worker.fetch(new Request(`https://x${IMPORT}`, { method: 'POST', headers: { Authorization: 'Bearer not-a-session', 'Content-Type': 'application/json' }, body: '{}' }), ctx.env, {});
    check('an invalid session: 401', bogus.status === 401);
    const getIt = await call(ctx, 'GET', IMPORT, 'mod');
    check('GET is not an import', !(await getIt.text()).includes('"results"'));
    check('bad bodies are rejected the same way as /api/rides/import', (await importAs(ctx, 'mod', [])).status === 400 && (await importAs(ctx, 'mod', [{ kind: 'pdf', content: 'x' }])).status === 400);
  }

  console.log('1b. Riders: searched by display name, and required for an import');
  {
    const ctx = await makeApp();
    const search = async (userId, q) => { const r = await call(ctx, 'GET', '/api/moderation/riders?display_name=' + encodeURIComponent(q), userId); return { status: r.status, body: await json(r) }; };
    check('rider search: 401 signed out, 403 for a non-moderator', (await search(null, 'alex')).status === 401 && (await search('rider', 'alex')).status === 403);
    const alex = await search('mod', 'alex');
    check('matches are case-insensitive substrings, and same-name riders are both listed', alex.status === 200 && alex.body.riders.map(r => r.id).sort().join() === 'rider,rider2');
    check('a rider entry carries only id, display name, handle and created_at (no email or connection data)', alex.body.riders.every(r => Object.keys(r).sort().join() === 'created_at,display_name,handle,id'));
    check('a user without a display name is never returned', !(await search('mod', '')).body.riders.length && !JSON.stringify((await search('mod', 'a')).body).includes('nameless'));
    check('LIKE wildcards are literal', (await search('mod', '%')).body.riders.map(r => r.id).join() === 'pct' && (await search('mod', '_')).body.riders.length === 0);
    const items = [{ kind: 'text', content: receipt() }];
    const none = await call(ctx, 'POST', IMPORT, 'mod', { items });
    check('an import with no rider is refused (400 missing_rider)', none.status === 400 && (await json(none)).error === 'missing_rider');
    const unknown = await importAs(ctx, 'mod', items, 'no-such-user');
    check('an unknown rider is 404 rider_not_found', unknown.status === 404 && unknown.body.error === 'rider_not_found');
    const nameless = await importAs(ctx, 'mod', items, 'nameless');
    check('a rider without a display name is refused (400 rider_has_no_display_name)', nameless.status === 400 && nameless.body.error === 'rider_has_no_display_name');
    check('none of the refused imports wrote anything', ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 0 && ctx.d1.query('SELECT COUNT(*) n FROM ride_sync_runs')[0].n === 0);
  }

  console.log('2. A valid receipt imports through the existing pipeline, into the chosen rider\'s Rider Data');
  const ctx = await makeApp();
  const statsBefore = await stats(ctx);
  let vid;
  {
    const r = await importAs(ctx, 'mod', [{ kind: 'eml', content: eml({ body: receipt({ plate: 'XJR2195' }) }) }]);
    check('200 with one result, naming the rider', r.status === 200 && r.body.success === true && r.body.results.length === 1 && r.body.rider.id === 'rider' && r.body.rider.display_name === 'Alex Rider');
    const item = r.body.results[0];
    check('the ride was created', item.outcome === 'created' && item.review_status === 'accepted' && r.body.run.added === 1);
    check('parsed fields are preserved: ride date, pickup time, distance, fare', item.ride.ride_date === '2026-06-09' && item.ride.pickup_time === '13:04' && item.ride.distance === 2.8 && item.ride.fare_amount_cents === 692 && item.ride.currency === 'USD');
    check('the ride counts (not held for review)', item.ride.review_state === 'counted');
    check('the result names the vehicle: new, private, no VIN, not public', item.vehicle.license_plate === 'XJR2195' && item.vehicle.created === true && item.vehicle.visibility === 'private' && item.vehicle.has_vin === false && item.vehicle.publicly_eligible === false);

    const trip = ctx.d1.query('SELECT * FROM trips')[0];
    check('the ride uses receipt_import provenance (not manual_entry / muse_api)', trip.source === 'receipt_import');
    check('the ride belongs to the chosen rider, not the moderator', trip.user_id === 'rider');
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', trip.submission_id)[0];
    check('submission status follows the existing rule (accepted receipt -> pending)', sub.status === 'pending' && sub.evidence_type === 'pasted_receipt');
    check('the sync run is a receipt_import run for the rider', ctx.d1.query(`SELECT * FROM ride_sync_runs WHERE user_id = 'rider' AND source = 'receipt_import'`).length === 1);

    const vs = vehiclesFor(ctx, 'XJR2195');
    vid = vs[0].id;
    check('a new plate created exactly one PRIVATE registry vehicle', vs.length === 1 && vs[0].visibility === 'private');
    check('no VIN, model or approval was invented for it', vs[0].vin === null && vs[0].model === null && vs[0].verification_status !== 'verified' && ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicle_reviews')[0].n === 0);
    check('the ride is linked to that vehicle', trip.robotaxi_vehicle_id === vid && item.vehicle.id === vid);

    const trips = await json(await call(ctx, 'GET', '/api/trips', 'rider'));
    check('the ride appears in the rider\'s Rider Data', trips.trips.length === 1 && trips.pagination.total === 1);
    check('not in the moderator\'s, and not in the other same-name rider\'s', (await json(await call(ctx, 'GET', '/api/trips', 'mod'))).trips.length === 0 && (await json(await call(ctx, 'GET', '/api/trips', 'rider2'))).trips.length === 0);

    const modList = await json(await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?plate=XJR2195', 'mod'));
    check('the vehicle is listed in the moderator Registry Vehicles', modList.vehicles.some(v => v.id === vid && v.visibility === 'private'));

    check('the private vehicle is NOT in the public registry', !(await publicList(ctx)).some(v => v.id === vid));
    check('the public vehicle detail is 404', (await call(ctx, 'GET', `/api/robotaxi-vehicles/${vid}`, null)).status === 404);
    const s = await stats(ctx);
    check('homepage totals are unchanged while it is private', s.public_vehicles === statsBefore.public_vehicles && s.recorded_rides === statsBefore.recorded_rides);
  }

  console.log('3. Duplicate protection is intact');
  {
    const again = await importAs(ctx, 'mod', [{ kind: 'text', content: receipt({ plate: 'XJR2195' }) }]);
    check('the same receipt again is a duplicate, not a second ride', again.body.results[0].outcome === 'duplicate' && ctx.d1.query('SELECT COUNT(*) n FROM trips')[0].n === 1);
    check('a duplicate reports the existing vehicle, not a created one', again.body.results[0].vehicle.id === vid && again.body.results[0].vehicle.created === false);
    check('still one vehicle row for the plate', vehiclesFor(ctx, 'XJR2195').length === 1);
    // Dedupe is per rider (the existing rule): the same receipt for a different
    // rider is THEIR ride — but one physical ride on the vehicle (ride_key).
    const other = await importAs(ctx, 'mod', [{ kind: 'text', content: receipt({ plate: 'XJR2195' }) }], 'rider2');
    check('the same receipt for a different rider is added to their Rider Data', other.body.results[0].outcome === 'created' && (await json(await call(ctx, 'GET', '/api/trips', 'rider2'))).trips.length === 1);
    check('and it is the same vehicle, still one row', other.body.results[0].vehicle.id === vid && vehiclesFor(ctx, 'XJR2195').length === 1);
  }

  console.log('4. An existing plate reuses the existing vehicle');
  {
    // A private registry vehicle already on file (as every app-created vehicle is).
    const existing = seedVehicle(ctx.d1, { id: '00000000-0000-4000-8000-0000000000aa', plate: 'ABC-1234' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${existing}'`);
    const r = await importAs(ctx, 'mod', [{ kind: 'text', content: receipt({ plate: 'ABC1234', pickupTime: '3:30 pm' }) }]);
    const item = r.body.results[0];
    check('imported onto the existing vehicle (normalized plate match)', item.outcome === 'created' && item.vehicle.id === existing && item.vehicle.created === false);
    check('no duplicate vehicle row was created', vehiclesFor(ctx, 'ABC1234').length === 1);
    check('the existing vehicle\'s visibility and plate are untouched', vehiclesFor(ctx, 'ABC1234')[0].visibility === 'private' && vehiclesFor(ctx, 'ABC1234')[0].license_plate === 'ABC-1234');
    check('the ride is associated with that vehicle', ctx.d1.query('SELECT robotaxi_vehicle_id FROM trips WHERE id = (SELECT trip_id FROM receipt_ingestions ORDER BY rowid DESC LIMIT 1)')[0].robotaxi_vehicle_id === existing);
  }

  console.log('5. Non-receipts and unreadable receipts behave as in the existing pipeline');
  {
    const r = await importAs(ctx, 'mod', [
      { kind: 'text', content: 'Hello, this is just a note about lunch.' },
      { kind: 'text', content: receiptBody({ date: 'garbled', pickupTime: 'n/a', summary: '1 mi · 5 min · NEW999' }) }
    ]);
    check('a non-receipt is rejected with no ride or vehicle', r.body.results[0].outcome === 'rejected' && r.body.results[0].ride === null && r.body.results[0].vehicle === null);
    check('a receipt without a readable date/time is not turned into a ride', ['unidentified', 'rejected'].includes(r.body.results[1].outcome) && r.body.results[1].ride === null);
    check('neither created a vehicle', vehiclesFor(ctx, 'NEW999').length === 0);
  }

  console.log('6. After the existing VIN + Approve Cybercab workflow, the ride counts publicly');
  {
    // The workflow is unchanged: approving without a VIN is still refused.
    const noVin = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/review`, 'mod', { action: 'approve_cybercab' });
    const noVinBody = await json(noVin);
    check('Approve Cybercab without a VIN is still refused (no_vin)', noVin.status === 409 && noVinBody.blocking_reasons.includes('no_vin'));
    check('the rider cannot set a VIN or approve', (await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/vin`, 'rider', { vin: VIN })).status === 403 && (await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/review`, 'rider', { action: 'approve_cybercab' })).status === 403);
    const setVin = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/vin`, 'mod', { vin: VIN });
    check('saving the VIN alone does not publish', setVin.status === 200 && !(await publicList(ctx)).some(v => v.id === vid));
    const approve = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${vid}/review`, 'mod', { action: 'approve_cybercab' });
    check('Approve Cybercab succeeds', approve.status === 200);

    const entry = (await publicList(ctx)).find(v => v.id === vid);
    check('Cars lists the vehicle with the imported ride', !!entry && entry.trip_count === 1 && entry.vin === VIN && entry.first_ride_date === '2026-06-09' && entry.last_ride_date === '2026-06-09' && entry.total_distance === 2.8);
    const detail = await json(await call(ctx, 'GET', `/api/robotaxi-vehicles/${vid}`, null));
    check('the vehicle detail shows the ride through the existing aggregation', detail.history.trip_count === 1 && detail.history.total_distance === 2.8);
    const s = await stats(ctx);
    check('homepage: +1 public vehicle and +1 Total Rides', s.public_vehicles === statsBefore.public_vehicles + 1 && s.recorded_rides === statsBefore.recorded_rides + 1);

    const later = await importAs(ctx, 'mod', [{ kind: 'text', content: receipt({ plate: 'XJR2195', pickupTime: '5:10 pm', date: 'June 10, 2026' }) }]);
    check('a later receipt for a public vehicle reports it as public and counted', later.body.results[0].vehicle.publicly_eligible === true && later.body.results[0].vehicle.visibility === 'public');
    check('and the Total Rides grows by one more', (await stats(ctx)).recorded_rides === statsBefore.recorded_rides + 2);
  }

  console.log('7. The existing rider import endpoint is unchanged');
  {
    const r = await call(ctx, 'POST', '/api/rides/import', 'rider', { items: [{ kind: 'text', content: receipt({ plate: 'RDR111' }) }] });
    const body = await json(r);
    check('an ordinary rider can still import their own receipts', r.status === 200 && body.results[0].outcome === 'created');
    check('its response shape is unchanged (no ride/vehicle read-back)', Object.keys(body.results[0]).sort().join() === 'index,outcome,reason,review_status,ride_date');
  }

  console.log('8. Moderator page: Import Receipt replaces Refresh');
  {
    const html = read('moderation.html');
    const d = new JSDOM(html).window.document;
    check('no Refresh button remains', !d.getElementById('modRefresh') && ![...d.querySelectorAll('button')].some(b => b.textContent.trim() === 'Refresh'));
    const link = d.getElementById('modImportReceipt');
    check('an Import Receipt link goes to the dedicated page', !!link && link.textContent.trim() === 'Import Receipt' && link.getAttribute('href') === '/moderation/import-receipt');
    check('the Registry Vehicles controls are still there', ['modVehicles', 'modVehicleSearch', 'modVehicleScope', 'modVehiclePlate', 'modVehicleList'].every(id => d.getElementById(id)));
    check('js/moderation.js no longer references the removed button', !/modRefresh/.test(read('js/moderation.js')));
    const seen = [];
    ctx.env.ASSETS = { fetch: async req => { seen.push(new URL(req.url).pathname); return new Response('asset'); } };
    await call(ctx, 'GET', '/moderation/import-receipt', null);
    check('/moderation/import-receipt falls through to the static page (no Worker route)', seen.join() === '/moderation/import-receipt');
    check('the page file exists where the static assets serve that URL', fs.existsSync(`${ROOT}public/moderation/import-receipt.html`));
  }

  console.log('9. Import page UI (real js/import-receipt.js in jsdom)');
  const PAGE_HTML = read('moderation/import-receipt.html');
  const COMBINED = `${read('js/calc.js')}\n${read('js/main.js')}\nCCC.init();\n${read('js/import-receipt.js')}`;
  async function openPage(env, sessionId) {
    const dom = new JSDOM(PAGE_HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation/import-receipt', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    if (sessionId) w.localStorage.setItem('teslaSessionId', sessionId);
    const requests = [];
    w.fetch = async (u, init = {}) => {
      const path = String(u).replace(WORKER_ORIGIN, '');
      // The submit button's state while the import request is in flight.
      requests.push({ path, method: init.method || 'GET', body: init.body, buttonBusy: d.getElementById('impSubmit').disabled && /Importing/.test(d.getElementById('impSubmit').textContent) });
      return worker.fetch(new Request(`https://x${path}`, { ...init, headers: { Origin: 'https://cybercabhunter.com', ...(init.headers || {}) } }), env, {});
    };
    const d = w.document;
    w.eval(COMBINED);
    const page = { w, d, requests,
      vis: id => !d.getElementById(id).classList.contains('hidden'),
      async waitFor(cond, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 10)); } return false; } };
    await page.waitFor(() => ['impReady', 'impSignedOut', 'impForbidden', 'impError'].some(page.vis));
    return page;
  }
  {
    const c = await makeApp();
    const anon = await openPage(c.env, null);
    check('signed out: the sign-in state, no form, sign-in returns here', anon.vis('impSignedOut') && !anon.vis('impReady') && /returnTo=%2Fmoderation%2Fimport-receipt/.test(anon.d.querySelector('#impSignedOut a').getAttribute('href')));
    const rider = await openPage(c.env, 'session-rider');
    check('non-moderator: Not authorized, no form', rider.vis('impForbidden') && !rider.vis('impReady'));
    const mod = await openPage(c.env, 'session-mod');
    check('moderator: the import form is shown', mod.vis('impReady') && !!mod.d.getElementById('impFiles') && !!mod.d.getElementById('impSubmit'));
    check('title, supported-file guidance and a link back to Registry Vehicles', /Import Receipt/.test(mod.d.querySelector('#impReady h1').textContent) && /\.eml/.test(mod.d.getElementById('impForm').textContent) && /PDFs/.test(mod.d.getElementById('impForm').textContent) && mod.d.querySelector('a[href="moderation#modVehicles"]'));

    // The rider is required: a receipt with no rider chosen is not sent.
    const file = new mod.w.File([eml({ body: receipt({ plate: 'UIP777' }) })], 'receipt.eml', { type: 'message/rfc822' });
    Object.defineProperty(mod.d.getElementById('impFiles'), 'files', { value: [file], configurable: true });
    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => mod.vis('impFormError'));
    check('with no rider chosen, import shows "Choose the rider" and sends nothing', /Choose the rider/.test(mod.d.getElementById('impFormError').textContent) && !mod.requests.some(r => r.path === IMPORT));

    // Search by display name; both "Alex Rider" accounts are offered, the nameless user never is.
    const type = v => { const i = mod.d.getElementById('impRiderSearch'); i.value = v; i.dispatchEvent(new mod.w.Event('input')); };
    type('alex');
    await mod.waitFor(() => mod.d.querySelectorAll('#impRiderResults button').length === 2);
    const options = [...mod.d.querySelectorAll('#impRiderResults button')];
    check('searching "alex" lists both same-name riders, told apart by ID', options.map(b => b.dataset.riderId).sort().join() === 'rider,rider2' && options.every(b => /Alex Rider/.test(b.textContent) && /ID /.test(b.textContent)));
    type('zzz');
    await mod.waitFor(() => mod.vis('impRiderStatus'));
    check('no match says so', /No rider with that display name/.test(mod.d.getElementById('impRiderStatus').textContent) && mod.d.querySelectorAll('#impRiderResults button').length === 0);
    type('alex');
    await mod.waitFor(() => mod.d.querySelectorAll('#impRiderResults button').length === 2);
    mod.d.querySelector('#impRiderResults button[data-rider-id="rider"]').click();
    check('choosing a rider shows them as selected and hides the search', mod.vis('impRiderSelected') && !mod.vis('impRiderPicker') && /Alex Rider/.test(mod.d.getElementById('impRiderName').textContent) && /ID rider/.test(mod.d.getElementById('impRiderMeta').textContent));

    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => mod.vis('impResults'));
    check('the button shows a loading state while importing', mod.requests.some(r => r.path === IMPORT && r.buttonBusy));
    const card = mod.d.querySelector('#impList li');
    check('success: a result card with plate, date, pickup, distance and fare', !!card && card.dataset.outcome === 'created' && /UIP777/.test(card.textContent) && /Jun 9, 2026/.test(card.textContent) && /1:04 PM/.test(card.textContent) && /2\.8 mi/.test(card.textContent) && /\$6\.92/.test(card.textContent));
    check('it says a new private vehicle was created and how to publish it', /New registry vehicle created/.test(card.textContent) && /Private/.test(card.textContent) && /VIN/.test(card.textContent));
    const open = card.querySelector('a');
    check('it links to that vehicle in Registry Vehicles', open && open.getAttribute('href') === 'moderation?plate=UIP777#modVehicles');
    const sent = JSON.parse(mod.requests.find(r => r.path === IMPORT && r.method === 'POST').body);
    check('the upload was sent as an .eml item, for the chosen rider\'s id', sent.rider_user_id === 'rider' && sent.items[0].kind === 'eml');
    check('the summary says whose Rider Data it went to', /Added to Alex Rider's Rider Data/.test(mod.d.getElementById('impSummary').textContent));
    check('the ride is in that rider\'s Rider Data, not the moderator\'s', c.d1.query(`SELECT user_id FROM trips`).map(r => r.user_id).join() === 'rider');
    check('the rider stays chosen for the next receipt', mod.vis('impRiderSelected'));
    check('the button is usable again afterwards', mod.d.getElementById('impSubmit').disabled === false);

    // Pasted text, as a duplicate.
    mod.d.getElementById('impText').value = receipt({ plate: 'UIP777' });
    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => mod.d.querySelector('#impList li') && mod.d.querySelector('#impList li').dataset.outcome === 'duplicate');
    check('pasting the same receipt reports "Already imported"', /Already imported/.test(mod.d.getElementById('impList').textContent) && /Matched an existing registry vehicle/.test(mod.d.getElementById('impList').textContent));

    // A non-receipt.
    mod.d.getElementById('impText').value = 'not a receipt at all';
    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => mod.d.querySelector('#impList li') && mod.d.querySelector('#impList li').dataset.outcome === 'rejected');
    check('a non-receipt shows an error-style result, not a ride', /Not recognized as a Tesla receipt/.test(mod.d.getElementById('impList').textContent));

    // Hostile text never becomes markup.
    mod.d.getElementById('impText').value = receipt({ plate: 'SAFE1' }).replace('NorthPark Center', '<img src=x onerror="window.__pwned=1">');
    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => /SAFE1/.test(mod.d.getElementById('impList').textContent));
    check('no markup from a receipt is ever rendered', mod.d.querySelectorAll('#impList img').length === 0 && mod.w.__pwned === undefined);

    // Change rider.
    mod.d.getElementById('impRiderChange').click();
    check('Change clears the choice and brings the search back', !mod.vis('impRiderSelected') && mod.vis('impRiderPicker'));
    mod.d.getElementById('impText').value = receipt({ plate: 'UIP888' });
    mod.d.getElementById('impSubmit').click();
    await mod.waitFor(() => mod.vis('impFormError'));
    check('and import is blocked again until a rider is chosen', /Choose the rider/.test(mod.d.getElementById('impFormError').textContent) && !/UIP888/.test(mod.d.getElementById('impList').textContent));
  }

  console.log('10. Moderator page: ?plate= pre-fills the registry search');
  {
    const c = await makeApp();
    const dom = new JSDOM(read('moderation.html'), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation?plate=XJR2195#modVehicles', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-mod');
    const seen = [];
    w.fetch = async (u, init = {}) => { const path = String(u).replace(WORKER_ORIGIN, ''); seen.push(path); return worker.fetch(new Request(`https://x${path}`, init), c.env, {}); };
    w.eval(`${read('js/calc.js')}\n${read('js/main.js')}\nCCC.init();\n${read('js/moderation.js')}`);
    const end = Date.now() + 2000;
    while (Date.now() < end && !seen.some(p => p.startsWith('/api/moderation/robotaxi-vehicles?'))) await new Promise(r => setTimeout(r, 10));
    check('the registry request searches that plate', seen.some(p => p === '/api/moderation/robotaxi-vehicles?plate=XJR2195'));
    check('the plate box shows it', w.document.getElementById('modVehiclePlate').value === 'XJR2195');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
