// Sightings replay (/replay, public/js/replay.js) and its data endpoint
// GET /api/camera-sightings/history (worker/camera-sightings.js).
//   - only public data: camera-watch detections, and spotter detections whose
//     sighting is still approved with its photo; nothing else ever appears
//   - the window, chronological order, pagination; the Zones feed unchanged
//   - the page: counter == dots shown == sightings in range, appearance order is
//     chronological, ranges/dates in the URL, scrubbing, reduced motion
// Real SQL (every migration) + the REAL Worker router; the page runs in jsdom.
// Run: node tests/replay.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const H = 3600e3;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider'] });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  ctx.d1.exec('DELETE FROM camera_detections');   // without the migration's seed row
  return ctx;
}
let n = 0;
function detection(ctx, ms, { camera = '65', source = null } = {}) {
  n += 1;
  ctx.d1.prepare(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key, source_submission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`det-${String(n).padStart(4, '0')}`, camera, `CAM ${camera}`, 30.27 + n / 1000, -97.74, iso(ms), `camera-captures/${camera}/${n}.jpg`, source)._exec();
  return `det-${String(n).padStart(4, '0')}`;
}
function sighting(ctx, id, { status = 'approved', photo = true } = {}) {
  ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, evidence_ref) VALUES (?, 'rider', 'vehicle_sighting', ?, 'photo', ?)`).bind(id, status, photo ? `evidence/rider/${id}.jpg` : null)._exec();
  return id;
}
const history = async (ctx, qs) => {
  const r = await worker.fetch(new Request(`https://x/api/camera-sightings/history?${qs}`), ctx.env, {});
  let body = null; try { body = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body, r };
};

