// The homepage's city rows and hero numbers, for one city, in one response.
//
//   GET /api/homepage-stats?city=austin|dallas   public, edge-cached 5 min
//   -> { city, name, generated_at,
//        hero:      { city: { vehicles, rides, sightings }, all: { vehicles, rides, sightings } },
//        area:      { square_miles, in_service_since, hours: { open, close }, description,
//                     vehicles, vehicles_added_7d, vehicles_added_prev_7d },
//        rides:     { rides, rides_30d, miles, average_fare, median_fare, per_mile, fare_rides,
//                     average_miles, longest_miles, average_minutes, minutes_rides,
//                     weekly_fares: [{ week, average_fare, rides }] }        (every week with fares)
//        sightings: { total, last_24h, prev_24h, last_7_days, prev_7_days, first_day, peak_hour, time_zone,
//                     hourly: [{ hour, count }] (24), daily: [{ date, count }] (90 days),
//                     top_spots: [{ location, count }], latest: [...] },
//        cameras:   { monitored, detections_24h, prev_24h, reporting_24h, last_detection_at, last_camera,
//                     hourly: [{ hour, count }] (24), daily: [{ date, count }] (every day with one) } }
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
import { usLocalParts } from './timezones.js';

const CACHE_SECONDS = 300;
const DAILY_DAYS = 90;            // sightings per day: the longest window the page offers
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
// Counts per UTC hour ({ hour: 'YYYY-MM-DDTHH', n }) -> counts per local date
// [{ date, count }], oldest first: the trailing `days` days with every day
// present (zeros included), or (days null) every day that has a count.
function localDaily(hours, zone, nowMs, days) {
  const pad = x => String(x).padStart(2, '0');
  const dateOf = ms => { const p = usLocalParts(ms, zone); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : new Date(ms).toISOString().slice(0, 10); };
  const byDate = new Map();
  for (const h of hours) {
    const ms = Date.parse(`${String(h.hour).slice(0, 13)}:00:00Z`);
    if (!Number.isNaN(ms) && h.n) byDate.set(dateOf(ms), (byDate.get(dateOf(ms)) || 0) + h.n);
  }
  if (!days) return [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count }));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dateOf(nowMs - i * 864e5);
    if (!out.length || out[out.length - 1].date !== date) out.push({ date, count: byDate.get(date) || 0 });
  }
  return out;
}

async function heroCounts(sql, area) {
  const rule = registryCitySql('v', area.key);
  const eligible = `FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}`;
  const counts = `SELECT COUNT(*) AS vehicles, COALESCE(SUM((SELECT COUNT(*) FROM ${physicalRidesFrom('v.id')})), 0) AS rides,
    COALESCE(SUM(v.created_at > datetime('now', '-7 days')), 0) AS added_7d,
    COALESCE(SUM(v.created_at > datetime('now', '-14 days') AND v.created_at <= datetime('now', '-7 days')), 0) AS added_prev_7d ${eligible}`;
  const [cityRow, all] = await sql.batch([sql.prepare(counts + rule.sql).bind(...rule.binds), sql.prepare(counts)]);
  const c = (cityRow.results || [])[0] || {}, a = (all.results || [])[0] || {};
  return {
    added_7d: Number(c.added_7d) || 0,
    added_prev_7d: Number(c.added_prev_7d) || 0,
    city: { vehicles: Number(c.vehicles) || 0, rides: Number(c.rides) || 0 },
    all: { vehicles: Number(a.vehicles) || 0, rides: Number(a.rides) || 0 }
  };
}

async function rideStats(sql, area, nowMs) {
  const city = area.name.toLowerCase();
  const [totals, fares] = await Promise.all([
    sql.prepare(`
      SELECT COUNT(*) AS rides, SUM(miles) AS miles, COUNT(miles) AS with_miles, MAX(miles) AS longest,
             AVG(minutes) AS minutes, COUNT(minutes) AS with_minutes, COALESCE(SUM(ride_date >= ?), 0) AS rides_30d
      FROM (SELECT MAX(${MILES_SQL}) AS miles, MAX(t.duration_minutes) AS minutes, MIN(t.ride_date) AS ride_date
            FROM ${CITY_RIDES_FROM}
            GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id))
    `).bind(new Date(nowMs - 30 * 864e5).toISOString().slice(0, 10), city, city).first(),
    computeFareStats(sql, area.name, nowMs)
  ]);
  // Every week with fares (the page's 90D / 6M / 1Y / All buttons pick the window).
  const { results } = await sql.prepare(`
    SELECT MIN(t.ride_date) AS ride_date, MAX(t.fare_amount_cents) AS fare_cents
    FROM ${CITY_RIDES_FROM}
      AND t.fare_amount_cents IS NOT NULL AND upper(COALESCE(t.currency, 'USD')) = 'USD'
    GROUP BY t.robotaxi_vehicle_id, COALESCE(t.ride_key, t.id)
  `).bind(city, city).all();
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
    rides_30d: rides ? Number(t.rides_30d) || 0 : null,
    average_fare: fares.average_fare,
    median_fare: fares.median_fare,
    per_mile: fares.per_mile,
    fare_rides: fares.rides,
    average_miles: Number(t.with_miles) ? round(miles / Number(t.with_miles), 1) : null,
    longest_miles: Number(t.with_miles) ? round(Number(t.longest), 1) : null,
    average_minutes: Number(t.with_minutes) ? round(Number(t.minutes), 1) : null,
    minutes_rides: Number(t.with_minutes) || 0,
    weekly_fares: [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([week, b]) => ({ week, average_fare: round(b.sum / b.n), rides: b.n }))
  };
}

