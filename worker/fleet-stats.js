// Live Fleet & Fares stats (the Zones page panel).
//
//   GET /api/fleet-stats?city=austin|dallas   public, edge-cached
//   -> { city, cybercabs, count_as_of,
//        fares: { rides, min_rides, median_fare, average_fare, per_mile,
//                 computed_at, sources } }
//
// PRIVACY: a private or not-yet-eligible vehicle never adds to the count or to
// a fare (publicVehicleEligibleSql — the same gate as every public page), and
// nothing per-vehicle or per-ride is ever returned.
//
// COUNT (live, every request; cached at the edge for COUNT_CACHE_SECONDS):
//   cybercabs   publicly eligible registry vehicles recorded as Cybercabs
//               whose service area is the city.
//   count_as_of when that count was taken (ISO 8601 UTC), so a page can say how
//               old it is (an edge-cached copy keeps its original time).
//
// FARES (recomputed daily by the cron in wrangler.jsonc — FLEET_STATS_CRON —
// and stored in KV, so the numbers move as new rides land, no deploy needed):
//   Sample: EVERY counted ride in the city with a fare and a distance > 0, in
//   USD — one entry per PHYSICAL ride (riders sharing a ride_key count once,
//   the same rule as physicalRidesFrom): rides on any publicly eligible
//   vehicle in the city AND rides not linked to any vehicle (by their own
//   service_area). A ride on a private or not-yet-eligible vehicle never
//   counts. Kilometres are converted to miles.
//   median_fare   median of the per-ride fares
//   average_fare  mean of the per-ride fares
//   per_mile      total fares / total miles (a distance-weighted rate, so one
//                 very short ride can't dominate it)
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

export const FARE_MIN_RIDES = 1;
// The cities with a fleet panel (Zones, homepage, Fleet ETA). Dallas added for
// the Dallas launch; every other city is refused (400 invalid_city).
export const FLEET_CITIES = ['austin', 'dallas'];
export const FLEET_STATS_CRON = '0 11 * * *';        // daily, 6 AM CDT / 5 AM CST
const COUNT_CACHE_SECONDS = 300;
const KM_TO_MI = 0.621371;
// Bump FARES_VERSION whenever the fare rules or shape change, so a deploy never
// serves figures stored under the old rules (the first request recomputes).
const FARES_VERSION = 2;   // 2: every city ride, no minimum
const kvKey = cityKey => `fleet_stats:v${FARES_VERSION}:${cityKey}:fares`;

const inCity = alias => `lower(trim(${alias}.service_area)) = ?`;

export async function computeFleetCounts(sql, cityName) {
  const row = await sql.prepare(`
    SELECT COUNT(*) AS cybercabs
    FROM robotaxi_vehicles v
    WHERE ${publicVehicleEligibleSql('v')} AND ${inCity('v')}
      AND lower(replace(trim(COALESCE(v.model, '')), ' ', '')) = 'cybercab'
  `).bind(cityName.toLowerCase()).first();
  return { cybercabs: Number(row ? row.cybercabs : 0) };
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
const round2 = n => Math.round(n * 100) / 100;

// THE city ride sample (see FARES above): counted rides on a publicly eligible
// vehicle in the city, or with no vehicle and the city as their own service
// area. `FROM … WHERE …` with two binds (the lower-case city name); callers
// add their own conditions and GROUP BY t.robotaxi_vehicle_id,
// COALESCE(t.ride_key, t.id) for one row per physical ride.
export const CITY_RIDES_FROM = `${RIDES_FROM}
    LEFT JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
    WHERE ${COUNTED_RIDES_WHERE}
      AND ((v.id IS NOT NULL AND ${publicVehicleEligibleSql('v')} AND ${inCity('v')})
           OR (t.robotaxi_vehicle_id IS NULL AND ${inCity('t')}))`;
export const MILES_SQL = `CASE WHEN lower(COALESCE(t.distance_unit, 'mi')) = 'km' THEN t.distance * ${KM_TO_MI} ELSE t.distance END`;

// The fare model from the city's rides (see FARES above). Pure aside from the query.
export async function computeFareStats(sql, cityName, nowMs = Date.now()) {
  const city = cityName.toLowerCase();
  const { results } = await sql.prepare(`
    SELECT MAX(t.fare_amount_cents) AS fare_cents,
           MAX(${MILES_SQL}) AS miles
    FROM ${CITY_RIDES_FROM}
      AND t.fare_amount_cents IS NOT NULL AND t.distance > 0
      AND upper(COALESCE(t.currency, 'USD')) = 'USD'
      AND lower(COALESCE(t.distance_unit, 'mi')) IN ('mi', 'km')
    GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id)
  `).bind(city, city).all();
  const rides = (results || []).map(r => ({ fare: Number(r.fare_cents) / 100, miles: Number(r.miles) }))
    .filter(r => Number.isFinite(r.fare) && r.fare >= 0 && Number.isFinite(r.miles) && r.miles > 0);
  const base = { rides: rides.length, min_rides: FARE_MIN_RIDES, computed_at: new Date(nowMs).toISOString(), sources: rides.length ? ['cybercabhunter_rides'] : [] };
  if (rides.length < FARE_MIN_RIDES) return { ...base, median_fare: null, average_fare: null, per_mile: null };
  const fares = rides.map(r => r.fare).sort((a, b) => a - b);
  const totalFare = fares.reduce((s, f) => s + f, 0);
  const totalMiles = rides.reduce((s, r) => s + r.miles, 0);
  return {
    ...base,
    median_fare: round2(median(fares)),
    average_fare: round2(totalFare / fares.length),
    per_mile: round2(totalFare / totalMiles)
  };
}

// The daily job: recompute and store the fare model for every supported city.
export async function recomputeFleetStats(env, nowMs = Date.now()) {
  const out = {};
  for (const key of FLEET_CITIES) {
    const fares = await computeFareStats(env.cybercabhunter_db, serviceAreaFor(key).name, nowMs);
    await env.TESLA_SESSIONS.put(kvKey(key), JSON.stringify(fares));
    out[key] = fares;
  }
  return out;
}

// The stored fare model; computed (and stored) once if the daily job hasn't run yet.
async function storedFares(env, area) {
  try {
    const raw = await env.TESLA_SESSIONS.get(kvKey(area.key));
    if (raw) return JSON.parse(raw);
  } catch (e) { /* recompute below */ }
  const fares = await computeFareStats(env.cybercabhunter_db, area.name);
  try { await env.TESLA_SESSIONS.put(kvKey(area.key), JSON.stringify(fares)); } catch (e) { /* served anyway */ }
  return fares;
}

export async function apiFleetStats(request, env, ctx) {
  const cityParam = (new URL(request.url).searchParams.get('city') || 'austin').toLowerCase();
  const area = FLEET_CITIES.includes(cityParam) ? serviceAreaFor(cityParam) : null;
  if (!area) return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const [counts, fares] = await Promise.all([computeFleetCounts(env.cybercabhunter_db, area.name), storedFares(env, area)]);
  const response = Response.json({ city: area.key, cybercabs: counts.cybercabs, count_as_of: new Date().toISOString(), fares },
    { headers: { 'Cache-Control': `public, max-age=${COUNT_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}
