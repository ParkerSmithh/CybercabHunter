// Approved traffic-camera photo sightings -> Zones map markers.
//   - public/data/traffic-cameras.json: the 50 watch cameras (camera-watch-50-coords.json) then the
//     20 backup cameras (camera-watch-backup-20-coords.json, City of Austin inventory) — 70 in all
//   - Submit: an optional camera_id is saved on the sighting (validated against the list);
//     without one nothing changes
//   - Approve (and Add to registry) of a camera sighting creates the camera_detections row
//     from the camera list + the sighting's observed time, COPYING the stored photo
//     (no re-upload, no token); approving one without a camera responds exactly as before
//   - "Add to map" for approved sightings without a camera; retries/re-approvals never add
//     a second row; moderators only (server-side); no plate/VIN/registry link on the map
//   - deleting or expiring the sighting photo removes its map copy
//   - the Submit drawer's picker and the moderation page's approved list / dialog
// Real SQL (every migration) + the REAL Worker router; pages run in jsdom.
// Run: node tests/camera-sighting-approval.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { TRAFFIC_CAMERAS, trafficCameraFor } from '../worker/traffic-cameras.js';
import { placeSightingOnMap } from '../worker/camera-sightings.js';
import { expireSightingPhotos } from '../worker/sightings-public.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const WORKER_ORIGIN = 'https://cybercabhunter.contactjoeclos.workers.dev';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const CAM = '65';   // MARTIN LUTHER KING JR BLVD / TRINITY ST

