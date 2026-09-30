// Camera-watch Cybercab detections on the Zones map (worker/camera-sightings.js,
// migrations 0018/0019, public/infrastructure.html).
//   - public GET: trailing 24 hours only, the LATEST detection per camera, newest first,
//     exactly six fields (no plate, VIN or registry link)
//   - POST: bearer token required (503 unconfigured, 401 missing/wrong), strict validation,
//     the JPEG stored in R2 at camera-captures/<camera_id>/<timestamp>.jpg plus the D1 row,
//     a retry of the same capture is one row
//   - the image route serves the stored capture; the seeded camera 65 row exists
//   - the page: one marker per camera, reconciled on refresh (never duplicated), popup with
//     image / name / Chicago time, a failed or empty fetch leaves no markers, legend entry
// Real SQL (every migration) + the REAL Worker router; the page script runs in jsdom.
// Run: node tests/camera-sightings.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { apiListCameraSightings, apiCreateCameraSighting } from '../worker/camera-sightings.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/infrastructure.html`, 'utf8');
const TOKEN = 'camera-watch-test-token';
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1, 0xFF, 0xD9]);
const NOW = Date.parse('2026-09-30T03:00:00Z');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const H = 3600000;

async function app({ token = TOKEN } = {}) {
  const ctx = await makeEnv({ users: [] });
  ctx.env.ASSETS = { fetch: async () => new Response('static', { status: 404 }) };
  if (token) ctx.env.CAMERA_WATCH_TOKEN = token;
  return ctx;
}
const row = (ctx, id, camera, observedAt, { key = `camera-captures/${camera}/${id}.jpg`, lat = 30.27, lng = -97.74 } = {}) =>
  ctx.d1.prepare(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, camera, `CAMERA ${camera}`, lat, lng, observedAt, key)._exec();
const list = async (ctx, now = NOW) => (await apiListCameraSightings(new Request('https://x/api/camera-sightings'), ctx.env, null, { now })).json();
const body = (o = {}) => ({ camera_id: '65', camera_name: 'MARTIN LUTHER KING JR BLVD / TRINITY ST', lat: 30.279638, lng: -97.734512, observed_at: '2026-09-30T01:24:33Z', image_base64: JPEG.toString('base64'), ...o });
const post = (ctx, b, { auth = `Bearer ${TOKEN}`, now = NOW } = {}) => apiCreateCameraSighting(new Request('https://x/api/camera-sightings', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: typeof b === 'string' ? b : JSON.stringify(b)
}), ctx.env, { now });
const route = (ctx, path, init = {}) => worker.fetch(new Request(`https://x${path}`, init), ctx.env, {});

