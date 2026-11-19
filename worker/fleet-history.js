import { SERVICE_AREAS } from './service-areas.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { localDate } from './daily.js';
import { shiftDate } from './push-policy.js';

const MAX_INPUT = 5000;
const MIN_DATE = '2025-01-01';
const SCOPES = ['all', ...SERVICE_AREAS.map(area => area.key)];
const METRICS = ['registry_count', 'cumulative_sightings', 'sightings_that_day', 'detections_that_day', 'dmv_cybercabs'];
const cityKey = value => String(value || '').split(',')[0].trim().toLowerCase();
const dayOf = time => time ? localDate(time) : null;
const increment = (map, day) => map.set(day, (map.get(day) || 0) + 1);
const firstDay = map => [...map.keys()].sort()[0] ?? null;

export function buildFleetHistory({ registry, sightings, detections, dmv, headline }, through) {
  const fromDate = time => {
    const day = dayOf(time);
    return day && day >= MIN_DATE && day <= through ? day : null;
  };
  const isCybercab = model => String(model || '').trim().toLowerCase() === 'cybercab';
  const result = {};
  for (const scope of SCOPES) {
    const withinScope = row => scope === 'all' || cityKey(row.city) === scope;
    const fleet = new Map(), observed = new Map(), cameras = new Map(), roster = new Map();
    const approvedByDay = new Map();
    let firstDallas = null;
    const markDallas = day => { if (firstDallas === null || day < firstDallas) firstDallas = day; };
    for (const row of registry.filter(withinScope)) {
      const day = fromDate(row.approved_at);
      if (!day) continue;
      increment(fleet, day);
      if (cityKey(row.city) === 'dallas' && isCybercab(row.model)) markDallas(day);
    }
    for (const row of sightings.filter(withinScope)) {
      const day = fromDate(row.reviewed_at);
      if (!day) continue;
      increment(approvedByDay, day);
      if (row.evidence_type === 'photo') increment(observed, day);
      if (cityKey(row.city) === 'dallas' && isCybercab(row.model)) markDallas(day);
    }
    for (const row of detections.filter(withinScope)) {
      const day = fromDate(row.observed_at);
      if (day) increment(cameras, day);
    }
    if (scope === 'all') for (const row of dmv) {
      if (row.snapshot_date >= MIN_DATE && row.snapshot_date <= through) roster.set(row.snapshot_date, row.cybercab_count);
    }
    const starts = [firstDay(fleet), firstDay(observed), firstDay(cameras), firstDay(roster)];
    const start = starts.filter(Boolean).sort()[0];
    const milestones = [];
    if (scope !== 'dallas' && through >= '2026-09-03') milestones.push({ day: '2026-09-03', label: 'Austin Cybercab public service began' });
    if (scope === 'all') {
      let count = 0;
      for (const day of [...approvedByDay.keys()].sort()) {
        count += approvedByDay.get(day);
        if (count < 1000) continue;
        milestones.push({ day, label: '1,000th dated approved sighting' });
        break;
      }
    }
    if (firstDallas) milestones.push({ day: firstDallas, label: 'First dated Dallas Cybercab registry entry or approved sighting' });
    const rows = [];
    let fleetCount = 0, cumulative = 0;
    for (let day = start; day && day <= through; day = shiftDate(day, 1)) {
      const count = observed.get(day) || 0;
      cumulative += count;
      fleetCount += fleet.get(day) || 0;
      const on = i => starts[i] && day >= starts[i];
      rows.push([day, on(0) ? fleetCount : null, on(1) ? cumulative : null, on(1) ? count : null,
        on(2) ? cameras.get(day) || 0 : null, roster.get(day) ?? null]);
    }
    result[scope] = { through, rows, milestones, starts, headline_sightings: scope === 'all' ? headline : null };
  }
  return result;
}

