// Texas DMV automated-vehicle registrations (Tesla), polled once a day.
//
// SOURCE (verified Oct 2026, public, no key): TxDMV's TxMCCS "Truck Stop"
// lookup — the public side of the Texas Motor Carrier Credentialing System,
// where TxDMV lists each company's SB 2807 automated-vehicle authorization and
// the vehicles it covers (txmccs.txdmv.gov/automated-vehicles redirects there).
//   GET /api/TruckStop/companies?searchType=companyName&searchValue=Tesla%20Robotaxi
//     -> { results: [{ businessEntityId, companyName, autonomousVehicleAuthorizationNumber,
//                       autonomousVehicleStatus, ... }], total }
//   GET /api/TruckStop/companies/{businessEntityId}/automated-motor-vehicles
//       ?limit=100&offset=N&sortBy=vin&sortDirection=asc     (limit is 1..100)
//     -> { vehicles: [{ vin, make, model, modelYear }], total }
// The roster has exactly those four fields: no registration dates, no owners,
// nothing else. We store nothing more.
//
// DAILY PULL (TXDMV_CRON, early morning Central): find Tesla Robotaxi, LLC by
// its authorization number, read every page sorted by VIN, and only if the
// pages add up (unique VINs == the source's total) write ONE dmv_snapshots row
// for today's Central date plus the per-VIN first/last-seen rows. A day that
// already has a snapshot is left alone (never overwritten); a failed or
// incomplete pull writes nothing — the panel keeps showing the last good
// snapshot with its real poll time — and the attempt is noted in KV
// (txdmv:last_attempt) so the panel can say the latest check failed.
//
// MODEL SPLIT: TxDMV's own `model` field ("Cybercab" / "Model Y"). There is no
// VIN decoder in this codebase (moderation only checks a VIN's shape). The VIN
// is a cross-check and the fallback when `model` is blank: in the Oct 2026
// roster every Cybercab VIN starts 5YJA (WMI 5YJ, 4th character A) and every
// Model Y VIN starts 7SAY (WMI 7SA, 4th character Y). Anything else is "other".
//
// "Matched to tracked plates": roster VINs equal (exact, upper-case, trimmed)
// to the VIN of a publicly eligible vehicle in our own registry.

import { DMV_HISTORY, DMV_HISTORY_SOURCE } from './txdmv-history.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { usLocalParts } from './timezones.js';

export const TXDMV_CRON = '30 11 * * *';          // 6:30 AM CDT / 5:30 AM CST
const API = 'https://txmccs.txdmv.gov/api/TruckStop';
export const TESLA_AUTHORIZATION = 'AV8313426653583';
const COMPANY_SEARCH = 'Tesla Robotaxi';
const PAGE = 100;
const MAX_PAGES = 30;                            // 3,000 vehicles; raise if the fleet grows past it
const TIMEOUT_MS = 20000;
const STATUS_KEY = 'txdmv:last_attempt';
const CACHE_SECONDS = 300;
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const ZONE = 'America/Chicago';

