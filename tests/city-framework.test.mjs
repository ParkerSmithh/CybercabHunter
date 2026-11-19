import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestD1, seedUser } from './helpers/d1-sqlite.mjs';
import { apiCities, computeCityEventDelta, recomputeCityStats } from '../worker/city-stats.js';
import { apiPreferredCity, cityPage } from '../worker/city-pages.js';
import { SERVICE_AREAS } from '../worker/service-areas.js';
import { clock, scheduledInstant, shiftDate } from '../worker/push-policy.js';

test('one daily snapshot and explicit city deltas, including a planned city', async () => {
  const db = createTestD1();
  seedUser(db, 'spotter');
  const now = Date.now();
  const day = shiftDate(clock(now, 'America/Chicago').date, -1);
  const timestamp = new Date(scheduledInstant(day, 720, 'America/Chicago')).toISOString().slice(0, 19).replace('T', ' ');
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  for (const [id, area, status] of [['a', 'Austin', 'approved'], ['d', 'Dallas', 'approved'], ['u', null, 'approved'], ['p', 'Dallas', 'pending']]) {
    if (status === 'approved') await run(
      `INSERT INTO robotaxi_vehicles (id, provider, license_plate, model, service_area, visibility, origin, vin, approval_basis, created_at, first_seen_at)
       VALUES (?, 'tesla', ?, 'Cybercab', ?, 'public', 'sighting', ?, 'manual', ?, ?)`,
      id, 'TEST' + id, area, '7SAYGDEF000000' + id, timestamp, timestamp);
    await run(`INSERT INTO submissions (id,user_id,submission_type,status,evidence_type,evidence_ref,submitted_at,reviewed_at)
      VALUES (?, 'spotter', 'vehicle_sighting', ?, 'photo', 'image.jpg', ?, ?)`, id, status, timestamp, timestamp);
    await run(`INSERT INTO vehicle_observations (id,user_id,submission_id,observed_at,service_area,evidence_ref,public_id)
      VALUES (?, 'spotter', ?, ?, ?, 'image.jpg', ?)`, id, id, timestamp, area, id);
  }
  const env = { cybercabhunter_db: db };
  await recomputeCityStats(env, now);
  await recomputeCityStats(env, now);
  // The registry city rule (db.registryCitySql): 'u' has no city and no rides, so
  // it counts toward the default city (Austin). Sightings count by the
  // observation's own city, so 'u's unassigned sighting is in neither.
  assert.deepEqual(db.query('SELECT city, registry_additions, approved_sightings FROM city_event_deltas ORDER BY city')
    .map(row => Object.values(row)), [['austin', 2, 1], ['dallas', 1, 1]]);
  const response = await apiCities(new Request('https://example.org/api/cities'), env);
  assert.deepEqual((await response.json()).cities.map(area => [area.key, area.stats.registry]),
    [['austin', 2], ['dallas', 1]]);   // 'u' (no city, no rides) is an Austin car
  const phoenix = { ...SERVICE_AREAS[0], key: 'phoenix', timeZone: 'America/Phoenix' };
  const delta = await computeCityEventDelta(db, phoenix, now);
  assert.equal(delta.registry_additions + delta.approved_sightings, 0);
});

test('city shorthand and private preference work', async () => {
  const request = new Request('https://example.org/dallas');
  assert.equal((await cityPage(request, {})).headers.get('Location'), 'https://example.org/?city=dallas');
  const db = createTestD1();
  seedUser(db, 'viewer');
  const env = { cybercabhunter_db: db };
  const update = new Request('https://example.org/api/me/city', { method: 'PATCH', body: JSON.stringify({ city: 'all' }) });
  assert.equal((await apiPreferredCity(update, env, null)).status, 401);
  assert.deepEqual(await (await apiPreferredCity(update, env, 'viewer')).json(), { city: 'all' });
  assert.deepEqual(await (await apiPreferredCity(request, env, 'viewer')).json(), { city: 'all' });
});

test('a config-only planned city has an honest map empty state and stays selected', async () => {
  const { readFile } = await import('node:fs/promises');
  const { JSDOM } = await import('jsdom');
  const [html, cities, switcher] = await Promise.all(['infrastructure.html', 'js/cities.js', 'js/city-switcher.js']
    .map(file => readFile(new URL('../public/' + file, import.meta.url), 'utf8')));
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.org/infrastructure' });
  const { window } = dom;
  window.localStorage.setItem('cch.preferredCity', 'phoenix');
  window.eval(cities);
  window.CCH_CITIES.SERVICE_AREAS.push({ key: 'phoenix', name: 'Phoenix', status: 'planned' });
  window.eval(switcher);
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  assert.equal(window.location.search, '?city=phoenix');
  assert.equal(window.document.querySelector('[aria-label="Tracker city"]').value, 'phoenix');
  assert.equal(window.document.querySelector('main').hidden, true);
  assert.match(window.document.querySelector('main').previousElementSibling.textContent, /Phoenix.*has no map/);
  window.close();
});