async function run() {
  console.log('1. Migration + seed');
  {
    const ctx = await app();
    const cols = ctx.d1.query(`PRAGMA table_info(camera_detections)`).map(c => c.name).join();
    check('camera_detections has the specified columns', cols === 'id,camera_id,camera_name,lat,lng,observed_at,image_r2_key,created_at', cols);
    const seed = ctx.d1.query(`SELECT * FROM camera_detections`);
    check('exactly one seeded row: camera 65 at MLK / Trinity, 2026-09-30T01:24:33Z, the camera\'s inventory coordinates, no image yet',
      seed.length === 1 && seed[0].camera_id === '65' && seed[0].camera_name === 'MARTIN LUTHER KING JR BLVD / TRINITY ST' &&
      seed[0].observed_at === '2026-09-30T01:24:33Z' && seed[0].lat === 30.279638 && seed[0].lng === -97.734512 && seed[0].image_r2_key === null);
    check('created_at defaults to an ISO 8601 UTC timestamp', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(seed[0].created_at));
    const out = await list(ctx);
    check('the seed is on the public list while it is within 24 hours, with image_url null (placeholder)', out.length === 1 && out[0].camera_id === '65' && out[0].image_url === null);
    check('...and drops off after 24 hours', (await list(ctx, Date.parse('2026-10-01T01:24:34Z'))).length === 0);
  }

  console.log('2. Public GET: 24-hour window, latest per camera, newest first');
  {
    const ctx = await app();
    ctx.d1.exec('DELETE FROM camera_detections');
    row(ctx, 'a-old', '10', iso(NOW - 30 * H));          // outside the window
    row(ctx, 'b-early', '20', iso(NOW - 20 * H));
    row(ctx, 'b-late', '20', iso(NOW - 2 * H));          // camera 20's latest
    row(ctx, 'b-mid', '20', iso(NOW - 5 * H));
    row(ctx, 'c-only', '30', iso(NOW - 1 * H));
    row(ctx, 'd-edge', '40', iso(NOW - 24 * H));         // exactly 24h: included
    row(ctx, 'e-future', '50', iso(NOW + 2 * H));        // a clock-skewed future row: excluded
    const out = await list(ctx);
    check('only detections in the trailing 24 hours (30h-old and future rows excluded)', out.every(d => !['10', '50'].includes(d.camera_id)));
    check('one entry per camera', out.length === 3 && new Set(out.map(d => d.camera_id)).size === 3, JSON.stringify(out.map(d => d.camera_id)));
    check('each camera\'s LATEST detection', out.find(d => d.camera_id === '20').observed_at === iso(NOW - 2 * H));
    check('ordered by observed_at, newest first', out.map(d => d.camera_id).join() === '30,20,40', out.map(d => d.camera_id).join());
    check('exactly the six public fields (no plate, VIN, registry id or R2 key)', out.every(d => Object.keys(d).join() === 'camera_id,camera_name,lat,lng,observed_at,image_url'));
    check('image_url is a Worker-served path for the detection', out.find(d => d.camera_id === '20').image_url === '/api/camera-sightings/b-late/image');
    const r = await route(ctx, '/api/camera-sightings');
    check('the router serves the GET publicly (no auth), cacheable', r.status === 200 && /public, max-age=60/.test(r.headers.get('Cache-Control')));
    const empty = await app(); empty.d1.exec('DELETE FROM camera_detections');
    check('no detections -> []', JSON.stringify(await list(empty)) === '[]');
  }

  console.log('3. POST: auth');
  {
    const unconfigured = await app({ token: null });
    const r0 = await post(unconfigured, body());
    check('no CAMERA_WATCH_TOKEN configured -> 503 not_configured', r0.status === 503 && (await r0.json()).error === 'not_configured');
    const ctx = await app();
    const before = ctx.d1.query('SELECT COUNT(*) n FROM camera_detections')[0].n;
    const r1 = await post(ctx, body(), { auth: null });
    check('no Authorization -> 401', r1.status === 401 && r1.headers.get('WWW-Authenticate') === 'Bearer');
    const r2 = await post(ctx, body(), { auth: 'Bearer wrong-token' });
    check('a wrong token -> 401', r2.status === 401);
    const r3 = await route(ctx, '/api/camera-sightings', { method: 'POST', headers: { Cookie: 'session=whatever', 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    check('a browser session is not accepted (through the router) -> 401', r3.status === 401);
    check('rejected requests store nothing', ctx.d1.query('SELECT COUNT(*) n FROM camera_detections')[0].n === before && ctx.env.EVIDENCE_BUCKET._objects.size === 0);
  }

  console.log('4. POST: stores the JPEG in R2 and the row in D1');
  {
    const ctx = await app();
    ctx.d1.exec('DELETE FROM camera_detections');
    const r = await route(ctx, '/api/camera-sightings', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body({ observed_at: iso(Date.now() - H), camera_id: 65 })) });
    const out = await r.json();
    check('201 with the new id and its image_url', r.status === 201 && out.ok === true && out.image_url === `/api/camera-sightings/${out.id}/image`);
    const stored = ctx.d1.query('SELECT * FROM camera_detections')[0];
    const key = `camera-captures/65/${iso(Date.now() - H).replace(/[-:]/g, '').slice(0, 13)}`;
    check('R2 key is camera-captures/<camera_id>/<timestamp>.jpg', /^camera-captures\/65\/\d{8}T\d{6}Z\.jpg$/.test(stored.image_r2_key) && stored.image_r2_key.startsWith(key), stored.image_r2_key);
    check('the R2 object holds exactly the uploaded JPEG bytes', Buffer.from(ctx.env.EVIDENCE_BUCKET._objects.get(stored.image_r2_key)).equals(JPEG));
    check('the row has the camera, its coordinates and observed_at in the stored form (a numeric camera_id is accepted)', stored.camera_id === '65' && stored.lat === 30.279638 && stored.lng === -97.734512 && /Z$/.test(stored.observed_at) && !/\./.test(stored.observed_at));
    const img = await route(ctx, out.image_url);
    check('the image route serves it as image/jpeg', img.status === 200 && img.headers.get('Content-Type') === 'image/jpeg' && Buffer.from(await img.arrayBuffer()).equals(JPEG));
    check('an unknown or seeded-without-image detection has no image (404)', (await route(ctx, '/api/camera-sightings/nope/image')).status === 404);
    const listed = await (await route(ctx, '/api/camera-sightings')).json();
    check('the new detection appears on the public list', listed.length === 1 && listed[0].image_url === out.image_url);

    const again = await post(ctx, body({ observed_at: '2026-09-30T02:00:00.000Z' }));
    const retry = await post(ctx, body({ observed_at: '2026-09-29T21:00:00-05:00' }));   // the same instant, written differently
    const rb = await retry.json();
    check('a retry of the same capture is one row (200 duplicate, same id)', again.status === 201 && retry.status === 200 && rb.duplicate === true && ctx.d1.query(`SELECT COUNT(*) n FROM camera_detections WHERE observed_at = '2026-09-30T02:00:00Z'`)[0].n === 1);
    const withData = await post(ctx, body({ observed_at: '2026-09-30T02:30:00Z', image_base64: 'data:image/jpeg;base64,' + JPEG.toString('base64') }));
    check('a data: URI prefix is accepted', withData.status === 201);
  }

  console.log('5. POST: validation');
  {
    const ctx = await app();
    const cases = [
      ['not JSON', 'not json', 'invalid_body'],
      ['an array', [], 'invalid_body'],
      ['an unknown field (e.g. a plate)', body({ plate: 'ABC123' }), 'unknown_field'],
      ['a bad camera_id', body({ camera_id: '../65' }), 'invalid_camera_id'],
      ['an empty camera_name', body({ camera_name: '  ' }), 'invalid_camera_name'],
      ['coordinates outside the Austin metro', body({ lat: 32.78, lng: -96.8 }), 'invalid_location'],
      ['string coordinates', body({ lat: '30.27' }), 'invalid_location'],
      ['observed_at without a zone', body({ observed_at: '2026-09-30T01:24:33' }), 'invalid_observed_at'],
      ['observed_at in the future', body({ observed_at: iso(NOW + H) }), 'invalid_observed_at'],
      ['observed_at garbage', body({ observed_at: 'yesterday' }), 'invalid_observed_at'],
      ['missing image', body({ image_base64: undefined }), 'invalid_image_base64'],
      ['a PNG instead of a JPEG', body({ image_base64: Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]).toString('base64') }), 'not_jpeg'],
      ['bad base64', body({ image_base64: '!!!!' }), 'invalid_image_base64'],
      ['an image over 2 MB', body({ image_base64: Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64') }), 'image_too_large']
    ];
    for (const [label, b, error] of cases) {
      const r = await post(ctx, b);
      const out = await r.json();
      check(`${label} -> 400 ${error}`, r.status === 400 && out.error === error, `${r.status} ${out.error}`);
    }
    check('nothing was stored by any invalid request', ctx.env.EVIDENCE_BUCKET._objects.size === 0 && ctx.d1.query('SELECT COUNT(*) n FROM camera_detections')[0].n === 1);
  }

  console.log('6. Privacy: no registry linkage');
  {
    const src = fs.readFileSync(`${ROOT}worker/camera-sightings.js`, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    check('the module never touches robotaxi_vehicles, plates or VINs', !/robotaxi_vehicles|plate|vin\b/i.test(src));
  }

  console.log('7. Zones page');
  async function page(responder) {
    const dom = new JSDOM(HTML.replace(/<script src="https?:[^"]*"><\/script>/g, '').replace(/<script src="js\/[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url: 'https://cybercabhunter.com/infrastructure', pretendToBeVisual: true });
    const w = dom.window;
    const markers = [];
    class Popup { constructor(o) { this.opts = o; } setHTML(h) { this.html = h; return this; } setLngLat() { return this; } addTo() { return this; } }
    class Marker {
      constructor(o) { this.el = o.element; this.anchor = o.anchor; }
      setLngLat(ll) { this.ll = ll; return this; } setPopup(p) { this.popup = p; return this; } getPopup() { return this.popup; }
      addTo() { markers.push(this); w.document.body.appendChild(this.el); return this; } remove() { this.removed = true; this.el.remove(); }
    }
    class LngLatBounds { constructor() {} extend() { return this; } }
    w.maplibregl = { Map: class { on() {} fitBounds() {} resize() {} setPaintProperty() {} addSource() {} addLayer() {} getCanvas() { return { style: {} }; } }, Marker, Popup, LngLatBounds };
    w.ResizeObserver = class { observe() {} };
    w.CCC = { init() {}, animateCounter() {} };
    const intervals = [];
    w.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
    const calls = [];
    w.fetch = async u => { calls.push(String(u)); return responder(String(u)); };
    const script = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('chargingLocations'));
    w.eval(script);
    await new Promise(r => setTimeout(r, 20));
    const cams = () => markers.filter(m => m.el.className === 'camera-cybercab');   // every camera marker ever created
    const live = () => cams().filter(m => !m.removed);
    const tick = async () => { await intervals.find(i => i.ms === 60000).fn(); await new Promise(r => setTimeout(r, 10)); };
    return { w, d: w.document, cams, live, tick, calls, intervals };
  }
  const det = (camera, observedAt, o = {}) => ({ camera_id: camera, camera_name: `CAMERA ${camera} / MAIN ST`, lat: 30.28, lng: -97.73, observed_at: observedAt, image_url: `/api/camera-sightings/id-${camera}/image`, ...o });
  {
    let data = [det('65', '2026-09-30T01:24:33Z', { camera_name: 'MARTIN LUTHER KING JR BLVD / TRINITY ST', lat: 30.279638, lng: -97.734512 }), det('7', '2026-09-30T00:10:00Z', { image_url: null })];
    let fail = false;
    const p = await page(() => (fail ? Promise.reject(new TypeError('down')) : Promise.resolve(new Response(JSON.stringify(data), { status: 200 }))));
    check('it fetches the same-origin /api/camera-sightings', p.calls[0] === '/api/camera-sightings');
    check('one marker per camera', p.live().length === 2);
    const m65 = p.live().find(m => m.popup.html.includes('TRINITY'));
    check('the marker sits at the camera: [lng, lat], anchored center', m65.ll[0] === -97.734512 && m65.ll[1] === 30.279638 && m65.anchor === 'center');
    check('the marker icon is CybercabOverhead.png at 34px inside a 44px tap target, with a gold ring',
      m65.el.querySelector('img').getAttribute('src') === 'images/CybercabOverhead.png' && m65.el.style.width === '44px' && /width:34px/.test(m65.el.innerHTML) && /rgba\(212,175,55/.test(m65.el.innerHTML));
    check('the marker has an accessible label', /TRINITY/.test(m65.el.getAttribute('aria-label')));
    const html = m65.popup.html;
    check('popup: the capture image (220px max, rounded)', /<img src="\/api\/camera-sightings\/id-65\/image"/.test(html) && /width:220px;max-width:100%/.test(html) && /rounded-lg/.test(html));
    check('popup: the camera name', html.includes('MARTIN LUTHER KING JR BLVD / TRINITY ST'));
    check('popup: observed time in America/Chicago ("Sep 29, 8:24 PM CDT")', html.includes('Sep 29, 8:24 PM CDT'), html.match(/Sep[^<]*/)?.[0]);
    check('popup fits a 320px phone (maxWidth 248px)', m65.popup.opts.maxWidth === '248px');
    check('a detection without an image shows a clearly marked placeholder, not a hotlink', p.live().find(m => m !== m65).popup.html.includes('Capture image pending') && !/cctv\.austinmobility|screenshot/i.test(HTML));

    check('refresh runs every 60 seconds', p.intervals.some(i => i.ms === 60000));
    await p.tick();
    check('a refresh with the same data creates no new markers', p.live().length === 2 && p.cams().length === 2);
    data = [det('65', '2026-09-30T02:24:33Z', { camera_name: 'MARTIN LUTHER KING JR BLVD / TRINITY ST', lat: 30.279638, lng: -97.734512 }), det('9', '2026-09-30T02:00:00Z')];
    await p.tick();
    check('reconciled by camera_id: camera 65 updated in place, camera 7 removed, camera 9 added', p.live().length === 2 && p.cams().length === 3 && m65.removed !== true && m65.popup.html.includes('9:24 PM CDT') && p.live().some(m => m.popup.html.includes('CAMERA 9')));
    fail = true;
    await p.tick();
    check('a failed fetch leaves no camera markers and no error UI', p.live().length === 0 && !/error|failed/i.test(p.d.getElementById('infraMap').textContent));
    fail = false; data = [];
    await p.tick();
    check('an empty response: still no markers', p.live().length === 0);
    data = [det('65', '2026-09-30T02:24:33Z')];
    await p.tick();
    check('markers come back on the next good refresh', p.live().length === 1);

    const escaped = await page(() => Promise.resolve(new Response(JSON.stringify([det('1', '2026-09-30T01:00:00Z', { camera_name: '<img src=x onerror=alert(1)>', image_url: 'https://evil.example/x.jpg' })]))));
    const eh = escaped.live()[0].popup.html;
    check('the camera name is escaped and a foreign image URL is never used', !eh.includes('<img src=x') && eh.includes('&lt;img') && !eh.includes('evil.example'));
    const bad = await page(() => Promise.resolve(new Response('oops', { status: 500 })));
    check('a server error on first load: no markers', bad.live().length === 0);

    const legend = p.d.querySelector('#austinContent').textContent.replace(/\s+/g, ' ');
    const entry = [...p.d.querySelectorAll('#austinContent span')].find(s => s.textContent.trim() === 'Cybercabs');
    check('legend: "Cybercabs" beside "Charging Locations", with the icon to the LEFT of the text at 18px',
      /Charging Locations Cybercabs/.test(legend) && entry && entry.firstElementChild.tagName === 'IMG' && entry.firstElementChild.getAttribute('src') === 'images/CybercabOverhead.png' && entry.firstElementChild.getAttribute('width') === '18');
    check('the legend row wraps on narrow screens (flex-wrap)', entry.parentElement.classList.contains('flex-wrap'));
    check('the icon file exists where the page references it', fs.existsSync(`${ROOT}public/images/CybercabOverhead.png`));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
