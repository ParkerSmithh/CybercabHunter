// Vehicle timelines (worker/vehicle-timeline.js, migration 0061): five vehicles
// with known histories, every event checked against the records; links only by
// the existing rule (never a guess); private/pending vehicles get no page and no
// timeline; the privacy rules hold in every response.
// Run: node tests/vehicle-timeline.test.mjs
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { rebuildVehicleTimelines } from '../worker/vehicle-timeline.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-11-18T12:00:00Z');

async function seed() {
  const ctx = await makeEnv({ users: ['u1', 'u2'] });
  const run = (q, ...b) => ctx.d1.prepare(q).bind(...b)._exec();
  const veh = (n, plate, area, o = {}) => run(`INSERT INTO robotaxi_vehicles (id, license_plate, service_area, visibility, origin, first_seen_at, created_at, approval_basis, approval_basis_set_at, vin, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid(n), plate, area, o.vis || 'public', o.origin || 'receipt', o.first || '2026-10-01 15:00:00', o.created || '2026-10-02 09:00:00', o.basis || null, o.basisAt || null, o.vin || null, o.model || null);
  let r = 0;
  const ride = (n, date, dist, key, status = 'approved', area = 'Austin', addr = '123 Secret Lane, Austin TX', user = 'u2') => { r++;
    run(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, submitted_at) VALUES (?, ?, 'ride_receipt', ?, 'email_receipt', ?)`, `rs${r}`, user, status, `${date} 20:15:00`);
    run(`INSERT INTO trips (id, submission_id, user_id, service_area, ride_date, distance, fare_amount_cents, robotaxi_vehicle_id, source, ride_key, pickup_description, pickup_time) VALUES (?, ?, ?, ?, ?, ?, 1234, ?, 'receipt_email', ?, ?, '08:42')`, `t${r}`, `rs${r}`, user, area, date, dist, uuid(n), key, addr); };
  let s = 0;
  const sight = (o) => { s++;
    run(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at) VALUES (?, 'u1', 'vehicle_sighting', ?, ?, ?, ?)`, `ss${s}`, o.status || 'approved', o.evidence || 'photo', o.photo ? `sightings/ss${s}.jpg` : null, o.submitted);
    run(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, observed_at, service_area, approx_location, license_plate, evidence_ref, public_id, verification_status, camera_id) VALUES (?, ?, 'u1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `ob${s}`, o.vid || null, `ss${s}`, o.observed || o.submitted, o.area || 'Austin', o.place || '1600 Lavaca St, Austin', o.plate || null, o.photo ? `sightings/ss${s}.jpg` : null, o.photo ? String(s).padStart(32, 'a') : null, o.verified === false ? 'unverified' : 'verified', o.camera || null);
    return `ob${s}`; };
  // V1: public Austin Cybercab, manually approved (date recorded), 2 physical rides (3 trips, one shared ride_key).
  veh(1, 'ABC123', 'Austin', { origin: 'sighting', basis: 'manual', basisAt: '2026-10-05 16:00:00', vin: '7SAYGDEF000000001', model: 'Cybercab' });
  ride(1, '2026-10-03', 4.2, 'k1'); ride(1, '2026-10-03', 4.2, 'k1', 'approved', 'Austin', '123 Secret Lane, Austin TX', 'u1'); ride(1, '2026-10-09', 6.0, 'k2');
  sight({ vid: uuid(1), submitted: '2026-11-10 18:05:00', observed: '2026-11-10 17:40:00', photo: true });          // linked by id, in the gallery
  sight({ plate: 'abc-123', submitted: '2026-10-10 14:00:00', observed: '2026-10-10 13:30:00', photo: true });    // plate match (unique): expired photo (> 30 days)
  sight({ plate: 'ABC123', submitted: '2026-11-01 10:00:00', status: 'pending' });                               // pending: never
  sight({ plate: 'ABC123', submitted: '2026-11-02 10:00:00', verified: false });                                 // unverified: never
  // V2: public Dallas receipt car, 1 ride, no sightings.
  veh(2, 'DAL900', 'Dallas', { first: '2026-11-01 12:00:00', created: '2026-11-03 08:00:00' });
  ride(2, '2026-11-01', 3.1, 'k3', 'approved', 'Dallas');
  // V3: private -> no page, no timeline (even with a ride and a linked sighting).
  veh(3, 'PRIV11', 'Austin', { vis: 'private' }); ride(3, '2026-10-04', 2, 'k4');
  sight({ vid: uuid(3), submitted: '2026-11-05 12:00:00', photo: true });
  // V4: pending (public flag, no counted ride) -> not public.
  veh(4, 'PEND22', 'Austin'); ride(4, '2026-10-06', 2, 'k5', 'rejected');
  // V5: public Austin; its sighting has no separate time (observed = submitted) -> "submitted".
  veh(5, 'AAA555', 'Austin', { first: '2026-10-15 10:00:00', created: '2026-10-15 10:00:00' }); ride(5, '2026-10-15', 1.5, 'k6');
  sight({ vid: uuid(5), submitted: '2026-11-12 09:00:00', evidence: 'text', camera: null });
  // Two registry cars share a plate: a sighting with that plate links to neither.
  veh(6, 'DUP777', 'Austin'); ride(6, '2026-10-07', 1, 'k7');
  veh(7, 'DUP 777', 'Austin'); ride(7, '2026-10-08', 1, 'k8');
  sight({ plate: 'DUP777', submitted: '2026-11-06 12:00:00', photo: true });
  // An unlinked sighting (no plate, no vehicle) and a watch-camera detection: on no timeline.
  sight({ submitted: '2026-11-07 12:00:00', photo: true });
  run(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city) VALUES ('w1', 'cam1', 'Cam', 30.2, -97.7, '2026-11-08T12:00:00Z', 'austin')`);
  return ctx;
}

