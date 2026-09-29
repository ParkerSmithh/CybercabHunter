// Tests for the public Cybercab Sightings gallery (worker/sightings-public.js,
// public/sightings.html + js/sightings.js): moderation-gated visibility,
// newest-first ordering, the city filters, the live "Seen" count,
// pagination, the public photo route, the moderator photo route, the 30-day
// photo retention job, and that nothing private leaves the public API.
// Sightings are created through the REAL photo endpoint and reviewed through
// the REAL moderation endpoints, with real SQL and the fake R2 bucket.
// Run: node tests/sightings-gallery.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { expireSightingPhotos } from '../worker/sightings-public.js';
import { installPhotonStub, placeIdFor } from './helpers/places.mjs';

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

// Submits a photo sighting through the real endpoint; returns its submission id.
async function submit(ctx, fields = {}) {
  const fd = new FormData();
  fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  // A location is always one picked from the suggestions (see helpers/places.mjs).
  if (fields.approx_location && !fields.location_id) fd.append('location_id', placeIdFor(fields.approx_location));
  const res = await req(ctx, 'POST', '/api/vehicle-sightings/photo', { user: 'rider', body: fd });
  return (await res.json()).submission_id;
}

const review = (ctx, id, action) => req(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${id}`, {
  user: 'mod', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(action === 'reject' ? { action, rejection_reason: 'not a Cybercab' } : { action })
});
const approve = (ctx, id) => review(ctx, id, 'approve');

async function list(ctx, query = '') {
  const res = await req(ctx, 'GET', `/api/sightings${query}`);
  return { status: res.status, cache: res.headers.get('Cache-Control'), json: await res.json() };
}

const age = (ctx, id, days) => ctx.d1.exec(`UPDATE submissions SET submitted_at = datetime('now', '-${days} days') WHERE id = '${id}'`);
const publicIdOf = (ctx, id) => ctx.d1.query('SELECT public_id FROM vehicle_observations WHERE submission_id = ?', id)[0].public_id;

async function run() {
  console.log('1. Moderation gates visibility: only approved photo sightings appear');
  {
    const ctx = await makeApp();
    const pending = await submit(ctx, { service_area: 'Austin', approx_location: 'Pending St' });
    const rejected = await submit(ctx, { service_area: 'Austin', approx_location: 'Rejected St' });
    const approved = await submit(ctx, { service_area: 'Austin', approx_location: 'Approved St' });
    await review(ctx, rejected, 'reject');
    await approve(ctx, approved);
    const { status, json, cache } = await list(ctx);
    check('200 with a short public cache', status === 200 && cache === 'public, max-age=60');
    check('only the approved sighting is listed', json.sightings.length === 1 && json.sightings[0].location === 'Approved St');
    check('pending and rejected never appear', !JSON.stringify(json).includes('Pending St') && !JSON.stringify(json).includes('Rejected St'));
    check('Seen counts only the approved one', json.seen === 1);
    check('a public id is assigned on approval only', !!publicIdOf(ctx, approved) && publicIdOf(ctx, pending) === null && publicIdOf(ctx, rejected) === null);
    check('approving did not auto-approve anything else', ctx.d1.query("SELECT COUNT(*) n FROM submissions WHERE status = 'pending'")[0].n === 1);
  }
  {
    const ctx = await makeApp();
    const text = await req(ctx, 'POST', '/api/vehicle-sightings', { user: 'rider', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service_area: 'Austin', license_plate: 'XJR2195' }) });
    const textId = (await text.json()).submission_id;
    await approve(ctx, textId);
    check('an approved sighting WITHOUT a photo is not in the gallery (and gets no public id)', (await list(ctx)).json.seen === 0 && publicIdOf(ctx, textId) === null);
    // A pending photo sighting from before new plates were registered on
    // submission (like one whose plate has no registry vehicle): promoting it
    // with "Add to registry" approves it too.
    const viaPromote = await submit(ctx, { service_area: 'Dallas', license_plate: 'QJH8021' });
    const autoVehicle = ctx.d1.query('SELECT robotaxi_vehicle_id FROM vehicle_observations WHERE submission_id = ?', viaPromote)[0].robotaxi_vehicle_id;
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL WHERE submission_id = '${viaPromote}'`);
    ctx.d1.exec(`DELETE FROM robotaxi_vehicles WHERE id = '${autoVehicle}'`);
    await req(ctx, 'POST', `/api/moderation/vehicle-sightings/${viaPromote}/promote`, { user: 'mod' });
    const after = (await list(ctx)).json;
    check('a photo sighting approved by promoting it to the registry appears too', after.seen === 1 && after.sightings[0].plate === 'QJH8021');
  }

  console.log('2. Newest -> oldest, by date spotted');
  {
    const ctx = await makeApp();
    const dates = ['2026-09-10T12:00:00Z', '2026-09-20T08:30:00Z', '2026-09-15T18:45:00Z'];
    for (const d of dates) await approve(ctx, await submit(ctx, { service_area: 'Austin', observed_at: d }));
    const newest = await submit(ctx, { service_area: 'Dallas' });   // no date: defaults to now
    await approve(ctx, newest);
    const got = (await list(ctx)).json.sightings.map(s => s.spotted_at);
    check('ordered newest first', got.length === 4 && got.slice(1).join() === '2026-09-20T08:30:00Z,2026-09-15T18:45:00Z,2026-09-10T12:00:00Z' && got[0] > got[1]);
    check('dates are ISO UTC instants', got.every(g => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(g)));
  }

  console.log('3. City filters (Austin, Dallas) + Seen per filter; only Austin/Dallas can be submitted');
  {
    const ctx = await makeApp();
    for (const a of ['Austin', 'austin', ' AUSTIN ', 'Dallas', null]) await approve(ctx, await submit(ctx, { service_area: a }));
    await submit(ctx, { service_area: 'Austin' });   // pending: never counted anywhere
    const seen = async c => (await list(ctx, `?city=${c}`)).json;
    const austin = await seen('austin');
    check('Austin: every spelling of Austin, shown as "Austin"', austin.seen === 3 && austin.sightings.every(s => s.city === 'Austin'));
    check('Dallas: 1', (await seen('dallas')).seen === 1);
    check('the API\'s city=all still covers every sighting, including one with no city', (await seen('all')).seen === 5 && (await seen('all')).sightings.some(s => s.city === null));
    check('city names are case-insensitive in the query', (await list(ctx, '?city=AUSTIN')).json.seen === 3);
    for (const c of ['miami', 'orlando', 'houston']) {
      const bad = await list(ctx, `?city=${c}`);
      check(`${c}: not a filter any more (400 invalid_city)`, bad.status === 400 && bad.json.error === 'invalid_city');
    }
    const rejected = await req(ctx, 'POST', '/api/vehicle-sightings/photo', { user: 'rider', body: (() => { const fd = new FormData(); fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' })); fd.append('service_area', 'Miami'); return fd; })() });
    check('submitting a city other than Austin or Dallas: 400 invalid_service_area', rejected.status === 400 && (await rejected.json()).error === 'invalid_service_area');
    const empty = await makeApp();
    const none = (await list(empty, '?city=dallas')).json;
    check('an empty filter: Seen 0 and no sightings', none.seen === 0 && none.sightings.length === 0 && none.next_cursor === null);
  }

  console.log('4. Pagination: keyset cursor, no gaps or repeats; Seen is the full total');
  {
    const ctx = await makeApp();
    for (let i = 0; i < 5; i++) await approve(ctx, await submit(ctx, { service_area: 'Austin', observed_at: `2026-09-0${i + 1}T10:00:00Z` }));
    const seenIds = [];
    let cursor = null, pages = 0, seenTotals = [];
    do {
      const page = (await list(ctx, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json;
      page.sightings.forEach(s => seenIds.push(s.id));
      seenTotals.push(page.seen);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    check('5 sightings in 3 pages of 2', pages === 3 && seenIds.length === 5 && new Set(seenIds).size === 5);
    check('Seen is the whole filter total on every page', seenTotals.every(n => n === 5));
    check('a malformed cursor is a 400', (await list(ctx, '?cursor=not-a-cursor')).status === 400);
    check('limit is capped at 48', (await list(ctx, '?limit=500')).json.sightings.length === 5);
  }

  console.log('5. Card fields: optional ones are null (not empty strings); nothing private');
  {
    const ctx = await makeApp();
    await approve(ctx, await submit(ctx, { service_area: 'Dallas', approx_location: 'NorthPark area', license_plate: 'xjr-2195', notes: 'my phone number is 555-0100', observed_at: '2026-09-20T19:30:00Z' }));
    await approve(ctx, await submit(ctx, { service_area: 'Austin' }));
    const { json } = await list(ctx);
    const full = json.sightings.find(s => s.city === 'Dallas'), bare = json.sightings.find(s => s.city === 'Austin');
    check('every field of a full sighting', full.location === 'NorthPark area' && full.plate === 'XJR2195' && full.spotted_at === '2026-09-20T19:30:00Z' && /^[0-9a-f]{32}$/.test(full.id) && full.image_url === `/api/sightings/${full.id}/photo`);
    check('no plate -> plate null', bare.plate === null);
    check('no approximate location -> location null', bare.location === null);
    check('each sighting has exactly the public fields', json.sightings.every(s => Object.keys(s).sort().join() === 'city,id,image_url,location,plate,spotted_at,time_zone'));
    check('each carries its area\'s time zone (Dallas and Austin are US Central)', full.time_zone === 'America/Chicago' && bare.time_zone === 'America/Chicago');
    const raw = JSON.stringify(json);
    const sub = ctx.d1.query('SELECT * FROM submissions')[0], obs = ctx.d1.query('SELECT * FROM vehicle_observations')[0];
    check('no user id, submission id, observation id, R2 key, description or moderation data', !raw.includes('rider') && !raw.includes('"mod"') && !raw.includes(sub.id) && !raw.includes(obs.id) && !raw.includes('evidence/') && !raw.includes('555-0100') && !/reviewed|status|user|evidence|notes/.test(raw));
  }

  console.log('6. Photo route: approved photos only, never arbitrary R2 access');
  {
    const ctx = await makeApp();
    const id = await submit(ctx, { service_area: 'Austin' });
    await approve(ctx, id);
    const publicId = publicIdOf(ctx, id);
    const res = await req(ctx, 'GET', `/api/sightings/${publicId}/photo`);
    check('200 with the stored bytes as image/png, nosniff, cacheable', res.status === 200 && res.headers.get('Content-Type') === 'image/png' && res.headers.get('X-Content-Type-Options') === 'nosniff' && res.headers.get('Cache-Control') === 'public, max-age=3600' && Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG)));
    const pendingId = await submit(ctx, { service_area: 'Austin' });
    const pendingRef = ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', pendingId)[0].evidence_ref;
    const notFound = async path => { const r = await req(ctx, 'GET', path); return r.status === 404 && (await r.json()).error === 'not_found'; };
    check('an unknown public id: 404', await notFound(`/api/sightings/${'0'.repeat(32)}/photo`));
    check('a submission id, an observation id or an R2 key cannot be used: 404', await notFound(`/api/sightings/${pendingId}/photo`) && await notFound(`/api/sightings/${encodeURIComponent(pendingRef)}/photo`));
    check('a malformed id: 404', await notFound('/api/sightings/..%2F..%2Fevidence/photo'));
  }

  console.log('7. Moderator photo route (so moderators can see what they approve)');
  {
    const ctx = await makeApp();
    const id = await submit(ctx, { service_area: 'Austin' });
    const mod = await req(ctx, 'GET', `/api/moderation/vehicle-sightings/${id}/photo`, { user: 'mod' });
    check('a moderator can view a PENDING sighting\'s photo, never cached', mod.status === 200 && mod.headers.get('Content-Type') === 'image/png' && mod.headers.get('Cache-Control') === 'private, no-store');
    check('a rider cannot: 403', (await req(ctx, 'GET', `/api/moderation/vehicle-sightings/${id}/photo`, { user: 'rider' })).status === 403);
    check('signed out: 401', (await req(ctx, 'GET', `/api/moderation/vehicle-sightings/${id}/photo`)).status === 401);
    check('an unknown sighting: 404', (await req(ctx, 'GET', `/api/moderation/vehicle-sightings/nope/photo`, { user: 'mod' })).status === 404);
  }

  console.log('8. 30-day retention: photos are deleted, metadata stays, Seen drops');
  {
    const ctx = await makeApp();
    const old = await submit(ctx, { service_area: 'Austin', approx_location: 'Old St', license_plate: 'OLD1234' });
    const recent = await submit(ctx, { service_area: 'Austin' });
    const oldPending = await submit(ctx, { service_area: 'Dallas' });
    await approve(ctx, old); await approve(ctx, recent);
    const oldRef = ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', old)[0].evidence_ref;
    const oldPublic = publicIdOf(ctx, old);
    check('before: Seen 2', (await list(ctx)).json.seen === 2);

    age(ctx, old, 31); age(ctx, oldPending, 45); age(ctx, recent, 29);
    check('past 30 days a photo stops showing immediately, even before cleanup runs', (await list(ctx)).json.seen === 1 && (await req(ctx, 'GET', `/api/sightings/${oldPublic}/photo`)).status === 404);

    // A non-sighting evidence file of the same age must never be touched.
    ctx.d1.exec(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref, submitted_at) VALUES ('receipt-sub', 'rider', 'ride_receipt', 'approved', 'screenshot', 'evidence/rider/receipt.png', datetime('now', '-90 days'))`);
    await ctx.env.EVIDENCE_BUCKET.put('evidence/rider/receipt.png', PNG);

    const result = await expireSightingPhotos(ctx.env);
    check('the job deletes the two photo sightings over 30 days (approved AND pending)', result.due === 2 && result.deleted === 2);
    check('their R2 objects are gone; the 29-day one and the receipt evidence remain', !ctx.env.EVIDENCE_BUCKET._objects.has(oldRef) && ctx.env.EVIDENCE_BUCKET._objects.size === 2 && ctx.env.EVIDENCE_BUCKET._objects.has('evidence/rider/receipt.png'));
    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', old)[0];
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE submission_id = ?', old)[0];
    check('the sighting metadata is kept (status, city, location, plate, public id); only the key is cleared', sub.status === 'approved' && sub.evidence_type === 'photo' && sub.evidence_ref === null && obs.evidence_ref === null && obs.service_area === 'Austin' && obs.approx_location === 'Old St' && obs.license_plate === 'OLD1234' && obs.public_id === oldPublic);
    check('the receipt submission is untouched', ctx.d1.query("SELECT evidence_ref FROM submissions WHERE id = 'receipt-sub'")[0].evidence_ref === 'evidence/rider/receipt.png');
    check('after: Seen 1', (await list(ctx)).json.seen === 1);
    check('a second run has nothing left to do', (await expireSightingPhotos(ctx.env)).due === 0);
  }
  {
    const ctx = await makeApp();
    const ids = [];
    for (let i = 0; i < 12; i++) { const id = await submit(ctx, { service_area: 'Austin' }); ids.push(id); age(ctx, id, 40); }
    const first = await expireSightingPhotos(ctx.env);
    check('each run is bounded (10), and the rest follow on the next run', first.deleted === 10 && (await expireSightingPhotos(ctx.env)).deleted === 2);
  }
  {
    const ctx = await makeApp();
    const id = await submit(ctx, { service_area: 'Austin' });
    age(ctx, id, 31);
    const realDelete = ctx.env.EVIDENCE_BUCKET.delete;
    ctx.env.EVIDENCE_BUCKET.delete = async () => { throw new Error('r2 down'); };
    const failed = await expireSightingPhotos(ctx.env);
    check('a failed R2 delete keeps the key so the next run retries it', failed.deleted === 0 && ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', id)[0].evidence_ref !== null);
    ctx.env.EVIDENCE_BUCKET.delete = realDelete;
    check('...and it does', (await expireSightingPhotos(ctx.env)).deleted === 1);
  }
  {
    const ctx = await makeApp();
    const id = await submit(ctx, { service_area: 'Austin' });
    age(ctx, id, 31);
    const waits = [];
    await worker.scheduled({}, ctx.env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    check('the scheduled (cron) handler runs the retention job', ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', id)[0].evidence_ref === null);
  }

  console.log('9. A photo missing from R2 stops counting toward Seen');
  {
    const ctx = await makeApp();
    const a = await submit(ctx, { service_area: 'Austin' }), b = await submit(ctx, { service_area: 'Austin' });
    await approve(ctx, a); await approve(ctx, b);
    const ref = ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', a)[0].evidence_ref;
    ctx.env.EVIDENCE_BUCKET._objects.delete(ref);   // lost outside the app
    const res = await req(ctx, 'GET', `/api/sightings/${publicIdOf(ctx, a)}/photo`);
    check('its photo URL is a 404', res.status === 404);
    check('...and it is recorded as gone: Seen 2 -> 1, metadata kept', (await list(ctx)).json.seen === 1 && ctx.d1.query('SELECT status FROM submissions WHERE id = ?', a)[0].status === 'approved');
  }

  console.log('9b. Moderator photo delete (API)');
  {
    const ctx = await makeApp();
    const approved = await submit(ctx, { service_area: 'Austin', approx_location: 'Keep me' });
    const other = await submit(ctx, { service_area: 'Austin' });
    const pending = await submit(ctx, { service_area: 'Dallas' });
    await approve(ctx, approved); await approve(ctx, other);
    const pub = publicIdOf(ctx, approved);
    const ref = ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', approved)[0].evidence_ref;
    const del = (path, user) => req(ctx, 'DELETE', path, { user });
    check('signed out: 401, nothing deleted', (await del(`/api/moderation/sightings/${pub}/photo`)).status === 401 && ctx.env.EVIDENCE_BUCKET._objects.has(ref));
    check('a rider (not a moderator): 403, nothing deleted', (await del(`/api/moderation/sightings/${pub}/photo`, 'rider')).status === 403 && ctx.env.EVIDENCE_BUCKET._objects.has(ref));
    check('an unknown or malformed public id: 404', (await del(`/api/moderation/sightings/${'f'.repeat(32)}/photo`, 'mod')).status === 404 && (await del('/api/moderation/sightings/nope/photo', 'mod')).status === 404);
    const ok = await del(`/api/moderation/sightings/${pub}/photo`, 'mod');
    check('a moderator deletes a public photo by its gallery id: 200', ok.status === 200 && (await ok.json()).deleted === true);
    check('the R2 object is gone and it left the gallery (Seen 2 -> 1)', !ctx.env.EVIDENCE_BUCKET._objects.has(ref) && (await list(ctx)).json.seen === 1 && (await req(ctx, 'GET', `/api/sightings/${pub}/photo`)).status === 404);
    const row = ctx.d1.query('SELECT s.status, s.evidence_ref, o.evidence_ref AS oref, o.approx_location FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id WHERE s.id = ?', approved)[0];
    check('an approved sighting stays approved; only its photo key is cleared, metadata kept', row.status === 'approved' && row.evidence_ref === null && row.oref === null && row.approx_location === 'Keep me');
    check('deleting again: 404 (nothing left to delete)', (await del(`/api/moderation/sightings/${pub}/photo`, 'mod')).status === 404);

    const pres = await del(`/api/moderation/vehicle-sightings/${pending}/photo`, 'mod');
    const p = ctx.d1.query('SELECT s.status, s.reviewed_by, s.rejection_reason, s.evidence_ref, o.verification_status FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id WHERE s.id = ?', pending)[0];
    check('from the moderation page (by submission id): a PENDING photo sighting is deleted and closed as rejected', pres.status === 200 && p.status === 'rejected' && p.reviewed_by === 'mod' && p.rejection_reason === 'Photo deleted by a moderator' && p.evidence_ref === null && p.verification_status === 'rejected');
    check('...so it leaves the review queue', !(await (await req(ctx, 'GET', '/api/moderation/vehicle-sightings', { user: 'mod' })).json()).sightings.some(x => x.submission_id === pending));
    check('a rider cannot use that route either: 403', (await del(`/api/moderation/vehicle-sightings/${other}/photo`, 'rider')).status === 403);
    ctx.env.EVIDENCE_BUCKET.delete = async () => { throw new Error('r2 down'); };
    const fail = await del(`/api/moderation/vehicle-sightings/${other}/photo`, 'mod');
    check('an R2 failure: 502 and nothing recorded (safe to retry)', fail.status === 502 && ctx.d1.query('SELECT evidence_ref FROM submissions WHERE id = ?', other)[0].evidence_ref !== null);
  }

  console.log('10. The page (js/sightings.js in jsdom)');
  {
    const ctx = await makeApp();
    await approve(ctx, await submit(ctx, { service_area: 'Austin', approx_location: 'S Congress Ave', license_plate: 'XVF2569', observed_at: '2026-09-20T19:30:00Z' }));
    await approve(ctx, await submit(ctx, { service_area: 'Austin', observed_at: '2026-09-18T12:00:00Z' }));
    await approve(ctx, await submit(ctx, { service_area: 'Dallas' }));
    const html = fs.readFileSync(`${ROOT}public/sightings.html`, 'utf8');
    const js = fs.readFileSync(`${ROOT}public/js/sightings.js`, 'utf8');
    async function open(url, session) {
      const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
      const w = dom.window;
      if (session) w.localStorage.setItem('teslaSessionId', session);
      const calls = [];
      w.fetch = async (u, init) => { const path = String(u).replace(/^https:\/\/[^/]+/, ''); calls.push(path); return worker.fetch(new Request(`https://x${path}`, init), ctx.env, {}); };
      w.eval(js);
      const d = w.document;
      const settle = async () => { for (let i = 0; i < 100 && d.getElementById('sightingsLoading').className.indexOf('hidden') < 0; i++) await new Promise(r => setTimeout(r, 10)); await new Promise(r => setTimeout(r, 20)); };
      await settle();
      return { w, d, calls, settle, seen: () => d.getElementById('seenCounter').textContent.replace(/\s+/g, ' ').trim(), cards: () => [...d.querySelectorAll('#sightingsGrid article')] };
    }
    const p = await open('https://cybercabhunter.com/sightings');
    check('the title is "SIGHTINGS", in white', p.d.querySelector('h1').textContent.replace(/\s+/g, ' ').trim() === 'SIGHTINGS' && p.d.querySelector('h1').classList.contains('text-white') && p.d.title === 'Cybercab Hunter — Sightings');
    check('only two filter buttons, Austin and Dallas; the page opens on Austin', [...p.d.querySelectorAll('#cityFilters [data-city]')].map(b => b.dataset.city).join() === 'austin,dallas' && p.d.querySelector('[data-city="austin"]').getAttribute('aria-pressed') === 'true' && p.calls[p.calls.length - 1] === '/api/sightings?city=austin');
    check('the counter reads "2 Seen" (Austin)', p.seen() === '2 Seen');
    check('two Austin cards', p.cards().length === 2);
    const austin = p.cards().find(c => /Austin/.test(c.textContent));
    check('a card shows the photo, city, location, plate and date', austin.querySelector('img').src.endsWith('/photo') && /S Congress Ave/.test(austin.textContent) && /XVF2569/.test(austin.textContent) && /Sep 20, 2026/.test(austin.textContent));
    check('the time is shown in the area\'s local time with its zone (19:30 UTC -> 2:30 PM CDT in Austin)', /Sep 20, 2026 · 2:30 PM CDT/.test(austin.textContent));
    const plain = p.cards().find(c => !/XVF2569/.test(c.textContent));
    check('a card without location/plate has no empty lines for them', plain.querySelectorAll('p').length === 0 && !/null|undefined/.test(plain.textContent));
    check('images load lazily', p.cards().every(c => c.querySelector('img').loading === 'lazy'));

    const viewer = p.d.getElementById('sightingViewer');
    check('the expanded-photo viewer starts closed', viewer.classList.contains('hidden'));
    austin.querySelector('button').click();
    check('clicking a photo expands it: same photo, with its details', !viewer.classList.contains('hidden') && p.d.getElementById('sightingViewerImg').src === austin.querySelector('img').src && /Austin · S Congress Ave · XVF2569/.test(p.d.getElementById('sightingViewerCaption').textContent));
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
    check('Escape closes it', viewer.classList.contains('hidden'));
    austin.querySelector('button').click();
    p.d.getElementById('sightingViewerImg').click();
    check('clicking the photo itself keeps it open', !viewer.classList.contains('hidden'));
    viewer.click();
    check('clicking outside the photo closes it', viewer.classList.contains('hidden'));
    austin.querySelector('button').click();
    p.d.getElementById('sightingViewerClose').click();
    check('the × button closes it', viewer.classList.contains('hidden'));

    p.d.querySelector('[data-city="dallas"]').click();
    await p.settle();
    check('Dallas: the counter and cards update ("1 Seen")', p.seen() === '1 Seen' && p.cards().length === 1 && /Dallas/.test(p.cards()[0].textContent));
    check('...Dallas is now the active filter, and the URL remembers it', p.d.querySelector('[data-city="dallas"]').getAttribute('aria-pressed') === 'true' && p.d.querySelector('[data-city="austin"]').getAttribute('aria-pressed') === 'false' && p.w.location.search === '?city=dallas');

    const direct = await open('https://cybercabhunter.com/sightings?city=dallas');
    check('opening ?city=dallas starts on Dallas', direct.d.querySelector('[data-city="dallas"]').getAttribute('aria-pressed') === 'true' && direct.calls.includes('/api/sightings?city=dallas'));
    const old = await open('https://cybercabhunter.com/sightings?city=miami');
    check('an old ?city=miami link falls back to Austin', old.d.querySelector('[data-city="austin"]').getAttribute('aria-pressed') === 'true');

    check('a visitor who is not a moderator gets no Delete control on any photo', p.d.querySelectorAll('.mod-photo-delete, .mod-photo').length === 0);
    const riderView = await open('https://cybercabhunter.com/sightings', 'session-rider');
    check('...nor does a signed-in rider', riderView.cards().length === 2 && riderView.d.querySelectorAll('.mod-photo-delete').length === 0);
    const modView = await open('https://cybercabhunter.com/sightings', 'session-mod');
    const buttons = [...modView.d.querySelectorAll('.mod-photo-delete')];
    check('a moderator gets a red Delete button over every photo, with the darkening layer', buttons.length === 2 && buttons.every(b => /bg-crimson/.test(b.className) && b.textContent === 'Delete') && modView.d.querySelectorAll('.mod-photo .mod-photo-shade').length === 2);
    check('the hover behaviour lives in the stylesheet (darken + reveal on hover)', /\.mod-photo:hover \.mod-photo-shade/.test(fs.readFileSync(`${ROOT}public/css/style.css`, 'utf8')));
    modView.w.confirm = () => false;
    buttons[0].click();
    await new Promise(r => setTimeout(r, 30));
    check('cancelling the confirmation deletes nothing', modView.cards().length === 2 && modView.seen() === '2 Seen');
    modView.w.confirm = () => true;
    buttons[0].click();
    await modView.settle();
    await new Promise(r => setTimeout(r, 50));
    check('confirming deletes it: the card goes and the counter drops to "1 Seen"', modView.cards().length === 1 && modView.seen() === '1 Seen');
    check('...and the server agrees', (await list(ctx)).json.seen === 2);
    check('clicking Delete does not also open the expanded view', modView.d.getElementById('sightingViewer').classList.contains('hidden'));

    const emptyCtx = await makeApp();
    ctx.env = emptyCtx.env;   // point the page at an empty database
    const none = await open('https://cybercabhunter.com/sightings');
    check('no sightings: "0 Seen" and the "No sightings yet" message, no cards', none.seen() === '0 Seen' && none.cards().length === 0 && /NO SIGHTINGS YET/.test(none.d.getElementById('sightingsEmpty').textContent) && /from Austin/.test(none.d.getElementById('sightingsEmptyText').textContent));
    check('the page has a Sightings nav entry marked for the nav highlight', /data-nav="sightings"/.test(html));
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
