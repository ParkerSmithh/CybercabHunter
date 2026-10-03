// Live Fleet & Fares stats (the Zones page panel and the Fleet ETA estimate).
//
//   GET /api/fleet-stats?city=austin   public, edge-cached
//   -> { city, cybercabs, active_cybercabs, active_window_days,
//        fares: { rides, min_rides, median_fare, average_fare, per_mile,
//                 median_miles, computed_at, sources },
//        model_y: { vehicles, active, fares: { ...same shape } } }
//   Every figure is per vehicle MODEL (the registry's model column): the
//   top-level ones are Cybercabs; model_y the same rules for Model Y. The
//   registry holds only Cybercabs today ("Approve Cybercab" is the one path to
//   public, and it records the model as Cybercab), so model_y is 0 / null until
//   Model Y vehicles and rides are tracked — and the page shows "—".
//
// PRIVACY: everything here is built ONLY from publicly eligible registry
// vehicles (publicVehicleEligibleSql — the same gate as every public page) and
// counted rides on them. A private or unapproved vehicle never adds to a count
// or a fare, and nothing per-vehicle or per-ride is ever returned.
//
// COUNTS (live, every request; cached at the edge for COUNT_CACHE_SECONDS):
//   cybercabs        publicly eligible registry vehicles whose service area is
//                    the city.
//   active_cybercabs the same set, limited to vehicles with recent activity.
//                    The codebase had no definition of "active" for registry
//                    vehicles (vehicles.active_status is a rider's own Tesla
//                    car), so: an APPROVED sighting observed, or a COUNTED
//                    ride dated, within the last ACTIVE_WINDOW_DAYS days.
//
// FARES (recomputed daily by the cron in wrangler.jsonc — FLEET_STATS_CRON —
// and stored in KV, so the numbers move as new rides land, no deploy needed):
//   Sample: EVERY counted ride in the city with a fare and a distance > 0, in
//   USD — one entry per PHYSICAL ride (riders sharing a ride_key count once,
//   the same rule as physicalRidesFrom). The city pool (`fares`, the Zones
//   panel and the Cybercab ETA estimate) takes rides on any publicly eligible
//   vehicle in the city AND rides not linked to any vehicle (their own
//   service_area); a ride on a private or not-yet-eligible vehicle never
//   counts. The Model Y pool takes only rides on public Model Y vehicles.
//   Kilometres are converted to miles.
//   median_fare   median of the per-ride fares
//   average_fare  mean of the per-ride fares
//   per_mile      total fares / total miles (a distance-weighted rate, so one
//                 very short ride can't dominate it)
//   median_miles  median ride distance (used by the ETA estimate)
//   All available rides are used: with FARE_MIN_RIDES (1) or more the stats
//   are shown, with the sample size beside them; with none, null -> "—".
//
// SOURCES / BLENDING: the site's own ride data is the only source. An online
// source was required to be verified first, and none is usable: Robotaxi
// Tracker (https://robotaxitracker.com) publishes fares only on its pages,
// backed by app-only JSON paths whose robots.txt forbids automated harvesting,
// and its documented machine-readable feeds (llms.txt) carry no fare data.
// Tesla's published rate card is a price list, not measured fares, and
// hard-coding it is exactly what this replaces. The rule if a permitted
// source is ever added: the site's own rides are used whenever there are any;
// external figures fill in only where there are none, and `sources` lists
// what was used.

import { COUNTED_RIDES_WHERE, RIDES_FROM, publicVehicleEligibleSql } from './ride-status.js';
import { serviceAreaFor } from './service-areas.js';

export const ACTIVE_WINDOW_DAYS = 30;
export const FARE_MIN_RIDES = 1;
export const FLEET_STATS_CRON = '0 11 * * *';        // daily, 6 AM CDT / 5 AM CST
const COUNT_CACHE_SECONDS = 300;
const KM_TO_MI = 0.621371;
const MODELS = { cybercab: 'cybercab', model_y: 'modely' };   // normalized registry model names
// Bump FARES_VERSION whenever the fare rules change, so a deploy never serves
// figures stored under the old rules (the first request recomputes).
const FARES_VERSION = 2;   // 2: every Austin ride, no minimum
const kvKey = (cityKey, model = 'cybercab') => `fleet_stats:v${FARES_VERSION}:${cityKey}:${model}:fares`;

const inCity = alias => `lower(trim(${alias}.service_area)) = ?`;
// The registry model, normalized ("Model Y", "model y", "ModelY" -> "modely").
const isModel = alias => `lower(replace(trim(COALESCE(${alias}.model, '')), ' ', '')) = ?`;

