// Tests for the sighting's date/time (worker/timezones.js): the form sends
// only the DATE; the time is the exact moment of submission in the local
// time zone of the area being documented (Austin -> US Central, Miami -> US
// Eastern), and the public Sightings page shows it in that zone.
// Run: node tests/sighting-time.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import { installPhotonStub, HANOVER } from './helpers/places.mjs';
import { timeZoneFor, resolveObservedAt } from '../worker/timezones.js';
import worker from '../worker/index.js';

installPhotonStub();

const t = makeCheck();
const { check } = t;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function makeApp() {
  const ctx = await makeEnv({ users: ['rider', 'mod'] });
  for (const id of ['rider', 'mod']) await ctx.env.TESLA_SESSIONS.put(`session:session-${id}`, JSON.stringify({ user_id: id }));
  ctx.d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  return ctx;
}

async function submit(ctx, fields) {
  const fd = new FormData();
  fd.append('photo', new File([PNG], 'p.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
  const res = await worker.fetch(new Request('https://x/api/vehicle-sightings/photo', { method: 'POST', headers: { Authorization: 'Bearer session-rider' }, body: fd }), ctx.env, {});
  return { status: res.status, json: await res.json() };
}

// A stored UTC 'YYYY-MM-DD HH:MM:SS' shown as wall-clock time in `zone`.
function wall(sqlUtc, zone) {
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const p = Object.fromEntries(f.map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
const nowMinutesIn = zone => wall(new Date().toISOString().slice(0, 19).replace('T', ' '), zone).minutes;
const closeTo = (a, b) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b)) <= 2;
const observedOf = (ctx, id) => ctx.d1.query('SELECT observed_at FROM vehicle_observations WHERE id = ?', id)[0].observed_at;

async function run() {
  console.log('1. Which time zone an area uses');
  {
    check('Austin, Dallas, Houston, San Antonio -> US Central', ['Austin', 'dallas', ' Houston ', 'San Antonio'].every(c => timeZoneFor({ serviceArea: c }) === 'America/Chicago'));
    check('Miami and Orlando -> US Eastern', timeZoneFor({ serviceArea: 'Miami' }) === 'America/New_York' && timeZoneFor({ serviceArea: 'Orlando, FL' }) === 'America/New_York');
    check('no city: the picked place\'s state decides ("..., Dallas, TX" -> Central; "..., AZ" -> Arizona)', timeZoneFor({ location: HANOVER.label }) === 'America/Chicago' && timeZoneFor({ location: 'Camelback Rd, Scottsdale, AZ' }) === 'America/Phoenix');
    check('a known city inside the place label wins over its state ("..., El Paso, TX" -> Mountain)', timeZoneFor({ location: 'Mesa St, El Paso, TX' }) === 'America/Denver');
    check('an unknown area uses the submitter\'s own zone, if valid', timeZoneFor({ serviceArea: 'Somewhere', fallback: 'America/Los_Angeles' }) === 'America/Los_Angeles' && timeZoneFor({ serviceArea: 'Somewhere', fallback: 'Not/AZone' }) === null);
  }

  console.log('2. The chosen date + the current local time there');
  {
    const now = Date.parse('2026-09-28T19:45:30Z');   // 2:45:30 PM CDT, 3:45:30 PM EDT
    check('Austin, Sep 20: 2:45:30 PM Central that day -> 19:45:30 UTC', resolveObservedAt({ date: '2026-09-20', zone: 'America/Chicago', now }).observedAt === '2026-09-20 19:45:30');
    check('Miami, Sep 20: 3:45:30 PM Eastern that day -> 19:45:30 UTC', resolveObservedAt({ date: '2026-09-20', zone: 'America/New_York', now }).observedAt === '2026-09-20 19:45:30');
    check('a January date uses that day\'s offset (CST, UTC-6): 2:45:30 PM -> 20:45:30 UTC', resolveObservedAt({ date: '2026-01-15', zone: 'America/Chicago', now }).observedAt === '2026-01-15 20:45:30');
    check('no date: exactly now', resolveObservedAt({ zone: 'America/Chicago', now }).observedAt === '2026-09-28 19:45:30');
    const lateNight = Date.parse('2026-09-29T03:00:00Z');  // still Sep 28, 10 PM in Austin
    check('"today" is the area\'s today: Sep 29 is still the future in Austin at 03:00 UTC', resolveObservedAt({ date: '2026-09-29', zone: 'America/Chicago', now: lateNight }).error === 'invalid_observed_at' && resolveObservedAt({ date: '2026-09-28', zone: 'America/Chicago', now: lateNight }).observedAt === '2026-09-29 03:00:00');
    check('an impossible or malformed date is rejected', resolveObservedAt({ date: '2026-02-30', zone: 'America/Chicago', now }).error === 'invalid_observed_at' && resolveObservedAt({ date: '09/20/2026', zone: 'America/Chicago', now }).error === 'invalid_observed_at');
  }

  console.log('3. Through the real endpoint');
  {
    const ctx = await makeApp();
    const austin = await submit(ctx, { service_area: 'Austin', observed_date: '2026-09-20', time_zone: 'America/Los_Angeles' });
    const a = wall(observedOf(ctx, austin.json.observation_id), 'America/Chicago');
    check('Austin: stored as Sep 20 at the current Central time (the city beats the browser\'s zone)', austin.status === 201 && a.date === '2026-09-20' && closeTo(a.minutes, nowMinutesIn('America/Chicago')));
    const dallas = await submit(ctx, { service_area: 'Dallas', observed_date: '2026-09-21', time_zone: 'America/New_York' });
    const m = wall(observedOf(ctx, dallas.json.observation_id), 'America/Chicago');
    check('Dallas: Sep 21 at the current Central time', m.date === '2026-09-21' && closeTo(m.minutes, nowMinutesIn('America/Chicago')));
    const placed = await submit(ctx, { approx_location: HANOVER.label, location_id: HANOVER.id, observed_date: '2026-09-22' });
    const p = wall(observedOf(ctx, placed.json.observation_id), 'America/Chicago');
    check('no city, but a Dallas, TX place: Central time', p.date === '2026-09-22' && closeTo(p.minutes, nowMinutesIn('America/Chicago')));
    const unknown = await submit(ctx, { observed_date: '2026-09-23', time_zone: 'America/Los_Angeles' });
    const u = wall(observedOf(ctx, unknown.json.observation_id), 'America/Los_Angeles');
    check('no city and no location: the submitter\'s own zone (Pacific here)', u.date === '2026-09-23' && closeTo(u.minutes, nowMinutesIn('America/Los_Angeles')));
    const none = await submit(ctx, { service_area: 'Austin' });
    const n = new Date(observedOf(ctx, none.json.observation_id).replace(' ', 'T') + 'Z').getTime();
    check('no date: the time of submission', Math.abs(n - Date.now()) < 120000);
    const future = await submit(ctx, { service_area: 'Austin', observed_date: '2099-01-01' });
    check('a future date: 400 invalid_observed_at, nothing stored', future.status === 400 && future.json.error === 'invalid_observed_at' && ctx.env.EVIDENCE_BUCKET._objects.size === 5);
  }

  console.log('4. The public page shows the time in the area\'s zone');
  {
    const ctx = await makeApp();
    for (const c of ['Austin', 'Dallas', null]) {
      const r = await submit(ctx, { service_area: c, observed_date: '2026-09-20' });
      await worker.fetch(new Request(`https://x/api/moderation/vehicle-sightings/${r.json.submission_id}`, { method: 'PATCH', headers: { Authorization: 'Bearer session-mod', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) }), ctx.env, {});
    }
    const list = await (await worker.fetch(new Request('https://x/api/sightings'), ctx.env, {})).json();
    const zoneOf = city => list.sightings.find(s => s.city === city).time_zone;
    check('each sighting carries its area\'s zone: Austin and Dallas Central, none when unknown', zoneOf('Austin') === 'America/Chicago' && zoneOf('Dallas') === 'America/Chicago' && zoneOf(null) === null);
  }

  t.finish();
}

run().catch(err => { console.error(err); process.exit(1); });