async function makeApp(users = { rider: 'user', mod: 'moderator' }) {
  const ctx = await makeEnv({ users: Object.keys(users) });
  for (const [id, role] of Object.entries(users)) {
    await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
    if (role !== 'user') ctx.d1.exec(`UPDATE users SET role = '${role}' WHERE id = '${id}'`);
  }
  ctx.env.ASSETS = { fetch: async () => new Response('static', { status: 404 }) };
  ctx.d1.exec('DELETE FROM camera_detections');   // start without the migration's seed row
  return ctx;
}
const call = async (ctx, path, { method = 'GET', session = 'session-mod', body, json } = {}) => {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body }), ctx.env, {});
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, r };
};
async function submit(ctx, fields = {}, { session = 'session-rider' } = {}) {
  const fd = new FormData();
  fd.append('photo', new File([JPEG], 'cam.jpg', { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return call(ctx, '/api/vehicle-sightings/photo', { method: 'POST', session, body: fd });
}
const approve = (ctx, id, session = 'session-mod') => call(ctx, `/api/moderation/vehicle-sightings/${id}`, { method: 'PATCH', session, json: { action: 'approve' } });
const addToMap = (ctx, id, cameraId, session = 'session-mod') => call(ctx, `/api/moderation/vehicle-sightings/${id}/map`, { method: 'POST', session, json: { camera_id: cameraId } });
const rows = ctx => ctx.d1.query('SELECT * FROM camera_detections');
const obs = (ctx, id) => ctx.d1.query('SELECT * FROM vehicle_observations WHERE submission_id = ?', id)[0];
const sub = (ctx, id) => ctx.d1.query('SELECT * FROM submissions WHERE id = ?', id)[0];
// A sighting observed "now-ish", so its marker is inside the public map's 24h window.
const recent = ctx => submit(ctx, { service_area: 'Austin', camera_id: CAM });

async function run() {
  console.log('1. The shipped camera list');
  {
    const source = JSON.parse(read('camera-watch-50-coords.json'));
    const backup = JSON.parse(read('camera-watch-backup-20-coords.json'));
    const shipped = JSON.parse(read('public/data/traffic-cameras.json'));
    const same = (c, s) => c && c.camera_id === String(s.camera_id) && c.name === s.name.trim() && c.lat === s.lat && c.lng === s.lng;
    const austin = shipped.filter(c => c.city === 'austin'), dallas = shipped.filter(c => c.city === 'dallas');
    check('public/data/traffic-cameras.json has 120 distinct cameras: 70 Austin, then 50 Dallas', shipped.length === 120 && new Set(shipped.map(c => c.camera_id)).size === 120 && austin.length === 70 && dallas.length === 50 && shipped.slice(0, 70).every(c => c.city === 'austin'));
    check('the Dallas cameras are TxDOT ids (txdot-dal-<OBJECTID>) inside the Dallas metro box', dallas.every(c => /^txdot-dal-\d+$/.test(c.camera_id) && c.lat >= 32.55 && c.lat <= 33.15 && c.lng >= -97.20 && c.lng <= -96.45 && c.name.length > 3));
    check('the first 50 are the watch cameras, untouched and in place (camera-watch-50-coords.json)', source.length === 50 && source.every((s, i) => same(shipped[i], s)));
    check('then the 20 backup cameras, in order (camera-watch-backup-20-coords.json)', backup.length === 20 && backup.every((s, i) => same(shipped[50 + i], s)));
    check('the backups are the 20 requested ids', backup.map(c => c.camera_id).join() === '699,173,220,787,471,92,202,168,283,150,117,302,325,1444,401,240,1356,227,452,525');
    check('each entry is exactly { camera_id, name, lat, lng, city }', shipped.every(c => Object.keys(c).join() === 'camera_id,name,lat,lng,city' && typeof c.camera_id === 'string'));
    check('the Worker uses the same file (a backup camera is valid server-side too)', TRAFFIC_CAMERAS.length === 120 && trafficCameraFor('txdot-dal-1017').name === 'Spur 366 @ Field St' && trafficCameraFor('txdot-dal-1017').city === 'dallas' && trafficCameraFor('1444').name === 'GUADALUPE ST / 17TH ST' && trafficCameraFor('65').name === 'MARTIN LUTHER KING JR BLVD / TRINITY ST' && trafficCameraFor(65) && !trafficCameraFor('nope'));
  }

  console.log('2. Submit: camera_id is saved; omitting it changes nothing');
  {
    const ctx = await makeApp();
    const withCam = await submit(ctx, { service_area: 'Austin', camera_id: CAM });
    check('a picked camera: 200 and camera_id stored on the sighting', withCam.status === 201 && obs(ctx, withCam.json.submission_id).camera_id === CAM);
    const backupCam = await submit(ctx, { service_area: 'Austin', camera_id: '1356' });
    check('a backup camera (#1356, IH 35 SVRD / 6TH ST) can be filed too', backupCam.status === 201 && obs(ctx, backupCam.json.submission_id).camera_id === '1356');
    const noCity = await submit(ctx, { camera_id: '1493' });
    check('a camera with no city chosen is fine', noCity.status === 201 && obs(ctx, noCity.json.submission_id).camera_id === '1493');
    const none = await submit(ctx, { service_area: 'Austin' });
    check('no camera: camera_id stays NULL', none.status === 201 && obs(ctx, none.json.submission_id).camera_id === null);
    const empty = await submit(ctx, { service_area: 'Austin', camera_id: '' });
    check('an empty camera value (the "Not a traffic camera" option) is the same as none', empty.status === 201 && obs(ctx, empty.json.submission_id).camera_id === null);
    const before = ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n;
    const bad = await submit(ctx, { service_area: 'Austin', camera_id: '99999' });
    check('a camera that is not in the list: 400 invalid_traffic_camera', bad.status === 400 && bad.json.error === 'invalid_traffic_camera');
    const dallas = await submit(ctx, { service_area: 'Dallas', camera_id: CAM });
    check('an Austin camera with Dallas as the city: 400 invalid_traffic_camera', dallas.status === 400 && dallas.json.error === 'invalid_traffic_camera');
    check('rejected submissions store nothing', ctx.d1.query('SELECT COUNT(*) n FROM submissions')[0].n === before);
    check('submitting never creates a map row (only approval does)', rows(ctx).length === 0);
  }

  console.log('3. Approve a camera sighting -> automatically on the Zones map');
  {
    const ctx = await makeApp();
    const s = (await recent(ctx)).json.submission_id;
    const photoKey = sub(ctx, s).evidence_ref;
    const r = await approve(ctx, s);
    check('approve: 200, approved, and the response says it is on the map', r.status === 200 && r.json.status === 'approved' && r.json.map && r.json.map.on_map === true);
    const [row] = rows(ctx);
    const camera = trafficCameraFor(CAM);
    check('exactly one camera_detections row', rows(ctx).length === 1);
    check('camera id, name and coordinates come from the camera list', row.camera_id === CAM && row.camera_name === camera.name && row.lat === camera.lat && row.lng === camera.lng);
    check('observed_at is the sighting\'s observed time (ISO 8601 UTC)', row.observed_at === obs(ctx, s).observed_at.replace(' ', 'T') + 'Z');
    check('the row records its source sighting', row.source_submission_id === s);
    check('the photo was COPIED (camera-captures/<camera>/<timestamp>.jpg), not re-uploaded', /^camera-captures\/65\/\d{8}T\d{6}Z\.jpg$/.test(row.image_r2_key) && row.image_r2_key !== photoKey);
    check('the copy holds the sighting photo\'s exact bytes, and the original is untouched',
      Buffer.from(ctx.env.EVIDENCE_BUCKET._objects.get(row.image_r2_key)).equals(Buffer.from(JPEG)) && ctx.env.EVIDENCE_BUCKET._objects.has(photoKey) && sub(ctx, s).evidence_ref === photoKey);
    const list = await call(ctx, '/api/camera-sightings', { session: null });
    const d = list.json[0];
    check('the public Zones feed shows it (no session needed)', list.status === 200 && list.json.length === 1 && d.camera_id === CAM && d.camera_name === camera.name);
    const img = await call(ctx, d.image_url, { session: null });
    check('...with the sighting\'s photo as its image', img.status === 200 && img.r.headers.get('Content-Type') === 'image/jpeg' && Buffer.from(await img.r.arrayBuffer()).equals(Buffer.from(JPEG)));
    check('no token was configured or needed', !ctx.env.CAMERA_WATCH_TOKEN);

    const again = await approve(ctx, s);
    check('re-approving: 409 already_reviewed, still one row', again.status === 409 && rows(ctx).length === 1);
    const twin = (await recent(ctx)).json.submission_id;   // same camera, same second: the same marker
    ctx.d1.exec(`UPDATE vehicle_observations SET observed_at = (SELECT observed_at FROM vehicle_observations WHERE submission_id = '${s}') WHERE submission_id = '${twin}'`);
    const tr = await approve(ctx, twin);
    const twinListed = (await call(ctx, '/api/moderation/approved-photo-sightings')).json.sightings.find(x => x.submission_id === twin);
    check('another sighting of the same camera at the same moment shares that one marker (no second row), and both views agree it is on the map', tr.json.map.on_map === true && rows(ctx).length === 1 && twinListed.on_map === true);
    const retry = await placeSightingOnMap(ctx.env, s, CAM);
    const other = await placeSightingOnMap(ctx.env, s, '1493');
    check('placing the same sighting again (same or another camera) never adds a second row', retry.placed && retry.existing && other.placed && other.existing && rows(ctx).length === 1);
  }

  console.log('4. Approve without a camera -> exactly as before');
  {
    const ctx = await makeApp();
    const s = (await submit(ctx, { service_area: 'Austin' })).json.submission_id;
    const r = await approve(ctx, s);
    check('the response is the same three fields as before (no map field)', r.status === 200 && Object.keys(r.json).join() === 'success,submission_id,status');
    check('no map row, no error', rows(ctx).length === 0 && sub(ctx, s).status === 'approved');
    const rej = (await recent(ctx)).json.submission_id;
    const rr = await call(ctx, `/api/moderation/vehicle-sightings/${rej}`, { method: 'PATCH', json: { action: 'reject', rejection_reason: 'blurry' } });
    check('rejecting a camera sighting puts nothing on the map', rr.status === 200 && !rr.json.map && rows(ctx).length === 0);
  }

  console.log('5. Add to registry also approves -> a camera sighting goes on the map');
  {
    const ctx = await makeApp();
    const s = (await submit(ctx, { service_area: 'Austin', camera_id: CAM, license_plate: 'CAM1234' })).json.submission_id;
    ctx.d1.exec(`DELETE FROM robotaxi_vehicles`);   // undo the automatic private registry entry so promote can run
    ctx.d1.exec(`UPDATE vehicle_observations SET robotaxi_vehicle_id = NULL`);
    const r = await call(ctx, `/api/moderation/vehicle-sightings/${s}/promote`, { method: 'POST' });
    check('promote: 201 approved and on the map', r.status === 201 && r.json.map && r.json.map.on_map === true && rows(ctx).length === 1);
  }

  console.log('6. "Add to map" for approved sightings without a camera');
  {
    const ctx = await makeApp();
    const s = (await submit(ctx, { service_area: 'Austin', license_plate: 'MAP1234' })).json.submission_id;
    await approve(ctx, s);
    let list = await call(ctx, '/api/moderation/approved-photo-sightings');
    check('the approved list shows it, not on the map, no camera', list.status === 200 && list.json.sightings[0].submission_id === s && list.json.sightings[0].on_map === false && list.json.sightings[0].camera_id === null);
    const r = await addToMap(ctx, s, CAM);
    check('Add to map: 200 on_map, row created from the camera list', r.status === 200 && r.json.on_map === true && r.json.already_on_map === false && rows(ctx).length === 1 && rows(ctx)[0].camera_name === trafficCameraFor(CAM).name);
    check('the chosen camera is recorded on the sighting', obs(ctx, s).camera_id === CAM);
    const again = await addToMap(ctx, s, CAM);
    const different = await addToMap(ctx, s, '1493');
    check('a retry (or another camera) returns already_on_map and adds no row', again.status === 200 && again.json.already_on_map === true && different.json.already_on_map === true && rows(ctx).length === 1 && obs(ctx, s).camera_id === CAM);
    list = await call(ctx, '/api/moderation/approved-photo-sightings');
    check('the approved list now says it is on the map, with the camera name', list.json.sightings[0].on_map === true && list.json.sightings[0].camera_name === trafficCameraFor(CAM).name);

    const pending = (await submit(ctx, { service_area: 'Austin' })).json.submission_id;
    check('a pending sighting cannot be added: 404', (await addToMap(ctx, pending, CAM)).status === 404);
    check('an unknown camera: 400 invalid_traffic_camera', (await addToMap(ctx, s, 'nope')).json.error === 'invalid_traffic_camera');
    check('a missing body: 400', (await call(ctx, `/api/moderation/vehicle-sightings/${s}/map`, { method: 'POST', body: 'x' })).status === 400);
    const noPhoto = await call(ctx, '/api/vehicle-sightings', { method: 'POST', session: 'session-rider', json: { service_area: 'Austin', license_plate: 'NOPIC12' } });
    await approve(ctx, noPhoto.json.submission_id);
    check('a sighting without a photo cannot be added: 404', (await addToMap(ctx, noPhoto.json.submission_id, CAM)).status === 404 && rows(ctx).length === 1);
  }

  console.log('7. Moderators only (server-side)');
  {
    const ctx = await makeApp();
    const s = (await recent(ctx)).json.submission_id;
    const approvedNoCam = (await submit(ctx, { service_area: 'Austin' })).json.submission_id;
    await approve(ctx, approvedNoCam);
    check('an ordinary user cannot approve (403) — so cannot trigger placement', (await approve(ctx, s, 'session-rider')).status === 403);
    check('...cannot Add to map (403)', (await addToMap(ctx, approvedNoCam, CAM, 'session-rider')).status === 403);
    check('...cannot list approved images (403)', (await call(ctx, '/api/moderation/approved-photo-sightings', { session: 'session-rider' })).status === 403);
    check('signed out: 401 on all three', (await approve(ctx, s, null)).status === 401 && (await addToMap(ctx, approvedNoCam, CAM, null)).status === 401 && (await call(ctx, '/api/moderation/approved-photo-sightings', { session: null })).status === 401);
    check('the camera watch token is not accepted as a moderator', (ctx.env.CAMERA_WATCH_TOKEN = 'watch-token') && (await addToMap(ctx, approvedNoCam, CAM, 'watch-token')).status === 401);
    check('nothing reached the map', rows(ctx).length === 0);
  }

  console.log('8. No registry linkage');
  {
    const ctx = await makeApp();
    const s = (await submit(ctx, { service_area: 'Austin', camera_id: CAM, license_plate: 'PLATE99' })).json.submission_id;
    check('(the plate made a private registry vehicle linked to the sighting)', !!obs(ctx, s).robotaxi_vehicle_id);
    await approve(ctx, s);
    const row = rows(ctx)[0];
    check('the map row has no plate, VIN or vehicle id', Object.keys(row).join() === 'id,camera_id,camera_name,lat,lng,observed_at,image_r2_key,created_at,source_submission_id,city' && !JSON.stringify(row).includes('PLATE99'));
    const pub = (await call(ctx, '/api/camera-sightings', { session: null })).json;
    check('the public feed shows no plate or vehicle id', !JSON.stringify(pub).includes('PLATE99') && !JSON.stringify(pub).includes(obs(ctx, s).robotaxi_vehicle_id));
    const code = ['worker/camera-sightings.js', 'worker/traffic-cameras.js'].map(f => read(f).replace(/^\s*\/\/.*$/gm, '')).join('\n');
    check('the map code never reads robotaxi_vehicles, plates or VINs', !/robotaxi_vehicles|license_plate|robotaxi_vehicle_id|\bvin\b/i.test(code));
  }

  console.log('9. The map copy goes when the sighting photo is deleted or expires');
  {
    const ctx = await makeApp();
    const s = (await recent(ctx)).json.submission_id;
    await approve(ctx, s);
    const copy = rows(ctx)[0].image_r2_key;
    const del = await call(ctx, `/api/moderation/vehicle-sightings/${s}/photo`, { method: 'DELETE' });
    check('deleting the photo removes the map row and its copied image', del.status === 200 && rows(ctx).length === 0 && !ctx.env.EVIDENCE_BUCKET._objects.has(copy));
    const s2 = (await recent(ctx)).json.submission_id;
    await approve(ctx, s2);
    const copy2 = rows(ctx)[0].image_r2_key;
    ctx.d1.exec(`UPDATE submissions SET submitted_at = datetime('now', '-31 days') WHERE id = '${s2}'`);
    await expireSightingPhotos(ctx.env);
    check('the 30-day photo expiry removes the map copy too', rows(ctx).length === 0 && !ctx.env.EVIDENCE_BUCKET._objects.has(copy2));
  }

  console.log('10. Submit drawer: the Traffic Camera picker');
  {
    const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html') && read(`public/${f}`).includes('id="sightingForm"'));
    check('every page with the drawer has the optional picker, defaulting to "Not a traffic camera"',
      pages.length === 12 && pages.every(f => /<select id="sightingCamera"[^>]*>\s*<option value="">Not a traffic camera<\/option>/.test(read(`public/${f}`)) && !/id="sightingCamera"[^>]*required/.test(read(`public/${f}`))));
    const ctx = await makeApp();
    const dom = new JSDOM(read('public/sightings.html').replace(/<script src="[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/sightings', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-rider');
    const sent = [];
    w.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'data/traffic-cameras.json') return new Response(read('public/data/traffic-cameras.json'));
      if (u.includes('/api/vehicle-sightings/photo')) { sent.push(init.body); return Response.json({ success: true, submission_id: 'x', status: 'pending' }); }
      // Everything else (the account menu's /api/me, service areas) goes to the real Worker.
      return worker.fetch(new Request(`https://x${u.replace(WORKER_ORIGIN, '')}`, init), ctx.env, {});
    };
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();`);
    const d = w.document;
    d.getElementById('openSightingDrawer').click();
    await new Promise(r => setTimeout(r, 50));
    const sel = d.getElementById('sightingCamera');
    check('opening the drawer fills the picker with all 70 cameras (plus "Not a traffic camera")', sel.options.length === 71 && sel.options[0].value === '' && [...sel.options].some(o => o.value === CAM && o.textContent === 'MARTIN LUTHER KING JR BLVD / TRINITY ST (#65)'));
    const photo = d.getElementById('sightingPhoto');
    const file = new w.File([JPEG], 'x.jpg', { type: 'image/jpeg' });
    Object.defineProperty(photo, 'files', { value: [file], configurable: true });
    d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise(r => setTimeout(r, 10));
    check('submitted without a camera: no camera_id field is sent', sent.length === 1 && !sent[0].has('camera_id'));
    sel.value = CAM;
    Object.defineProperty(photo, 'files', { value: [file], configurable: true });
    d.getElementById('sightingForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 10));
    check('with a camera picked: camera_id is sent', sent.length === 2 && sent[1].get('camera_id') === CAM);
    w.close();
  }

  console.log('11. Moderation page: approved list, map status, Add to map dialog');
  {
    const ctx = await makeApp();
    const onMap = (await recent(ctx)).json.submission_id;
    await approve(ctx, onMap);
    const pendingCam = (await submit(ctx, { service_area: 'Austin', camera_id: '1493' })).json.submission_id;
    const plain = (await submit(ctx, { service_area: 'Austin', license_plate: 'PLAIN12' })).json.submission_id;
    await approve(ctx, plain);
    const dom = new JSDOM(read('public/moderation.html'), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-mod');
    w.URL.createObjectURL = () => 'blob:x';
    w.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'data/traffic-cameras.json') return new Response(read('public/data/traffic-cameras.json'));
      return worker.fetch(new Request(`https://x${u.replace(WORKER_ORIGIN, '')}`, init), ctx.env, {});
    };
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/moderation.js')}`);
    await new Promise(r => setTimeout(r, 150));
    const d = w.document;
    const pendingCard = d.querySelector(`#modImageList [data-submission-id="${pendingCam}"]`);
    check('a pending camera sighting shows its traffic camera', pendingCard && pendingCard.textContent.includes('Traffic camera: SH 71 SVRD / CARDINAL LOOP (PRESIDENTIAL BLVD)'));
    const card = id => d.querySelector(`#modApprovedList [data-approved-id="${id}"]`);
    check('the approved list is shown', !d.getElementById('modApproved').classList.contains('hidden'));
    check('an approved camera sighting reads "On the Zones map ✓" (no Add to map button)', card(onMap).querySelector('[data-on-map]').textContent === 'On the Zones map ✓' && !card(onMap).querySelector('[data-approved-action="add-to-map"]'));
    check('one approved without a camera has "Add to map"', card(plain).querySelector('button[data-approved-action="add-to-map"]').textContent.trim() === 'Add to map');

    pendingCard.querySelector('button[data-action="approve"]').click();
    await new Promise(r => setTimeout(r, 150));
    const toast = d.getElementById('toastRoot').lastElementChild.textContent;
    check('Approve on a camera sighting: toast says it is on the Zones map, and the card moves to the approved list with the confirmation', /on the Zones map ✓/i.test(toast) && card(pendingCam) && card(pendingCam).textContent.includes('On the Zones map ✓'));

    card(plain).querySelector('button[data-approved-action="add-to-map"]').click();
    await new Promise(r => setTimeout(r, 80));
    const dialog = d.getElementById('modMapDialog');
    check('Add to map opens the dialog with the camera picker (70 cameras)', dialog.hasAttribute('open') && d.getElementById('modMapCamera').options.length === 71);
    d.getElementById('modMapCamera').value = '538';
    d.getElementById('modMapForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 150));
    check('choosing a camera places it: the card now reads "On the Zones map ✓"', !dialog.hasAttribute('open') && card(plain).textContent.includes('On the Zones map ✓') && rows(ctx).some(r => r.source_submission_id === plain && r.camera_id === '538'));
    check('three map rows in all (one per approved sighting, no duplicates)', rows(ctx).length === 3);

    // Deleting an approved photo from its card.
    const delBtn = card(onMap).querySelector('button[data-approved-action="delete-photo"]');
    check('every approved card has a Delete button on its photo', delBtn && delBtn.textContent.trim() === 'Delete' && d.querySelectorAll('#modApprovedList button[data-approved-action="delete-photo"]').length === 3);
    const copy = rows(ctx).find(r => r.source_submission_id === onMap).image_r2_key;
    const photoKey = sub(ctx, onMap).evidence_ref;
    w.confirm = () => false;
    delBtn.click();
    await new Promise(r => setTimeout(r, 80));
    check('cancelling the confirmation deletes nothing', card(onMap) && ctx.env.EVIDENCE_BUCKET._objects.has(photoKey));
    w.confirm = () => true;
    card(onMap).querySelector('button[data-approved-action="delete-photo"]').click();
    await new Promise(r => setTimeout(r, 150));
    check('confirming deletes the photo: gone from storage, the card leaves the list', !ctx.env.EVIDENCE_BUCKET._objects.has(photoKey) && !card(onMap) && /Photo deleted/.test(d.getElementById('toastRoot').lastElementChild.textContent));
    check('the sighting stays approved (just without its photo)', sub(ctx, onMap).status === 'approved' && sub(ctx, onMap).evidence_ref === null);
    check('...and it leaves the Zones map (row and copied image removed)', !rows(ctx).some(r => r.source_submission_id === onMap) && !ctx.env.EVIDENCE_BUCKET._objects.has(copy));
    const gallery = (await call(ctx, '/api/sightings', { session: null })).json;
    check('...and the public Sightings gallery', gallery.sightings.length === 2);
    const rider = await call(ctx, `/api/moderation/vehicle-sightings/${plain}/photo`, { method: 'DELETE', session: 'session-rider' });
    check('an ordinary user cannot delete an approved photo (403)', rider.status === 403 && !!sub(ctx, plain).evidence_ref);
    w.close();
  }

  console.log('12. Truthful map status: "on the map" only while the capture is in the public Zones feed (last 24 hours)');
  {
    // Investigation 2026-10-06: the Oct 4 "badge but no marker" approvals all had
    // committed, well-formed rows in the feed; but a capture filed more than 24
    // hours before it is approved or added gets a row the feed never returns, and
    // was still reported as "on the map".
    const ctx = await makeApp();
    const ago = (id, hours) => ctx.d1.exec(`UPDATE vehicle_observations SET observed_at = datetime('now', '-${hours} hours') WHERE submission_id = '${id}'`);
    const feed = async () => (await call(ctx, '/api/camera-sightings', { session: null })).json.map(d => d.camera_id);

    const fresh = (await submit(ctx, { service_area: 'Austin', license_plate: 'FRESH12' })).json.submission_id;
    await approve(ctx, fresh);
    ago(fresh, 23);
    const r1 = await addToMap(ctx, fresh, '538');
    check('Add to map, filed 23 hours ago: on the map and visible', r1.status === 200 && r1.json.on_map === true && r1.json.visible_on_map === true);
    check('...and the public Zones feed returns it (the /map flow, native stored observed_at)', (await feed()).includes('538'));

    const stale = (await submit(ctx, { service_area: 'Austin', license_plate: 'STALE12' })).json.submission_id;
    await approve(ctx, stale);
    ago(stale, 30);
    const r2 = await addToMap(ctx, stale, '1493');
    check('Add to map, filed 30 hours ago: the row is recorded (on_map) but NOT visible', r2.status === 200 && r2.json.on_map === true && r2.json.visible_on_map === false && rows(ctx).some(r => r.source_submission_id === stale));
    check('...and indeed the public Zones feed does not return it', !(await feed()).includes('1493'));
    const again = await addToMap(ctx, stale, '1493');
    check('...retrying says the same (already_on_map, still not visible)', again.json.already_on_map === true && again.json.visible_on_map === false);

    const oldCam = (await submit(ctx, { service_area: 'Austin', camera_id: '61' })).json.submission_id;
    ago(oldCam, 30);
    const r3 = await approve(ctx, oldCam);
    check('Approve a camera sighting filed 30 hours ago: placed, but the response says it is not visible', r3.status === 200 && r3.json.map.on_map === true && r3.json.map.visible_on_map === false && !(await feed()).includes('61'));

    const list = (await call(ctx, '/api/moderation/approved-photo-sightings')).json.sightings;
    const of = id => list.find(x => x.submission_id === id);
    check('the approved list agrees with the feed: fresh visible, stale and old-camera not', of(fresh).on_map && of(fresh).visible_on_map === true && of(stale).on_map && of(stale).visible_on_map === false && of(oldCam).on_map && of(oldCam).visible_on_map === false);
    const plain = (await submit(ctx, { service_area: 'Austin', license_plate: 'PLAIN34' })).json.submission_id;
    await approve(ctx, plain);
    const plainRow = (await call(ctx, '/api/moderation/approved-photo-sightings')).json.sightings.find(x => x.submission_id === plain);
    check('not on the map at all: on_map false, visible_on_map false', plainRow.on_map === false && plainRow.visible_on_map === false);
  }

  console.log('13. Moderation page: the badge and toasts never claim a marker the map will not show');
  {
    const ctx = await makeApp();
    const ago = (id, hours) => ctx.d1.exec(`UPDATE vehicle_observations SET observed_at = datetime('now', '-${hours} hours') WHERE submission_id = '${id}'`);
    const fresh = (await recent(ctx)).json.submission_id;
    await approve(ctx, fresh);
    const old = (await submit(ctx, { service_area: 'Austin', camera_id: '61' })).json.submission_id;
    ago(old, 30);
    await approve(ctx, old);
    const stale = (await submit(ctx, { service_area: 'Austin', license_plate: 'STALE34' })).json.submission_id;
    await approve(ctx, stale);
    ago(stale, 30);
    const dom = new JSDOM(read('public/moderation.html'), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/moderation.html', pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.localStorage.setItem('teslaSessionId', 'session-mod');
    w.URL.createObjectURL = () => 'blob:x';
    w.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u === 'data/traffic-cameras.json') return new Response(read('public/data/traffic-cameras.json'));
      return worker.fetch(new Request(`https://x${u.replace(WORKER_ORIGIN, '')}`, init), ctx.env, {});
    };
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/moderation.js')}`);
    await new Promise(r => setTimeout(r, 150));
    const d = w.document;
    const card = id => d.querySelector(`#modApprovedList [data-approved-id="${id}"]`);
    check('a fresh capture reads "On the Zones map ✓"', card(fresh).textContent.includes('On the Zones map ✓'));
    check('a capture over 24 hours old never reads "On the Zones map ✓"; it says it is off the map, and why', !card(old).textContent.includes('On the Zones map ✓') && /Off the Zones map/.test(card(old).textContent) && /24 hours/.test(card(old).textContent) && !card(old).querySelector('[data-approved-action="add-to-map"]'));

    card(stale).querySelector('button[data-approved-action="add-to-map"]').click();
    await new Promise(r => setTimeout(r, 80));
    d.getElementById('modMapCamera').value = '538';
    d.getElementById('modMapForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 150));
    const toast = d.getElementById('toastRoot').lastElementChild.textContent;
    check('Add to map on a capture over 24 hours old: the toast says it will not show, not "Added ✓"', !/Added to the Zones map ✓/.test(toast) && /24 hours/.test(toast));
    check('...and its card says off the map, not ✓', !card(stale).textContent.includes('On the Zones map ✓') && /Off the Zones map/.test(card(stale).textContent));
    w.close();
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
