// Fleet ETA accuracy: the daily estimate model (worker/fleet-eta-model.js),
// the precompute and endpoints (worker/fleet-eta.js), and the page's use of
// them. Scenarios from the brief: short/long trips, vehicle types, pickup
// areas, weekday/weekend, peak/off-peak, small samples, missing data,
// outdated prices, duplicates, fleet registration jumps, no public service,
// unusually high fares and unusually long waits.
// Run: node tests/fleet-eta.test.mjs

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeEnv, makeCheck, seedRide, seedVehicle, approveVehicle } from './helpers/env.mjs';
import * as M from '../worker/fleet-eta-model.js';
import { buildCityPayload, recomputeFleetEta, validateFareReport, REPORT_DAILY_LIMIT } from '../worker/fleet-eta.js';
import worker from '../worker/index.js';

const require = createRequire(import.meta.url);
const CALC = require('../public/js/calc.js');
const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const NOW = Date.parse('2026-10-12T17:00:00Z');   // a Monday, noon in Austin
const DAY = 864e5;

// Deterministic pseudo-random numbers.
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
// Local (Central, CDT in these dates) dow/hour of a UTC time.
const local = ts => M.localParts(ts, 'America/Chicago');

// Synthetic rides: fare = (base + rate x miles) x demand x vehicle factor x noise.
function makeRides({ n = 300, seed = 7, base = 3, rate = 1.5, busyMult = 1.3, cyFactor = 1, noise = 0.15, days = 120, cyShare = 0.5, myShare = 0.3 } = {}) {
  const r = rng(seed);
  const rides = [];
  for (let i = 0; i < n; i++) {
    const ts = NOW - r() * days * DAY;
    const { dow, hour } = local(ts);
    const busy = (dow === 5 || dow === 6) && hour >= 19 ? busyMult : 1;
    const miles = 0.6 + r() * 11;
    const u = r();
    const type = u < cyShare ? 'Cybercab' : u < cyShare + myShare ? 'Model Y' : null;
    const f = (base + rate * miles) * busy * (type === 'Cybercab' ? cyFactor : 1) * (1 - noise + r() * 2 * noise);
    rides.push({ fare_cents: Math.round(f * 100), miles, started_at_utc: new Date(ts).toISOString(), model: type, vehicle_id: type ? `v${i % 30}` : null, pickup: `1 Main St, Austin, TX ${['78701', '78702', '78704'][i % 3]}`, ride: `r${i}` });
  }
  return rides;
}
function makeWaitReports({ n = 60, seed = 3, days = 60, mean = 10, spread = 8, area = null, noCarsEvery = 0 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const ts = NOW - r() * days * DAY;
    const { dow, hour } = local(ts);
    const noCars = noCarsEvery && i % noCarsEvery === 0 ? 1 : 0;
    return { id: `w${seed}-${i}`, pickup_area: area || ['downtown', 'east'][i % 2], dropoff_area: null, kind: 'quote', vehicle_type: 'unknown', distance_miles: null, quoted_fare_cents: null, quoted_wait_minutes: noCars ? null : Math.round(mean - spread / 2 + r() * spread), actual_wait_minutes: null, no_cars_available: noCars, observed_hour_utc: new Date(Math.floor(ts / 36e5) * 36e5).toISOString().replace('.000Z', 'Z'), local_dow: dow, local_hour: hour };
  });
}
const fleet = (o = {}) => ({ documented: { cybercab: 120, model_y: 0, unknown: 5 }, seen: [], unidentified_sightings_30d: 0, camera_detections_30d: 0, dmv: null, ...o });

