// Shared calendar/daily accounting. No private fields and no imported DMV estimates.
import { PUBLIC_PHOTO_SIGHTING_SQL } from './db.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { usLocalParts } from './timezones.js';

export function localDate(value) {
  const ms = typeof value === 'number' ? value : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return null;
  const p = usLocalParts(ms, 'America/Chicago');
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
const eligibleCybercab = alias => `${publicVehicleEligibleSql(alias)} AND (lower(trim(${alias}.model)) = 'cybercab' OR ${alias}.approval_basis IS NOT NULL) AND lower(trim(COALESCE(${alias}.model, ''))) NOT IN ('model y', 'model_y', 'modely')`;
// Registry rows may duplicate a plate before moderator merging. Count only
// the earliest publicly eligible row for a shared VIN or normalized plate.
const plateKey = alias => `upper(replace(replace(trim(COALESCE(${alias}.license_plate, '')), '-', ''), ' ', ''))`;
const vinKey = alias => `upper(trim(COALESCE(${alias}.vin, '')))`;
const vehicleWhere = `${eligibleCybercab('v')} AND NOT EXISTS (
  SELECT 1 FROM robotaxi_vehicles duplicate WHERE ${eligibleCybercab('duplicate')}
    AND (duplicate.created_at < v.created_at OR (duplicate.created_at = v.created_at AND duplicate.id < v.id))
    AND ((${vinKey('v')} <> '' AND ${vinKey('v')} = ${vinKey('duplicate')})
      OR (${plateKey('v')} <> '' AND ${plateKey('v')} = ${plateKey('duplicate')})))`;
const sightingFrom = `submissions s JOIN vehicle_observations o ON o.submission_id = s.id
 LEFT JOIN robotaxi_vehicles pv ON pv.id = o.robotaxi_vehicle_id AND ${publicVehicleEligibleSql('pv')}`;
const sightingWhere = `${PUBLIC_PHOTO_SIGHTING_SQL} AND (o.robotaxi_vehicle_id IS NULL OR pv.id IS NOT NULL)`;
const sources = {
  registry: { from: 'robotaxi_vehicles v', where: vehicleWhere, time: 'v.created_at' },
  sightings: { from: sightingFrom, where: sightingWhere, time: 'o.observed_at' },
  cameras: { from: 'camera_detections', where: '1=1', time: 'observed_at' }
};
function utcBounds(date) {
  // Central midnight is 05:00 or 06:00 UTC; settle offset using the existing DST helper.
  const midnight = Date.parse(date + 'T00:00:00Z');
  const guess = midnight + 6 * 3600e3;
  return new Date(midnight - usLocalParts(guess, 'America/Chicago').offset * 3600e3).toISOString();
}
function nextDate(date) { return new Date(Date.parse(date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10); }
export async function buildActivity(sql, year, now = Date.now()) {
  const today = localDate(now), days = [], coverage = {}, errors = {};
  for (let d = `${year}-01-01`; d <= `${year}-12-31`; d = nextDate(d)) {
    days.push({ date: d, registry: null, sightings: null, cameras: null, dmv: null, cybercab: null, model_y: null });
  }
  const byDate = new Map(days.map(d => [d.date, d]));
  await Promise.all(Object.entries(sources).map(async ([key, s]) => {
    try {
      const first = await sql.prepare(`SELECT MIN(${s.time}) AS first FROM ${s.from} WHERE ${s.where}`).first();
      const rows = await sql.prepare(`SELECT strftime('%Y-%m-%dT%H:00:00Z', ${s.time}) AS hour, COUNT(*) AS n
        FROM ${s.from} WHERE ${s.where} AND ${s.time} >= ? AND ${s.time} < ? GROUP BY hour`)
        .bind(...[utcBounds(`${year}-01-01`), utcBounds(`${year + 1}-01-01`)].map(value => key === 'cameras' ? value : value.slice(0, 19).replace('T', ' '))).all();
      let start = first?.first ? localDate(first.first) : today;
      if (key === 'sightings') {
        // Retention prevents a complete historical count. The occurrence day just
        // inside the submission window may still contain expired records.
        const retention = nextDate(localDate(now - 30 * 864e5));
        if (start && start < retention) start = retention;
      }
      coverage[key] = start;
      for (const d of days) if (start && d.date >= start && d.date <= today) d[key] = 0;
      for (const r of rows.results || []) { const d = byDate.get(localDate(r.hour)); if (d && d[key] !== null) d[key] += Number(r.n); }
    } catch { errors[key] = 'Data temporarily unavailable'; coverage[key] = null; }
  }));
  try {
    const snapshots = (await sql.prepare('SELECT snapshot_date FROM dmv_snapshots ORDER BY snapshot_date').all()).results || [];
    coverage.dmv = snapshots[0]?.snapshot_date || null;
    // A baseline and missing/failed polls cannot establish zero new registrations.
    for (const s of snapshots.slice(1)) {
      const d = byDate.get(s.snapshot_date);
      if (d && d.date <= today) d.dmv = d.cybercab = d.model_y = 0;
    }
    const rows = (await sql.prepare(`SELECT first_seen_date AS date, lower(model) AS model, COUNT(*) AS n FROM dmv_av_vehicles
      WHERE in_baseline = 0 AND first_seen_date >= ? AND first_seen_date < ? AND lower(model) IN ('cybercab', 'model y') GROUP BY date, lower(model)`)
      .bind(`${year}-01-01`, `${year + 1}-01-01`).all()).results || [];
    for (const r of rows) { const d = byDate.get(r.date); if (d && d.dmv !== null) { d.dmv += Number(r.n); d[r.model === 'cybercab' ? 'cybercab' : 'model_y'] += Number(r.n); } }
  } catch { coverage.dmv = null; errors.dmv = 'DMV data temporarily unavailable'; }
  const starts = Object.values(coverage).filter(Boolean);
  const firstYear = starts.length ? Number(starts.sort()[0].slice(0, 4)) : Number(today.slice(0, 4));
  return { today, year, timezone: 'America/Chicago', generated_at: new Date(now).toISOString(), coverage, errors,
    years: Array.from({ length: Math.max(1, Number(today.slice(0, 4)) - firstYear + 1) }, (_, i) => Number(today.slice(0, 4)) - i), days };
}
async function details(sql, date) {
  const start = utcBounds(date), end = utcBounds(nextDate(date));
  const sqlBounds = [start, end].map(value => value.slice(0, 19).replace('T', ' '));
  const result = {};
  const queries = {
    vehicles: [`SELECT v.id, v.license_plate FROM robotaxi_vehicles v WHERE ${vehicleWhere} AND v.created_at >= ? AND v.created_at < ? ORDER BY v.created_at DESC LIMIT 20`, sqlBounds],
    sightings: [`SELECT o.public_id, o.observed_at FROM ${sightingFrom} WHERE ${sightingWhere} AND o.observed_at >= ? AND o.observed_at < ? ORDER BY o.observed_at DESC LIMIT 5`, sqlBounds],
    cameras: ['SELECT camera_name, COUNT(*) AS count FROM camera_detections WHERE observed_at >= ? AND observed_at < ? GROUP BY camera_id, camera_name ORDER BY count DESC', [start, end]]
  };
  await Promise.all(Object.entries(queries).map(async ([key, [query, binds]]) => {
    try { result[key] = (await sql.prepare(query).bind(...binds).all()).results || []; } catch { result[key] = null; }
  }));
  return result;
}
export async function apiActivity(request, env, ctx) {
  const url = new URL(request.url), today = localDate(Date.now());
  const date = url.searchParams.get('date');
  const year = Number(url.searchParams.get('year') || (date ? date.slice(0, 4) : today.slice(0, 4)));
  if (!Number.isInteger(year) || year < 2007 || year > Number(today.slice(0, 4)) || (date && (!/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > today || !date.startsWith(String(year))))) {
    return Response.json({ error: 'Invalid activity period' }, { status: 400 });
  }
  const cache = globalThis.caches?.default, key = new Request(url.toString());
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  try {
    const data = await buildActivity(env.cybercabhunter_db, year);
    if (date) { data.day = data.days.find(d => d.date === date); data.details = await details(env.cybercabhunter_db, date); delete data.days; }
    const failed = Object.keys(data.errors).length > 0;
    const response = Response.json(data, { headers: { 'Cache-Control': failed ? 'no-store' : 'public, max-age=60' } });
    if (cache && !failed) { const save = cache.put(key, response.clone()); if (ctx?.waitUntil) ctx.waitUntil(save); else await save; }
    return response;
  } catch { return Response.json({ error: 'Activity unavailable' }, { status: 503 }); }
}
