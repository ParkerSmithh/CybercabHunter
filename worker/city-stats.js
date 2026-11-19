import { DEFAULT_CITY, SERVICE_AREAS } from './service-areas.js';
import { PUBLIC_PHOTO_SIGHTING_SQL, registryCitySql } from './db.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { computeHomepageStats } from './homepage-stats.js';
import { computeFleetSnapshot } from './fleet-stats.js';
import { clock, scheduledInstant, shiftDate } from './push-policy.js';

const cybercab = `${publicVehicleEligibleSql('v')} AND
  (lower(trim(v.model)) = 'cybercab' OR v.approval_basis IS NOT NULL)
  AND lower(trim(coalesce(v.model, ''))) NOT IN ('model y', 'model_y', 'modely')`;
const cityOfSighting = "(lower(trim(o.service_area)) = ? OR lower(trim(o.service_area)) LIKE ? || ',%')";
const sqlDate = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// One completed calendar day in the city's timezone. Prefer the original
// public approval over creation for moderated vehicles, including backfills.
export async function computeCityEventDelta(db, area, now) {
  const today = clock(now, area.timeZone).date;
  const day = shiftDate(today, -1);
  const start = sqlDate(scheduledInstant(day, 0, area.timeZone));
  const end = sqlDate(scheduledInstant(today, 0, area.timeZone));
  const registry = registryCitySql('v', area.key);
  const [vehicles, sightings] = await db.batch([
    db.prepare(`WITH candidates AS (
      SELECT id FROM robotaxi_vehicles WHERE created_at >= ? AND created_at < ?
      UNION
      SELECT robotaxi_vehicle_id FROM robotaxi_vehicle_reviews
        WHERE action = 'approved_public' AND created_at >= ? AND created_at < ?
    )
    SELECT COUNT(*) AS n FROM candidates c JOIN robotaxi_vehicles v ON v.id = c.id
      WHERE ${cybercab}${registry.sql}
      AND COALESCE((SELECT MIN(r.created_at) FROM robotaxi_vehicle_reviews r
        WHERE r.robotaxi_vehicle_id = v.id AND r.action = 'approved_public'), v.created_at) >= ?
      AND COALESCE((SELECT MIN(r.created_at) FROM robotaxi_vehicle_reviews r
        WHERE r.robotaxi_vehicle_id = v.id AND r.action = 'approved_public'), v.created_at) < ?`)
      .bind(start, end, start, end, ...registry.binds, start, end),
    db.prepare(`SELECT COUNT(*) AS n FROM submissions s
      CROSS JOIN vehicle_observations o ON o.submission_id = s.id
      WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} AND s.evidence_ref IS NOT NULL
      AND s.reviewed_at >= ? AND s.reviewed_at < ? AND ${cityOfSighting}`)
      .bind(start, end, area.key, area.key)
  ]);
  return { city: area.key, day, registry_additions: vehicles.results[0].n,
    approved_sightings: sightings.results[0].n, rows_read: (vehicles.meta.rows_read ?? 0) + (sightings.meta.rows_read ?? 0) };
}

export async function recomputeCityStats(env, now = Date.now()) {
  const db = env.cybercabhunter_db;
  const computedAt = new Date(now).toISOString();
  for (const area of SERVICE_AREAS) {
    const registry = registryCitySql('v', area.key);
    const [homepage, fleet, delta, prior, launch, firstSighting] = await Promise.all([
      computeHomepageStats(db, area, now),
      computeFleetSnapshot(db, area, now),
      computeCityEventDelta(db, area, now),
      db.prepare('SELECT cybercab_since FROM city_daily_summary WHERE city = ?').bind(area.key).first(),
      area.cybercabSince ? null : db.prepare(`SELECT MIN(first_seen_at) AS first FROM robotaxi_vehicles v
        WHERE ${cybercab}${registry.sql}`).bind(...registry.binds).first(),
      area.cybercabSince ? null : db.prepare(`SELECT MIN(o.observed_at) AS first
        FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
        LEFT JOIN robotaxi_vehicles v ON v.id = o.robotaxi_vehicle_id
        WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} AND ${cityOfSighting}
          AND (o.robotaxi_vehicle_id IS NULL OR (${cybercab}))`).bind(area.key, area.key).first()
    ]);
    const cybercabSince = area.cybercabSince || [prior?.cybercab_since, launch?.first?.slice(0, 10), firstSighting?.first?.slice(0, 10)].filter(Boolean).sort()[0] || null;
    await db.batch([
      db.prepare(`INSERT INTO city_daily_summary VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(city) DO UPDATE SET computed_at = excluded.computed_at, registry = excluded.registry,
          homepage_payload = excluded.homepage_payload, fleet_payload = excluded.fleet_payload,
          cybercab_since = excluded.cybercab_since WHERE city_daily_summary.computed_at <= excluded.computed_at`)
        .bind(area.key, computedAt, homepage.hero.city.vehicles, JSON.stringify(homepage), JSON.stringify(fleet), cybercabSince),
      db.prepare(`INSERT INTO city_event_deltas VALUES (?, ?, ?, ?)
        ON CONFLICT(city, day) DO UPDATE SET registry_additions = excluded.registry_additions,
          approved_sightings = excluded.approved_sightings`)
        .bind(area.key, delta.day, delta.registry_additions, delta.approved_sightings)
    ]);
  }
}

export async function apiCities(request, env, ctx) {
  const key = new Request(new URL('/api/cities', request.url));
  const cache = globalThis.caches?.default;
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const result = await env.cybercabhunter_db.prepare('SELECT city, computed_at, registry, cybercab_since FROM city_daily_summary').all();
  const stats = new Map(result.results.map(row => [row.city, row]));
  const response = Response.json({ default_city: DEFAULT_CITY, cities: SERVICE_AREAS.map(area => ({ ...area, stats: stats.get(area.key) || null })) },
    { headers: { 'Cache-Control': 'public, max-age=3600' } });
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}
