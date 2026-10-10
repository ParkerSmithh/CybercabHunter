import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv } from './helpers/env.mjs';
import { buildActivity, apiActivity, localDate } from '../worker/activity.js';
import worker from '../worker/index.js';
const { env, d1 } = await makeEnv();
const now = Date.now(), today = localDate(now), year = Number(today.slice(0, 4));
const utc = new Date(now).toISOString(), sqlTime = utc.slice(0, 19).replace('T', ' ');
const prior = new Date(Date.parse(today + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
function run(sql, ...binds) { d1.prepare(sql).bind(...binds)._exec(); }
for (const [id, visibility, model] of [['public', 'public', 'Cybercab'], ['private', 'private', 'Cybercab'], ['model-y', 'public', 'Model Y']]) {
  run("INSERT INTO robotaxi_vehicles(id, license_plate, model, visibility, origin, vin, created_at) VALUES (?, ?, ?, ?, 'sighting', ?, ?)", id, id.toUpperCase(), model, visibility, id, sqlTime);
}
run("INSERT INTO robotaxi_vehicles(id, license_plate, model, visibility, origin, vin, created_at) VALUES ('public-duplicate', 'p-u-b-l-i-c', 'Cybercab', 'public', 'sighting', 'duplicate-vin', ?)", sqlTime);
run("UPDATE robotaxi_vehicles SET approval_basis = 'manual' WHERE id = 'model-y'");
for (const [id, status, vehicle] of [['approved', 'approved', null], ['pending', 'pending', null], ['hidden', 'approved', 'private']]) {
  run("INSERT INTO submissions(id,user_id,submission_type,status,evidence_type,submitted_at) VALUES (?, 'u1', 'vehicle_sighting', ?, 'photo', ?)", id, status, sqlTime);
  run("INSERT INTO vehicle_observations(id, user_id, submission_id, observed_at, evidence_ref, public_id, robotaxi_vehicle_id) VALUES (?, 'u1', ?, ?, 'photo', ?, ?)", id, id, sqlTime, id.padStart(32, 'a'), vehicle);
}
run("INSERT INTO camera_detections(id,camera_id,camera_name,lat,lng,observed_at) VALUES ('capture','camera','Congress',30,-97,?)", utc);
for (const date of [prior, today]) run("INSERT INTO dmv_snapshots(snapshot_date,total,cybercab_count,model_y_count,authorization_number,raw_json,polled_at) VALUES (?,3,2,1,'test','[]',?)", date, utc);
for (const [vin, model, baseline] of [['baseline', 'Cybercab', 1], ['new-c', 'Cybercab', 0], ['new-y', 'Model Y', 0]]) {
  run('INSERT INTO dmv_av_vehicles(vin,model,first_seen_date,last_seen_date,in_baseline) VALUES (?,?,?,?,?)', vin, model, today, today, baseline);
}
const result = await buildActivity(d1, year, now), day = result.days.find(d => d.date === today);
assert.equal(day.registry, 1); assert.equal(day.sightings, 1); assert.equal(day.cameras, 1);
assert.equal(day.dmv, 2); assert.equal(day.cybercab, 1); assert.equal(day.model_y, 1);
assert.equal(result.days.find(d => d.date === prior).dmv, null, 'baseline cannot be treated as zero');
assert.equal(result.days[0].registry, null, 'pre-coverage is unavailable');
assert.equal(localDate('2026-03-08T05:59:59Z'), '2026-03-07');
assert.equal(localDate('2026-03-08T06:00:00Z'), '2026-03-08');
assert.equal(localDate('2026-11-01T05:00:00Z'), '2026-11-01');
const detail = await (await apiActivity(new Request(`https://test/api/activity?date=${today}`), env, {})).json();
assert.deepEqual(detail.day, day, 'daily endpoint and calendar share identical totals');
assert.equal(detail.details.vehicles.length, 1); assert.equal(detail.details.sightings.length, 1);
assert(!JSON.stringify(detail).includes('PRIVATE')); assert(!JSON.stringify(detail).includes('user_id'));
for (const query of ['date=2026-02-30', 'year=1999', 'year=2099']) assert.equal((await apiActivity(new Request('https://test/api/activity?' + query), env, {})).status, 400);
const failing = { prepare() { throw new Error('Database unavailable'); } };
const failed = await buildActivity(failing, year, now);
assert.equal(failed.days.find(d => d.date === today).cameras, null);
assert.equal(Object.keys(failed.errors).length, 4);
const html = fs.readFileSync('public/calendar.html', 'utf8'), home = fs.readFileSync('public/index.html', 'utf8'), js = fs.readFileSync('public/js/activity.js', 'utf8');
assert([...new JSDOM(html).window.document.querySelectorAll('header nav a, #mobileBottomNav a')].every(a => !a.href.includes('calendar')));
assert(home.indexOf('id="cybercabDaily"') > home.indexOf('id="serviceBanner"'));
assert(home.indexOf('id="cybercabDaily"') < home.indexOf('id="map"'));
assert(home.includes('href="/calendar"'));
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://test/calendar' });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
dom.window.fetch = async url => apiActivity(new Request(url), env, {});
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.matchMedia = () => ({ matches: true });
dom.window.eval(js);
await new Promise(r => setTimeout(r, 80));
const doc = dom.window.document;
assert.equal(doc.querySelectorAll('.activity-day').length, result.days.length);
assert(doc.querySelector(`[data-date="${today}"]`));
const filter = doc.getElementById('activityCategory'); filter.value = 'dmv'; filter.dispatchEvent(new dom.window.Event('change'));
assert(doc.querySelector(`[data-date="${today}"]`).getAttribute('aria-label').includes('2'));
doc.querySelector(`[data-date="${today}"]`).click();
await new Promise(r => setTimeout(r, 80));
assert.equal(doc.getElementById('activityDayDialog').open, true);
assert(dom.window.document.body.classList.contains('activity-modal-open'));
assert(doc.querySelector('#activityDetail a[href="/vehicle/public"]'));
assert(!doc.getElementById('activityDetail').textContent.includes('PRIVATE'));
doc.getElementById('activityDayClose').click();
assert.equal(doc.getElementById('activityDayDialog').open, false);
assert(!doc.body.classList.contains('activity-modal-open'));
assert.equal(doc.activeElement.dataset.date, today);
dom.window.close();
const homeDom = new JSDOM(home, { runScripts: 'outside-only', url: 'https://test/' });
homeDom.window.fetch = async url => apiActivity(new Request(url), env, {});
homeDom.window.eval(js); await new Promise(r => setTimeout(r, 80));
assert.deepEqual([...homeDom.window.document.querySelectorAll('#dailyStats dd')].map(n => n.textContent), ['+1', '+2', '1', '1']);
homeDom.window.close();
// Use a controllable browser clock to exercise midnight, visibility and errors.
let clock = now, tick, requests = 0;
const rollover = new JSDOM(home, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://test/' });
const NativeDate = rollover.window.Date;
rollover.window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
rollover.window.setInterval = fn => { tick = fn; return 1; };
rollover.window.fetch = async url => {
  requests++;
  const requested = Number(new URL(url).searchParams.get('year'));
  return Response.json(await buildActivity(d1, requested, clock));
};
rollover.window.eval(js); await new Promise(r => setTimeout(r, 50));
assert.equal(requests, 1);
tick(); await new Promise(r => setTimeout(r, 20)); assert.equal(requests, 1, 'no request before freshness deadline');
clock += 864e5; tick(); await new Promise(r => setTimeout(r, 50));
assert.equal(requests, 2, 'a Central date rollover fetches immediately');
assert.equal(rollover.window.document.getElementById('dailyDate').textContent, new Date(clock).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
assert.equal(rollover.window.document.querySelector('#dailyStats dd').textContent, '+0', 'new day clears yesterday’s totals');
rollover.window.fetch = async () => { requests++; throw new Error('offline'); };
clock += 300001; tick(); await new Promise(r => setTimeout(r, 50));
assert([...rollover.window.document.querySelectorAll('#dailyStats dd')].every(n => n.textContent === 'Unavailable'));
const failedRequests = requests; tick(); await new Promise(r => setTimeout(r, 20));
assert.equal(requests, failedRequests, 'failure does not cause a retry every second');
rollover.window.close();
const routed = await worker.fetch(new Request(`https://test/api/activity?year=${year}`), env, {});
assert.equal(routed.status, 200); assert.equal((await routed.json()).days.find(d => d.date === today).dmv, 2);

// Test fixtures live only in tests. Expose an optional local review server.
if (process.argv.includes('--serve')) {
  const { createServer } = await import('node:http');
  createServer(async (req, res) => {
    if (req.url === '/review') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:20px;background:#222;color:white;font:16px sans-serif"><h1>Test review: 390px mobile / 1100px desktop</h1><div style="display:flex;gap:20px"><iframe title="Mobile calendar" style="width:390px;height:1000px;border:0;flex-shrink:0" src="/calendar"></iframe><iframe title="Desktop calendar" style="width:1100px;height:1000px;border:0;flex-shrink:0" src="/calendar"></iframe></div></body></html>'); return; }
    if (req.url.startsWith('/api/activity')) { const response = await apiActivity(new Request('http://localhost:8787' + req.url), env, {}); res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text()); return; }
    let path = req.url.split('?')[0]; if (path === '/') path = '/index.html'; if (path === '/calendar' || path === '/calendar/') path = '/calendar.html';
    if (path.includes('..')) { res.writeHead(400); res.end(); return; }
    try { let content = fs.readFileSync('public' + path); if (path === '/js/activity.js') content = content.toString().replace("const API = 'https://cybercabhunter.contactjoeclos.workers.dev'", "const API = ''");
      res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream'); res.end(content);
    } catch { res.writeHead(404); res.end(); }
  }).listen(8787, '127.0.0.1');
  console.log('Test-only SQLite fixture review server: http://localhost:8787');
}
console.log('Activity SQL, privacy, timezone, unavailable-state, homepage parity, calendar interactions and navigation tests passed.');
