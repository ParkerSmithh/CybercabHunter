import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv } from './helpers/env.mjs';
import { buildDaily, apiDaily, localDate } from '../worker/daily.js';
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

const result = await buildDaily(d1, now), day = result.day;
assert.equal(day.registry, 1); assert.equal(day.sightings, 1); assert.equal(day.cameras, 1);
assert.equal(day.dmv, 2); assert.equal(day.cybercab, 1); assert.equal(day.model_y, 1);
assert.equal(result.previous.dmv, null, 'DMV baseline is unavailable, not zero');
assert.equal(result.previous.registry, null, 'pre-coverage remains unavailable');
assert.equal(result.days, undefined, 'no historical year data');
assert.equal(localDate('2026-03-08T05:59:59Z'), '2026-03-07');
assert.equal(localDate('2026-03-08T06:00:00Z'), '2026-03-08');
assert.equal(localDate('2026-11-01T05:00:00Z'), '2026-11-01');
const routed = await worker.fetch(new Request('https://test/api/daily'), env, {});
assert.equal(routed.status, 200);
assert.deepEqual((await routed.json()).day, day);
assert(!JSON.stringify(result).includes('PRIVATE')); assert(!JSON.stringify(result).includes('user_id'));
for (const path of ['/api/activity?year=2026', '/api/activity?date='+today, '/calendar', '/calendar/', '/calendar.html']) {
 assert.equal((await worker.fetch(new Request('https://test'+path), env, {})).status, 404);
}
const failing = { prepare() { throw new Error('Database unavailable'); } };
const failed = await buildDaily(failing, now);
assert.equal(Object.keys(failed.errors).length, 4);
assert(['registry','sightings','cameras','dmv'].every(key => failed.day[key] === null));
const home = fs.readFileSync('public/index.html', 'utf8'), js = fs.readFileSync('public/js/daily.js', 'utf8');
// One card: the former "Live now" banner is Cybercab Daily now (24/7: no
// countdown, no service-day track, no separate service banner).
assert(!home.includes('id="serviceBanner"') && !home.includes('service-banner.js') && !fs.existsSync('public/js/service-banner.js'), 'no separate service banner');
assert(home.indexOf('id="cybercabDaily"') > home.indexOf('id="statSightings"'), 'below the stats bar');
assert(home.indexOf('id="cybercabDaily"') < home.indexOf('id="map"'), 'above SERVICE ZONES');
const card = home.slice(home.indexOf('id="cybercabDaily"'), home.indexOf('<!-- ===== Live map'));
assert(/class="service-banner[^"]*"/.test(card) && /Live · 24\/7/.test(card) && /Cybercab Daily<\/h2>/.test(card), 'the Live now design: banner, green 24/7 eyebrow, CYBERCAB DAILY');
assert(/runs 24\/7 in Austin and Dallas/.test(card) && /images\/CybercabLive\.webp/.test(card), '24/7 line and the Cybercab');
assert(/id="dailyStats" class="sb-day"/.test(card), 'the figures take the old service-day column');
assert(!/Service ends|Back on the road|Service day|countdown|5:00 AM|2:00 AM/i.test(card), 'nothing counts down or names the old hours');
assert(!home.includes('/calendar')); assert(!fs.existsSync('public/calendar.html'));
assert(!js.includes('/api/activity'));
const homeDom = new JSDOM(home, { runScripts: 'outside-only', url: 'https://test/' });
homeDom.window.fetch = async url => { assert.match(url, /^\/api\/daily\?day=\d{4}-\d\d-\d\d$/); return apiDaily(new Request('https://test'+url), env, {}); };
homeDom.window.eval(js); await new Promise(r => setTimeout(r, 80));
assert.deepEqual([...homeDom.window.document.querySelectorAll('#dailyStats .daily-value')].map(n => n.textContent), ['+1', '+2', '1', '1']);
assert.equal(homeDom.window.document.querySelectorAll('#dailyStats .is-updated').length, 0, 'the first figures of the day don\'t glow');
// Phones: the date and update time as one compact line, kept in step with the
// two desktop lines (no extra request); the short service line.
{
  const doc = homeDom.window.document, stampText = doc.getElementById('dailyStamp').textContent;
  const short = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(today + 'T12:00:00Z'));
  assert.equal(stampText, `${short} · ${doc.getElementById('dailyUpdated').textContent}`, 'the phone line: "Thu, Nov 12 · Updated 2:12 PM CT"');
  assert.match(stampText, /^\w{3}, \w{3} \d{1,2} · Updated \d{1,2}:\d\d [AP]M CT$/);
  assert.equal(doc.querySelector('#cybercabDaily .daily-sub-short').textContent, 'Robotaxi 24/7 in Austin and Dallas');
  assert.equal(doc.querySelector('#cybercabDaily .daily-sub-long').textContent, 'Robotaxi service runs 24/7 in Austin and Dallas.', 'desktop keeps its line');
  assert(!doc.querySelector('#cybercabDaily input, #cybercabDaily [role="switch"]') && !/Live Activity/i.test(doc.getElementById('cybercabDaily').textContent), 'no Live Activity toggle or text on the website');
}
{
  const css = fs.readFileSync('public/css/daily.css', 'utf8');
  const phone = css.slice(css.indexOf('@media(max-width:639px)'), css.indexOf('@media(max-width:374px)'));
  assert(/#cybercabDaily\{[^}]*min-height:0/.test(phone), 'phones: no forced banner height');
  assert(/\.activity-stats\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/.test(phone), 'phones: the four figures in one row');
  assert(/grid-template-rows:subgrid/.test(phone) && /@supports not \(grid-template-rows:subgrid\)/.test(phone), 'phones: labels line up, with a fallback');
  assert(/\.daily-sub-long,#cybercabDaily \.activity-date,#cybercabDaily \.daily-updated\{display:none\}/.test(phone) && /\.daily-sub-short,#cybercabDaily \.daily-stamp\{display:block\}/.test(phone), 'phones: the compact lines replace the long ones');
  assert(/^#cybercabDaily \.daily-sub-short,#cybercabDaily \.daily-stamp\{display:none\}$/m.test(css), 'desktop and tablet: the compact lines are hidden');
}
homeDom.window.close();
// Midnight rollover, visibility, and unavailable states remain part of Daily.
let clock = now, tick, requests = 0;
const rollover = new JSDOM(home, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://test/' });
const NativeDate = rollover.window.Date;
rollover.window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } };
rollover.window.setInterval = fn => { tick = fn; return 1; };
rollover.window.fetch = async () => { requests++; return Response.json(await buildDaily(d1, clock)); };
rollover.window.eval(js); await new Promise(r => setTimeout(r, 50));
assert.equal(requests, 1);
tick(); await new Promise(r => setTimeout(r, 20)); assert.equal(requests, 1);
clock += 864e5; tick(); await new Promise(r => setTimeout(r, 50));
assert.equal(requests, 2, 'Central date rollover immediately refreshes');
assert.equal(rollover.window.document.querySelector('#dailyStats .daily-value').textContent, '+0');
// Midnight with a stale answer (a browser cache or a server a few seconds
// behind still saying yesterday): no error, a retry 15 seconds later.
const urls = [];
let lagMs = 864e5;
rollover.window.fetch = async url => { requests++; urls.push(url); return Response.json(await buildDaily(d1, clock - lagMs)); };
clock += 864e5; tick(); await new Promise(r => setTimeout(r, 50));
const doc = rollover.window.document;
assert.equal(requests, 3);
assert.match(urls[0], new RegExp(`day=${new Date(clock).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' })}$`), 'the request names the new Central day');
assert(!/could not be retrieved/.test(doc.getElementById('dailyStats').textContent), 'a server still on yesterday is not an error');
assert.equal(doc.getElementById('dailyUpdated').textContent, 'Updating for the new day');
clock += 5000; tick(); await new Promise(r => setTimeout(r, 20)); assert.equal(requests, 3, 'no hammering: waits 15 s');
lagMs = 0; clock += 10001; tick(); await new Promise(r => setTimeout(r, 50));
assert.equal(requests, 4, 'retries 15 s later');
assert.equal(doc.querySelector('#dailyStats .daily-value').textContent, '+0');
{
  // A day the DMV snapshot hasn't reported yet (dmv: null): 0, not "Unavailable".
  const body = await buildDaily(d1, clock);
  rollover.window.fetch = async () => { requests++; return Response.json({ ...body, day: { ...body.day, dmv: null } }); };
  clock += 300001; tick(); await new Promise(r => setTimeout(r, 50));
  assert.equal(doc.querySelectorAll('#dailyStats .daily-value')[1].textContent, '+0');
  assert(!/Unavailable/.test(doc.getElementById('dailyStats').textContent));
}
assert(/^Updated /.test(doc.getElementById('dailyUpdated').textContent));
rollover.window.fetch = async () => { requests++; throw new Error('offline'); };
clock += 300001; tick(); await new Promise(r => setTimeout(r, 50));
assert.deepEqual([...rollover.window.document.querySelectorAll('#dailyStats .daily-value')].map(n => n.textContent), ['+0', '+0', '0', '0'], 'values not in yet show 0, never "Unavailable"');
assert(!/Unavailable/.test(rollover.window.document.getElementById('dailyStats').textContent));
rollover.window.close();
// Cache variants cannot make the client trigger an annual scan or bypass TTL.
const savedCaches = globalThis.caches, store = new Map(); let queries = 0;
const measured = { prepare(sql) { queries++; return d1.prepare(sql); } };
globalThis.caches = { default: {
 async match(key) { return store.get(key.url)?.clone(); },
 async put(key, response) { store.set(key.url, response.clone()); }
} };
try {
 await apiDaily(new Request('https://test/api/daily?year=2026'), {...env,cybercabhunter_db:measured}, {});
 assert(queries > 0); queries = 0;
 const cached = await apiDaily(new Request('https://test/api/daily?random=123'), {...env,cybercabhunter_db:measured}, {});
 assert.equal(queries, 0); assert.equal(cached.headers.get('Cache-Control'), 'public, max-age=300');
 store.clear();
 const partial = await apiDaily(new Request('https://test/api/daily'), {...env,cybercabhunter_db:failing}, {});
 assert.equal(partial.headers.get('Cache-Control'),'no-store'); assert.equal(store.size,0);
} finally { globalThis.caches = savedCaches; }
// No correlated duplicate subquery or year-wide grouping can return unnoticed.
const queriesUsed=[];
await buildDaily({prepare(sql){queriesUsed.push(sql);return d1.prepare(sql);}}, now);
assert(queriesUsed.every(sql => !/duplicate|strftime|GROUP BY hour|OFFSET/.test(sql)));
assert.equal(queriesUsed.length,6);
const dmvQuery = queriesUsed.find(sql => sql.includes('FROM dmv_av_vehicles'));
assert(d1.query('EXPLAIN QUERY PLAN '+dmvQuery,prior,today).some(row=>row.detail.includes('idx_dmv_daily_new_date_model')),
  'Daily additions must search the partial date index, not baseline roster rows');
// Preserve the old Daily accounting for same-VIN, same-plate and chained
// identities, without deploying its expensive correlated SQL.
const separate = await makeEnv();
const earlier = new Date(now - 864e5).toISOString().slice(0,19).replace('T',' ');
for (const [id, plate, vin, visibility, time] of [
 ['a','ONE',' shared ', 'public',earlier],
 ['b','TWO','SHARED','public',sqlTime],
 ['c','t-w-o','unique','public',sqlTime],
 ['d','THREE','three','private',earlier],
 ['e','THREE','three','public',sqlTime],
 ['f','FOUR','four','public',sqlTime],
 ['g','FOUR','different','public',sqlTime]
]) separate.d1.prepare("INSERT INTO robotaxi_vehicles(id,license_plate,vin,model,origin,visibility,created_at) VALUES(?,?,?,'Cybercab','sighting',?,?)").bind(id,plate,vin,visibility,time)._exec();
const identityDay = (await buildDaily(separate.d1,now)).day;
assert.equal(identityDay.registry,2,'earlier eligible VIN, chained plate and same-time ID ties are preserved');
// A source whose second query fails must not present a fabricated DMV zero.
const partiallyFailing = { prepare(query) {
 if(query.includes('FROM dmv_av_vehicles')) throw new Error('D1_ERROR');
 return d1.prepare(query);
} };
assert.equal((await buildDaily(partiallyFailing,now)).day.dmv,null);
console.log('Cybercab Daily: counts, privacy, source errors, baseline, DST, rollover, cache and deleted routes passed');
