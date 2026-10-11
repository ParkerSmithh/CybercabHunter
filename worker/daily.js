// Cybercab Daily only: two days of public counts, no annual history or
// correlated VIN/plate comparisons. All source tables belong to other features.
import { PUBLIC_PHOTO_SIGHTING_SQL } from './db.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { usLocalParts } from './timezones.js';

export function localDate(value) {
  const ms = typeof value === 'number' ? value : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return null;
  const p = usLocalParts(ms, 'America/Chicago');
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
const shiftDate = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 864e5).toISOString().slice(0, 10);
function midnight(date) {
  const ms = Date.parse(date + 'T00:00:00Z');
  return new Date(ms - usLocalParts(ms + 6 * 3600e3, 'America/Chicago').offset * 3600e3).toISOString();
}
const emptyDay = date => ({ date, registry: null, dmv: null, sightings: null, cameras: null, cybercab: null, model_y: null });
const eligibleCybercab = `${publicVehicleEligibleSql('v')} AND (lower(trim(v.model)) = 'cybercab' OR v.approval_basis IS NOT NULL) AND lower(trim(COALESCE(v.model, ''))) NOT IN ('model y', 'model_y', 'modely')`;

export async function buildDaily(sql, now = Date.now()) {
  const today = localDate(now), previous = shiftDate(today, -1);
  const days = [emptyDay(previous), emptyDay(today)], errors = {};
  const bounds = [midnight(previous), midnight(today), midnight(shiftDate(today, 1))];
  const sqlBounds = bounds.map(value => value.slice(0, 19).replace('T', ' '));
  await Promise.all([
    (async () => {
      // Read each eligible registry row once. Preserve Daily's earliest-entry
      // accounting with linear sets instead of one database scan per vehicle.
      const { results } = await sql.prepare(`SELECT v.id, v.license_plate, v.vin, v.created_at FROM robotaxi_vehicles v WHERE ${eligibleCybercab}`).all();
      const rows = (results || []).sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const vins = new Set(), plates = new Set(), counts = new Map();
      let first = null;
      for (const row of rows) {
        if (!row.created_at) continue;
        // SQLite trim() strips ASCII spaces only, not arbitrary whitespace.
        const trim = value => String(value || '').replace(/^ +| +$/g, '');
        const upper = value => value.replace(/[a-z]/g, c => c.toUpperCase());
        const vin = upper(trim(row.vin));
        const plate = upper(trim(row.license_plate).replace(/[- ]/g, ''));
        const duplicate = (vin && vins.has(vin)) || (plate && plates.has(plate));
        // An excluded row can still be an earlier match for a later row.
        if (vin) vins.add(vin); if (plate) plates.add(plate);
        if (duplicate) continue;
        const date = localDate(row.created_at);
        if (date && (!first || date < first)) first = date;
        if (date) counts.set(date, (counts.get(date) || 0) + 1);
      }
      for (const day of days) if (day.date >= (first || today)) day.registry = counts.get(day.date) || 0;
    })().catch(() => { errors.registry = 'Data temporarily unavailable'; }),
    (async () => {
      const row = await sql.prepare(`SELECT MIN(o.observed_at) AS first,
        COALESCE(SUM(o.observed_at >= ? AND o.observed_at < ?), 0) AS previous,
        COALESCE(SUM(o.observed_at >= ? AND o.observed_at < ?), 0) AS today
        FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id
        LEFT JOIN robotaxi_vehicles pv ON pv.id = o.robotaxi_vehicle_id AND ${publicVehicleEligibleSql('pv')}
        WHERE ${PUBLIC_PHOTO_SIGHTING_SQL} AND (o.robotaxi_vehicle_id IS NULL OR pv.id IS NOT NULL)`)
        .bind(sqlBounds[0], sqlBounds[1], sqlBounds[1], sqlBounds[2]).first();
      const first = row?.first ? localDate(row.first) : today;
      for (let i = 0; i < days.length; i++) if (days[i].date >= first) days[i].sightings = Number(row?.[i ? 'today' : 'previous'] || 0);
    })().catch(() => { errors.sightings = 'Data temporarily unavailable'; }),
    (async () => {
      const first = await sql.prepare('SELECT MIN(observed_at) AS first FROM camera_detections').first();
      const { results } = await sql.prepare(`SELECT observed_at FROM camera_detections WHERE observed_at >= ? AND observed_at < ?`).bind(bounds[0], bounds[2]).all();
      for (const day of days) if (day.date >= (first?.first ? localDate(first.first) : today)) day.cameras = 0;
      for (const row of results || []) { const day = days.find(day => day.date === localDate(row.observed_at)); if (day && day.cameras !== null) day.cameras++; }
    })().catch(() => { errors.cameras = 'Data temporarily unavailable'; }),
    (async () => {
      const { results: snapshots } = await sql.prepare(`SELECT snapshot_date FROM dmv_snapshots
        WHERE snapshot_date >= ? AND snapshot_date <= ? AND snapshot_date > (SELECT MIN(snapshot_date) FROM dmv_snapshots)`)
        .bind(previous, today).all();
      for (const row of snapshots || []) { const day = days.find(day => day.date === row.snapshot_date); if (day) day.dmv = day.cybercab = day.model_y = 0; }
      // Migration 0036 excludes baseline roster rows from this index, so
      // today's empty additions do not scan the entire baseline roster.
      const { results } = await sql.prepare(`SELECT first_seen_date AS date, lower(model) AS model, COUNT(*) AS n FROM dmv_av_vehicles
        WHERE first_seen_date >= ? AND first_seen_date <= ? AND in_baseline = 0 AND lower(model) IN ('cybercab', 'model y') GROUP BY first_seen_date, lower(model)`)
        .bind(previous, today).all();
      for (const row of results || []) { const day = days.find(day => day.date === row.date); if (day && day.dmv !== null) { day.dmv += Number(row.n); day[row.model === 'cybercab' ? 'cybercab' : 'model_y'] += Number(row.n); } }
    })().catch(() => { errors.dmv = 'DMV data temporarily unavailable'; for (const day of days) day.dmv = day.cybercab = day.model_y = null; })
  ]);
  return { today, timezone: 'America/Chicago', generated_at: new Date(now).toISOString(), errors, day: days[1], previous: days[0] };
}

export async function apiDaily(request, env, ctx) {
  // Historical/year parameters cannot trigger larger queries or split caches.
  const url = new URL('/api/daily', request.url);
  url.searchParams.set('day', localDate(Date.now()));
  const key = new Request(url), cache = globalThis.caches?.default;
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const data = await buildDaily(env.cybercabhunter_db);
  const failed = Object.keys(data.errors).length > 0;
  const response = Response.json(data, { headers: { 'Cache-Control': failed ? 'no-store' : 'public, max-age=300' } });
  if (cache && !failed) { const save = cache.put(key, response.clone()).catch(() => {}); if (ctx?.waitUntil) ctx.waitUntil(save); else await save; }
  return response;
}
