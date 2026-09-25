// Tests for "Add to registry": a moderator promotes a reviewable community
// sighting into a PRIVATE registry vehicle (origin 'sighting', migration 0014)
// — no ride is invented — and such a vehicle reaches the public registry only
// through a moderator-entered VIN + Approve Cybercab. Also proves the rule
// change is confined to sighting-origin vehicles: receipt vehicles still need
// a counted ride. Real SQL (every migration), the REAL Worker router, jsdom
// for the moderator page.
// Run: node tests/sighting-promotion.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, seedRide, seedVehicle, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const VIN = '5YJSA1E14FF101183';

async function makeApp(users = { mod: 'moderator', u1: 'user' }) {
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
const json = async resp => resp.json();
const submit = async (ctx, fields, userId = 'u1') => (await json(await call(ctx, 'POST', '/api/vehicle-sightings', userId, { service_area: 'Austin', ...fields })));
const promote = (ctx, id, userId = 'mod') => call(ctx, 'POST', `/api/moderation/vehicle-sightings/${id}/promote`, userId);
const count = (ctx, sql, ...a) => ctx.d1.query(sql, ...a)[0].n;
const vehicles = ctx => ctx.d1.query('SELECT * FROM robotaxi_vehicles');
const publicStatus = async (ctx, id) => (await call(ctx, 'GET', `/api/robotaxi-vehicles/${id}`, null)).status;
const stats = async ctx => json(await call(ctx, 'GET', '/api/registry/stats', null));

async function run() {
  console.log('1. Authorization: moderators only');
  {
    const ctx = await makeApp();
    const s = await submit(ctx, { license_plate: 'XVF-2567' });
    check('anonymous is refused (401)', (await promote(ctx, s.submission_id, null)).status === 401);
    check('a non-moderator rider is refused (403)', (await promote(ctx, s.submission_id, 'u1')).status === 403);
    check('nothing was created by the refused attempts', vehicles(ctx).length === 0 || vehicles(ctx).length === 0);
    check('the sighting is still pending after refusals', count(ctx, `SELECT COUNT(*) n FROM submissions WHERE id = ? AND status = 'pending'`, s.submission_id) === 1);
  }

  console.log('2. Promote: a private sighting-origin vehicle, an approved sighting, and NO ride');
  {
    const ctx = await makeApp();
    const s = await submit(ctx, { license_plate: 'xvf-2567', model: 'Cybercab', color: 'Gold', notes: 'Downtown at dusk' });
    const obsBefore = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    const resp = await promote(ctx, s.submission_id);
    const body = await json(resp);
    check('promote succeeds (201)', resp.status === 201 && body.success === true && body.status === 'approved');
    const rows = vehicles(ctx);
    check('exactly one registry vehicle was created', rows.length === 1);
    const v = rows[0];
    check('it is PRIVATE with origin sighting', v.visibility === 'private' && v.origin === 'sighting');
    check('plate is stored normalized; model/color/area come from the sighting', v.license_plate === 'XVF2567' && v.model === 'Cybercab' && v.color === 'Gold' && v.service_area === 'Austin');
    check('first/last seen come from the sighting itself, not an invented time', v.first_seen_at === obsBefore.observed_at && v.last_seen_at === obsBefore.observed_at);
    check('verification_status stays the untouched default (unverified)', v.verification_status === 'unverified');
    check('NO ride, trip, or receipt was created', count(ctx, 'SELECT COUNT(*) n FROM trips') === 0 && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE submission_type = 'ride_receipt'`) === 0);
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', s.observation_id)[0];
    check('the observation is linked to the new vehicle and verified', obs.robotaxi_vehicle_id === v.id && obs.verification_status === 'verified');
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', s.submission_id)[0];
    check('the sighting is approved, attributed to the moderator, with a review time', sub.status === 'approved' && sub.reviewed_by === 'mod' && !!sub.reviewed_at && sub.rejection_reason === null);

    const mv = body.vehicle;
    check('the moderator card data: 0 counted rides, origin sighting, eligible for approval', mv.origin === 'sighting' && mv.counted_ride_count === 0 && mv.total_trip_count === 0 && mv.approval.state === 'eligible_for_approval' && mv.approval.can_approve === true);
    check('blocking reasons are empty; the note says it came from a sighting (no "orphaned" note)', mv.approval.blocking_reasons.length === 0 && mv.approval.notes.includes('added_from_sighting') && !mv.approval.notes.includes('no_rides_on_record'));
    check('it is not publicly eligible and Approve Cybercab stays disabled until a VIN exists', mv.publicly_eligible === false && mv.can_approve_cybercab === false);

    const queue = await json(await call(ctx, 'GET', '/api/moderation/vehicle-sightings', 'mod'));
    check('it left the sighting queue', queue.sightings.length === 0);
    const list = await json(await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', 'mod'));
    check('it shows up in Registry Vehicles → Private', list.vehicles.some(x => x.id === v.id && x.origin === 'sighting'));
    check('the public site still does not show it (private)', (await publicStatus(ctx, v.id)) === 404);
    const st = await stats(ctx);
    check('the homepage stats are still 0 / 0', st.public_vehicles === 0 && st.recorded_rides === 0);
  }

  console.log('3. The path to public: VIN, then Approve Cybercab');
  {
    const ctx = await makeApp();
    const s = await submit(ctx, { license_plate: 'XVF2567', model: 'Cybercab' });
    const id = (await json(await promote(ctx, s.submission_id))).vehicle.id;

    const noVin = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_cybercab' });
    const noVinBody = await json(noVin);
    check('Approve Cybercab without a VIN is refused (409 not_eligible, no_vin)', noVin.status === 409 && noVinBody.error === 'not_eligible' && noVinBody.blocking_reasons.includes('no_vin') && !noVinBody.blocking_reasons.includes('no_counted_rides'));

    const vin = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/vin`, 'mod', { vin: VIN });
    check('a moderator can save the VIN on a sighting-origin vehicle', vin.status === 200);
    const before = await json(await call(ctx, 'GET', '/api/moderation/robotaxi-vehicles?scope=private', 'mod'));
    check('once a VIN exists Approve Cybercab is enabled', before.vehicles.find(v => v.id === id).can_approve_cybercab === true);
    check('the VIN alone does not make anything public', (await publicStatus(ctx, id)) === 404);

    const approve = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'approve_cybercab' });
    const ab = await json(approve);
    check('Approve Cybercab succeeds (200)', approve.status === 200 && ab.success === true && ab.vehicle.visibility === 'public');
    check('the moderator view now reports it publicly eligible', ab.vehicle.publicly_eligible === true && ab.vehicle.approval.state === 'public');
    check('it is audited like any other approval (0 counted rides recorded)', ctx.d1.query(`SELECT * FROM robotaxi_vehicle_reviews WHERE robotaxi_vehicle_id = ?`, id).some(r => r.action === 'approved_public' && r.moderator_user_id === 'mod' && r.counted_ride_count === 0));

    check('the public detail page serves it (200)', (await publicStatus(ctx, id)) === 200);
    const detail = await json(await call(ctx, 'GET', `/api/robotaxi-vehicles/${id}`, null));
    check('with honest nulls: 0 rides, no ride dates (nothing invented)', detail.history.trip_count === 0 && detail.history.first_ride_date === null && detail.history.last_ride_date === null);
    check('the public list includes it', (await json(await call(ctx, 'GET', '/api/robotaxi-vehicles', null))).vehicles.some(v => v.id === id));
    const st = await stats(ctx);
    check('the homepage counts 1 vehicle and still 0 rides', st.public_vehicles === 1 && st.recorded_rides === 0);
    const sightings = await json(await call(ctx, 'GET', `/api/robotaxi-vehicles/${id}/sightings`, null));
    check('the approved sighting shows publicly as a date + area only', sightings.sightings.length === 1 && sightings.sightings[0].service_area === 'Austin');

    const back = await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${id}/review`, 'mod', { action: 'return_private' });
    check('Return to Private takes it down again', back.status === 200 && (await publicStatus(ctx, id)) === 404);
  }

  console.log('4. Promote refusals: nothing is written');
  {
    const ctx = await makeApp();
    const noPlate = await submit(ctx, {});
    let r = await promote(ctx, noPlate.submission_id);
    check('a sighting with no plate is refused (400 plate_required)', r.status === 400 && (await json(r)).error === 'plate_required');

    seedVehicle(ctx.d1, { id: 'existing', plate: 'ABC1234' });
    const dupe = await submit(ctx, { license_plate: 'abc-1234' });
    r = await promote(ctx, dupe.submission_id);
    const rb = await json(r);
    check('a plate already in the registry is refused (409 vehicle_exists) and names that vehicle', r.status === 409 && rb.error === 'vehicle_exists' && rb.robotaxi_vehicle_id === 'existing');

    seedVehicle(ctx.d1, { id: 'amb1', plate: 'DUP9999' });
    seedVehicle(ctx.d1, { id: 'amb2', plate: 'DUP-9999' });
    const amb = await submit(ctx, { license_plate: 'DUP9999' });
    r = await promote(ctx, amb.submission_id);
    check('an ambiguous (duplicated) plate is refused too', r.status === 409 && (await json(r)).error === 'vehicle_exists');

    check('none of the refusals created a vehicle', vehicles(ctx).length === 3);
    check('the refused sightings are still pending and unlinked', count(ctx, `SELECT COUNT(*) n FROM submissions WHERE status = 'pending' AND submission_type = 'vehicle_sighting'`) === 3);

    check('an unknown id is 404', (await promote(ctx, 'nope')).status === 404);
    const rideSub = seedRide(ctx.d1, { userId: 'u1' });
    check('a ride-receipt submission id is 404, never promotable', (await promote(ctx, `sub-${rideSub}`)).status === 404);

    const ok = await submit(ctx, { license_plate: 'NEW1111' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${ok.submission_id}`, 'mod', { action: 'reject', rejection_reason: 'blurry' });
    r = await promote(ctx, ok.submission_id);
    check('an already-reviewed sighting is refused (409 already_reviewed)', r.status === 409 && (await json(r)).error === 'already_reviewed');
  }

  console.log('5. Races: the same sighting promoted twice concurrently creates one vehicle');
  {
    const ctx = await makeApp({ mod: 'moderator', mod2: 'moderator', u1: 'user' });
    const s = await submit(ctx, { license_plate: 'RACE0001' });
    const [a, b] = await Promise.all([promote(ctx, s.submission_id, 'mod'), promote(ctx, s.submission_id, 'mod2')]);
    const statuses = [a.status, b.status].sort();
    check('exactly one succeeds and one is refused with 409', statuses[0] === 201 && statuses[1] === 409);
    check('exactly one vehicle exists', vehicles(ctx).length === 1);
    const again = await promote(ctx, s.submission_id);
    check('a later repeat is refused and still creates nothing', again.status === 409 && vehicles(ctx).length === 1);
  }

  console.log('5b. The atomic write guards itself (what a race would hit, past the endpoint pre-checks)');
  {
    const ctx = await makeApp();
    const s = await submit(ctx, { license_plate: 'GRD1234' });
    seedVehicle(ctx.d1, { id: 'appeared', plate: 'GRD-1234' });   // e.g. a receipt created this plate a moment ago
    const r = await db.promoteSightingToRegistryVehicle(ctx.d1, { submissionId: s.submission_id, reviewerId: 'mod' });
    check('an existing plate makes the write itself apply nothing', r.applied === false && r.vehicleId === null);
    check('no vehicle was added and the sighting is untouched (still pending, unlinked)', vehicles(ctx).length === 1
      && count(ctx, `SELECT COUNT(*) n FROM submissions WHERE id = ? AND status = 'pending' AND reviewed_by IS NULL`, s.submission_id) === 1
      && count(ctx, 'SELECT COUNT(*) n FROM vehicle_observations WHERE id = ? AND robotaxi_vehicle_id IS NULL AND verification_status = ?', s.observation_id, 'unverified') === 1);

    const done = await submit(ctx, { license_plate: 'GRD5555' });
    await call(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${done.submission_id}`, 'mod', { action: 'approve' });
    const again = await db.promoteSightingToRegistryVehicle(ctx.d1, { submissionId: done.submission_id, reviewerId: 'mod' });
    check('an already-reviewed sighting makes the write itself apply nothing', again.applied === false && vehicles(ctx).length === 1);

    const noPlate = await submit(ctx, {});
    const np = await db.promoteSightingToRegistryVehicle(ctx.d1, { submissionId: noPlate.submission_id, reviewerId: 'mod' });
    check('a plate-less sighting makes the write itself apply nothing', np.applied === false && vehicles(ctx).length === 1);
  }

  console.log('6. The rule change is confined to sighting-origin vehicles');
  {
    const ctx = await makeApp();
    // The public/moderation routes only accept UUID ids.
    const RCPT = crypto.randomUUID(), SIGHT = crypto.randomUUID(), NOV = crypto.randomUUID();
    // receipt-origin vehicle with NO ride, made public directly + a VIN: must stay hidden
    seedVehicle(ctx.d1, { id: RCPT, plate: 'RCP1234' });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '${VIN}' WHERE id = '${RCPT}'`);
    check('a RECEIPT vehicle with a VIN but no counted ride is NOT publicly eligible (404)', (await publicStatus(ctx, RCPT)) === 404);
    check('and is not counted in the stats', (await stats(ctx)).public_vehicles === 0);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${RCPT}'`);
    const rv = await json(await call(ctx, 'POST', `/api/moderation/robotaxi-vehicles/${RCPT}/review`, 'mod', { action: 'approve_cybercab' }));
    check('approving a receipt vehicle with no ride is still refused (no_counted_rides)', rv.error === 'not_eligible' && rv.blocking_reasons.includes('no_counted_rides'));
    check('a receipt vehicle DEFAULTS to origin receipt', ctx.d1.query(`SELECT origin FROM robotaxi_vehicles WHERE id = '${RCPT}'`)[0].origin === 'receipt');

    // sighting-origin: needs BOTH public and a VIN
    ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, origin, visibility) VALUES ('${SIGHT}', 'SGT1234', 'sighting', 'public')`);
    check('a sighting vehicle that is public but has NO VIN is NOT eligible (404)', (await publicStatus(ctx, SIGHT)) === 404);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private', vin = '${VIN}' WHERE id = '${SIGHT}'`);
    check('a sighting vehicle with a VIN but still PRIVATE is NOT eligible (404)', (await publicStatus(ctx, SIGHT)) === 404);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public', vin = '' WHERE id = '${SIGHT}'`);
    check('an empty-string VIN does not count as a VIN', (await publicStatus(ctx, SIGHT)) === 404);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '${VIN}' WHERE id = '${SIGHT}'`);
    check('public AND a VIN makes a sighting vehicle eligible (200)', (await publicStatus(ctx, SIGHT)) === 200);

    // the atomic in-write guard: no caller can make a VIN-less sighting vehicle public
    ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, origin, visibility) VALUES ('${NOV}', 'NOV1234', 'sighting', 'private')`);
    const res = await db.changeRobotaxiVehicleVisibility(ctx.d1, { vehicleId: NOV, moderatorId: 'mod', target: 'public', cybercabApproval: true });
    check('the audited write itself refuses a VIN-less sighting vehicle (nothing applied, no history row)',
      res.applied === false && count(ctx, `SELECT COUNT(*) n FROM robotaxi_vehicle_reviews WHERE robotaxi_vehicle_id = '${NOV}'`) === 0
      && ctx.d1.query(`SELECT visibility FROM robotaxi_vehicles WHERE id = '${NOV}'`)[0].visibility === 'private');
  }

  console.log('7. Migration 0014');
  {
    const ctx = await makeApp();
    check('the migration is additive: one ALTER TABLE ADD COLUMN, nothing destructive',
      /ALTER TABLE robotaxi_vehicles ADD COLUMN origin/.test(fs.readFileSync(`${ROOT}migrations/0014_registry_origin.sql`, 'utf8'))
      && !/DROP|DELETE|UPDATE\s/i.test(fs.readFileSync(`${ROOT}migrations/0014_registry_origin.sql`, 'utf8').replace(/--.*$/gm, '')));
    let rejected = false;
    try { ctx.d1.exec(`INSERT INTO robotaxi_vehicles (id, license_plate, origin) VALUES ('bad', 'BAD1', 'other')`); } catch (e) { rejected = true; }
    check('the CHECK constraint rejects any origin other than receipt/sighting', rejected);
  }

  console.log('8. End to end: a Muse connector submission can be promoted');
  {
    const ctx = await makeApp({ mod: 'moderator', muse: 'user' });
    ctx.env.MUSE_CONNECTOR_TOKEN = 'connector-token-for-test-0123456789';
    ctx.env.MUSE_CONNECTOR_USER_ID = 'muse';
    const resp = await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.env.MUSE_CONNECTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_plate: 'XVF2567', service_area: 'Austin', model: 'Cybercab', color: 'Gold', notes: 'Filmed 2026-09-04' })
    }), ctx.env, {});
    const s = await json(resp);
    check('the connector submission is queued', resp.status === 201);
    const r = await promote(ctx, s.submission_id);
    check('and can be promoted to a private sighting-origin vehicle', r.status === 201 && vehicles(ctx).length === 1 && vehicles(ctx)[0].origin === 'sighting' && vehicles(ctx)[0].visibility === 'private');
    // a later sighting of the same plate links to the new vehicle automatically
    const later = await worker.fetch(new Request('https://x/api/connector/vehicle-sightings', {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.env.MUSE_CONNECTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_plate: 'XVF-2567', service_area: 'Dallas' })
    }), ctx.env, {});
    const laterBody = await json(later);
    check('a later sighting of that plate links to the vehicle at submission time', laterBody.robotaxi_vehicle_id === vehicles(ctx)[0].id);
  }

  console.log('9. Deleting a sighting-origin vehicle');
  {
    const ctx = await makeApp({ mod: 'moderator', u1: 'user', u2: 'user' });
    const s = await submit(ctx, { license_plate: 'DEL1234' });
    const id = (await json(await promote(ctx, s.submission_id))).vehicle.id;
    const del = await call(ctx, 'DELETE', `/api/moderation/robotaxi-vehicles/${id}`, 'mod');
    check('Delete Vehicle works (200) and removes the vehicle', del.status === 200 && vehicles(ctx).length === 0);
    check('the sighting record survives, simply unlinked', count(ctx, 'SELECT COUNT(*) n FROM vehicle_observations WHERE id = ? AND robotaxi_vehicle_id IS NULL', s.observation_id) === 1);
    const s2 = await submit(ctx, { license_plate: 'DEL1234' }, 'u2'); // a different rider: the same rider's 2-minute duplicate guard would replay the old sighting
    check('after deletion the plate can be promoted again', (await promote(ctx, s2.submission_id)).status === 201);
  }

  console.log('10. Moderator page (jsdom): the Add to registry button and the card');
  {
    const HTML = fs.readFileSync(`${ROOT}moderation.html`, 'utf8');
    const COMBINED = `${fs.readFileSync(`${ROOT}js/calc.js`, 'utf8')}\n${fs.readFileSync(`${ROOT}js/main.js`, 'utf8')}\nCCC.init();\n${fs.readFileSync(`${ROOT}js/moderation.js`, 'utf8')}`;
    const ctx = await makeApp();
    seedVehicle(ctx.d1, { id: 'linked', plate: 'LNK1234' });
    await submit(ctx, { license_plate: 'XVF2567' });        // promotable
    await submit(ctx, {});                                  // no plate
    await submit(ctx, { license_plate: 'LNK1234' });        // already matches a registry vehicle

    const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-mod');
    const paths = [];
    w.fetch = async (url, init = {}) => {
      const path = String(url).replace('https://cybercabhunter.contactjoeclos.workers.dev', '');
      paths.push({ path, method: init.method || 'GET' });
      return worker.fetch(new Request(`https://x${path}`, init), ctx.env, {});
    };
    w.eval(COMBINED);
    const d = w.document;
    const waitFor = async (cond, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 5)); } return false; };
    await waitFor(() => d.querySelectorAll('[data-submission-id]').length === 3);
    const cards = [...d.querySelectorAll('[data-submission-id]')];
    const byPlate = p => cards.find(c => c.textContent.includes(p));
    const btn = c => c && c.querySelector('button[data-action="promote"]');
    check('a sighting with a plate and no registry vehicle has "Add to registry"', !!btn(byPlate('XVF2567')) && /Add to registry/.test(btn(byPlate('XVF2567')).textContent));
    check('a sighting with no plate does NOT', !btn(byPlate('Plate not given')));
    check('a sighting already matched to a registry vehicle does NOT', !btn(byPlate('LNK1234')));
    check('Approve and Reject are still offered on every card', cards.every(c => c.querySelector('button[data-action="approve"]') && c.querySelector('button[data-action="ask-reject"]')));

    btn(byPlate('XVF2567')).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitFor(() => vehicles(ctx).length === 2);
    check('clicking it POSTs to the promote endpoint', paths.some(p => p.method === 'POST' && /\/vehicle-sightings\/[^/]+\/promote$/.test(p.path)));
    check('the sighting card leaves the queue', await waitFor(() => d.querySelectorAll('[data-submission-id]').length === 2));
    const vehicleCard = async () => { await waitFor(() => [...d.querySelectorAll('[data-vehicle-id]')].some(c => c.textContent.includes('XVF2567'))); return [...d.querySelectorAll('[data-vehicle-id]')].find(c => c.textContent.includes('XVF2567')); };
    const vc = await vehicleCard();
    const text = vc ? vc.textContent.replace(/\s+/g, ' ') : '';
    check('the new vehicle card appears in Registry Vehicles', !!vc);
    check('the card says Private — Needs Review / Eligible for Approval / 0 counted rides', /Private — Needs Review/.test(text) && /Eligible for Approval/.test(text) && /0 counted rides/.test(text));
    check('the card is honest about provenance: added from a sighting, no receipt and no rides', /Added from a community sighting/.test(text) && /no receipt and no rides/.test(text) && !/Forwarded email:/.test(text));
    check('the Cybercab verification panel (Tracker link, VIN, Approve Cybercab) is present', /Cybercab verification/.test(text) && /Check Robotaxi Tracker/.test(text) && !!vc.querySelector('[data-vehicle-action="save-vin"]') && !!vc.querySelector('[data-vehicle-action="approve-cybercab"]'));
    check('Approve Cybercab is disabled until a VIN is saved', vc.querySelector('[data-vehicle-action="approve-cybercab"]').disabled === true);
    check('Delete Vehicle is offered', !!vc.querySelector('[data-vehicle-action="ask-delete"]'));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
