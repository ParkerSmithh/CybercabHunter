import { SERVICE_AREAS } from './service-areas.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { clock, shiftDate } from './push-policy.js';

const MINIMUM = 10;
const LIMIT = 2000;
const RANGES = { '30d': 30, '90d': 90, '1y': 365, all: Infinity };
const vehicle = value => {
  const model = String(value ?? '').toLowerCase().replace(/[ _-]/g, '');
  return model === 'cybercab' ? 'cybercab' : model === 'modely' ? 'model_y' : 'unknown';
};

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return Math.round((sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low)) * 100) / 100;
}

export function fareDistribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length < MINIMUM ? { n: sorted.length, median: null, p25: null, p75: null } :
    { n: sorted.length, median: percentile(sorted, .5), p25: percentile(sorted, .25), p75: percentile(sorted, .75) };
}

const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
const weekOf = day => shiftDate(day, -((weekday(day) + 6) % 7));
const aggregate = rows => ({
  fare: fareDistribution(rows.map(r => r.fare)),
  per_mile: fareDistribution(rows.filter(r => r.miles > 0).map(r => r.fare / r.miles))
});

export function buildFareSnapshot(rows, today) {
  const filters = {};
  for (const [range, days] of Object.entries(RANGES)) {
    const from = Number.isFinite(days) ? shiftDate(today, 1 - days) : null;
    const subset = rows.filter(r => r.day <= today && (!from || r.day >= from));
    filters[range] = {};
    for (const type of ['all', 'cybercab', 'model_y']) {
      const observations = type === 'all' ? subset : subset.filter(r => r.type === type);
      const weeks = new Map();
      const slots = Array.from({ length: 28 }, () => []);
      for (const row of observations) {
        const week = weekOf(row.day);
        if (!weeks.has(week)) weeks.set(week, []);
        weeks.get(week).push(row);
        if (row.hour !== null) slots[weekday(row.day) * 4 + Math.floor(row.hour / 6)].push(row.fare);
      }
      const points = [];
      if (weeks.size) {
        const first = from ? weekOf(from) : [...weeks.keys()].sort()[0];
        for (let week = first; week <= weekOf(today); week = shiftDate(week, 7)) {
          points.push({ week, ...aggregate(weeks.get(week) || []) });
        }
      }
      filters[range][type] = { ...aggregate(observations), weeks: points, times: slots.map(fareDistribution) };
    }
  }
  return filters;
}

