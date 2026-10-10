// Zones heatmap (worker/camera-sightings.js apiCameraSightingsHeat,
// public/js/zones-heatmap.js) and the homepage forecasts (public/js/forecast.js,
// the fleet growth chart in index.html, public/js/dmv-panel.js):
//   - the heat API: per-camera counts from real detection rows only, the public
//     approval filter, one count per detection filed twice, Austin-time hour x
//     weekday grid (DST-safe), ranges, cities, validation
//   - statsFor: hour filter, busiest hour / day, most recent
//   - the forecast: never negative, never decreasing, linear (not exponential),
//     zero days counted, gaps not counted as zero, one-day spikes damped, only
//     data up to the start, too little history -> a reason, per-series rates
//   - all three features are off by default and wired into their pages
// Run: node tests/heatmap-forecast.test.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { apiCameraSightingsHeat, austinHourDay } from '../worker/camera-sightings.js';

const require = createRequire(import.meta.url);
const F = require('../public/js/forecast.js');
const t = makeCheck();
const { check } = t;
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const DAY = 864e5;
const NOW = Date.parse('2026-10-10T18:00:00Z');

async function heatEnv() {
  const ctx = await makeEnv({ users: ['u1'] });
  ctx.d1.exec('DELETE FROM camera_detections');
  const sub = (id, status, ev = 'photos/x.jpg', type = 'vehicle_sighting') => ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_ref) VALUES (?, 'u1', ?, ?, ?)`).bind(id, type, status, ev)._exec();
  let n = 0;
  const det = (camera, iso, { city = 'austin', submission = null, lat = 30.27, lng = -97.74 } = {}) => ctx.d1.prepare(`INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city, source_submission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`d${++n}`, camera, `CAM ${camera}`, lat, lng, iso, city, submission)._exec();
  return { ...ctx, sub, det };
}
const heat = async (env, qs) => { const r = await apiCameraSightingsHeat(new Request(`https://x/api/camera-sightings/heat?${qs}`), env, null, { now: NOW }); return { status: r.status, json: await r.json() }; };