async function run() {
  console.log('1. Statistics and cleaning');
  {
    check('weighted median ignores one huge value', M.weightedMedian([1, 2, 3, 4, 1000].map(v => ({ v, w: 1 }))) === 3);
    check('recency: a 30-day-old fare weighs half', Math.abs(M.recencyWeight(NOW - 30 * DAY, NOW) - 0.5) < 1e-9);
    const obs = [
      { id: 'a', fare: 10, miles: 3, ts: NOW - DAY },
      { id: 'a', fare: 10, miles: 3, ts: NOW - DAY },           // duplicate
      { id: 'b', fare: 240, miles: 2, ts: NOW - DAY },          // $120/mi: impossible
      { id: 'c', fare: 0, miles: 2, ts: NOW - DAY },            // free ride: invalid
      { id: 'd', fare: 9, miles: 3, ts: NOW - 200 * DAY },      // outdated pricing
      { id: 'e', fare: 12, miles: 4, ts: NOW - 2 * DAY }
    ];
    const c = M.cleanFares(obs, NOW);
    check('cleaning: duplicates, impossible values and outdated fares are excluded', c.kept.length === 2 && c.excluded.duplicate === 1 && c.excluded.invalid === 2 && c.excluded.outdated === 1, JSON.stringify(c.excluded));
  }

  console.log('2. The fare model');
  {
    const rides = makeRides({ n: 400, cyShare: 0.45, myShare: 0.45, busyMult: 1 });
    const p = buildCityPayload('austin', { rides, reports: [], fleet: fleet() }, NOW);
    const all = p.fares.models.all;
    check('the fitted curve recovers the base and per-mile rate (true $3.00 + $1.50/mi)', Math.abs(all.a - 3) < 0.8 && Math.abs(all.b - 1.5) < 0.15, `${all.a} + ${all.b}`);
    const short = CALC.etaFareRange(all, 1, 'typical'), long = CALC.etaFareRange(all, 15, 'typical');
    check('short trip: a few dollars; long trip: proportionally more (the base makes short trips dearer per mile)', short.center > 3.5 && short.center < 6.5 && long.center > 22 && long.center < 28 && short.center / 1 > long.center / 15, `${short.center} / ${long.center}`);
    check('the browser copy (js/calc.js) gives exactly the model\'s range', ['quiet', 'typical', 'busy'].every(tier => JSON.stringify(CALC.etaFareRange(all, 6, tier)) === JSON.stringify(M.fareRange(all, 6, tier))));
    check('every range contains its center, and Quiet < Typical < Busy', ['quiet', 'typical', 'busy'].every(k => all.tiers[k].lo <= all.tiers[k].center && all.tiers[k].center <= all.tiers[k].hi) && all.tiers.quiet.center <= all.tiers.typical.center && all.tiers.typical.center <= all.tiers.busy.center);
    check('a range, never a single price: the typical range spans at least 15%', all.tiers.typical.hi / all.tiers.typical.lo > 1.15);
    check('observed basis with its sample size; confidence computed (not "high" by default)', all.basis === 'observed' && all.n >= 380 && ['high', 'medium'].includes(p.fares.by_vehicle.cybercab.confidence.level));
    check('the calibration check holds out the newest rides and scores them', p.fares.checks.all && p.fares.checks.all.n_test >= 70 && p.fares.checks.all.within_range > 0.6);
    check('...and compares against the previous page\'s per-mile formula on the same rides', p.fares.checks.all.baselines.previous_measured_rate && p.fares.checks.all.mae < p.fares.checks.all.baselines.previous_measured_rate.mae);
    check('accuracy is broken down by vehicle type, part of day and area', ['vehicle', 'part_of_day', 'area'].every(k => p.fares.checks.all.by[k] && Object.keys(p.fares.checks.all.by[k]).length));
  }

  console.log('3. Vehicle types: separate when the data supports it, never a fixed discount');
  {
    const cheap = buildCityPayload('austin', { rides: makeRides({ n: 500, cyFactor: 0.8, cyShare: 0.5, myShare: 0.5, busyMult: 1 }) }, NOW);
    const cy = CALC.etaFareRange(cheap.fares.models.cybercab, 5), my = CALC.etaFareRange(cheap.fares.models.model_y, 5);
    check('Cybercab and Model Y are fitted separately and the observed difference shows (~20% cheaper)', cheap.fares.by_vehicle.cybercab.use === 'cybercab' && cheap.fares.by_vehicle.model_y.use === 'model_y' && cy.center / my.center > 0.72 && cy.center / my.center < 0.88, `${cy.center}/${my.center}`);
    const dear = buildCityPayload('austin', { rides: makeRides({ n: 500, cyFactor: 1.2, cyShare: 0.5, myShare: 0.5, busyMult: 1 }) }, NOW);
    check('...and if Cybercabs cost MORE, that shows too (no assumed discount)', CALC.etaFareRange(dear.fares.models.cybercab, 5).center > CALC.etaFareRange(dear.fares.models.model_y, 5).center);
    const pooled = buildCityPayload('austin', { rides: makeRides({ n: 200, cyShare: 0.02, myShare: 0.02 }) }, NOW);
    check('too few typed rides: both cards use the all-robotaxi model, labelled, and confidence is capped below high', pooled.fares.by_vehicle.model_y.use === 'all' && /together/.test(pooled.fares.by_vehicle.model_y.note) && pooled.fares.by_vehicle.model_y.confidence.level !== 'high');
  }

  console.log('4. Demand tiers: fitted, used for a time slot only when they predict');
  {
    const p = buildCityPayload('austin', { rides: makeRides({ n: 900, busyMult: 1.35, noise: 0.08, days: 150 }) }, NOW);
    check('weekend evenings (35% dearer in the data) are assumed Busy', p.slot_tiers['weekend:evening'].tier === 'busy', JSON.stringify(p.slot_tiers['weekend:evening']));
    check('weekday mornings (off-peak, normal prices) are not', p.slot_tiers['weekday:morning'].tier !== 'busy');
    check('the time-slot tiers beat "always Typical" on held-out rides, so they are used', p.fares.checks.all.time_tiers_helped === true && p.fares.models.all.time_tiers === true);
    check('the Busy multiplier is fitted from the data, in the range real prices move (Obi: about +27%)', p.fares.models.all.tiers.busy.center > 1.03 && p.fares.models.all.tiers.busy.center < 1.6);
    const flat = buildCityPayload('austin', { rides: makeRides({ n: 400, busyMult: 1, noise: 0.15 }) }, NOW);
    check('no real time pattern: no slot is labelled Busy or Quiet (noise is not demand)', Object.values(flat.slot_tiers).every(s => s.tier === 'typical'), JSON.stringify(Object.fromEntries(Object.entries(flat.slot_tiers).map(([k, v]) => [k, v.tier]))));
    const small = buildCityPayload('austin', { rides: makeRides({ n: 18 }) }, NOW);
    check('small sample (18 rides): one Typical range, no Quiet/Busy split, and not high confidence', small.fares.models.all.tiered === false && small.fares.models.all.tiers.quiet.center === small.fares.models.all.tiers.busy.center && small.fares.by_vehicle.cybercab.confidence.level !== 'high');
    check('the tier names are never attributed to Tesla', /not a Tesla label/.test(fs.readFileSync(`${ROOT}public/js/fleet-compare.js`, 'utf8')) && /Cybercab Hunter's own demand scenarios/.test(fs.readFileSync(`${ROOT}public/simulation.html`, 'utf8')));
  }

  console.log('5. Missing, outdated and outlier data');
  {
    const none = buildCityPayload('austin', {}, NOW);
    check('no data at all (Austin): modeled from published reports, low confidence, labelled external', none.fares.by_vehicle.cybercab.use === 'external' && none.fares.by_vehicle.cybercab.confidence.level === 'low' && none.fares.models.external.basis === 'external');
    const ext = none.fares.models.external;
    check('...the external curve hits RobotaxiTracker\'s Austin median at its average trip ($10.42 at 4.1 mi)', Math.abs(M.fareRange(ext, 4.1).center - 10.42) < 0.05);
    check('...with Obi\'s day-to-day range as the tier spread', Math.abs(ext.tiers.quiet.lo - M.OBI_MULTIPLIERS.quiet) < 0.01 && Math.abs(ext.tiers.busy.hi - M.OBI_MULTIPLIERS.busy) < 0.01);
    check('...and waits from published Austin reports (10-15 min typical)', none.waits.use === 'external' && none.waits.model.tiers.typical.lo === 10 && none.waits.model.tiers.typical.hi === 15 && none.waits.confidence.level === 'low');
    const old = buildCityPayload('austin', { rides: makeRides({ n: 100, days: 400 }).map(r => ({ ...r, started_at_utc: new Date(Date.parse(r.started_at_utc) - 200 * DAY).toISOString() })) }, NOW);
    check('only outdated fares (>180 days): none used; falls back to the external model', old.fares.cleaning.excluded.outdated === 100 && old.fares.by_vehicle.cybercab.use === 'external');
    const rides = makeRides({ n: 120, busyMult: 1 });
    const base = buildCityPayload('austin', { rides }, NOW).fares.models.all;
    const spiked = buildCityPayload('austin', { rides: [...rides, ...Array.from({ length: 4 }, (_, i) => ({ ...rides[i], ride: `x${i}`, fare_cents: 9500, miles: 4 }))] }, NOW).fares.models.all;
    check('unusually high fares ($95 for 4 mi): dropped as outliers, the estimate barely moves', spiked.outliers_dropped >= 4 && Math.abs(M.fareRange(spiked, 5).center - M.fareRange(base, 5).center) < 0.3, `${spiked.outliers_dropped} ${M.fareRange(spiked, 5).center} ${M.fareRange(base, 5).center}`);
    const stale = buildCityPayload('austin', { rides: makeRides({ n: 60, days: 20 }).map(r => ({ ...r, started_at_utc: new Date(Date.parse(r.started_at_utc) - 100 * DAY).toISOString() })) }, NOW);
    check('observations 100+ days old: still used, but confidence is low', stale.fares.by_vehicle.cybercab.confidence.level === 'low');
  }

  console.log('6. Waits: observed, by area, by tier');
  {
    const reports = [...makeWaitReports({ n: 40, area: 'downtown', mean: 6, seed: 4 }), ...makeWaitReports({ n: 40, area: 'east', mean: 16, seed: 5 })];
    const p = buildCityPayload('austin', { reports, fleet: fleet() }, NOW);
    const w = p.waits.model;
    check('waits come from rider-reported quotes, labelled observed, with a range', p.waits.use === 'observed' && w.n === 80 && w.tiers.typical.lo < w.tiers.typical.hi);
    const dt = CALC.etaWaitRange(w, 'typical', 'downtown'), east = CALC.etaWaitRange(w, 'typical', 'east');
    check('a downtown pickup gets a shorter wait than East Austin (area data supports it)', dt.center < east.center, `${dt.center} vs ${east.center}`);
    check('Busy waits are longer than Quiet waits', CALC.etaWaitRange(w, 'busy').center > CALC.etaWaitRange(w, 'quiet').center);
    const thin = buildCityPayload('austin', { reports: [...makeWaitReports({ n: 30, area: 'downtown' }), ...makeWaitReports({ n: 3, area: 'north', seed: 9 })] }, NOW);
    check('an area with 3 reports gets no area adjustment (citywide, no fabricated precision)', !thin.waits.model.area_mult.north && thin.waits.model.area_n.north === 3);
    const longWaits = makeWaitReports({ n: 30, mean: 12, spread: 6 });
    longWaits[0].quoted_wait_minutes = 85; longWaits[1].quoted_wait_minutes = 88;
    const lw = buildCityPayload('austin', { reports: longWaits }, NOW).waits.model;
    check('unusually long waits (85+ min) don\'t drag the typical estimate', lw.tiers.typical.center < 17, String(lw.tiers.typical.center));
    check('waits over 90 minutes are rejected at the door', validateFareReport({ city: 'austin', kind: 'quote', quoted_wait_minutes: 120, observed_at: new Date().toISOString() }).error === 'invalid_quoted_wait');
    const unavailable = buildCityPayload('austin', { reports: makeWaitReports({ n: 60, noCarsEvery: 2, days: 20 }) }, NOW);
    check('"no cars available" reports are a Busy signal for their time slot', Object.values(unavailable.slot_tiers).some(s => s.tier === 'busy' && /no car available/.test(s.reasons.join())));
    const quoted = makeWaitReports({ n: 20 }).map((r, i) => ({ ...r, kind: 'completed', actual_wait_minutes: r.quoted_wait_minutes == null ? null : r.quoted_wait_minutes + 3 }));
    const avq = buildCityPayload('austin', { reports: quoted }, NOW).waits.actual_vs_quoted;
    check('quoted ETA and actual pickup time are kept apart (riders: cars 3 min later than quoted)', avq.n === 20 && avq.median_delay === 3);
  }

  console.log('7. Fleet layers: never interchangeable, never double counted');
  {
    const rides = makeRides({ n: 40, days: 10 }).map(r => ({ ...r, vehicle_id: 'same-car', model: 'Cybercab' }));
    const p = buildCityPayload('austin', { rides, fleet: fleet({ seen: Array.from({ length: 20 }, () => ({ vid: 'same-car', ms: NOW - DAY })), camera_detections_30d: 20 }) }, NOW);
    check('one Cybercab in 20 sightings and 40 rides is ONE car seen', p.fleet.observed_7d === 1 && p.fleet.observed_30d === 1);
    check('20 camera detections that can\'t be tied to a car are reported separately, not as cars', p.fleet.unidentified_30d.camera_detections === 20 && p.fleet.observed_30d === 1);
    check('the pickup-available fleet is not claimed', p.fleet.available_pickup === null);
    const big = buildCityPayload('austin', { rides: makeRides({ n: 200 }), fleet: fleet({ dmv: { snapshot_date: '2026-10-11', total: 5000, cybercab: 3000, model_y: 2000, scope: 'Texas (statewide)' } }) }, NOW);
    const small = buildCityPayload('austin', { rides: makeRides({ n: 200 }), fleet: fleet() }, NOW);
    check('a big jump in DMV registrations changes no fare or wait estimate (registered is not available)', JSON.stringify(big.fares.models) === JSON.stringify(small.fares.models) && JSON.stringify(big.waits) === JSON.stringify(small.waits) && big.fleet.dmv.total === 5000);
  }

  console.log('8. Per city: Dallas is never Austin');
  {
    const austinRides = makeRides({ n: 300 });
    const dal = buildCityPayload('dallas', { rides: [] }, NOW);
    check('Dallas with no Cybercab evidence: Cybercab fare and wait are "Insufficient data", not Austin\'s', dal.service.cybercab_service === false && dal.fares.by_vehicle.cybercab.use === 'none' && dal.fares.by_vehicle.cybercab.confidence.level === 'insufficient');
    check('Dallas Model Y: modeled from Dallas\'s own published figures ($5.88 median at 2.2 mi), not Austin\'s', Math.abs(M.fareRange(dal.fares.models.external, 2.2).center - 5.88) < 0.05);
    check('Dallas waits: no published Dallas wait data, so "none" (Austin\'s waits are not reused)', dal.waits.use === 'none');
    const both = buildCityPayload('dallas', { rides: [], reports: [] }, NOW);
    const aus = buildCityPayload('austin', { rides: austinRides }, NOW);
    check('the two cities are computed independently (Austin rides never reach the Dallas payload)', both.fares.cleaning.candidates === 0 && aus.fares.cleaning.candidates === 300);
    const dalCy = makeRides({ n: 30, cyShare: 1, myShare: 0 });
    const withCy = buildCityPayload('dallas', { rides: dalCy }, NOW);
    check('a logged Dallas Cybercab ride is evidence of service: the Dallas Cybercab estimate appears', withCy.service.cybercab_service === true && withCy.fares.by_vehicle.cybercab.use === 'cybercab');
  }

  console.log('9. Reports: validation');
  {
    const ok = { city: 'austin', kind: 'quote', vehicle_type: 'cybercab', pickup_area: 'downtown', quoted_fare: 9.4, distance_miles: 3.1, quoted_wait_minutes: 7, observed_at: new Date(Date.now() - 3600e3).toISOString() };
    const v = validateFareReport(ok);
    check('a sensible report is accepted and stored coarsely (area, hour)', v.report && v.report.quoted_fare_cents === 940 && /T\d\d:00:00Z$/.test(v.report.observed_hour_utc));
    const bad = [
      [{ ...ok, city: 'houston' }, 'invalid_city'],
      [{ ...ok, pickup_area: '123 Main St' }, 'invalid_pickup_area'],
      [{ ...ok, quoted_fare: 0.2 }, 'invalid_fare'],
      [{ ...ok, quoted_fare: 400 }, 'invalid_fare'],
      [{ ...ok, distance_miles: null }, 'distance_required_with_fare'],
      [{ ...ok, quoted_fare: 90, distance_miles: 1 }, 'implausible_fare_for_distance'],
      [{ ...ok, duration_minutes: 2, distance_miles: 10, quoted_fare: 20 }, 'implausible_speed'],
      [{ ...ok, no_cars_available: true }, 'no_cars_with_values'],
      [{ city: 'austin', kind: 'quote', observed_at: ok.observed_at }, 'nothing_reported'],
      [{ ...ok, actual_wait_minutes: 9 }, 'actual_wait_needs_completed_ride'],
      [{ ...ok, observed_at: new Date(Date.now() - 40 * DAY).toISOString() }, 'observed_at_out_of_range'],
      [{ ...ok, observed_at: new Date(Date.now() + 2 * 3600e3).toISOString() }, 'observed_at_out_of_range']
    ];
    for (const [body, err] of bad) check(`rejects: ${err}`, validateFareReport(body).error === err, validateFareReport(body).error);
    check('"no cars available" alone is a valid report', !!validateFareReport({ city: 'dallas', kind: 'quote', no_cars_available: true, observed_at: ok.observed_at }).report);
  }

  console.log('10. Endpoints, moderation, and the D1 budget on the request path');
  {
    const ctx = await makeEnv({ users: ['u1', 'mod'] });
    const { env, d1 } = ctx;
    d1.prepare(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`)._exec();
    await env.TESLA_SESSIONS.put('session:s-u1', JSON.stringify({ user_id: 'u1' }));
    await env.TESLA_SESSIONS.put('session:s-mod', JSON.stringify({ user_id: 'mod' }));
    const background = [];
    const call = (method, path, { body, session, ip = '203.0.113.9' } = {}) => worker.fetch(new Request(`https://cybercabhunter.com${path}`, {
      method, headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), 'CF-Connecting-IP': ip },
      body: body ? JSON.stringify(body) : undefined
    }), env, { waitUntil(p) { background.push(p); } });

    // Record every SQL statement the request handlers run.
    const log = [];
    const realPrepare = d1.prepare;
    const watch = on => { d1.prepare = on ? (sql => { log.push(sql.replace(/\s+/g, ' ').trim()); return realPrepare(sql); }) : realPrepare; };

    watch(true); log.length = 0;
    const first = await call('GET', '/api/fleet-eta?city=dallas');
    const firstJson = await first.json();
    watch(false);
    // Everything after the first statement belongs to the background recompute.
    const inRequest = log.findIndex(q => !/fleet_eta_stats WHERE city/.test(q)) === -1 ? log.length : log.findIndex(q => !/fleet_eta_stats WHERE city/.test(q));
    check('before the first daily run: published-report estimates, flagged, from one indexed read in the request itself', first.status === 200 && firstJson.pending_first_run === true && inRequest === 1 && /FROM fleet_eta_stats WHERE city = \?/.test(log[0]));
    check('...cached for a minute only', /max-age=60\b/.test(first.headers.get('Cache-Control')));
    await Promise.all(background.splice(0));
    const filled = await (await call('GET', '/api/fleet-eta?city=dallas')).json();
    check('...and the city\'s row is computed once in the background, so the next request has its fleet count', !filled.pending_first_run && filled.fleet && typeof filled.fleet.documented.cybercab === 'number');
    await call('GET', '/api/fleet-eta?city=austin');
    check('a burst of misses recomputes only once (5-minute marker)', await env.TESLA_SESSIONS.get('fleet_eta:first_run:dallas') === '1');
    await Promise.all(background.splice(0));
    d1.prepare(`DELETE FROM fleet_eta_stats`)._exec();
    await env.TESLA_SESSIONS.delete('fleet_eta:first_run:austin'); await env.TESLA_SESSIONS.delete('fleet_eta:first_run:dallas');
    check('unknown city: 400', (await call('GET', '/api/fleet-eta?city=houston')).status === 400);

    const vid = 'aaaaaaaa-0000-4000-8000-000000000001';
    seedVehicle(d1, { id: vid, plate: 'CYB1', model: 'Cybercab' });
    approveVehicle(d1, vid);
    d1.prepare(`UPDATE robotaxi_vehicles SET service_area = 'Austin' WHERE id = ?`).bind(vid)._exec();
    const r = rng(5);
    for (let i = 0; i < 40; i++) {
      const miles = Math.round((1 + r() * 8) * 10) / 10;
      seedRide(d1, { vehicleId: i % 2 ? vid : null, serviceArea: 'Austin', rideDate: `2026-${i % 2 ? '09' : '10'}-${String(1 + (i % 9)).padStart(2, '0')}`, pickupTime: `1${i % 10}:15`, distance: miles, fare: Math.round((3 + 1.5 * miles) * (0.9 + r() * 0.2) * 100), rideKey: `k${i}`, pickupDescription: '1 Congress Ave, Austin, TX 78701' });
    }

    const report = { city: 'austin', kind: 'quote', vehicle_type: 'cybercab', pickup_area: 'downtown', quoted_fare: 11.5, distance_miles: 4, quoted_wait_minutes: 8, observed_at: new Date(Date.now() - 1800e3).toISOString() };
    check('reporting needs sign-in', (await call('POST', '/api/fare-reports', { body: report })).status === 401);
    watch(true); log.length = 0;
    const sent = await call('POST', '/api/fare-reports', { body: report, session: 's-u1' });
    watch(false);
    check('a report is accepted as pending (unverified)', sent.status === 201 && (await sent.json()).status === 'pending');
    check('one report = two bounded limit checks + one INSERT (no other table touched)', log.length === 3 && log.filter(s => /LIMIT 10\)/.test(s)).length === 2 && log.every(s => /fare_reports/.test(s) && !/trips|vehicle_observations|camera_detections|robotaxi_vehicles/.test(s)), log.join('\n'));
    check('the same report again is a duplicate (409)', (await call('POST', '/api/fare-reports', { body: report, session: 's-u1' })).status === 409);
    let last = null;
    for (let i = 0; i < REPORT_DAILY_LIMIT; i++) last = await call('POST', '/api/fare-reports', { body: { ...report, quoted_fare: 12 + i }, session: 's-u1' });
    check(`more than ${REPORT_DAILY_LIMIT} reports a day: 429`, last.status === 429);
    const viaIp = await call('POST', '/api/fare-reports', { body: { ...report, quoted_fare: 30 }, session: 's-mod' });
    check('the per-IP daily limit applies across accounts', viaIp.status === 429);
    const otherIp = await call('POST', '/api/fare-reports', { body: { ...report, quoted_fare: 30 }, session: 's-mod', ip: '198.51.100.4' });
    check('...another IP is fine', otherIp.status === 201);

    check('the moderation queue is moderators only', (await call('GET', '/api/moderation/fare-reports', { session: 's-u1' })).status === 403);
    const queue = await (await call('GET', '/api/moderation/fare-reports', { session: 's-mod' })).json();
    check('moderators see the pending reports', queue.reports.length === 11);
    const approve = await call('POST', `/api/moderation/fare-reports/${queue.reports[0].id}`, { body: { action: 'approve' }, session: 's-mod' });
    const reject = await call('POST', `/api/moderation/fare-reports/${queue.reports[1].id}`, { body: { action: 'reject' }, session: 's-mod' });
    check('approve and reject work once each', approve.status === 200 && reject.status === 200 && (await call('POST', `/api/moderation/fare-reports/${queue.reports[0].id}`, { body: { action: 'reject' }, session: 's-mod' })).status === 404);

    await recomputeFleetEta(env, Date.now());
    const rows = d1.prepare(`SELECT city, payload FROM fleet_eta_stats ORDER BY city`)._exec().results;
    check('the daily job stores exactly one current row per city', rows.map(x => x.city).join() === 'austin,dallas');
    const aus = JSON.parse(rows[0].payload);
    check('only APPROVED reports feed it (1 of 11), next to the logged rides', aus.fares.cleaning.sources.reports === 1 && aus.fares.cleaning.sources.rides === 40, JSON.stringify(aus.fares.cleaning.sources));
    check('the fleet mix count is the whole public registry (any city), the same list as the Cars page', aus.fleet.registry && aus.fleet.registry.total === 1 && aus.fleet.registry.cybercab === 1);
    check('Austin\'s fleet mix counts the whole public registry (any city); Dallas only cars documented in Dallas', aus.fleet.registry && aus.fleet.registry.total === 1 && JSON.parse(rows[1].payload).fleet.documented.cybercab === 0);
    check('the stored row is aggregates only: no ids, plates, users or addresses', !/CYB1|u1|"mod"|Congress Ave|aaaaaaaa-/.test(rows[0].payload));
    watch(true); log.length = 0;
    const servedResp = await call('GET', '/api/fleet-eta?city=austin');
    const served = await servedResp.json();
    watch(false);
    check('the stats API is edge-cacheable for an hour once computed', /max-age=3600/.test(servedResp.headers.get('Cache-Control')));
    check('a page load reads the one stored row and nothing else', log.length === 1 && served.computed_at === aus.computed_at && !served.pending_first_run);

    const page = fs.readFileSync(`${ROOT}public/js/fleet-compare.js`, 'utf8');
    check('the page calls /api/fleet-eta, not any history endpoint', /\/api\/fleet-eta\?city=/.test(page) && !/\/api\/(trips|sightings|camera-sightings)/.test(page));
  }

  console.log('11. The page');
  {
    const html = fs.readFileSync(`${ROOT}public/simulation.html`, 'utf8');
    check('"How are these estimates calculated?" is on the page', /How are these estimates calculated\?/.test(html));
    check('it says the site is independent and has no live Tesla data', /independent tracking site/.test(html) && /no live Tesla pricing or dispatch data/.test(html));
    check('it explains registered vs available fleet', /Why the registered fleet is not the available fleet/.test(html));
    check('each city has an area picker, a distance slider and four confidence-labelled estimates', ['austin', 'dallas'].every(c => html.includes(`data-eta-area="${c}"`) && html.includes(`data-eta-miles="${c}"`) && html.includes(`data-eta-fare="${c}:cybercab"`) && html.includes(`data-eta-fare="${c}:model_y"`)));
    check('a report form exists (optional, unverified until reviewed)', /id="fareReportForm"/.test(html) && /unverified until a moderator reviews them/.test(html));
    check('no measured-fare-as-Cybercab label remains (logged rides of unknown type were shown as Cybercab fares)', !/Cybercab, measured rate/.test(html) && !/id="medianFare"/.test(html));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
