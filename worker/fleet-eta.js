// Fleet ETA estimates (simulation.html?view=eta): precomputed once a day,
// served from one stored row per city.
//
//   GET  /api/fleet-eta?city=austin|dallas      public, edge-cached 1 hour
//        -> the city's stored summary (fleet_eta_stats.payload)
//   POST /api/fare-reports                      signed in; one report
//   GET  /api/moderation/fare-reports           moderators: the pending queue
//   POST /api/moderation/fare-reports/:id       moderators: approve | reject
//
// D1 BUDGET (docs/fleet-eta-accuracy.md): every aggregate is computed by
// recomputeFleetEta, run by the existing daily crons (Austin with
// FLEET_STATS_CRON, Dallas with TXDMV_CRON; no new trigger). A page load reads at most ONE row (fleet_eta_stats, by primary
// key), and only on an edge-cache miss. A report reads at most the rider's and
// the IP's reports from the last 24 hours (indexed, capped at the limit) and
// inserts one row. Nothing here scans a table on a request.
//
// PRIVACY: the stored summary holds aggregates only (no ride, rider, vehicle
// or plate). Recent reports are shown coarsely (area, vehicle type, fare,
// distance, wait, day). A report stores an area, never an address, and the
// hour, never the minute. Private or not-yet-eligible vehicles never count.
//
// CITIES: Austin and Dallas are computed separately from their own
// observations only; nothing from one city is used for the other.

import { COUNTED_RIDES_WHERE, RIDES_FROM, publicVehicleEligibleSql } from './ride-status.js';
import { MILES_SQL, FLEET_CITIES } from './fleet-stats.js';
import { serviceAreaFor } from './service-areas.js';
import { requireModerator } from './moderation.js';
import { tesla } from './tesla.js';
import { sha256Hex } from './account.js';
import CALC from '../public/js/calc.js';
import * as M from './fleet-eta-model.js';

const CACHE_SECONDS = 3600;
export const REPORT_DAILY_LIMIT = 10;        // per rider and per IP, rolling 24 h
const REPORT_MAX_AGE_DAYS = 30;
const REPORTS_READ_CAP = 1000;               // newest approved reports the daily job reads per city
const RECENT_SHOWN = 6;
const AREA_SQ_MI = { austin: CALC.ETA_ASSUMPTIONS.areaSqMi, dallas: CALC.DALLAS_AREA_SQ_MI };
const TZ = 'America/Chicago';

const vehicleType = model => {
  const m = String(model || '').toLowerCase().replace(/[\s_-]/g, '');
  if (m === 'cybercab') return 'cybercab';
  if (m === 'modely' || m === 'teslamodely') return 'model_y';
  return 'unknown';
};

// ---- Daily job: inputs ------------------------------------------------------
// Every read is index-bounded and capped, so the daily job's D1 reads stay
// small as the tables grow (scripts/measure-fleet-eta-reads.mjs):
//   - publicly eligible vehicles: read once, reused for every filter below
//     and for the documented-fleet counts (no per-ride eligibility subquery);
//   - rides: newest first through idx_trips_area_date, at most RIDES_READ_CAP
//     rows (the model keeps the newest MAX_FARE_OBS clean fares anyway);
//   - sightings: the last 30 days through idx_vehicle_observations_observed_at;
//   - "seen but not identifiable" counts stop at COUNT_CAP.
const RIDES_READ_CAP = 3000;
const COUNT_CAP = 1000;

// Publicly eligible registry vehicles (the same gate as every public page):
// Map id -> { type, area }.
async function eligibleVehicles(sql) {
  const { results } = await sql.prepare(`
    SELECT v.id, v.model, lower(trim(COALESCE(v.service_area, ''))) AS area
    FROM robotaxi_vehicles v WHERE ${publicVehicleEligibleSql('v')}`).all();
  return new Map((results || []).map(r => [r.id, { type: vehicleType(r.model), area: r.area }]));
}