async function run() {
  console.log('1. The heat API');
  {
    const e = await heatEnv();
    // Camera 10: three real detections (one is filed twice, 40 s apart).
    e.det('10', '2026-10-10T00:30:00Z');                       // Fri Oct 9, 7:30 PM CDT
    e.det('10', '2026-10-10T00:30:40Z');                       // the same Cybercab again -> counts once
    e.det('10', '2026-10-09T23:10:00Z');                       // Fri 6:10 PM CDT
    e.det('10', '2026-10-08T23:20:00Z');                       // Thu 6:20 PM CDT
    // Camera 20: approved spotter photo counts; pending, rejected, photo-less ones don't.
    e.sub('s1', 'approved'); e.sub('s2', 'pending'); e.sub('s3', 'rejected'); e.sub('s4', 'approved', null);
    e.det('20', '2026-10-10T15:00:00Z', { submission: 's1', lat: 30.26, lng: -97.75 });
    e.det('20', '2026-10-10T15:30:00Z', { submission: 's2', lat: 30.26, lng: -97.75 });
    e.det('20', '2026-10-10T16:00:00Z', { submission: 's3', lat: 30.26, lng: -97.75 });
    e.det('20', '2026-10-10T16:30:00Z', { submission: 's4', lat: 30.26, lng: -97.75 });
    // Camera 30: one detection long ago (all time only); camera 40: Dallas.
    e.det('30', '2026-08-01T12:00:00Z');
    e.det('40', '2026-10-05T12:00:00Z', { city: 'dallas', lat: 32.8, lng: -96.8 });
    // Two cameras at the same moment are two detections (dedupe is per camera).
    e.det('50', '2026-10-10T00:30:00Z', { lat: 30.3, lng: -97.7 });

    const w = await heat(e.env, 'city=austin&range=7d');
    const cam = id => w.json.cameras.find(c => c.camera_id === id);
    check('7 days: per-camera counts from detection rows; a detection filed twice within 2 minutes counts once', w.status === 200 && cam('10').count === 3 && w.json.total === 5);
    check('...an approved spotter photo counts; pending, rejected and photo-less sightings never do', cam('20').count === 1);
    check('...the same moment at two cameras is two detections', cam('50').count === 1);
    check('...a camera with no detection in the window adds nothing (not listed)', !cam('30') && w.json.cameras.every(c => c.count > 0));
    check('...the busiest camera first; coordinates are the camera\'s own', w.json.cameras[0].camera_id === '10' && cam('20').lat === 30.26 && cam('20').lng === -97.75);
    check('Austin time: 00:30 UTC Oct 10 is Friday 7 PM CDT (grid index 5*24+19)', cam('10').grid[5 * 24 + 19] === 1 && cam('10').grid[5 * 24 + 18] === 1 && cam('10').grid[4 * 24 + 18] === 1 && cam('10').grid.reduce((s, v) => s + v, 0) === 3);
    check('...across the DST change too (Nov 2 12:30 UTC = 6:30 AM CST, Sunday)', JSON.stringify(austinHourDay(Date.parse('2026-11-02T12:30:00Z'))) === JSON.stringify({ hour: 6, day: 1 }) && JSON.stringify(austinHourDay(Date.parse('2026-11-01T05:30:00Z'))) === JSON.stringify({ hour: 0, day: 0 }));
    check('...last and last_by_hour carry the real timestamps', cam('10').last === '2026-10-10T00:30:00Z' && cam('10').last_by_hour[19] === '2026-10-10T00:30:00Z' && cam('10').last_by_hour[18] === '2026-10-09T23:10:00Z');
    const d24 = await heat(e.env, 'city=austin&range=24h');
    check('24 hours: only the last day (Thursday\'s and the older camera drop out)', d24.json.cameras.find(c => c.camera_id === '10').count === 2 && d24.json.total === 4);
    const all = await heat(e.env, 'city=austin&range=all');
    check('all time: every detection, including the old one', all.json.total === 6 && all.json.cameras.some(c => c.camera_id === '30'));
    const dal = await heat(e.env, 'city=dallas&range=30d');
    check('cities are kept apart', dal.json.total === 1 && dal.json.cameras[0].camera_id === '40' && !all.json.cameras.some(c => c.camera_id === '40'));
    const none = await heat(e.env, 'city=dallas&range=24h');
    check('no detections: an empty list (the page shows an empty state, never fake heat)', none.status === 200 && none.json.total === 0 && none.json.cameras.length === 0);
    check('validation: unknown range or city -> 400', (await heat(e.env, 'city=austin&range=2y')).status === 400 && (await heat(e.env, 'city=houston&range=7d')).status === 400);
    check('the response has no image, submission or detection ids', !JSON.stringify(all.json).match(/image|submission|"id"/));
  }

  console.log('2. The page side (zones-heatmap.js)');
  {
    const sandbox = { window: {}, document: {}, console };
    vm.runInNewContext(read('public/js/zones-heatmap.js'), sandbox);
    const { statsFor } = sandbox.window.CCCZonesHeat;
    const grid = new Array(168).fill(0);
    grid[5 * 24 + 17] = 3; grid[1 * 24 + 17] = 1; grid[1 * 24 + 9] = 4;
    const cam = { grid, last: '2026-10-10T00:00:00Z', last_by_hour: Object.assign(new Array(24).fill(null), { 17: '2026-10-09T22:30:00Z', 9: '2026-10-06T14:00:00Z' }) };
    const allH = statsFor(cam, null), five = statsFor(cam, 17);
    check('all hours: total, busiest hour (9 AM, 4) and busiest day (Monday, 5)', allH.count === 8 && allH.busiestHour === 9 && allH.busiestDay === 1 && allH.last === cam.last);
    check('5-6 PM only: 4 detections, busiest day Friday, most recent in that hour', five.count === 4 && five.busiestDay === 5 && five.last === '2026-10-09T22:30:00Z');
    check('an hour with nothing: zero, no busiest', statsFor(cam, 3).count === 0 && statsFor(cam, 3).busiestDay === null);
    const js = read('public/js/zones-heatmap.js');
    check('off by default: Normal Map pressed, the heat panel hidden', /data-zh-mode="normal" aria-pressed="true"/.test(js) && /data-zh-mode="heat" aria-pressed="false"/.test(js) && /data-zh-panel hidden/.test(js) && /let mode = 'normal', range = '7d'/.test(js));
    check('heat comes only from the API\'s detections (no random or simulated points)', !/Math\.random/.test(js) && /\/api\/camera-sightings\/heat/.test(js));
    check('switching back restores the icons and never moves the map', /classList\.toggle\('zones-heat-on'/.test(js) && !/flyTo|fitBounds|jumpTo|setCenter|setZoom/.test(js));
    const page = read('public/infrastructure.html');
    check('the Zones page loads it and refreshes it on a city switch', page.includes('js/zones-heatmap.js') && /CCCZonesHeat\.attach\(map, \{ city: \(\) => currentCity \}\)/.test(page) && /if \(heat\) heat\.refresh\(\)/.test(page));
    check('the camera icons are hidden only while the heatmap is on', /\.zones-heat-on \.camera-cybercab\{display:none !important;\}/.test(read('public/css/style.css')));
  }

  console.log('3. The forecast (forecast.js)');
  {
    const start = Date.parse('2026-09-01T12:00:00Z');
    const end = start + 40 * DAY;
    // Steady: +2 a day for 40 days.
    const steady = Array.from({ length: 41 }, (_, i) => ({ t: start + i * DAY, value: 10 + 2 * i }));
    const f = F.forecast(steady, { horizonDays: 30, endMs: end });
    const v = f.points.map(p => p.value);
    check('a steady +2/day history projects about +2/day', f.ok && Math.abs(v[29] - (90 + 60)) <= 2 && f.current === 90);
    check('never below the current count, never decreasing; bands bracket the value', v.every((x, i) => x >= 90 && (i === 0 || x >= v[i - 1])) && f.points.every((p, i) => p.low <= p.value && p.high >= p.value && p.low >= 90 && (i === 0 || (p.low >= f.points[i - 1].low && p.high >= f.points[i - 1].high))));
    // Accelerating history: no exponential extrapolation.
    const accel = Array.from({ length: 41 }, (_, i) => ({ t: start + i * DAY, value: Math.round(Math.pow(1.08, i)) }));
    const fa = F.forecast(accel, { horizonDays: 90, endMs: end });
    const lastRate = accel[40].value - accel[39].value;
    check('growth is linear: 90 days never add more than 90 x the latest daily rise', fa.ok && fa.points[89].value - fa.current <= 90 * lastRate);
    // Zero days are counted: a long flat stretch slows the rate.
    const flat = Array.from({ length: 41 }, (_, i) => ({ t: start + i * DAY, value: i < 20 ? 2 * i : 38 }));
    const ff = F.forecast(flat, { horizonDays: 30, endMs: end });
    check('days with no additions count as zero (a stalled fleet projects little)', ff.ok && ff.rates.r7 === 0 && ff.points[29].value - ff.current < 15);
    // Gaps are spread, not zero: two points 20 days apart.
    const sparse = [{ t: start, value: 0 }, { t: start + 20 * DAY, value: 100 }, { t: start + 21 * DAY, value: 105 }, { t: start + 22 * DAY, value: 110 }];
    const daily = F.dailyAdditions(sparse, start + 22 * DAY);
    check('a missing stretch between snapshots is spread over its days, never counted as zero', daily.days.slice(0, 20).every(d => Math.abs(d.add - 5) < 1e-9 && d.approx) && daily.days.length === 22);
    // A one-day spike is damped.
    const spiky = Array.from({ length: 41 }, (_, i) => ({ t: start + i * DAY, value: 2 * i + (i >= 38 ? 400 : 0) }));
    const fs1 = F.forecast(spiky, { horizonDays: 30, endMs: end });
    check('one 400-vehicle batch is capped, so it can\'t set the pace', fs1.ok && fs1.cap < 50 && fs1.points[29].value - fs1.current < 400);
    // Decreases stay in history, add nothing to the rate.
    const down = Array.from({ length: 41 }, (_, i) => ({ t: start + i * DAY, value: i === 30 ? 20 : 50 + i }));
    const fd = F.forecast(down, { horizonDays: 7, endMs: end });
    check('a correction (a drop) adds no negative rate', fd.ok && fd.rate >= 0 && fd.points.every(p => p.value >= fd.current));
    // Only data up to the start.
    const later = [...steady, { t: end + 5 * DAY, value: 9999 }];
    check('data after the forecast\'s start is ignored', JSON.stringify(F.forecast(later, { horizonDays: 30, endMs: end }).points) === JSON.stringify(f.points));
    check('too little history: no forecast, with the reason', !F.forecast(steady.slice(0, 5), { horizonDays: 30, endMs: start + 4 * DAY }).ok && /at least 14/.test(F.forecast(steady.slice(0, 5), { horizonDays: 30, endMs: start + 4 * DAY }).reason) && !F.forecast([], {}).ok);
    const fewAdds = Array.from({ length: 30 }, (_, i) => ({ t: start + i * DAY, value: i < 29 ? 5 : 6 }));
    check('...or too few days with additions', /Too few days/.test(F.forecast(fewAdds, { horizonDays: 30, endMs: start + 29 * DAY }).reason));
    check('approximate history widens the range', (() => {
      const a = F.forecast(steady.map(o => ({ ...o, approx: true })), { horizonDays: 30, endMs: end });
      const noisy = steady.map((o, i) => ({ ...o, value: o.value + (i % 3) }));
      const n1 = F.forecast(noisy, { horizonDays: 30, endMs: end }), n2 = F.forecast(noisy.map(o => ({ ...o, approx: true })), { horizonDays: 30, endMs: end });
      return a.approx && n2.points[29].high - n2.points[29].value > n1.points[29].high - n1.points[29].value;
    })());
    check('horizons: 7 / 30 / 90 days of points', [7, 30, 90].every(h => F.forecast(steady, { horizonDays: h, endMs: end }).points.length === h));
    // Two series, two rates (Cybercab vs Model Y).
    const cy = F.forecast(steady, { horizonDays: 30, endMs: end });
    const my = F.forecast(flat, { horizonDays: 30, endMs: end });
    check('each series is forecast from its own history (different rates)', cy.rate > 3 * my.rate);
  }

  console.log('4. The homepage charts');
  {
    const index = read('public/index.html'), dmv = read('public/js/dmv-panel.js'), vehicles = read('public/vehicles.html');
    check('fleet growth: Actual pressed and the horizon hidden by default; predictions off', /data-fleet-mode="actual" aria-pressed="true"/.test(index) && /id="fleetHorizon"[^>]*/.test(index) && /forecast-horizon hidden" id="fleetHorizon"/.test(index) && /let predict = false, horizon = 30;/.test(index));
    check('...7D / 30D / 90D, 30 by default; the old range buttons untouched', /data-fleet-horizon="30" aria-pressed="true"/.test(index) && ['90d', '6m', '1y', 'all'].every(r => index.includes(`data-range="${r}"`)));
    check('...forecast from the loaded registry series only, labeled PROJECTED, with "How predictions work"', /CCCForecast\.forecast\(obs, \{ horizonDays: horizon \}\)/.test(index) && index.includes('PROJECTED') && index.includes('How predictions work') && /not Tesla’s total built or deployed/.test(index));
    check('DMV: predictions off by default; Cybercab and Model Y forecast separately', /let predict = false, horizon = 30/.test(dmv) && /forecast\(obs\('cybercab'\)/.test(dmv) && /forecast\(obs\('model_y'\)/.test(dmv));
    check('...projected values always labeled estimates, never TxDMV numbers', /estimate, not TxDMV data/.test(dmv) && /not official TxDMV numbers/.test(dmv));
    check('forecast.js loads before the DMV panel on both pages', [index, vehicles].every(h => h.indexOf('<script src="js/forecast.js') > 0 && h.indexOf('<script src="js/forecast.js') < h.indexOf('<script src="js/dmv-panel.js')));
    check('no hard-coded future numbers in the forecast code', !/value:\s*\d{3,}/.test(read('public/js/forecast.js')));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