async function run() {
  const NOW = Date.now();
  console.log('1. History endpoint: public data only, in order, paged');
  {
    const ctx = await makeApp();
    const inRange = [];
    inRange.push(detection(ctx, NOW - 20 * H));                                       // watch
    inRange.push(detection(ctx, NOW - 3 * H, { camera: '1493' }));                    // watch
    inRange.push(detection(ctx, NOW - 10 * H, { camera: '538', source: sighting(ctx, 'ok-sig') }));   // spotter, approved with photo
    detection(ctx, NOW - 8 * H, { source: sighting(ctx, 'pending-sig', { status: 'pending' }) });     // not approved: never shown
    detection(ctx, NOW - 7 * H, { source: sighting(ctx, 'nophoto-sig', { photo: false }) });          // photo gone: never shown
    detection(ctx, NOW - 30 * H);                                                     // outside the window
    const r = await history(ctx, `from=${iso(NOW - 24 * H)}&to=${iso(NOW)}`);
    const d = r.body.detections;
    check('200, only the 3 public detections in the window', r.status === 200 && d.length === 3, JSON.stringify(d));
    check('oldest first (chronological)', d.every((x, i) => i === 0 || d[i - 1].t <= x.t));
    check('camera-watch vs spotter is labelled', d.map(x => x.source).join() === 'watch,spotter,watch');
    check('exactly the public fields (no ids, image keys or submission ids)', d.every(x => Object.keys(x).join() === 't,lat,lng,camera_id,camera_name,source') && !/det-|evidence|camera-captures|sig/.test(JSON.stringify(d)));
    check('an unapproved sighting\'s detection never appears; nor one whose photo is gone', !d.some(x => x.t === iso(NOW - 8 * H) || x.t === iso(NOW - 7 * H)));

    // Pagination: every row exactly once, in order.
    for (let i = 0; i < 9; i++) detection(ctx, NOW - (12 - i) * H - 60e3, { camera: String(100 + i) });
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const p = await history(ctx, `from=${iso(NOW - 24 * H)}&to=${iso(NOW)}&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...p.body.detections); cursor = p.body.next_cursor; pages++;
    } while (cursor && pages < 10);
    check('pages of 4 cover all 12 public detections exactly once, in order', seen.length === 12 && pages === 3 && seen.every((x, i) => i === 0 || seen[i - 1].t <= x.t));

    const bad = [
      ['no range', ''],
      ['not ISO', 'from=yesterday&to=now'],
      ['more than 31 days', `from=${iso(NOW - 40 * 24 * H)}&to=${iso(NOW)}`],
      ['ending in the future', `from=${iso(NOW)}&to=${iso(NOW + 24 * H)}`],
      ['to before from', `from=${iso(NOW)}&to=${iso(NOW - H)}`],
      ['a malformed cursor', `from=${iso(NOW - H)}&to=${iso(NOW)}&cursor=nope`]
    ];
    for (const [label, qs] of bad) check(`${label}: 400`, (await history(ctx, qs)).status === 400);
    check('cacheable at the edge', /public, max-age=60/.test(r.r.headers.get('Cache-Control')));
    const zones = await (await worker.fetch(new Request('https://x/api/camera-sightings'), ctx.env, {})).json();
    check('the Zones map feed is unchanged (latest per camera, last 24h)', Array.isArray(zones) && Object.keys(zones[0]).join() === 'camera_id,camera_name,lat,lng,observed_at,image_url' && new Set(zones.map(z => z.camera_id)).size === zones.length);
  }

  console.log('2. Window from the URL (Austin time)');
  {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(read('public/js/replay.js'));
    const R = dom.window.CCCReplay;
    const now = Date.parse('2026-10-02T17:00:00Z');   // Oct 2, 12 PM CDT
    const w24 = R.windowFor('', now);
    check('default: the last 24 hours, ending now', w24.range === '24h' && w24.end === now && w24.start === now - 24 * H && w24.date === null);
    const w7 = R.windowFor('?range=7d', now);
    check('?range=7d: the last 7 days', w7.end - w7.start === 7 * 24 * H);
    const past = R.windowFor('?range=24h&date=2026-09-30', now);
    check('?date=2026-09-30: ends at that day\'s Austin midnight (Oct 1, 05:00 UTC in CDT)', past.end === Date.parse('2026-10-01T05:00:00Z') && past.start === past.end - 24 * H && past.date === '2026-09-30');
    const today = R.windowFor('?range=24h&date=2026-10-02', now);
    check('today\'s date: never past now', today.end === now);
    check('an unknown range falls back to 24h', R.windowFor('?range=99y', now).range === '24h');
    check('the tint follows the time of day (night indigo, midday clear, dusk amber)', /^rgba\(38,44,112/.test(R.tintAt(2)) && /,0\.000\)$/.test(R.tintAt(12)) && /^rgba\(255,1[45]\d,/.test(R.tintAt(18.5)));
    dom.window.close();
  }

  console.log('3. The page (jsdom)');
  async function page(ctx, search, { reduceMotion = false } = {}) {
    const html = read('public/replay.html').replace(/<script src="https?:[^"]*"><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://cybercabhunter.com/replay${search}`, pretendToBeVisual: true });
    const w = dom.window;
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.matchMedia = q => ({ matches: reduceMotion && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    w.fetch = async url => {
      const u = String(url);
      if (u.startsWith('/api/camera-sightings/history')) return worker.fetch(new Request(`https://x${u}`), ctx.env, {});
      return new Response('{}', { status: 404 });
    };
    w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/replay.js')}`);
    await new Promise(r => setTimeout(r, 120));
    return { w, d: w.document, R: w.CCCReplay };
  }
  {
    const ctx = await makeApp();
    const times = [22, 18, 18.5, 9, 3, 1].map(h => NOW - h * H);
    times.forEach((ms, i) => detection(ctx, ms, { camera: String(200 + (i % 3)) }));
    detection(ctx, NOW - 5 * H, { source: sighting(ctx, 'p2', { status: 'pending' }) });   // never shown
    detection(ctx, NOW - 40 * H);                                                          // outside 24h

    const done = await page(ctx, '?range=24h', { reduceMotion: true });
    const counter = () => Number(done.d.getElementById('replayCounter').dataset.value);
    check('reduced motion: straight to the full picture — 6 sightings', counter() === 6 && done.R.state.T === done.R.state.end);
    check('the counter matches the dots shown', Number(done.d.getElementById('replayCanvas').dataset.dots) === counter() && done.R.state.shown === counter());
    check('the odometer has one rolling column per digit', done.d.querySelectorAll('#replayCounter .od-col').length === 1 && done.d.querySelector('#replayCounter .od-strip').style.transform === 'translateY(-6em)');
    check('the unapproved sighting and the out-of-range one never appear', done.R.state.dots.length === 6);
    check('the range button and labels follow the URL', done.d.querySelector('#replayRange [data-range="24h"]').getAttribute('aria-pressed') === 'true' && done.d.getElementById('replayRangeLabel').textContent === 'Last 24 hours');
    const ribbon = done.d.getElementById('replayRibbon');
    ribbon.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 48 });
    ribbon.dispatchEvent(new done.w.MouseEvent('pointerdown', { clientX: 500, bubbles: true }));
    ribbon.dispatchEvent(new done.w.MouseEvent('pointerup', { bubbles: true }));
    const mid = done.R.state.start + 0.5 * (done.R.state.end - done.R.state.start);
    const expected = times.filter(ms => ms <= mid).length;
    check(`scrubbing to the middle shows exactly the ${expected} sightings before it`, done.R.state.T === mid && counter() === expected && Number(done.d.getElementById('replayCanvas').dataset.dots) === expected);
    done.w.close();

    const live = await page(ctx, '?range=24h');
    live.d.querySelector('#replaySpeed [data-speed="60"]').click();
    for (let i = 0; i < 80 && live.R.state.T < live.R.state.end; i++) await new Promise(r => setTimeout(r, 50));
    const appeared = live.R.state.appeared;
    check('playback runs to the end of the window and shows all 6', live.R.state.T === live.R.state.end && appeared.length === 6 && Number(live.d.getElementById('replayCounter').dataset.value) === 6);
    check('sightings appear in chronological order', appeared.every((x, i) => i === 0 || appeared[i - 1] <= x) && JSON.stringify(appeared) === JSON.stringify([...times].map(ms => Math.floor(ms / 1000) * 1000).sort((a, b) => a - b)));   // stored to the second
    check('the play button offers Play again at the end', live.d.getElementById('replayPlay').getAttribute('aria-label') === 'Play');
    live.w.close();

    const empty = await makeApp();
    const none = await page(empty, '?range=7d', { reduceMotion: true });
    check('a window with no sightings: an honest empty state, counter 0, nothing faked', !none.d.getElementById('replayEmpty').classList.contains('hidden') && Number(none.d.getElementById('replayCounter').dataset.value) === 0 && none.R.state.dots.length === 0);
    none.w.close();
  }

  console.log('4. Placement and links');
  {
    const zones = read('public/infrastructure.html');
    check('the Zones map has a Replay button linking to today\'s replay', /<a id="zonesReplay" href="\/replay\?range=24h"[^>]*>[\s\S]*?Replay\s*<\/a>/.test(zones));
    const html = read('public/replay.html');
    check('the replay page is public (no sign-in gate) and draws on one canvas', !/signin\.html\?returnTo=%2Freplay/.test(html) && (html.match(/<canvas id="replayCanvas"/g) || []).length === 1);
    check('no video export of any kind', !/MediaRecorder|captureStream|\.mp4|\.webm|download=/i.test(read('public/js/replay.js') + html));
    check('the brand mark is on the stage', /cybercabhunter\.com<\/span>/.test(html));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