const pad = n => String(n).padStart(2, '0');
export function centralDate(ms) {
  const p = usLocalParts(ms, ZONE);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// 'cybercab' | 'model_y' | 'other' — see MODEL SPLIT above.
export function classifyModel(model, vin) {
  const m = String(model || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (m === 'cybercab') return 'cybercab';
  if (m === 'model y') return 'model_y';
  if (!m) {
    const v = String(vin || '').toUpperCase();
    if (v.startsWith('5YJA')) return 'cybercab';
    if (v.startsWith('7SAY')) return 'model_y';
  }
  return 'other';
}

async function getJson(fetchImpl, url) {
  const resp = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CybercabHunter/1.0 (+https://cybercabhunter.com; daily TxDMV AV roster poll)' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error(`txdmv_http_${resp.status}`);
  return resp.json();
}

// The whole roster, or a thrown error — never a partial list.
export async function fetchRoster(fetchImpl = fetch) {
  const found = await getJson(fetchImpl, `${API}/companies?${new URLSearchParams({ searchType: 'companyName', searchValue: COMPANY_SEARCH, limit: '10', offset: '0' })}`);
  const company = ((found && found.results) || []).find(c => c && c.autonomousVehicleAuthorizationNumber === TESLA_AUTHORIZATION);
  if (!company || !company.businessEntityId) throw new Error('txdmv_company_not_found');
  const rows = [];
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await getJson(fetchImpl, `${API}/companies/${encodeURIComponent(company.businessEntityId)}/automated-motor-vehicles?${new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), sortBy: 'vin', sortDirection: 'asc' })}`);
    if (!body || !Array.isArray(body.vehicles) || !Number.isInteger(body.total)) throw new Error('txdmv_bad_page');
    if (total === null) total = body.total;
    if (body.total !== total) throw new Error('txdmv_total_changed_mid_poll');
    rows.push(...body.vehicles);
    if (body.vehicles.length < PAGE || rows.length >= total) break;
  }
  const byVin = new Map();
  for (const r of rows) {
    const vin = String((r && r.vin) || '').trim().toUpperCase();
    if (!VIN_RE.test(vin)) throw new Error('txdmv_bad_vin');
    byVin.set(vin, {
      vin,
      make: r.make == null ? null : String(r.make).trim(),
      model: r.model == null ? null : String(r.model).trim(),
      model_year: Number.isInteger(r.modelYear) ? r.modelYear : null
    });
  }
  if (byVin.size !== total) throw new Error(`txdmv_incomplete_${byVin.size}_of_${total}`);
  const vehicles = [...byVin.values()].sort((a, b) => (a.vin < b.vin ? -1 : 1));
  return { company: { id: company.businessEntityId, name: company.companyName, authorization: company.autonomousVehicleAuthorizationNumber, status: company.autonomousVehicleStatus }, total, vehicles };
}

async function noteAttempt(env, status) {
  try { await env.TESLA_SESSIONS.put(STATUS_KEY, JSON.stringify(status)); } catch (e) { /* the snapshot is what matters */ }
}

// The daily job. Returns { ok, snapshot_date, total, ... } or { ok: false, error }.
export async function runTxdmvPoll(env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const sql = env.cybercabhunter_db;
  const date = centralDate(nowMs);
  const at = new Date(nowMs).toISOString();
  try {
    if (await sql.prepare('SELECT 1 FROM dmv_snapshots WHERE snapshot_date = ?').bind(date).first()) {
      await noteAttempt(env, { at, ok: true, snapshot_date: date, skipped: 'already_polled_today' });
      return { ok: true, skipped: 'already_polled_today', snapshot_date: date };
    }
    const roster = await fetchRoster(fetchImpl);
    const counts = { cybercab: 0, model_y: 0, other: 0 };
    for (const v of roster.vehicles) counts[classifyModel(v.model, v.vin)] += 1;
    const first = !(await sql.prepare('SELECT 1 FROM dmv_snapshots LIMIT 1').first());
    const polledAt = new Date().toISOString();
    const raw = JSON.stringify(roster.vehicles);
    await sql.batch([
      sql.prepare(`INSERT OR IGNORE INTO dmv_snapshots (snapshot_date, total, cybercab_count, model_y_count, other_count, authorization_number, raw_json, polled_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(date, roster.total, counts.cybercab, counts.model_y, counts.other, roster.company.authorization, raw, polledAt),
      // One statement for the whole roster (D1's per-invocation query budget).
      sql.prepare(`INSERT INTO dmv_av_vehicles (vin, make, model, model_year, first_seen_date, last_seen_date, in_baseline)
                   SELECT json_extract(value, '$.vin'), json_extract(value, '$.make'), json_extract(value, '$.model'),
                          json_extract(value, '$.model_year'), ?, ?, ?
                   FROM json_each(?) WHERE 1
                   ON CONFLICT(vin) DO UPDATE SET make = excluded.make, model = excluded.model,
                     model_year = excluded.model_year, last_seen_date = excluded.last_seen_date`)
        .bind(date, date, first ? 1 : 0, raw)
    ]);
    const result = { ok: true, snapshot_date: date, total: roster.total, ...counts, polled_at: polledAt, baseline: first };
    await noteAttempt(env, { at, ok: true, snapshot_date: date });
    return result;
  } catch (e) {
    const error = String((e && e.message) || e).slice(0, 120);
    await noteAttempt(env, { at, ok: false, error });
    return { ok: false, error };
  }
}

const daysBefore = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

// GET /api/dmv-registrations — the panel. Reads only D1 snapshots (never TxDMV).
//   -> { source, snapshot: { date, polled_at, total, cybercab, model_y, other } | null,
//        tracking_since, series: [{ date, total, cybercab, model_y }],
//        new: { d30, d7, cybercab_30d, model_y_30d, window_start_30d, window_start_7d },
//        matched: { count, spotted_30d }, last_attempt: { at, ok } | null }
export async function apiDmvRegistrations(request, env, ctx) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const sql = env.cybercabhunter_db;
  let attempt = null;
  try { attempt = JSON.parse((await env.TESLA_SESSIONS.get(STATUS_KEY)) || 'null'); } catch (e) { attempt = null; }
  const source = { name: 'TxDMV Motor Carrier Credentialing System (TxMCCS)', company: 'Tesla Robotaxi, LLC', authorization: TESLA_AUTHORIZATION, law: 'SB 2807' };
  try {
    const { results: series } = await sql.prepare(`SELECT snapshot_date AS date, total, cybercab_count AS cybercab, model_y_count AS model_y, other_count AS other, polled_at FROM dmv_snapshots ORDER BY snapshot_date`).all();
    const latest = series && series.length ? series[series.length - 1] : null;
    let body = { source, snapshot: null, tracking_since: null, series: [], new: null, matched: null, last_attempt: attempt ? { at: attempt.at, ok: !!attempt.ok } : null };
    if (latest) {
      const d30 = daysBefore(latest.date, 30), d7 = daysBefore(latest.date, 7);
      const [fresh, matched] = await sql.batch([
        // New = first listed after the baseline snapshot, still listed today.
        sql.prepare(`SELECT
            COALESCE(SUM(first_seen_date > ?), 0) AS d30, COALESCE(SUM(first_seen_date > ?), 0) AS d7,
            COALESCE(SUM(first_seen_date > ? AND lower(model) = 'cybercab'), 0) AS cybercab_30d,
            COALESCE(SUM(first_seen_date > ? AND lower(model) = 'model y'), 0) AS model_y_30d
          FROM dmv_av_vehicles WHERE in_baseline = 0 AND last_seen_date = ?`).bind(d30, d7, d30, d30, latest.date),
        sql.prepare(`SELECT COUNT(*) AS n,
            COALESCE(SUM(EXISTS (SELECT 1 FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
              WHERE o.robotaxi_vehicle_id = v.id AND s.submission_type = 'vehicle_sighting' AND s.status = 'approved'
                AND o.observed_at > datetime('now', '-30 days'))), 0) AS spotted
          FROM robotaxi_vehicles v JOIN dmv_av_vehicles d ON d.vin = upper(trim(v.vin)) AND d.last_seen_date = ?
          WHERE ${publicVehicleEligibleSql('v')}`).bind(latest.date)
      ]);
      const f = (fresh.results || [])[0] || {}, m = (matched.results || [])[0] || {};
      const trackingSince = series[0].date;
      // Before our first snapshot: the imported, approximate history (never after it).
      // (env.DMV_HISTORY_OVERRIDE: tests only; no such binding in production.)
      const imported = Array.isArray(env.DMV_HISTORY_OVERRIDE) ? env.DMV_HISTORY_OVERRIDE : DMV_HISTORY;
      const history = imported.filter(p => p.date < trackingSince).map(p => ({ ...p, approx: true }));
      const full = [...history, ...series.map(r => ({ date: r.date, total: r.total, cybercab: r.cybercab, model_y: r.model_y }))];
      // A window that starts before tracking began can't be counted by VIN; it's
      // the change in the counts over the window instead (approximate).
      const at = date => { let v = null; for (const p of full) { if (p.date <= date) v = p; else break; } return v || { total: 0, cybercab: 0, model_y: 0 }; };
      const delta = (from, key) => latest[key] - at(from)[key];
      const byCount30 = !!history.length && d30 < trackingSince, byCount7 = !!history.length && d7 < trackingSince;
      body = {
        ...body,
        snapshot: { date: latest.date, polled_at: latest.polled_at, total: latest.total, cybercab: latest.cybercab, model_y: latest.model_y, other: latest.other },
        tracking_since: trackingSince,
        history_source: history.length ? { ...DMV_HISTORY_SOURCE, from: history[0].date, until: trackingSince } : null,
        series: full,
        new: {
          d30: byCount30 ? delta(d30, 'total') : Number(f.d30) || 0,
          d7: byCount7 ? delta(d7, 'total') : Number(f.d7) || 0,
          cybercab_30d: byCount30 ? delta(d30, 'cybercab') : Number(f.cybercab_30d) || 0,
          model_y_30d: byCount30 ? delta(d30, 'model_y') : Number(f.model_y_30d) || 0,
          approx: byCount30
        },
        matched: { count: Number(m.n) || 0, spotted_30d: Number(m.spotted) || 0 }
      };
    }
    const response = Response.json(body, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
    if (cache) { const stored = cache.put(cacheKey, response.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(stored); }
    return response;
  } catch (e) {
    return Response.json({ success: false, error: 'registrations_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

// GET /api/dmv-registrations/vins?q=&model=cybercab|model_y&limit=&offset= — the
// "Every VIN" page: today's roster with exactly the source's fields.
export async function apiDmvVins(request, env) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), 200);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);
  // A VIN fragment: letters and digits only (VINs have no other characters).
  const q = [...String(params.get('q') || '').toUpperCase()].filter(c => /[0-9A-Z]/.test(c)).join('').slice(0, 17);
  const model = params.get('model');
  const where = ['d.last_seen_date = (SELECT MAX(snapshot_date) FROM dmv_snapshots)'];
  const binds = [];
  if (q) { where.push('d.vin LIKE ?'); binds.push(`%${q}%`); }
  if (model === 'cybercab') where.push(`lower(d.model) = 'cybercab'`);
  else if (model === 'model_y') where.push(`lower(d.model) = 'model y'`);
  const sql = env.cybercabhunter_db;
  try {
    const [rows, count] = await sql.batch([
      sql.prepare(`SELECT d.vin, d.make, d.model, d.model_year FROM dmv_av_vehicles d WHERE ${where.join(' AND ')} ORDER BY d.vin LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
      sql.prepare(`SELECT COUNT(*) AS n FROM dmv_av_vehicles d WHERE ${where.join(' AND ')}`).bind(...binds)
    ]);
    return Response.json({
      total: Number(((count.results || [])[0] || {}).n) || 0, limit, offset,
      vehicles: (rows.results || []).map(r => ({ vin: r.vin, make: r.make, model: r.model, model_year: r.model_year }))
    }, { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  } catch (e) {
    return Response.json({ success: false, error: 'registrations_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
