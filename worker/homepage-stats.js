// The homepage's city rows and hero numbers, for one city, in one response.
//
//   GET /api/homepage-stats?city=austin|dallas   public, edge-cached 5 min
//   -> { city, name, generated_at,
//        hero:      { city: { vehicles, rides, sightings }, all: { vehicles, rides, sightings } },
//        area:      { square_miles, in_service_since, hours: { open, close }, description, vehicles },
//        rides:     { rides, miles, average_fare, per_mile, fare_rides, average_miles, average_minutes,
//                     weekly_fares: [{ week, average_fare, rides }] },
//        sightings: { total, last_24h, last_7_days, peak_hour, top_spots: [{ location, count }], latest: [...] },
//        cameras:   { monitored, detections_24h, last_detection_at, hourly: [{ hour, count }] } }
//
// EVERY figure is live from D1 and reuses the rule that already defines it —
// nothing is counted a second way:
//   vehicles        the Cars page's registry city rule (db.registryCitySql) over
//                   publicly eligible vehicles; `all` = the registry stats
//   rides (hero)    physical rides (physicalRidesFrom) on those vehicles;
//                   `all` = the registry stats' recorded_rides
//   rides (row)     the city ride sample behind the Fleet fares
//                   (fleet-stats CITY_RIDES_FROM: COUNTED_RIDES_WHERE, publicly
//                   eligible vehicles only), one row per physical ride; the
//                   average fare and per-mile rate are fleet-stats'
//                   computeFareStats itself
//   sightings       approved public photo sightings (db PUBLIC_PHOTO_SIGHTING_SQL
//                   via the existing queries); peak hour and 7 days from the
//                   Sightings page's buildSightingStats
//   cameras         camera_detections for the city (every row is a camera-watch
//                   detection; the table has no other status), and the cameras
//                   listed for the city in public/data/traffic-cameras.json
// "No data" is null (shown as "—"), never a made-up 0: averages with no rides,
// a peak hour the data doesn't clearly show, a last detection that never was.
// Area facts (square miles, launch date, hours, description) are the published
// zone facts in worker/service-areas.js, the same the Zones page shows.
//
// PRIVACY: no rider is named or counted individually; no ride is listed
// (aggregates only); sightings are
// the already-public ones with their public fields; no moderation state,
// pending count or queue figure is selected anywhere.

import { db, registryCitySql } from './db.js';
import { physicalRidesFrom, publicVehicleEligibleSql } from './ride-status.js';
import { CITY_RIDES_FROM, MILES_SQL, computeFareStats, FLEET_CITIES } from './fleet-stats.js';
import { buildSightingStats, publicSightingJson } from './sightings-public.js';
import { publicLocation } from './places.js';
import { TRAFFIC_CAMERAS, cameraCity } from './traffic-cameras.js';
import { serviceAreaFor } from './service-areas.js';

const CACHE_SECONDS = 300;
const FARE_WEEKS = 13;            // ~90 days of weekly average fares
const LATEST_SIGHTINGS = 5;
const TOP_SPOTS = 3;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const num = v => (v == null ? null : Number(v));

