// Tests for the Sightings page's sort order, stats and live updates:
// GET /api/sightings?order=asc|desc&stats=1 (worker/sightings-public.js
// buildSightingStats, worker/timezones.js usLocalParts), the visibility rule
// that a plate is shown only from a PUBLICLY ELIGIBLE registry vehicle, and
// the page's Most/Least recent toggle, LIVE indicator, stat cards and
// once-a-minute polling (public/js/sightings.js, in jsdom).
// Run: node tests/sightings-stats.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, approveVehicle } from './helpers/env.mjs';
import { buildSightingStats } from '../worker/sightings-public.js';
import { usLocalParts } from '../worker/timezones.js';
import worker from '../worker/index.js';

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
async function submit(ctx, fields = {}) {
  const fd = new FormData();
  fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  return (await (await req(ctx, 'POST', '/api/vehicle-sightings/photo', { user: 'rider', body: fd })).json()).submission_id;
}
const approve = (ctx, id) => req(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${id}`, { user: 'mod', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
// An approved sighting observed `hoursAgo` hours before now.
async function sighting(ctx, fields, hoursAgo) {
  const id = await submit(ctx, fields);
  await approve(ctx, id);
  ctx.d1.exec(`UPDATE vehicle_observations SET observed_at = datetime('now', '-${hoursAgo * 60} minutes') WHERE submission_id = '${id}'`);
  return id;
}
const list = async (ctx, qs = '') => (await req(ctx, 'GET', `/api/sightings${qs}`)).json();

async function run() {
  console.log('1. Stats maths in Austin time (buildSightingStats)');
  {
    const Z = 'America/Chicago';
    const now = Date.parse('2026-09-29T04:30:00Z');   // Mon Sep 28, 11:30 PM CDT
    const buckets = [
      { utc_hour: '2026-09-29T03', n: 2, last_7_days: 2 },  // Sep 28, 10 PM CDT
      { utc_hour: '2026-09-28T22', n: 5, last_7_days: 5 },  // Sep 28, 5 PM CDT
      { utc_hour: '2026-09-27T22', n: 6, last_7_days: 6 },  // Sep 27, 5 PM CDT
      { utc_hour: '2026-01-15T23', n: 1, last_7_days: 0 },  // Jan 15, 5 PM CST (UTC-6 in winter)
      { utc_hour: '2026-08-31T04', n: 3, last_7_days: 0 }   // Aug 30, 11 PM CDT — still August locally
    ];
    const s = buildSightingStats(buckets, Z, now);
    check('today = the Austin calendar day (Sep 28, even though it is already Sep 29 in UTC)', s.today === 7);
    check('this month = Austin September only (the Aug 30 local sighting is excluded)', s.this_month === 13);
    check('peak hour = 5 PM Austin time, across DST (CDT in Sep + CST in Jan): 12 sightings', s.peak_hour.hour === 17 && s.peak_hour.count === 12);
    check('best day = Sep 28 with 7', s.best_day.date === '2026-09-28' && s.best_day.count === 7);
    check('last 7 days = the exact count from SQL', s.last_7_days === 13 && s.total === 17 && s.time_zone === Z);
    const tie = buildSightingStats([{ utc_hour: '2026-09-20T15', n: 2, last_7_days: 0 }, { utc_hour: '2026-09-21T20', n: 2, last_7_days: 0 }], Z, now);
    check('a tied busiest hour is NOT a peak (no tie-break guess); best-day ties go to the more recent day', tie.peak_hour === null && tie.best_day.date === '2026-09-21');
    const prod = buildSightingStats([{ utc_hour: '2026-09-28T17', n: 1, last_7_days: 1 }, { utc_hour: '2026-09-30T01', n: 1, last_7_days: 1 }], Z, now);
    check('the production case (12:39 PM and 8:47 PM, one each): no peak hour, "not enough data"', prod.peak_hour === null && prod.total === 2);
    const single = buildSightingStats([{ utc_hour: '2026-09-28T22', n: 1, last_7_days: 1 }], Z, now);
    check('a single sighting is not a peak', single.peak_hour === null);
    const clear = buildSightingStats([{ utc_hour: '2026-09-28T22', n: 2, last_7_days: 2 }, { utc_hour: '2026-09-27T15', n: 1, last_7_days: 1 }], Z, now);
    check('a clear busiest hour (2 sightings vs 1) is shown: 5 PM', clear.peak_hour.hour === 17 && clear.peak_hour.count === 2);
    const none = buildSightingStats([], Z, now);
    check('no sightings: real zeros and no peak/best', none.today === 0 && none.this_month === 0 && none.last_7_days === 0 && none.peak_hour === null && none.best_day === null);
    let mismatches = 0;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: Z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
    for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 3600000) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
      const u = usLocalParts(ms, Z);
      if (+p.year !== u.y || +p.month !== u.m || +p.day !== u.d || +p.hour !== u.h) mismatches++;
    }
    check('the US DST arithmetic matches Intl for every hour of 2025–2027 (incl. every changeover)', mismatches === 0);
  }

  console.log('2. GET /api/sightings: order, cursor and stats');
  {
    const ctx = await makeApp();
    for (let i = 0; i < 5; i++) await sighting(ctx, { service_area: 'Austin' }, 10 * (i + 1));
    const desc = await list(ctx, '?city=austin');
    const asc = await list(ctx, '?city=austin&order=asc');
    const times = j => j.sightings.map(s => s.spotted_at);
    check('default = most recent first (order "desc")', desc.order === 'desc' && times(desc).join() === [...times(desc)].sort().reverse().join());
    check('order=asc = least recent first', asc.order === 'asc' && times(asc).join() === [...times(desc)].reverse().join());
    check('an unknown order falls back to most recent first', (await list(ctx, '?city=austin&order=sideways')).order === 'desc');
    const ids = [];
    let cursor = null, pages = 0;
    do {
      const page = await list(ctx, `?city=austin&order=asc&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      page.sightings.forEach(s => ids.push(s.spotted_at));
      cursor = page.next_cursor; pages++;
    } while (cursor && pages < 10);
    check('least-recent paging: all 5, no gaps or repeats, in order', ids.length === 5 && ids.join() === [...times(desc)].reverse().join());
    const descCursor = (await list(ctx, '?city=austin&limit=2')).next_cursor;
    check('a most-recent cursor cannot be reused for least-recent (400 invalid_cursor)', (await req(ctx, 'GET', `/api/sightings?city=austin&order=asc&cursor=${descCursor}`)).status === 400);
    check('stats only when asked (stats=1)', !('stats' in desc) && 'stats' in (await list(ctx, '?city=austin&stats=1')));
  }

  console.log('3. Stats from the real endpoint: approved photo sightings only, history included');
  {
    const ctx = await makeApp();
    await sighting(ctx, { service_area: 'Austin' }, 1);
    await sighting(ctx, { service_area: 'Austin' }, 2);
    await sighting(ctx, { service_area: 'Austin' }, 24 * 10);           // 10 days ago
    await sighting(ctx, { service_area: 'Dallas' }, 1);
    await submit(ctx, { service_area: 'Austin' });                       // pending: never counted
    const rejected = await submit(ctx, { service_area: 'Austin' });
    await req(ctx, 'PATCH', `/api/moderation/vehicle-sightings/${rejected}`, { user: 'mod', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', rejection_reason: 'no' }) });
    const s = (await list(ctx, '?city=austin&stats=1')).stats;
    check('last 7 days counts only the approved Austin sightings inside the window', s.last_7_days === 2 && s.total === 3);
    check('Dallas has its own stats', (await list(ctx, '?city=dallas&stats=1')).stats.total === 1);
    const old = ctx.d1.query("SELECT s.id FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id WHERE o.observed_at < datetime('now', '-9 days')")[0].id;
    ctx.d1.exec(`UPDATE submissions SET submitted_at = datetime('now', '-40 days') WHERE id = '${old}'`);   // its photo has expired
    const after = await list(ctx, '?city=austin&stats=1');
    check('an expired photo leaves the gallery AND the stats (they count exactly what is listed)', after.seen === 2 && after.stats.total === 2 && after.sightings.length === 2);
    check('stats never carry plates, ids or locations', !/plate|public_id|location|evidence/.test(JSON.stringify(after.stats)));
  }

  // Regression (Sep 30, 2026: the Austin stats read 7 / today 4 while 5
  // cards were listed): stats and list share one predicate, and day buckets
  // follow the area's local time. Both run through the real router with the
  // JS clock pinned to a known local time today (SQLite's own clock is real).
  const Z = 'America/Chicago';
  const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const localMidnight = () => {                       // start of today in Austin, as UTC ms
    const p = usLocalParts(Date.now(), Z);
    return Date.UTC(p.y, p.m - 1, p.d) - p.offset * 3600000;
  };
  async function withClock(ms, fn) {
    const real = Date.now;
    Date.now = () => ms;
    try { return await fn(); } finally { Date.now = real; }
  }
  async function at(ctx, ms) {
    const id = await submit(ctx, { service_area: 'Austin' });
    await approve(ctx, id);
    ctx.d1.exec(`UPDATE vehicle_observations SET observed_at = '${sqlTime(ms)}' WHERE submission_id = '${id}'`);
    return id;
  }

  console.log('3b. Regression: day buckets follow Austin time across local midnight, not UTC');
  {
    const ctx = await makeApp();
    const M = localMidnight();
    const before = await at(ctx, M - 30 * 60000);     // 11:30 PM yesterday (Austin)
    const after = await at(ctx, M + 30 * 60000);      // 12:30 AM today (Austin)
    check('(both fall on the same UTC day, so UTC bucketing would call both "today")', new Date(M - 30 * 60000).toISOString().slice(0, 10) === new Date(M + 30 * 60000).toISOString().slice(0, 10));
    const r = await withClock(M + 2 * 3600000, () => list(ctx, '?city=austin&stats=1'));
    const s = r.stats;
    const today = usLocalParts(M + 3600000, Z), yesterday = usLocalParts(M - 3600000, Z);
    const iso = p => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    check('"today" counts only the 12:30 AM sighting', s.today === 1, JSON.stringify(s));
    check('the two land on two different local days (best day is a one-sighting day: today, the later of the tie)', s.best_day && s.best_day.count === 1 && s.best_day.date === iso(today));
    check('"this month" follows the local month too', s.this_month === (today.m === yesterday.m ? 2 : 1));
    check('the list shows both, and every total agrees with it', r.sightings.length === 2 && s.total === 2 && s.last_7_days === 2);
    check('(sanity: the sightings are the ones inserted)', !!before && !!after);
  }

  console.log('3c. Regression: deleting a sighting\'s photo decrements every stat at once');
  {
    const ctx = await makeApp();
    const M = localMidnight();
    const h = (hh, mm) => M + (hh * 60 + mm) * 60000;   // a local time today
    await at(ctx, h(10, 5));
    const target = await at(ctx, h(10, 40));
    await at(ctx, h(10, 50));
    await at(ctx, h(8, 15));
    const stats = () => withClock(h(13, 0), () => list(ctx, '?city=austin&stats=1'));
    const b = await stats();
    check('before: 4 listed, and the stats agree (total / 7 days / today / month 4, best day today 4, peak 10 AM with 3)',
      b.sightings.length === 4 && b.stats.total === 4 && b.stats.last_7_days === 4 && b.stats.today === 4 && b.stats.this_month === 4 &&
      b.stats.best_day.count === 4 && b.stats.peak_hour && b.stats.peak_hour.hour === 10 && b.stats.peak_hour.count === 3, JSON.stringify(b.stats));
    const del = await req(ctx, 'DELETE', `/api/moderation/vehicle-sightings/${target}/photo`, { user: 'mod' });
    const a = await stats();
    check('the moderator delete succeeds; the sighting stays approved (just without its photo)', del.status === 200 && ctx.d1.query(`SELECT status FROM submissions WHERE id = '${target}'`)[0].status === 'approved');
    check('after: 3 listed, and EVERY stat drops by one (total, 7 days, today, month, best day, peak hour)',
      a.sightings.length === 3 && a.stats.total === 3 && a.stats.last_7_days === 3 && a.stats.today === 3 && a.stats.this_month === 3 &&
      a.stats.best_day.count === 3 && a.stats.peak_hour && a.stats.peak_hour.hour === 10 && a.stats.peak_hour.count === 2, JSON.stringify(a.stats));
    const pub = (await list(ctx, '?city=austin&stats=1'));
    check('the gallery count and the stats total never disagree', pub.seen === pub.stats.total);
  }

  console.log('4. Visibility: a plate appears only from a PUBLICLY ELIGIBLE registry vehicle');
  {
    const ctx = await makeApp();
    const id = await sighting(ctx, { service_area: 'Austin', license_plate: 'PRIV001' }, 1);   // auto-creates a PRIVATE registry vehicle
    const vid = ctx.d1.query('SELECT robotaxi_vehicle_id AS v FROM vehicle_observations WHERE submission_id = ?', id)[0].v;
    const privateView = await list(ctx, '?city=austin&stats=1');
    check('private registry vehicle: the sighting shows, but with no plate and no Cybercab label', privateView.sightings[0].plate === null && privateView.sightings[0].cybercab === false);
    check('...and the private plate appears nowhere in the response', !JSON.stringify(privateView).includes('PRIV001'));
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'public' WHERE id = '${vid}'`);
    check('public but no counted ride yet (not eligible, like the vehicle page): still no plate', (await list(ctx, '?city=austin')).sightings[0].plate === null && (await req(ctx, 'GET', `/api/robotaxi-vehicles/${vid}`)).status === 404);
    approveVehicle(ctx.d1, vid, { withRide: true });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '5YJ3E1EA0KF000011' WHERE id = '${vid}'`);
    const pub = (await list(ctx, '?city=austin')).sightings[0];
    check('publicly eligible (the vehicle page shows it): plate + Cybercab label', pub.plate === 'PRIV001' && pub.cybercab === true && (await req(ctx, 'GET', `/api/robotaxi-vehicles/${vid}`)).status === 200);
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${vid}'`);
    check('made private again: the plate disappears at once', (await list(ctx, '?city=austin')).sightings[0].plate === null);
    const noVehicle = await sighting(ctx, { service_area: 'Austin' }, 2);
    check('a sighting with no vehicle has no plate', (await list(ctx, '?city=austin')).sightings.find(s => s.plate === null) && !!noVehicle);
  }

  console.log('4b. Edge cache: repeated polls within 30 s never reach D1');
  {
    const ctx = await makeApp();
    await sighting(ctx, { service_area: 'Austin' }, 1);
    const store = new Map();
    globalThis.caches = { default: {
      match: async r => { const hit = store.get(r.url); return hit ? hit.clone() : undefined; },
      put: async (r, resp) => { store.set(r.url, resp); }
    } };
    let queries = 0;
    const realPrepare = ctx.d1.prepare.bind(ctx.d1);
    ctx.d1.prepare = (...a) => { queries++; return realPrepare(...a); };
    const waits = [];
    const call = () => worker.fetch(new Request('https://cybercabhunter.com/api/sightings?city=austin&order=desc&stats=1'), ctx.env, { waitUntil: p => waits.push(p) });
    const first = await (await call()).json();
    await Promise.all(waits);
    const afterFirst = queries;
    await sighting(ctx, { service_area: 'Austin' }, 0);   // new data arrives...
    queries = 0;
    const second = await (await call()).json();
    check('the first poll is stored in the edge cache (30 s)', store.size === 1 && afterFirst > 0 && waits.length === 1);
    check('a repeat poll is served from the cache: zero D1 queries', queries === 0 && JSON.stringify(second) === JSON.stringify(first));
    check('the cached response says so (max-age=30)', (await call()).headers.get('Cache-Control') === 'public, max-age=30');
    check('a different city or order is a different cache entry', (await (await worker.fetch(new Request('https://cybercabhunter.com/api/sightings?city=dallas&order=desc&stats=1'), ctx.env, {})).json()) && store.size === 2);
    delete globalThis.caches;
  }

  console.log('5. The page: sort toggle, LIVE, stat cards, live updates');
  {
    const ctx = await makeApp();
    await sighting(ctx, { service_area: 'Austin' }, 3);
    await sighting(ctx, { service_area: 'Austin' }, 24 * 9);   // outside the last 7 days
    const html = fs.readFileSync(`${ROOT}public/sightings.html`, 'utf8');
    const js = fs.readFileSync(`${ROOT}public/js/sightings.js`, 'utf8');
    const opened = [];
    async function open(url, { failApi = false, stored = null } = {}) {
      const dom = new JSDOM(html, { runScripts: 'outside-only', url, pretendToBeVisual: true });
      const w = dom.window;
      opened.push(w);
      if (stored) w.localStorage.setItem('sightingsOrder', stored);
      const calls = [], timers = { set: [], cleared: 0 };
      const realSet = w.setInterval.bind(w), realClear = w.clearInterval.bind(w);
      w.setInterval = (fn, ms) => { timers.set.push(ms); return realSet(fn, ms); };
      w.clearInterval = id => { timers.cleared++; return realClear(id); };
      w.fetch = async u => {
        const path = String(u).replace(/^https:\/\/[^/]+/, '');
        calls.push(path);
        if (failApi && path.startsWith('/api/sightings')) throw new TypeError('offline');
        return worker.fetch(new Request(`https://x${path}`), ctx.env, {});
      };
      w.eval(js);
      const d = w.document;
      await new Promise(r => setTimeout(r, 150));
      return { w, d, calls, timers, text: id => d.getElementById(id).textContent.replace(/\s+/g, ' ').trim(), cards: () => [...d.querySelectorAll('#sightingsGrid article')] };
    }
    const p = await open('https://cybercabhunter.com/sightings');
    check('LIVE with a pulsing yellow dot, top right of the page header', /LIVE/.test(p.text('liveIndicator')) && p.d.getElementById('liveDot').classList.contains('live-dot') && /\.live-dot\{[^}]*#facc15[^}]*animation:live-pulse/.test(fs.readFileSync(`${ROOT}public/css/style.css`, 'utf8')));
    check('the pulse is switched off for reduced motion', /prefers-reduced-motion: reduce\)\{\s*\.live-dot, \.live-dot\.live-flash\{animation:none;\}/.test(fs.readFileSync(`${ROOT}public/css/style.css`, 'utf8')));
    check('stat cards show the server\'s numbers', p.text('statWeek') === '1' && p.text('statToday') !== '—' && p.text('statMonth') !== '—' && p.text('statPeakHour') === 'TBD' && /clear busiest hour/.test(p.text('statPeakCount')) && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(p.text('statBestDay')));
    check('Most recent is selected by default and requested', p.d.querySelector('[data-order="desc"]').getAttribute('aria-pressed') === 'true' && p.calls.some(c => c.includes('order=desc&stats=1')));
    check('polling is scheduled every 60 seconds', p.timers.set.includes(60000));

    p.d.querySelector('[data-order="asc"]').click();
    await new Promise(r => setTimeout(r, 120));
    check('Least recent re-queries with order=asc and re-renders oldest first', p.calls.some(c => c.includes('order=asc')) && p.cards().length === 2 && p.d.querySelector('[data-order="asc"]').getAttribute('aria-pressed') === 'true');
    check('...and the choice is remembered', p.w.localStorage.getItem('sightingsOrder') === 'asc');
    const again = await open('https://cybercabhunter.com/sightings', { stored: 'asc' });
    check('reopening the page uses the remembered order', again.d.querySelector('[data-order="asc"]').getAttribute('aria-pressed') === 'true' && again.calls.some(c => c.includes('order=asc')));

    // A new approved sighting arrives; the page picks it up on its next check.
    const live = await open('https://cybercabhunter.com/sightings');
    const before = live.cards().length;
    await sighting(ctx, { service_area: 'Austin' }, 0);
    live.d.dispatchEvent(new live.w.Event('visibilitychange'));   // tab shown again -> immediate check
    await new Promise(r => setTimeout(r, 150));
    check('a new sighting is added at the top without a reload', live.cards().length === before + 1);
    check('the stats update with it', live.text('statWeek') === '2');
    check('the LIVE dot flashes', live.d.getElementById('liveDot').classList.contains('live-flash'));
    Object.defineProperty(live.d, 'hidden', { configurable: true, get: () => true });
    const clearedBefore = live.timers.cleared;
    live.d.dispatchEvent(new live.w.Event('visibilitychange'));
    check('polling pauses while the tab is hidden', live.timers.cleared > clearedBefore);

    const failed = await open('https://cybercabhunter.com/sightings', { failApi: true });
    check('a failed load shows em dashes, never 0', ['statWeek', 'statToday', 'statMonth', 'statPeakHour', 'statBestDay'].every(id => failed.text(id) === '—'));
    check('...and LIVE shows it could not check', failed.d.getElementById('liveIndicator').classList.contains('is-stale'));

    // Two sightings in the same hour (3 hours ago) + one elsewhere: a clear peak.
    const peakCtx = await makeApp();
    await sighting(peakCtx, { service_area: 'Austin' }, 3);
    await sighting(peakCtx, { service_area: 'Austin' }, 3);
    await sighting(peakCtx, { service_area: 'Austin' }, 24 * 9);
    ctx.env = peakCtx.env;
    const peakPage = await open('https://cybercabhunter.com/sightings');
    check('a clear busiest hour is shown as a range with its count', /^\d{1,2}:00 (AM|PM) – \d{1,2}:00 (AM|PM)$/.test(peakPage.text('statPeakHour')) && peakPage.text('statPeakCount') === '2 sightings');

    const emptyCtx = await makeApp();
    ctx.env = emptyCtx.env;
    const empty = await open('https://cybercabhunter.com/sightings');
    check('a real zero is shown as 0 (not a dash)', empty.text('statWeek') === '0' && empty.text('statToday') === '0' && empty.text('statMonth') === '0' && empty.text('statPeakHour') === 'None yet');
    opened.forEach(w => w.close());
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