// Counted rides whose receipt is in the city, newest first, one per physical
// ride (riders sharing a ride_key count once). A ride on a vehicle counts only
// if that vehicle is publicly eligible; a ride linked to no vehicle counts on
// its own. Fare, miles, when, vehicle type and pickup ZIP area.
async function cityRides(sql, city, vehicles, sinceDate) {
  const { results } = await sql.prepare(`
    SELECT t.fare_amount_cents AS fare_cents, ${MILES_SQL} AS miles, t.started_at_utc, t.ride_date, t.pickup_time,
           t.robotaxi_vehicle_id AS vehicle_id, t.pickup_description AS pickup, COALESCE(t.ride_key, t.id) AS ride
    FROM ${RIDES_FROM}
    WHERE lower(trim(t.service_area)) = ? AND t.ride_date >= ? AND ${COUNTED_RIDES_WHERE}
      AND upper(COALESCE(t.currency, 'USD')) = 'USD'
      AND lower(COALESCE(t.distance_unit, 'mi')) IN ('mi', 'km')
    ORDER BY t.ride_date DESC LIMIT ${RIDES_READ_CAP}`).bind(city, sinceDate).all();
  const rides = new Map();
  for (const r of results || []) {
    if (r.vehicle_id && !vehicles.has(r.vehicle_id)) continue;   // private / not yet eligible
    const key = `${r.vehicle_id || ''}|${r.ride}`;
    const prev = rides.get(key);
    if (!prev) { rides.set(key, { ...r, model: r.vehicle_id ? vehicles.get(r.vehicle_id).type : null }); continue; }
    // One physical ride: keep a recorded fare/distance (the larger, as MAX did).
    if (r.fare_cents != null && (prev.fare_cents == null || r.fare_cents > prev.fare_cents)) prev.fare_cents = r.fare_cents;
    if (r.miles != null && (prev.miles == null || r.miles > prev.miles)) prev.miles = r.miles;
  }
  return [...rides.values()];
}

// When a ride started, as UTC ms: started_at_utc, else the receipt's local
// date and pickup time read as Central time (both cities are Central).
function rideMs(r) {
  if (r.started_at_utc) { const t = Date.parse(r.started_at_utc); if (Number.isFinite(t)) return t; }
  if (!r.ride_date) return NaN;
  const hm = /^(\d{1,2}):(\d{2})/.exec(r.pickup_time || '') || [null, '12', '00'];
  const guess = Date.parse(`${r.ride_date}T${hm[1].padStart(2, '0')}:${hm[2]}:00Z`);
  if (!Number.isFinite(guess)) return NaN;
  // Shift by Central's offset at that moment (CDT -5 / CST -6).
  const off = M.localParts(guess, TZ).hour - new Date(guess).getUTCHours();
  return guess - (((off + 24 + 12) % 24) - 12) * 3600000;
}

async function approvedReports(sql, city, sinceIso) {
  const { results } = await sql.prepare(`
    SELECT id, pickup_area, dropoff_area, kind, vehicle_type, distance_miles, quoted_fare_cents,
           quoted_wait_minutes, actual_wait_minutes, no_cars_available, observed_hour_utc, local_dow, local_hour
    FROM fare_reports
    WHERE city = ? AND status = 'approved' AND observed_hour_utc >= ?
    ORDER BY observed_hour_utc DESC LIMIT ${REPORTS_READ_CAP}
  `).bind(city, sinceIso).all();
  return results || [];
}

