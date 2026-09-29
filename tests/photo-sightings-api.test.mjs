// Tests for POST /api/vehicle-sightings/photo (worker/sightings.js
// apiCreatePhotoSighting) through the REAL Worker router, with real SQL and
// the fake R2 bucket: auth, photo validation (by the file's own bytes),
// size limit, storage key, the pending D1 records, and failure cleanup.
// Run: node tests/photo-sightings-api.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import { db } from '../worker/db.js';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 0x1a, 0, 0, 0, ...Buffer.from('WEBPVP8L'), 0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0]);

async function makeApp(users = ['u1']) {
  const ctx = await makeEnv({ users });
  for (const u of users) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  return ctx;
}

function form(fields = {}, photo = { bytes: PNG, name: 'cybercab.png', type: 'image/png' }) {
  const fd = new FormData();
  if (photo) fd.append('photo', new File([photo.bytes], photo.name, { type: photo.type }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function post(env, body, { session = 'session-u1', headers = {} } = {}) {
  const h = { ...headers };
  if (session) h.Authorization = `Bearer ${session}`;
  const resp = await worker.fetch(new Request('https://x/api/vehicle-sightings/photo', { method: 'POST', headers: h, body }), env, {});
  let json = null;
  try { json = await resp.json(); } catch (e) { /* none */ }
  return { status: resp.status, json };
}

const counts = ctx => ({
  submissions: ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n,
  observations: ctx.d1.query('SELECT COUNT(*) n FROM vehicle_observations')[0].n,
  objects: ctx.env.EVIDENCE_BUCKET._objects.size
});
const nothingStored = ctx => { const c = counts(ctx); return c.submissions === 0 && c.observations === 0 && c.objects === 0; };

async function run() {
  console.log('1. Unauthenticated submissions are rejected before anything is stored');
  {
    const ctx = await makeApp();
    const none = await post(ctx.env, form(), { session: null });
    check('no session: 401', none.status === 401 && none.json.authenticated === false);
    const bogus = await post(ctx.env, form(), { session: 'not-a-real-session' });
    check('an unknown session: 401', bogus.status === 401);
    check('nothing stored in D1 or R2', nothingStored(ctx));
  }

  console.log('2. Missing, unsupported and oversized photos are rejected');
  {
    const ctx = await makeApp();
    const missing = await post(ctx.env, form({ service_area: 'Austin' }, null));
    check('no photo field: 400 missing_photo', missing.status === 400 && missing.json.error === 'missing_photo');
    const asText = new FormData(); asText.append('photo', 'not a file');
    const textField = await post(ctx.env, asText);
    check('a text value instead of a file: 400 missing_photo', textField.status === 400 && textField.json.error === 'missing_photo');
    const empty = await post(ctx.env, form({}, { bytes: new Uint8Array(0), name: 'x.png', type: 'image/png' }));
    check('an empty file: 400 missing_photo', empty.status === 400 && empty.json.error === 'missing_photo');

    const gif = await post(ctx.env, form({}, { bytes: new Uint8Array([...Buffer.from('GIF89a'), 1, 0, 1, 0]), name: 'x.gif', type: 'image/gif' }));
    check('a GIF: 400 unsupported_file_type', gif.status === 400 && gif.json.error === 'unsupported_file_type');
    const disguised = await post(ctx.env, form({}, { bytes: Buffer.from('<html><script>alert(1)</script></html>'), name: 'photo.jpg', type: 'image/jpeg' }));
    check('HTML disguised with a .jpg name and image/jpeg type: 400 unsupported_file_type (the bytes decide)', disguised.status === 400 && disguised.json.error === 'unsupported_file_type');
    const pdf = await post(ctx.env, form({}, { bytes: Buffer.from('%PDF-1.7 ...'), name: 'scan.png', type: 'image/png' }));
    check('a PDF named .png: 400 unsupported_file_type', pdf.status === 400 && pdf.json.error === 'unsupported_file_type');

    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PNG);
    const oversized = await post(ctx.env, form({}, { bytes: big, name: 'huge.png', type: 'image/png' }));
    check('a photo over 10 MB: 413 file_too_large', oversized.status === 413 && oversized.json.error === 'file_too_large');
    const declared = await post(ctx.env, form(), { headers: { 'Content-Length': String(50 * 1024 * 1024) } });
    check('an obviously huge declared body is refused before parsing: 413', declared.status === 413 && declared.json.error === 'file_too_large');
    check('none of these stored anything', nothingStored(ctx));
  }

  console.log('3. Field validation matches the JSON sighting endpoint (City is optional here)');
  {
    const ctx = await makeApp();
    const plate = await post(ctx.env, form({ license_plate: '!!!!' }));
    check('an invalid plate: 400 invalid_license_plate', plate.status === 400 && plate.json.error === 'invalid_license_plate');
    const future = await post(ctx.env, form({ observed_at: new Date(Date.now() + 86400000).toISOString() }));
    check('a date spotted in the future: 400 invalid_observed_at', future.status === 400 && future.json.error === 'invalid_observed_at');
    const garbage = await post(ctx.env, form({ observed_at: 'yesterday-ish' }));
    check('an unparseable date: 400 invalid_observed_at', garbage.status === 400 && garbage.json.error === 'invalid_observed_at');
    check('rejected fields store nothing (the photo is checked before anything is written)', nothingStored(ctx));
  }

  console.log('4. A valid photo is accepted: stored in R2 under a server key, pending D1 records created');
  {
    const ctx = await makeApp();
    const res = await post(ctx.env, form({
      service_area: ' Austin ', approx_location: 'S Congress Ave', notes: 'Gold Cybercab at the light',
      observed_at: '2026-09-20T19:30:00.000Z', license_plate: 'xjr-2195'
    }, { bytes: PNG, name: '../../etc/passwd.png', type: 'text/plain' }));
    check('201 with the new ids and status "pending"', res.status === 201 && res.json.success === true && res.json.duplicate === false && res.json.status === 'pending' && !!res.json.submission_id && !!res.json.observation_id);

    const sub = ctx.d1.query('SELECT * FROM submissions WHERE id = ?', res.json.submission_id)[0];
    const obs = ctx.d1.query('SELECT * FROM vehicle_observations WHERE id = ?', res.json.observation_id)[0];
    check('submission: the signed-in user, a vehicle sighting, PENDING, never reviewed', sub.user_id === 'u1' && sub.submission_type === 'vehicle_sighting' && sub.status === 'pending' && sub.reviewed_at === null && sub.reviewed_by === null);
    check('submission records the photo: evidence_type "photo" + the storage key', sub.evidence_type === 'photo' && /^evidence\/u1\/[0-9a-f-]{36}\.png$/.test(sub.evidence_ref));
    check('the key is server-generated: nothing from the uploaded filename reaches it', !/passwd|etc|\.\./.test(sub.evidence_ref));
    check('the extension comes from the bytes (PNG), not the browser\'s claimed type (text/plain)', sub.evidence_ref.endsWith('.png'));
    check('observation: linked to the submission and user, same photo key, unverified', obs.submission_id === sub.id && obs.user_id === 'u1' && obs.evidence_ref === sub.evidence_ref && obs.verification_status === 'unverified');
    check('observation: optional fields stored (trimmed / normalized)', obs.service_area === 'Austin' && obs.approx_location === 'S Congress Ave' && obs.notes === 'Gold Cybercab at the light' && obs.license_plate === 'XJR2195');
    check('observation: date spotted stored in the schema\'s UTC format', obs.observed_at === '2026-09-20 19:30:00');
    const stored = ctx.env.EVIDENCE_BUCKET._objects.get(sub.evidence_ref);
    check('R2 holds exactly the uploaded bytes', stored && Buffer.from(stored).equals(Buffer.from(PNG)));
    check('the registry is untouched (no vehicle created from an unreviewed sighting)', ctx.d1.query('SELECT COUNT(*) n FROM robotaxi_vehicles')[0].n === 0);
    check('the response exposes no storage key or internal detail', !JSON.stringify(res.json).includes('evidence/'));
    const evidence = await worker.fetch(new Request(`https://x/api/submissions/${sub.id}/evidence`, { headers: { Authorization: 'Bearer session-u1' } }), ctx.env, {});
    check('the submitter can fetch their photo through the existing owner-only evidence route', evidence.status === 200);
  }
  {
    const ctx = await makeApp(['u1', 'u2']);
    const jpeg = await post(ctx.env, form({}, { bytes: JPEG, name: 'IMG_0001.JPG', type: 'image/jpeg' }));
    const webp = await post(ctx.env, form({}, { bytes: WEBP, name: 'shot.webp', type: '' }), { session: 'session-u2' });
    const refs = ctx.d1.query('SELECT user_id, evidence_ref FROM submissions ORDER BY user_id');
    check('a JPEG and a WebP are accepted too (photo only, every other field optional)', jpeg.status === 201 && webp.status === 201);
    check('each is keyed under its own user with the sniffed extension', /^evidence\/u1\/.+\.jpg$/.test(refs[0].evidence_ref) && /^evidence\/u2\/.+\.webp$/.test(refs[1].evidence_ref));
    const obs = ctx.d1.query('SELECT service_area, approx_location, notes, license_plate FROM vehicle_observations')[0];
    check('omitted optional fields are stored as NULL', obs.service_area === null && obs.approx_location === null && obs.notes === null && obs.license_plate === null);
    const other = await worker.fetch(new Request(`https://x/api/submissions/${ctx.d1.query("SELECT id FROM submissions WHERE user_id = 'u1'")[0].id}/evidence`, { headers: { Authorization: 'Bearer session-u2' } }), ctx.env, {});
    check('another user cannot fetch someone else\'s photo', other.status === 404);
  }

  console.log('5. Duplicates and failures leave nothing behind');
  {
    const ctx = await makeApp();
    await post(ctx.env, form({ license_plate: 'XJR2195' }));
    const dup = await post(ctx.env, form({ license_plate: 'xjr 2195' }));
    check('the same plate again within minutes: reported as a duplicate', dup.status === 200 && dup.json.duplicate === true);
    check('...and the duplicate photo is not stored', counts(ctx).objects === 1 && counts(ctx).submissions === 1);
  }
  {
    const ctx = await makeApp();
    ctx.env.EVIDENCE_BUCKET.put = async () => { throw new Error('r2 down'); };
    const res = await post(ctx.env, form());
    check('an R2 failure: 502 upload_failed, and no D1 record', res.status === 502 && res.json.error === 'upload_failed' && counts(ctx).submissions === 0);
  }
  {
    const ctx = await makeApp();
    const original = db.createVehicleSighting;
    db.createVehicleSighting = async () => { throw new Error('d1 down'); };
    let res;
    try { res = await post(ctx.env, form()); } finally { db.createVehicleSighting = original; }
    check('a D1 failure: 500 sighting_create_failed', res.status === 500 && res.json.error === 'sighting_create_failed');
    check('...and the already-uploaded photo is deleted (no orphan)', counts(ctx).objects === 0);
  }
  {
    const ctx = await makeApp();
    const res = await worker.fetch(new Request('https://x/api/vehicle-sightings/photo', { method: 'POST', headers: { Authorization: 'Bearer session-u1', 'Content-Type': 'multipart/form-data; boundary=x' }, body: 'garbage' }), ctx.env, {});
    check('a malformed multipart body: 400 invalid_form_data', res.status === 400 && (await res.json()).error === 'invalid_form_data');
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