export async function recomputeFareHistory(env, now = Date.now()) {
  const db = env.cybercabhunter_db;
  const [receipts, reports] = await db.batch([
    db.prepare(`SELECT COALESCE(NULLIF(t.ride_key,''), NULLIF(t.ride_identifier,''), t.id) AS ride,
        t.service_area AS city, t.ride_date AS day, t.started_at_utc AS started_at, t.pickup_time AS pickup_time,
        t.distance AS miles, t.distance_unit AS unit, t.fare_amount_cents AS cents, t.currency, v.model
      FROM trips t JOIN submissions s ON s.id = t.submission_id
      LEFT JOIN robotaxi_vehicles v ON v.id = t.robotaxi_vehicle_id
      WHERE t.superseded_by IS NULL AND t.fare_amount_cents IS NOT NULL
        AND s.status = 'approved'
        AND t.source IN ('receipt_email', 'receipt_import', 'gmail_api', 'tesla_api')
        AND (t.robotaxi_vehicle_id IS NULL OR (${publicVehicleEligibleSql('v')}))
      ORDER BY t.ride_date DESC, t.id LIMIT ${LIMIT + 1}`),
    db.prepare(`SELECT city, vehicle_type AS model, observed_hour_utc AS started_at,
        distance_miles AS miles, 'mi' AS unit, quoted_fare_cents AS cents, 'USD' AS currency
      FROM fare_reports WHERE status = 'approved' AND kind = 'completed'
        AND quoted_fare_cents IS NOT NULL AND no_cars_available = 0
      ORDER BY observed_hour_utc DESC, id LIMIT ${LIMIT + 1}`)
  ]);
  if (receipts.results.length > LIMIT || reports.results.length > LIMIT) throw Error('Fare history sample capacity exceeded');
  const exclusions = {};
  const excluded = reason => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
  const seen = new Set();
  const rows = [];
  for (const raw of [...receipts.results, ...reports.results]) {
    const area = SERVICE_AREAS.find(a => a.key === String(raw.city ?? '').trim().toLowerCase());
    if (!area) { excluded('unassigned_city'); continue; }
    const value = raw.cents / 100;
    const miles = raw.miles === null ? null : raw.unit === 'km' ? raw.miles / 1.609344 : raw.miles;
    if (raw.currency !== 'USD' || !Number.isInteger(raw.cents) || value < 0 || value > 500 ||
        (miles !== null && (!['mi', 'km'].includes(raw.unit) || !Number.isFinite(miles) || miles < 0 || miles > 250 ||
          (miles === 0 && value > 0) || (miles > 0 && value / miles > 100)))) {
      excluded('invalid_price_distance_or_currency');
      continue;
    }
    const startedAt = Date.parse(raw.started_at ?? '');
    const local = Number.isFinite(startedAt) ? clock(startedAt, area.timeZone) : null;
    const day = local?.date || raw.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || day < '2025-06-01' ||
        day > clock(now, area.timeZone).date || day !== new Date(day + 'T00:00:00Z').toJSON()?.slice(0, 10)) {
      excluded('invalid_date');
      continue;
    }
    const key = raw.ride ? JSON.stringify([area.key, raw.ride]) : null;
    if (key && seen.has(key)) { excluded('duplicate_receipt'); continue; }
    if (key) seen.add(key);
    const pickup = /^([01]?\d|2[0-3]):[0-5]\d/.exec(raw.pickup_time ?? '');
    rows.push({ city: area.key, type: vehicle(raw.model), day, hour: local ? Math.floor(local.minute / 60) : pickup ? Number(pickup[1]) : null,
      fare: value, miles });
  }
  if (Object.keys(exclusions).length) console.info('Fare history exclusions', exclusions);
  const timestamp = new Date(now).toISOString();
  const writes = ['all', ...SERVICE_AREAS.map(area => area.key)].map(city => {
    const today = clock(now, SERVICE_AREAS.find(area => area.key === city)?.timeZone || SERVICE_AREAS[0].timeZone).date;
    const payload = buildFareSnapshot(rows.filter(row => city === 'all' || row.city === city), today);
    return db.prepare(`INSERT INTO fare_history_summary (city, computed_at, payload) VALUES (?, ?, ?)
      ON CONFLICT(city) DO UPDATE SET computed_at = excluded.computed_at, payload = excluded.payload
      WHERE excluded.computed_at >= fare_history_summary.computed_at`).bind(city, timestamp, JSON.stringify(payload));
  });
  const results = await db.batch(writes);
  return [receipts, reports, ...results].reduce((total, result) => total + (result.meta.rows_read ?? 0), 0);
}

export async function apiFareHistory(request, env, ctx) {
  const url = new URL(request.url);
  const city = url.searchParams.get('city') || 'all';
  if (city !== 'all' && !SERVICE_AREAS.some(a => a.key === city)) return Response.json({ error: 'invalid_city' }, { status: 400 });
  const calibration = url.pathname.endsWith('/summary');
  const key = new Request(new URL(url.pathname + '?city=' + city, url));
  const cache = globalThis.caches?.default;
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const row = await env.cybercabhunter_db.prepare('SELECT computed_at, payload FROM fare_history_summary WHERE city = ?').bind(city).first();
  if (!row) return Response.json({ error: 'awaiting_daily_snapshot' }, { status: 503 });
  const ranges = JSON.parse(row.payload);
  const body = { city, updated_at: row.computed_at, minimum: MINIMUM, currency: 'USD' };
  if (calibration) {
    const { fare, per_mile } = ranges['90d'].all;
    body.summary = { range: '90d', fare, per_mile };
  } else body.ranges = ranges;
  const response = Response.json(body, { headers: { 'Cache-Control': 'public, max-age=3600' } });
  if (cache && ctx) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
  return response;
}