// Monday (UTC date) of the week a YYYY-MM-DD ride date falls in.
function weekOf(dateStr) {
  const t = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// The city's public registry vehicles and their physical rides (the Cars page
// city rule), and the same over every city (the registry stats).
async function heroCounts(sql, area) {
  const rule = registryCitySql('v', area.key);
  const eligible = `FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}`;
  const counts = `SELECT COUNT(*) AS vehicles, COALESCE(SUM((SELECT COUNT(*) FROM ${physicalRidesFrom('v.id')})), 0) AS rides ${eligible}`;
  const [cityRow, all] = await sql.batch([sql.prepare(counts + rule.sql).bind(...rule.binds), sql.prepare(counts)]);
  const c = (cityRow.results || [])[0] || {}, a = (all.results || [])[0] || {};
  return {
    city: { vehicles: Number(c.vehicles) || 0, rides: Number(c.rides) || 0 },
    all: { vehicles: Number(a.vehicles) || 0, rides: Number(a.rides) || 0 }
  };
}

async function rideStats(sql, area, nowMs) {
  const city = area.name.toLowerCase();
  const [totals, fares] = await Promise.all([
    sql.prepare(`
      SELECT COUNT(*) AS rides, SUM(miles) AS miles, COUNT(miles) AS with_miles,
             AVG(minutes) AS minutes, COUNT(minutes) AS with_minutes
      FROM (SELECT MAX(${MILES_SQL}) AS miles, MAX(t.duration_minutes) AS minutes
            FROM ${CITY_RIDES_FROM}
            GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id))
    `).bind(city, city).first(),
    computeFareStats(sql, area.name, nowMs)
  ]);
  const since = new Date(nowMs - FARE_WEEKS * 7 * 864e5).toISOString().slice(0, 10);
  const { results } = await sql.prepare(`
    SELECT MIN(t.ride_date) AS ride_date, MAX(t.fare_amount_cents) AS fare_cents
    FROM ${CITY_RIDES_FROM}
      AND t.fare_amount_cents IS NOT NULL AND upper(COALESCE(t.currency, 'USD')) = 'USD' AND t.ride_date >= ?
    GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id)
  `).bind(city, city, since).all();
  const weeks = new Map();
  for (const r of results || []) {
    const w = weekOf(r.ride_date), fare = Number(r.fare_cents) / 100;
    if (!w || !Number.isFinite(fare)) continue;
    const b = weeks.get(w) || { sum: 0, n: 0 };
    b.sum += fare; b.n += 1; weeks.set(w, b);
  }
  const t = totals || {};
  const rides = Number(t.rides) || 0;
  const miles = num(t.miles);
  return {
    rides,
    miles: rides && miles != null ? round(miles, 1) : null,
    average_fare: fares.average_fare,
    per_mile: fares.per_mile,
    fare_rides: fares.rides,
    average_miles: Number(t.with_miles) ? round(miles / Number(t.with_miles), 1) : null,
    average_minutes: Number(t.with_minutes) ? round(Number(t.minutes), 1) : null,
    weekly_fares: [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([week, b]) => ({ week, average_fare: round(b.sum / b.n), rides: b.n }))
  };
}

async function sightingStats(sql, area) {
  const city = area.name.toLowerCase();
  const [total, last24, buckets, spots, latest] = await Promise.all([
    db.countPublicPhotoSightings(sql, { city }),
    db.countPublicPhotoSightings(sql, { city, sinceHours: 24 }),
    db.getApprovedPhotoSightingHourBuckets(sql, { city }),
    db.getPublicPhotoSightingSpots(sql, { city, limit: 20 }),
    db.getPublicPhotoSightings(sql, { city, limit: LATEST_SIGHTINGS })
  ]);
  const stats = buildSightingStats(buckets, area.timeZone);
  // Spots by their public label (house numbers dropped), so two stored forms
  // of one place count together.
  const byLabel = new Map();
  for (const s of spots) {
    const label = publicLocation(s.location);
    if (label) byLabel.set(label, (byLabel.get(label) || 0) + Number(s.n));
  }
  return {
    total: Number(total) || 0,
    last_24h: Number(last24) || 0,
    last_7_days: stats.last_7_days,
    peak_hour: stats.peak_hour,
    time_zone: stats.time_zone,
    top_spots: [...byLabel.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_SPOTS).map(([location, count]) => ({ location, count })),
    latest: latest.map(publicSightingJson)
  };
}

async function cameraStats(sql, area, nowMs) {
  const since = new Date(nowMs - 24 * 3600e3).toISOString().slice(0, 19) + 'Z';
  const [last, hours] = await sql.batch([
    sql.prepare(`SELECT MAX(observed_at) AS last FROM camera_detections WHERE city = ?`).bind(area.key),
    sql.prepare(`SELECT substr(observed_at, 1, 13) AS hour, COUNT(*) AS n FROM camera_detections WHERE city = ? AND observed_at >= ? GROUP BY hour`).bind(area.key, since)
  ]);
  const byHour = new Map((hours.results || []).map(r => [r.hour, Number(r.n)]));
  // The trailing 24 UTC hours, oldest first (the page labels them in local time).
  const start = Math.floor(nowMs / 3600e3) * 3600e3 - 23 * 3600e3;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const iso = new Date(start + i * 3600e3).toISOString();
    return { hour: `${iso.slice(0, 13)}:00:00Z`, count: byHour.get(iso.slice(0, 13)) || 0 };
  });
  const lastAt = ((last.results || [])[0] || {}).last || null;
  return {
    monitored: TRAFFIC_CAMERAS.filter(c => cameraCity(c) === area.key).length,
    detections_24h: hourly.reduce((n, h) => n + h.count, 0),
    last_detection_at: lastAt,
    hourly
  };
}

export async function apiHomepageStats(request, env, ctx) {
  const cityParam = (new URL(request.url).searchParams.get('city') || 'austin').toLowerCase();
  const area = FLEET_CITIES.includes(cityParam) ? serviceAreaFor(cityParam) : null;
  if (!area) return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const sql = env.cybercabhunter_db;
  const nowMs = Date.now();
  try {
    const [hero, rides, sightings, cameras, allSightings] = await Promise.all([
      heroCounts(sql, area), rideStats(sql, area, nowMs), sightingStats(sql, area), cameraStats(sql, area, nowMs),
      db.countPublicPhotoSightings(sql, {})
    ]);
    const z = area.zone || {};
    const response = Response.json({
      city: area.key,
      name: area.name,
      generated_at: new Date(nowMs).toISOString(),
      hero: {
        city: { ...hero.city, sightings: sightings.total },
        all: { ...hero.all, sightings: Number(allSightings) || 0 }
      },
      area: {
        square_miles: z.square_miles ?? null, in_service_since: z.in_service_since || null,
        hours: z.hours || null, description: z.description || null, vehicles: hero.city.vehicles
      },
      rides,
      sightings,
      cameras
    }, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    if (cache) {
      const stored = cache.put(cacheKey, response.clone()).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
    }
    return response;
  } catch (e) {
    return Response.json({ success: false, error: 'stats_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