async function fleetLayers(sql, city, vehicles, nowMs) {
  const since30 = new Date(nowMs - 30 * M.DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
  const since30Iso = new Date(nowMs - 30 * M.DAY_MS).toISOString();
  const [obs, cams, dmv] = await Promise.all([
    // Approved sightings in the city in the last 30 days. The unary + keeps
    // SQLite on the observed_at index instead of walking every approved
    // submission through idx_submissions_status.
    sql.prepare(`
      SELECT o.robotaxi_vehicle_id AS vid, o.observed_at AS at
      FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
      WHERE o.observed_at >= ? AND lower(trim(o.service_area)) = ?
        AND +s.submission_type = 'vehicle_sighting' AND +s.status = 'approved'`).bind(since30, city).all(),
    sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM camera_detections WHERE observed_at >= ? AND city = ? AND source_submission_id IS NULL LIMIT ${COUNT_CAP})`).bind(since30Iso, city).first(),
    sql.prepare(`SELECT snapshot_date, total, cybercab_count, model_y_count FROM dmv_snapshots ORDER BY snapshot_date DESC LIMIT 1`).first()
  ]);
  const documented = { cybercab: 0, model_y: 0, unknown: 0 };
  for (const v of vehicles.values()) if (v.area === city) documented[v.type] += 1;
  const latest = new Map();
  let unidentified = 0;
  for (const r of obs.results || []) {
    if (!r.vid) { unidentified++; continue; }
    if (!vehicles.has(r.vid)) continue;
    const ms = Date.parse(String(r.at).replace(' ', 'T') + (String(r.at).includes('Z') ? '' : 'Z'));
    if (Number.isFinite(ms) && ms > (latest.get(r.vid) || 0)) latest.set(r.vid, ms);
  }
  return {
    documented,
    seen: [...latest].map(([vid, ms]) => ({ vid, ms })),
    unidentified_sightings_30d: Math.min(unidentified, COUNT_CAP),
    camera_detections_30d: Number(cams ? cams.n : 0),
    counts_capped_at: COUNT_CAP,
    dmv: dmv ? { snapshot_date: dmv.snapshot_date, total: Number(dmv.total), cybercab: Number(dmv.cybercab_count), model_y: Number(dmv.model_y_count), scope: 'Texas (statewide)' } : null
  };
}

// ---- Daily job: the summary -------------------------------------------------

export function buildCityPayload(city, { rides = [], reports = [], fleet = null }, nowMs = Date.now()) {
  const area = serviceAreaFor(city);
  const ext = M.EXTERNAL[city];
  const slotOf = (dow, hour) => M.slotKey(dow, hour);

  // Observations: logged rides (completed, actual fares) and approved reports.
  const fareObs = [];
  for (const r of rides) {
    const ts = rideMs(r);
    if (!Number.isFinite(ts) || r.fare_cents == null) continue;
    const p = M.localParts(ts, TZ);
    fareObs.push({ id: `ride:${r.ride}`, key: `ride:${r.vehicle_id || ''}:${r.ride}`, source: 'ride', kind: 'completed', fare: Number(r.fare_cents) / 100, miles: Number(r.miles), ts, slot: slotOf(p.dow, p.hour), part: M.daypart(p.hour), area: M.areaFromAddress(city, r.pickup), vehicle: vehicleType(r.model) });
  }
  const reportRows = reports.map(r => {
    const ts = Date.parse(r.observed_hour_utc);
    return { ...r, ts, slot: slotOf(Number(r.local_dow), Number(r.local_hour)), part: M.daypart(Number(r.local_hour)) };
  }).filter(r => Number.isFinite(r.ts));
  for (const r of reportRows) {
    if (r.no_cars_available || r.quoted_fare_cents == null || r.distance_miles == null) continue;
    fareObs.push({ id: `report:${r.id}`, key: `report:${r.id}`, source: 'report', kind: r.kind, fare: Number(r.quoted_fare_cents) / 100, miles: Number(r.distance_miles), ts: r.ts, slot: r.slot, part: r.part, area: r.pickup_area || null, vehicle: r.vehicle_type });
  }
  const cleaned = M.cleanFares(fareObs, nowMs);
  const unavail = M.unavailabilityBySlot(reportRows.filter(r => nowMs - r.ts <= M.WAIT_WINDOW_DAYS * M.DAY_MS).map(r => ({ slot: r.slot, no_cars: !!r.no_cars_available })));

  // Public service evidence: Tesla's launch in the city (service-areas.js), and
  // for Cybercabs specifically a logged Cybercab ride or an approved completed
  // Cybercab report in the last 90 days, or a published Cybercab fleet count.
  const recent = o => nowMs - o.ts <= 90 * M.DAY_MS;
  const ownCybercab = cleaned.kept.filter(o => o.vehicle === 'cybercab' && o.kind === 'completed' && recent(o)).length;
  const launched = area && area.zone && Date.parse(area.zone.in_service_since) <= nowMs;
  const cybercabService = ownCybercab > 0 || !!(ext && ext.fleet && ext.fleet.cybercab > 0);
  const service = {
    public_service: !!launched,
    since: area && area.zone ? area.zone.in_service_since : null,
    hours: area && area.zone ? area.zone.hours : null,
    cybercab_service: cybercabService,
    cybercab_evidence: ownCybercab > 0 ? `${ownCybercab} logged Cybercab ride${ownCybercab === 1 ? '' : 's'} in the last 90 days`
      : ext && ext.fleet && ext.fleet.cybercab > 0 ? `${ext.fleet.source}: ${ext.fleet.cybercab} Cybercabs in service (${ext.fleet.as_of})`
        : 'No logged Cybercab ride and no published report of Cybercabs in public service here'
  };

  // ---- Fares: one model per vehicle group, each with a held-out check.
  const groups = { all: cleaned.kept, cybercab: cleaned.kept.filter(o => o.vehicle === 'cybercab'), model_y: cleaned.kept.filter(o => o.vehicle === 'model_y') };
  const rate = ext && ext.rate_card;
  const fareCheck = rows => M.holdoutCheck(rows, {
    nowMs,
    build: train => M.buildFareModel(train, nowMs, { unavailability: unavail.slots }),
    predict: (m, r, tier) => M.fareRange(m, r.miles, tier, r.area),
    actual: r => r.fare,
    unavailability: unavail.slots,
    groupKeys: { vehicle: r => r.vehicle, part_of_day: r => r.part, area: r => r.area },
    baselines: {
      // The previous page: the measured $/mile times the distance.
      previous_measured_rate: train => { const perMile = train.reduce((s, x) => s + x.fare, 0) / train.reduce((s, x) => s + x.miles, 0); return r => perMile * r.miles; },
      ...(rate ? { reported_rate_card: () => r => rate.base + rate.per_mile * r.miles } : {})
    }
  });
  const fareModels = {}, fareChecks = {};
  for (const [g, rows] of Object.entries(groups)) {
    const check = fareCheck(rows);
    let model = M.buildFareModel(rows, nowMs, { unavailability: unavail.slots });
    if (model) {
      model.time_tiers = !!(check && check.time_tiers_helped);
      const w = M.widenTiers(model, check);
      model = { ...w.model, widened_by: w.widened_by };
    }
    fareModels[g] = model; fareChecks[g] = check;
  }
  const externalFare = M.externalFareModel(city);
  const perVehicle = {};
  for (const type of ['cybercab', 'model_y']) {
    let use, model, check = null, note = null, borrowed = false;
    if (type === 'cybercab' && !cybercabService) {
      use = 'none'; model = null;
      note = `No evidence of Cybercabs in public service in ${area ? area.name : city} yet, so no Cybercab estimate (Austin's numbers are not reused).`;
    } else if (fareModels[type]) {
      use = type; model = fareModels[type]; check = fareChecks[type];
    } else if (fareModels.all) {
      use = 'all'; model = fareModels.all; check = fareChecks.all; borrowed = true;
      note = `Too few ${type === 'cybercab' ? 'Cybercab' : 'Model Y'} rides with a known vehicle type to price it separately, so this is all logged ${area ? area.name : ''} robotaxi rides together.`;
    } else if (externalFare) {
      use = 'external'; model = externalFare;
      note = 'Fewer than 10 usable logged rides here, so this is modeled from published reports (not the site\'s own data).';
    } else {
      use = 'none'; model = null; note = 'Not enough data.';
    }
    perVehicle[type] = { use, note, confidence: M.confidence(model, check, { borrowed }), model_ref: use };
  }

  // ---- Waits (rider reports only; Tesla's dispatch data is not available).
  const waitRows = reportRows.filter(r => r.quoted_wait_minutes != null && !r.no_cars_available)
    .map(r => ({ minutes: Number(r.quoted_wait_minutes), ts: r.ts, slot: r.slot, part: r.part, area: r.pickup_area || null }));
  const docCybercabs = fleet ? fleet.documented.cybercab : 0;
  const waitCheck = M.holdoutCheck(waitRows.filter(r => nowMs - r.ts <= M.WAIT_WINDOW_DAYS * M.DAY_MS && r.minutes >= 0 && r.minutes <= M.WAIT_LIMITS.max), {
    nowMs,
    build: train => M.buildWaitModel(train, nowMs, { unavailability: unavail.slots }),
    predict: (m, r, tier) => M.waitRange(m, tier, r.area),
    actual: r => Math.max(1, r.minutes),
    unavailability: unavail.slots,
    groupKeys: { part_of_day: r => r.part, area: r => r.area },
    baselines: {
      // The previous page: the fleet-geometry model's "most likely" for the documented Cybercabs.
      previous_fleet_geometry: () => {
        const e = CALC.etaRange({ fleetSize: docCybercabs, scenario: 'typical', assumptions: { ...CALC.ETA_ASSUMPTIONS, areaSqMi: AREA_SQ_MI[city] } });
        return () => (e.state === 'ok' ? e.likely : NaN);
      }
    }
  });
  let waitModel = M.buildWaitModel(waitRows, nowMs, { unavailability: unavail.slots });
  if (waitModel) {
    waitModel.time_tiers = !!(waitCheck && waitCheck.time_tiers_helped);
    const w = M.widenTiers(waitModel, waitCheck);
    waitModel = { ...w.model, widened_by: w.widened_by };
  }
  const waitUse = waitModel ? 'observed' : M.externalWaitModel(city) ? 'external' : 'none';
  const waits = {
    use: waitUse,
    model: M.publicModel(waitModel || M.externalWaitModel(city)),
    confidence: M.confidence(waitModel || M.externalWaitModel(city), waitCheck),
    check: waitCheck,
    note: waitUse === 'observed' ? null : waitUse === 'external'
      ? 'Fewer than 8 rider-reported waits here, so this range comes from published Austin reports.'
      : `No rider-reported waits for ${area ? area.name : city} yet, and no published wait reports to fall back on.`,
    actual_vs_quoted: M.actualVsQuoted(reportRows.map(r => ({ quoted: r.quoted_wait_minutes == null ? NaN : Number(r.quoted_wait_minutes), actual: r.actual_wait_minutes == null ? NaN : Number(r.actual_wait_minutes) }))),
    actual: (() => {
      const xs = reportRows.filter(r => r.actual_wait_minutes != null).map(r => ({ v: Number(r.actual_wait_minutes), w: 1 }));
      return xs.length >= M.MIN_WAIT_N ? { n: xs.length, median: M.weightedMedian(xs), p25: M.weightedQuantile(xs, 0.25), p75: M.weightedQuantile(xs, 0.75) } : { n: xs.length };
    })(),
    unavailability: unavail.all
  };

  // ---- The tier assumed for each time slot (only where it was shown to help).
  const fareSlots = fareModels.all && fareModels.all.time_tiers ? fareModels.all.slots : {};
  const waitSlots = waitModel && waitModel.time_tiers ? waitModel.slots : {};
  const slot_tiers = {};
  for (const k of M.SLOT_KEYS) {
    const reasons = [];
    const f = fareSlots[k] && fareSlots[k].tier, w = waitSlots[k] && waitSlots[k].tier;
    const u = unavail.slots[k];
    let tier = 'typical';
    if (u && u.n >= 6 && u.share >= 0.25) { tier = 'busy'; reasons.push(`no car available in ${Math.round(u.share * 100)}% of ${u.n} reports`); }
    if (f === 'busy' || w === 'busy') { tier = 'busy'; reasons.push(f === 'busy' ? 'fares run high' : 'quoted waits run long'); }
    else if (tier !== 'busy' && (f === 'quiet' || w === 'quiet') && f !== 'busy' && w !== 'busy') { tier = 'quiet'; reasons.push(f === 'quiet' ? 'fares run low' : 'quoted waits run short'); }
    slot_tiers[k] = { tier, reasons, fare_n: fareSlots[k] ? fareSlots[k].n : 0, wait_n: waitSlots[k] ? waitSlots[k].n : 0 };
  }

  // ---- Fleet layers (never interchangeable).
  const ridesVehicles30 = new Set(rides.filter(r => r.vehicle_id && nowMs - rideMs(r) <= 30 * M.DAY_MS).map(r => r.vehicle_id));
  const seen = new Map();
  for (const s of (fleet ? fleet.seen : [])) seen.set(s.vid, s.ms);
  for (const r of rides) if (r.vehicle_id) { const t = rideMs(r); if (Number.isFinite(t) && t > (seen.get(r.vehicle_id) || 0)) seen.set(r.vehicle_id, t); }
  const seenWithin = days => [...seen.values()].filter(t => nowMs - t <= days * M.DAY_MS).length;
  const fleetOut = fleet ? {
    documented: { ...fleet.documented, total: fleet.documented.cybercab + fleet.documented.model_y + fleet.documented.unknown },
    observed_7d: seenWithin(7),
    observed_30d: seenWithin(30),
    ride_vehicles_30d: ridesVehicles30.size,
    unidentified_30d: { sightings: fleet.unidentified_sightings_30d, camera_detections: fleet.camera_detections_30d },
    dmv: fleet.dmv,
    external: ext && ext.fleet ? ext.fleet : null,
    available_pickup: null
  } : null;

  // ---- Recent approved reports, coarse.
  const areaLabel = k => ((M.AREAS[city] || []).find(a => a.key === k) || {}).label || null;
  const recent_reports = reportRows.slice(0, RECENT_SHOWN).map(r => ({
    day: r.observed_hour_utc.slice(0, 10), kind: r.kind, vehicle: r.vehicle_type, area: areaLabel(r.pickup_area),
    fare: r.quoted_fare_cents == null ? null : Number(r.quoted_fare_cents) / 100,
    miles: r.distance_miles == null ? null : Number(r.distance_miles),
    quoted_wait: r.quoted_wait_minutes == null ? null : Number(r.quoted_wait_minutes),
    actual_wait: r.actual_wait_minutes == null ? null : Number(r.actual_wait_minutes),
    no_cars: !!r.no_cars_available
  }));

  const areas = (M.AREAS[city] || []).map(a => ({
    key: a.key, label: a.label,
    wait_n: waitModel && waitModel.area_n ? (waitModel.area_n[a.key] || 0) : 0,
    fare_n: cleaned.kept.filter(o => o.area === a.key).length
  }));

  return {
    city, model_version: M.MODEL_VERSION, computed_at: new Date(nowMs).toISOString(),
    service,
    fleet: fleetOut,
    fares: {
      models: { all: M.publicModel(fareModels.all), cybercab: M.publicModel(fareModels.cybercab), model_y: M.publicModel(fareModels.model_y), external: externalFare },
      by_vehicle: perVehicle,
      checks: fareChecks,
      cleaning: { candidates: fareObs.length, used: cleaned.kept.length, excluded: cleaned.excluded, sources: { rides: cleaned.kept.filter(o => o.source === 'ride').length, reports: cleaned.kept.filter(o => o.source === 'report').length } },
      external: ext ? { rate_card: ext.rate_card, rate_history: ext.rate_history, tracker: ext.tracker, obi: M.OBI_DAILY_RANGE } : null
    },
    waits,
    slot_tiers,
    areas,
    recent_reports,
    limits: { fare_window_days: M.FARE_WINDOW_DAYS, wait_window_days: M.WAIT_WINDOW_DAYS, half_life_days: M.HALF_LIFE_DAYS, min_fit: M.MIN_FIT_N, min_tiers: M.MIN_TIER_N, min_waits: M.MIN_WAIT_N }
  };
}

// Everything the daily job reads for one city (SELECTs only).
export async function dailyReads(sql, key, nowMs = Date.now()) {
  const city = serviceAreaFor(key).name.toLowerCase();
  const since = new Date(nowMs - M.FARE_WINDOW_DAYS * M.DAY_MS).toISOString().slice(0, 13) + ':00:00Z';
  const vehicles = await eligibleVehicles(sql);
  const [rides, reports, fleet] = await Promise.all([
    cityRides(sql, city, vehicles, since.slice(0, 10)), approvedReports(sql, key, since), fleetLayers(sql, city, vehicles, nowMs)
  ]);
  return { rides, reports, fleet };
}

// The daily job: each city separately; one upsert per city. The scheduled
// handler runs one city per cron invocation (Austin with FLEET_STATS_CRON,
// Dallas with TXDMV_CRON) to keep each invocation's CPU small.
export async function recomputeFleetEta(env, nowMs = Date.now(), cities = FLEET_CITIES) {
  const sql = env.cybercabhunter_db;
  const out = {};
  for (const key of cities) {
    const payload = buildCityPayload(key, await dailyReads(sql, key, nowMs), nowMs);
    await sql.prepare(`
      INSERT INTO fleet_eta_stats (city, model_version, computed_at, payload) VALUES (?, ?, ?, ?)
      ON CONFLICT(city) DO UPDATE SET model_version = excluded.model_version, computed_at = excluded.computed_at, payload = excluded.payload
    `).bind(key, M.MODEL_VERSION, payload.computed_at, JSON.stringify(payload)).run();
    out[key] = payload;
  }
  return out;
}

// ---- GET /api/fleet-eta ------------------------------------------------------

export async function apiFleetEta(request, env, ctx) {
  const city = (new URL(request.url).searchParams.get('city') || 'austin').toLowerCase();
  if (!FLEET_CITIES.includes(city)) return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(`https://cybercabhunter.com/api/fleet-eta?city=${city}`, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const row = await env.cybercabhunter_db.prepare(`SELECT model_version, payload FROM fleet_eta_stats WHERE city = ?`).bind(city).first();
  let body;
  if (row && Number(row.model_version) === M.MODEL_VERSION) {
    body = row.payload;
  } else {
    // Not computed yet (before the first daily run, or after a model change):
    // the published-reports estimate, with no D1 scan. The next run fills it.
    body = JSON.stringify({ ...buildCityPayload(city, {}, Date.now()), pending_first_run: true });
  }
  const response = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}

// ---- POST /api/fare-reports --------------------------------------------------

const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

// Validates a report body. Returns { report } or { error }.
export function validateFareReport(body, nowMs = Date.now()) {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' };
  const city = String(body.city || '').toLowerCase();
  if (!FLEET_CITIES.includes(city)) return { error: 'invalid_city' };
  const kind = String(body.kind || '');
  if (!['quote', 'completed'].includes(kind)) return { error: 'invalid_kind' };
  const vehicle = String(body.vehicle_type || 'unknown');
  if (!['cybercab', 'model_y', 'unknown'].includes(vehicle)) return { error: 'invalid_vehicle_type' };
  const areaOk = v => v == null || v === '' || v === 'other' || M.areaKeys(city).includes(v);
  if (!areaOk(body.pickup_area)) return { error: 'invalid_pickup_area' };
  if (!areaOk(body.dropoff_area)) return { error: 'invalid_dropoff_area' };
  const noCars = body.no_cars_available === true || body.no_cars_available === 1 || body.no_cars_available === '1';
  const miles = num(body.distance_miles), fare = num(body.quoted_fare), wait = num(body.quoted_wait_minutes);
  const actual = num(body.actual_wait_minutes), duration = num(body.duration_minutes);
  const L = M.FARE_LIMITS;
  if (miles !== null && !(Number.isFinite(miles) && miles >= L.minMiles && miles <= L.maxMiles)) return { error: 'invalid_distance' };
  if (fare !== null && !(Number.isFinite(fare) && fare >= L.minUsd && fare <= L.maxUsd)) return { error: 'invalid_fare' };
  if (fare !== null && miles === null) return { error: 'distance_required_with_fare' };
  if (fare !== null && (fare / miles < L.minPerMile || fare / miles > L.maxPerMile)) return { error: 'implausible_fare_for_distance' };
  if (wait !== null && !(Number.isInteger(wait) && wait >= 0 && wait <= M.WAIT_LIMITS.max)) return { error: 'invalid_quoted_wait' };
  if (actual !== null && !(Number.isInteger(actual) && actual >= 0 && actual <= 120)) return { error: 'invalid_actual_wait' };
  if (duration !== null && !(Number.isInteger(duration) && duration >= 1 && duration <= 180)) return { error: 'invalid_duration' };
  if (duration !== null && miles !== null && miles / (duration / 60) > 80) return { error: 'implausible_speed' };
  if (noCars && (fare !== null || wait !== null || actual !== null)) return { error: 'no_cars_with_values' };
  if (!noCars && fare === null && wait === null && actual === null) return { error: 'nothing_reported' };
  if (actual !== null && kind !== 'completed') return { error: 'actual_wait_needs_completed_ride' };
  const t = Date.parse(String(body.observed_at || ''));
  if (!Number.isFinite(t)) return { error: 'invalid_observed_at' };
  if (t > nowMs + 10 * 60000 || nowMs - t > REPORT_MAX_AGE_DAYS * M.DAY_MS) return { error: 'observed_at_out_of_range' };
  const hour = new Date(Math.floor(t / 3600000) * 3600000).toISOString().replace('.000Z', 'Z');
  const local = M.localParts(t, TZ);
  return {
    report: {
      city, kind, vehicle_type: vehicle,
      pickup_area: body.pickup_area || null, dropoff_area: body.dropoff_area || null,
      distance_miles: miles, duration_minutes: duration,
      quoted_fare_cents: fare === null ? null : Math.round(fare * 100),
      quoted_wait_minutes: wait, actual_wait_minutes: actual, no_cars_available: noCars ? 1 : 0,
      observed_hour_utc: hour, local_dow: local.dow, local_hour: local.hour
    }
  };
}

export async function apiCreateFareReport(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401 });
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const v = validateFareReport(body);
  if (v.error) return fail(v.error);
  const r = v.report;
  const sql = env.cybercabhunter_db;
  const since = new Date(Date.now() - M.DAY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipDay = ip ? await sha256Hex(`${ip}|${new Date().toISOString().slice(0, 10)}`) : null;
  // The two daily limits: indexed, and never reads more than the limit's worth of rows.
  const [mine, fromIp] = await Promise.all([
    sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM fare_reports WHERE user_id = ? AND created_at >= ? LIMIT ${REPORT_DAILY_LIMIT})`).bind(userId, since).first(),
    ipDay ? sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM fare_reports WHERE ip_day_hash = ? AND created_at >= ? LIMIT ${REPORT_DAILY_LIMIT})`).bind(ipDay, since).first() : null
  ]);
  if (Number(mine && mine.n) >= REPORT_DAILY_LIMIT || Number(fromIp && fromIp.n) >= REPORT_DAILY_LIMIT) {
    return Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '3600' } });
  }
  const dedupe = await sha256Hex([userId, r.city, r.observed_hour_utc, r.kind, r.vehicle_type, r.quoted_fare_cents, r.distance_miles, r.quoted_wait_minutes, r.no_cars_available].join('|'));
  const id = crypto.randomUUID();
  const ins = await sql.prepare(`
    INSERT INTO fare_reports (id, user_id, city, pickup_area, dropoff_area, kind, vehicle_type, distance_miles, duration_minutes,
      quoted_fare_cents, quoted_wait_minutes, actual_wait_minutes, no_cars_available, observed_hour_utc, local_dow, local_hour,
      ip_day_hash, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(id, userId, r.city, r.pickup_area, r.dropoff_area, r.kind, r.vehicle_type, r.distance_miles, r.duration_minutes,
    r.quoted_fare_cents, r.quoted_wait_minutes, r.actual_wait_minutes, r.no_cars_available, r.observed_hour_utc, r.local_dow, r.local_hour,
    ipDay, dedupe).run();
  if (!ins || !ins.meta || !ins.meta.changes) return fail('duplicate_report', 409);
  return Response.json({ success: true, id, status: 'pending' }, { status: 201 });
}

// ---- Moderation --------------------------------------------------------------

function authFail(auth) {
  return auth.error === 'unauthenticated' ? Response.json({ authenticated: false }, { status: 401 }) : fail('forbidden', 403);
}

export async function apiListFareReports(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFail(auth);
  const { results } = await env.cybercabhunter_db.prepare(`
    SELECT r.id, r.city, r.pickup_area, r.dropoff_area, r.kind, r.vehicle_type, r.distance_miles, r.duration_minutes,
           r.quoted_fare_cents, r.quoted_wait_minutes, r.actual_wait_minutes, r.no_cars_available, r.observed_hour_utc,
           r.created_at, u.display_name AS reporter
    FROM fare_reports r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 50`).all();
  return Response.json({ success: true, reports: results || [] }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function apiReviewFareReport(request, env, id) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFail(auth);
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  const action = body && body.action;
  if (!['approve', 'reject'].includes(action)) return fail('invalid_action');
  const res = await env.cybercabhunter_db.prepare(`
    UPDATE fare_reports SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = ? AND status = 'pending'`).bind(action === 'approve' ? 'approved' : 'rejected', auth.userId, String(id)).run();
  if (!res || !res.meta || !res.meta.changes) return fail('not_found', 404);
  return Response.json({ success: true, status: action === 'approve' ? 'approved' : 'rejected' });
}