async function sightingStats(sql, area) {
  const city = area.name.toLowerCase();
  const [total, last24, last48, last7d, last14d, buckets, spots, latest] = await Promise.all([
    db.countPublicPhotoSightings(sql, { city }),
    db.countPublicPhotoSightings(sql, { city, sinceHours: 24 }),
    db.countPublicPhotoSightings(sql, { city, sinceHours: 48 }),
    db.countPublicPhotoSightings(sql, { city, sinceHours: 168 }),
    db.countPublicPhotoSightings(sql, { city, sinceHours: 336 }),
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
  // Per hour (the trailing 24 UTC hours) and per local day (the trailing
  // DAILY_DAYS days), from the same hour buckets as the stats.
  const byHour = new Map(buckets.map(b => [String(b.utc_hour).replace(' ', 'T'), Number(b.n) || 0]));
  const nowMs = Date.now();
  const start = Math.floor(nowMs / 3600e3) * 3600e3 - 23 * 3600e3;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const h = new Date(start + i * 3600e3).toISOString().slice(0, 13);
    return { hour: `${h}:00:00Z`, count: byHour.get(h) || 0 };
  });
  const daily = localDaily(buckets.map(b => ({ hour: String(b.utc_hour).replace(' ', 'T'), n: Number(b.n) || 0 })), area.timeZone, nowMs, DAILY_DAYS);
  const n = v => Number(v) || 0;
  return {
    total: n(total),
    last_24h: n(last24),
    prev_24h: n(last48) - n(last24),
    last_7_days: n(last7d),
    prev_7_days: n(last14d) - n(last7d),
    first_day: stats.first_day,
    peak_hour: stats.peak_hour,
    time_zone: stats.time_zone,
    hourly,
    daily,
    top_spots: [...byLabel.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_SPOTS).map(([location, count]) => ({ location, count })),
    latest: latest.map(publicSightingJson)
  };
}

async function cameraStats(sql, area, nowMs) {
  const since = new Date(nowMs - 24 * 3600e3).toISOString().slice(0, 19) + 'Z';
  const since48 = new Date(nowMs - 48 * 3600e3).toISOString().slice(0, 19) + 'Z';
  const [last, hours, win, history] = await sql.batch([
    sql.prepare(`SELECT observed_at AS last, camera_name FROM camera_detections WHERE city = ? ORDER BY observed_at DESC LIMIT 1`).bind(area.key),
    sql.prepare(`SELECT substr(observed_at, 1, 13) AS hour, COUNT(*) AS n FROM camera_detections WHERE city = ? AND observed_at >= ? GROUP BY hour`).bind(area.key, since),
    sql.prepare(`SELECT COUNT(DISTINCT CASE WHEN observed_at >= ? THEN camera_id END) AS reporting,
                        COALESCE(SUM(observed_at < ?), 0) AS prev FROM camera_detections WHERE city = ? AND observed_at >= ?`).bind(since, since, area.key, since48),
    sql.prepare(`SELECT substr(observed_at, 1, 13) AS hour, COUNT(*) AS n FROM camera_detections WHERE city = ? GROUP BY hour`).bind(area.key)
  ]);
  const byHour = new Map((hours.results || []).map(r => [r.hour, Number(r.n)]));
  // The trailing 24 UTC hours, oldest first (the page labels them in local time).
  const start = Math.floor(nowMs / 3600e3) * 3600e3 - 23 * 3600e3;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const iso = new Date(start + i * 3600e3).toISOString();
    return { hour: `${iso.slice(0, 13)}:00:00Z`, count: byHour.get(iso.slice(0, 13)) || 0 };
  });
  const lastRow = (last.results || [])[0] || {};
  const w = (win.results || [])[0] || {};
  return {
    monitored: TRAFFIC_CAMERAS.filter(c => cameraCity(c) === area.key).length,
    detections_24h: hourly.reduce((n, h) => n + h.count, 0),
    prev_24h: Number(w.prev) || 0,
    reporting_24h: Number(w.reporting) || 0,
    last_detection_at: lastRow.last || null,
    last_camera: lastRow.camera_name || null,
    hourly,
    // Every day with a detection, by local date (the page's buttons pick the window).
    daily: localDaily((history.results || []).map(r => ({ hour: r.hour, n: Number(r.n) || 0 })), area.timeZone, nowMs, null)
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
        hours: z.hours || null, description: z.description || null, vehicles: hero.city.vehicles,
        vehicles_added_7d: hero.added_7d, vehicles_added_prev_7d: hero.added_prev_7d
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