export async function recomputeFleetHistory(env, now = Date.now()) {
  const db = env.cybercabhunter_db;
  const queries = await db.batch([
    db.prepare(`SELECT v.service_area AS city, v.model,
        COALESCE(v.approval_basis_set_at, (SELECT MAX(r.created_at) FROM robotaxi_vehicle_reviews r
          WHERE r.robotaxi_vehicle_id = v.id AND r.action = 'approved_public')) AS approved_at
      FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')} LIMIT ${MAX_INPUT + 1}`),
    db.prepare(`SELECT s.reviewed_at, s.evidence_type, o.service_area AS city, v.model
      FROM submissions s
      JOIN site_stat_events e ON e.counter_key = 'sightings_all_time' AND e.event_key = 'submission:' || s.id
      LEFT JOIN vehicle_observations o ON o.id = (
        SELECT first.id FROM vehicle_observations first WHERE first.submission_id = s.id ORDER BY first.id LIMIT 1)
      LEFT JOIN robotaxi_vehicles v ON v.id = o.robotaxi_vehicle_id
      WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved'
      LIMIT ${MAX_INPUT + 1}`),
    db.prepare(`SELECT city, observed_at FROM camera_detections LIMIT ${MAX_INPUT + 1}`),
    db.prepare(`SELECT snapshot_date, cybercab_count FROM dmv_snapshots LIMIT ${MAX_INPUT + 1}`),
    db.prepare("SELECT value FROM site_stat_counters WHERE key = 'sightings_all_time'"),
    db.prepare('SELECT city, payload FROM fleet_history_series')
  ]);
  if (queries.some(query => query.results.length > MAX_INPUT)) throw Error('Fleet History source capacity exceeded');
  const [registry, sightings, detections, dmv, headline, prior] = queries.map(query => query.results);
  const previous = new Map(prior.map(row => [row.city, JSON.parse(row.payload)]));
  const through = shiftDate(localDate(now), -1);
  const series = buildFleetHistory({ registry, sightings, detections, dmv, headline: headline[0]?.value ?? null }, through);
  const computed = new Date(now).toISOString();
  const writes = [];
  for (const [city, payload] of Object.entries(series)) {
    const priorRows = new Map((previous.get(city)?.rows || []).map(row => [row[0], JSON.stringify(row)]));
    const changed = payload.rows.filter(row => priorRows.get(row[0]) !== JSON.stringify(row));
    const dates = new Set(payload.rows.map(row => row[0]));
    const removed = [...priorRows.keys()].filter(day => !dates.has(day));
    if (removed.length) writes.push(db.prepare('DELETE FROM fleet_history_snapshots WHERE city = ? AND day IN (SELECT value FROM json_each(?))')
      .bind(city, JSON.stringify(removed)));
    if (changed.length) writes.push(db.prepare(`INSERT OR REPLACE INTO fleet_history_snapshots
      SELECT ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'),
        json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]') FROM json_each(?)`)
      .bind(city, JSON.stringify(changed)));
    writes.push(db.prepare(`INSERT INTO fleet_history_series VALUES (?, ?, ?)
      ON CONFLICT(city) DO UPDATE SET computed_at=excluded.computed_at, payload=excluded.payload`)
      .bind(city, computed, JSON.stringify(payload)));
  }
  const written = await db.batch(writes);
  return [...queries, ...written].reduce((sum, result) => sum + (result.meta.rows_read ?? 0), 0);
}

export async function apiFleetHistory(request, env, ctx) {
  const url = new URL(request.url);
  const city = url.searchParams.get('city') || 'all';
  if (!SCOPES.includes(city)) return Response.json({ error: 'invalid_city' }, { status: 400 });
  const key = new Request(new URL('/api/fleet-history?city=' + city, url));
  const cache = globalThis.caches?.default;
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const snapshot = await env.cybercabhunter_db.prepare('SELECT computed_at, payload FROM fleet_history_series WHERE city = ?').bind(city).first();
  if (!snapshot) return Response.json({ error: 'awaiting_daily_snapshot' }, { status: 503 });
  const response = Response.json({ city, metrics: METRICS, updated_at: snapshot.computed_at, ...JSON.parse(snapshot.payload) },
    { headers: { 'Cache-Control': 'public, max-age=3600' } });
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}