const ctx = await seed();
const res = await rebuildVehicleTimelines(ctx.env, NOW);
const get = async p => { const r = await worker.fetch(new Request(`https://x${p}`), ctx.env, { waitUntil() {} }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch (e) { body = null; } return { status: r.status, body, text, cc: r.headers.get('Cache-Control') }; };
const tl = (n, q = '') => get(`/api/robotaxi-vehicles/${uuid(n)}/timeline${q}`);

console.log(`1. Five vehicles, checked against the records (${JSON.stringify(res)})`);
{
  const v1 = await tl(1);
  const kinds = v1.body.events.map(e => `${e.kind}:${e.date}${e.date_kind === 'submitted' ? '(s)' : ''}`);
  check(`V1 newest first: ${kinds.join(', ')}`, kinds.join(',') === 'sighting:2026-11-10,sighting:2026-10-10,rides:2026-10-09,approved:2026-10-05,added:2026-10-02,first_seen:2026-10-01');
  const [s1] = v1.body.events, s2 = v1.body.events.filter(e => e.kind === 'sighting')[1];
  check('V1 sighting linked by id: image, in the gallery (photo plus city)', s1.type === 'image' && s1.photo && s1.photo.image_url.startsWith('/api/sightings/') && s1.city === 'Austin' && !('location' in s1));
  check('V1 sighting linked by the unique plate (abc-123 = ABC123); its photo has expired: no photo, no place', s2.type === 'image' && s2.photo === null && !('location' in s2) && s2.city === 'Austin');
  check('V1 pending and unverified sightings are not on it; counts: 2 sightings, 2 rides (shared ride key once), 3 status', v1.body.counts.sightings === 2 && v1.body.counts.rides === 2 && v1.body.counts.status === 3);
  const rides = v1.body.events.find(e => e.kind === 'rides');
  check('V1 rides: one aggregate (2 rides, Oct 3 – Oct 9, 10.2 mi) — the current public totals, no per-ride entries', rides.count === 2 && rides.first === '2026-10-03' && rides.last === '2026-10-09' && Math.abs(rides.total_distance - 10.2) < 1e-9 && v1.body.events.filter(e => e.kind === 'rides').length === 1);
  check('V1 approved: manual basis, the recorded date', v1.body.events.find(e => e.kind === 'approved').basis === 'manual');
  const v2 = await tl(2);
  check('V2 (Dallas): no sightings -> none invented; rides 1; no approval event (no approval date recorded)', v2.body.counts.sightings === 0 && v2.body.counts.rides === 1 && !v2.body.events.some(e => e.kind === 'approved') && v2.body.city === 'dallas');
  check('V2 sightings filter: an honest empty list', (await tl(2, '?filter=sightings')).body.events.length === 0);
  const v5 = await tl(5);
  const s5 = v5.body.events.find(e => e.kind === 'sighting');
  check('V5 sighting with no separate sighting time: "submitted" date; a report (no photo)', s5.date_kind === 'submitted' && s5.date === '2026-11-12' && s5.type === 'report');
  check('V3 (private) and V4 (pending): 404, no timeline rows at all', (await tl(3)).status === 404 && (await tl(4)).status === 404 && ctx.d1.query(`SELECT COUNT(*) AS n FROM vehicle_history_events WHERE vehicle_id IN (?, ?)`, uuid(3), uuid(4))[0].n === 0);
}

console.log('\n2. Linking: never a guess');
{
  const all = ctx.d1.query(`SELECT data FROM vehicle_history_events WHERE kind = 'sighting'`);
  check(`only the 3 rightly linked sightings exist on any timeline (found ${all.length})`, all.length === 3);
  check('the shared plate (DUP777 / DUP 777) links to neither car', (await tl(6)).body.counts.sightings === 0 && (await tl(7)).body.counts.sightings === 0);
  check('the plate-less sighting and the watch detection are on no timeline', !ctx.d1.query(`SELECT event_key FROM vehicle_history_events`).some(r => /ob8|w1/.test(r.event_key)));
}

console.log('\n3. Filters, paging, neighbours, caching');
{
  check('filter: sightings / rides / status', (await tl(1, '?filter=sightings')).body.events.every(e => e.kind === 'sighting') && (await tl(1, '?filter=rides')).body.events.length === 1 && (await tl(1, '?filter=status')).body.events.length === 3);
  check('bad filter: 400', (await tl(1, '?filter=fares')).status === 400);
  const v5 = await tl(5);
  // Austin public cars by plate: AAA555, ABC123, DUP 777, DUP777.
  check('previous / next in the same city, by plate (V5 AAA555 -> next ABC123, no previous)', v5.body.prev === null && v5.body.next && v5.body.next.id === uuid(1) && v5.body.next.plate === 'ABC123');
  check('the browser must revalidate the public vehicle gate', (await tl(1)).cc === 'private, no-cache');
  check('page offsets are bounded', (await tl(1, '?page=11')).status === 400);
}

console.log('\n4. Privacy, in every response');
{
  const texts = [(await tl(1)).text, (await tl(2)).text, (await tl(5)).text, (await get(`/api/robotaxi-vehicles/${uuid(1)}`)).text];
  check('no addresses (no pickup/drop-off, no house-numbered street)', texts.every(x => !/Secret Lane|1600 Lavaca|pickup|dropoff|address/i.test(x)));
  check('no exact times (no HH:MM anywhere)', texts.slice(0, 3).every(x => !/\d{2}:\d{2}/.test(x)));
  check('no rider identity (no user ids, emails, names) and no fares', texts.every(x => !/"u1"|"u2"|user_id|@|fare/i.test(x)));
}

console.log('\n5. Event cache respects current moderation');
{
  const store = new Map();
  globalThis.caches = { default: {
    async match(key) { return store.get(key.url)?.clone(); },
    async put(key, response) { store.set(key.url, response.clone()); }
  } };
  const first = await tl(1);
  check('the internal event response has an hour of cache life', [...store.values()].every(r => r.headers.get('Cache-Control') === 'public, max-age=3600') && store.size > 0);
  ctx.d1.exec("UPDATE submissions SET status = 'rejected' WHERE id = 'ss1'");
  const second = await tl(1);
  check('a reversed approval disappears on a cache hit', first.body.events.some(e => e.date === '2026-11-10') && !second.body.events.some(e => e.date === '2026-11-10'));
  ctx.d1.exec("UPDATE submissions SET status = 'approved' WHERE id = 'ss1'");
  delete globalThis.caches;
}

console.log('\n5. Pages and removal');
{
  ctx.env.ASSETS = { fetch: async () => new Response('<html><head><link rel="canonical" href="https://cybercabhunter.com/vehicle"></head></html>', { headers: { 'Content-Type': 'text/html' } }) };
  const page = id => worker.fetch(new Request(`https://x/vehicle/${id}`), ctx.env, {});
  check('a public vehicle: 200', (await page(uuid(1))).status === 200);
  check('private, pending, unknown or malformed: 404 (no public page)', (await page(uuid(3))).status === 404 && (await page(uuid(4))).status === 404 && (await page(uuid(99))).status === 404 && (await page('not-a-uuid')).status === 404);
  // Removed from public view: the API 404s at once; the next rebuild drops its rows.
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${uuid(1)}'`);
  check('removed from public view: 404 immediately', (await tl(1)).status === 404);
  await rebuildVehicleTimelines(ctx.env, NOW + 864e5);
  check('...and the next rebuild deletes its timeline and summary', ctx.d1.query(`SELECT COUNT(*) AS n FROM vehicle_history_events WHERE vehicle_id = ?`, uuid(1))[0].n === 0 && ctx.d1.query(`SELECT COUNT(*) AS n FROM vehicle_history_summary WHERE vehicle_id = ?`, uuid(1))[0].n === 0);
  check('the rebuild kept everything else (V2, V5 still there)', ctx.d1.query(`SELECT COUNT(*) AS n FROM vehicle_history_summary`)[0].n === 4);
}

t.finish();