export async function computeFleetCounts(sql, cityName, model = 'cybercab') {
  const city = cityName.toLowerCase();
  const row = await sql.prepare(`
    SELECT COUNT(*) AS cybercabs,
           COALESCE(SUM(
             EXISTS (SELECT 1 FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
                     WHERE o.robotaxi_vehicle_id = v.id AND s.submission_type = 'vehicle_sighting' AND s.status = 'approved'
                       AND o.observed_at >= datetime('now', '-${ACTIVE_WINDOW_DAYS} days'))
             OR EXISTS (SELECT 1 FROM ${RIDES_FROM}
                        WHERE t.robotaxi_vehicle_id = v.id AND ${COUNTED_RIDES_WHERE}
                          AND t.ride_date >= date('now', '-${ACTIVE_WINDOW_DAYS} days'))
           ), 0) AS active_cybercabs
    FROM robotaxi_vehicles v
    WHERE ${publicVehicleEligibleSql('v')} AND ${inCity('v')} AND ${isModel('v')}
  `).bind(city, MODELS[model]).first();
  return { cybercabs: Number(row ? row.cybercabs : 0), active_cybercabs: Number(row ? row.active_cybercabs : 0) };
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const round2 = n => Math.round(n * 100) / 100;

// The fare model from the city's rides (see FARES above). Pure aside from the query.
// model 'cybercab' is the city pool (every ride in the city — see FARES);
// 'model_y' is rides on public Model Y vehicles only.
export async function computeFareStats(sql, cityName, nowMs = Date.now(), model = 'cybercab') {
  const city = cityName.toLowerCase();
  const cityPool = model === 'cybercab';
  const pool = cityPool
    ? `((v.id IS NOT NULL AND ${publicVehicleEligibleSql('v')} AND ${inCity('v')})
        OR (t.robotaxi_vehicle_id IS NULL AND ${inCity('t')}))`
    : `(v.id IS NOT NULL AND ${publicVehicleEligibleSql('v')} AND ${inCity('v')} AND ${isModel('v')})`;
  const { results } = await sql.prepare(`
    SELECT MAX(t.fare_amount_cents) AS fare_cents,
           MAX(CASE WHEN lower(COALESCE(t.distance_unit, 'mi')) = 'km' THEN t.distance * ${KM_TO_MI} ELSE t.distance END) AS miles
    FROM ${RIDES_FROM}
    LEFT JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
    WHERE ${COUNTED_RIDES_WHERE} AND ${pool}
      AND t.fare_amount_cents IS NOT NULL AND t.distance > 0
      AND upper(COALESCE(t.currency, 'USD')) = 'USD'
      AND lower(COALESCE(t.distance_unit, 'mi')) IN ('mi', 'km')
    GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id)
  `).bind(...(cityPool ? [city, city] : [city, MODELS[model]])).all();
  const rides = (results || []).map(r => ({ fare: Number(r.fare_cents) / 100, miles: Number(r.miles) }))
    .filter(r => Number.isFinite(r.fare) && r.fare >= 0 && Number.isFinite(r.miles) && r.miles > 0);
  const base = { rides: rides.length, min_rides: FARE_MIN_RIDES, computed_at: new Date(nowMs).toISOString(), sources: rides.length ? ['cybercabhunter_rides'] : [] };
  if (rides.length < FARE_MIN_RIDES) return { ...base, median_fare: null, average_fare: null, per_mile: null, median_miles: null };
  const fares = rides.map(r => r.fare).sort((a, b) => a - b);
  const miles = rides.map(r => r.miles).sort((a, b) => a - b);
  const totalFare = fares.reduce((s, f) => s + f, 0);
  const totalMiles = miles.reduce((s, m) => s + m, 0);
  return {
    ...base,
    median_fare: round2(median(fares)),
    average_fare: round2(totalFare / fares.length),
    per_mile: round2(totalFare / totalMiles),
    median_miles: round2(median(miles))
  };
}

// The daily job: recompute and store the fare model for every supported city.
export async function recomputeFleetStats(env, nowMs = Date.now()) {
  const out = {};
  for (const key of ['austin']) {
    const area = serviceAreaFor(key);
    out[key] = {};
    for (const model of Object.keys(MODELS)) {
      const fares = await computeFareStats(env.cybercabhunter_db, area.name, nowMs, model);
      await env.TESLA_SESSIONS.put(kvKey(key, model), JSON.stringify(fares));
      out[key][model] = fares;
    }
  }
  return out;
}

// The stored fare model; computed (and stored) once if the daily job hasn't run yet.
async function storedFares(env, area, model = 'cybercab') {
  try {
    const raw = await env.TESLA_SESSIONS.get(kvKey(area.key, model));
    if (raw) return JSON.parse(raw);
  } catch (e) { /* recompute below */ }
  const fares = await computeFareStats(env.cybercabhunter_db, area.name, Date.now(), model);
  try { await env.TESLA_SESSIONS.put(kvKey(area.key, model), JSON.stringify(fares)); } catch (e) { /* served anyway */ }
  return fares;
}

export async function apiFleetStats(request, env, ctx) {
  const cityParam = (new URL(request.url).searchParams.get('city') || 'austin').toLowerCase();
  const area = cityParam === 'austin' ? serviceAreaFor('austin') : null;   // Austin is the only city with fleet data
  if (!area) return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const sql = env.cybercabhunter_db;
  const [counts, fares, myCounts, myFares] = await Promise.all([
    computeFleetCounts(sql, area.name), storedFares(env, area),
    computeFleetCounts(sql, area.name, 'model_y'), storedFares(env, area, 'model_y')
  ]);
  const response = Response.json({
    city: area.key,
    cybercabs: counts.cybercabs,
    active_cybercabs: counts.active_cybercabs,
    active_window_days: ACTIVE_WINDOW_DAYS,
    fares,
    model_y: { vehicles: myCounts.cybercabs, active: myCounts.active_cybercabs, fares: myFares }
  }, { headers: { 'Cache-Control': `public, max-age=${COUNT_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}
