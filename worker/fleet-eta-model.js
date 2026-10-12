// Fleet ETA estimate model: pure functions, no I/O (worker/fleet-eta.js feeds
// it once a day; tests/fleet-eta-model.test.mjs runs it directly).
//
// What it turns observations into, per city (never blended across cities):
//   - a fare curve per vehicle group (Cybercab, Model Y, all robotaxis):
//     typical fare = a + b x miles, fit robustly on recency-weighted rides;
//   - three demand tiers (Quiet / Typical / Busy) as multipliers on that
//     curve, FIT from the spread of observed fares (25th / 50th / 80th
//     percentile of fare / curve), each with the range the remaining noise
//     leaves (10th-90th percentile within comparable time slots);
//   - the same tiers for rider-reported pickup waits, per pickup area when
//     an area has enough reports;
//   - which tier each time slot (weekday/weekend x part of day) looks like,
//     used only if it beats "always Typical" on held-out observations;
//   - calibration: the newest observations are held out, the model is fit
//     on the rest and scored on them (error, share inside the shown range),
//     against the previous page's formulas on the same rides;
//   - a confidence label from sample size, freshness and that score.
// The tier names are Cybercab Hunter's own scenarios. Nothing here claims
// they are Tesla's labels, and nothing is a live Tesla quote.

export const MODEL_VERSION = 1;
export const DAY_MS = 86400000;
export const FARE_WINDOW_DAYS = 180;      // older fares are "outdated" and dropped
export const WAIT_WINDOW_DAYS = 90;
export const HALF_LIFE_DAYS = 30;         // a fare 30 days old counts half as much
// At most this many clean fares per city feed the model (the newest; older
// ones weigh little anyway): bounds the daily job's CPU as the data grows.
export const MAX_FARE_OBS = 400;
export const MIN_FIT_N = 10;              // fewer clean fares: no observed curve
export const MIN_TIER_N = 30;             // fewer: one Typical range, no tiers
export const MIN_TIER_NEFF = 20;
export const MIN_WAIT_N = 8;
export const MIN_AREA_N = 8;
export const MIN_SLOT_N = 8;
export const MIN_HOLDOUT_TEST = 5;
export const MIN_TIME_TEST = 10;

// Plausibility limits for one fare (anything outside is a typo or a non-ride).
export const FARE_LIMITS = { minUsd: 1, maxUsd: 250, minMiles: 0.2, maxMiles: 60, minPerMile: 0.4, maxPerMile: 30 };
export const WAIT_LIMITS = { min: 0, max: 90 };

export const TIERS = ['quiet', 'typical', 'busy'];
// Percentiles of the observed fare/curve ratio each tier sits at.
const TIER_CENTER_P = { quiet: 0.25, typical: 0.5, busy: 0.8 };

// ---- Published / reported context (cited; used only where the site has no
// observations of its own, and always labelled as external).
export const EXTERNAL = {
  austin: {
    // Tesla's Austin fare structure as reported over time: calibration
    // context only, NOT current pricing.
    rate_card: { base: 3.00, per_mile: 1.40, as_of: '2026-03-12', source: 'Not a Tesla App / TheStreet reporting' },
    rate_history: [
      { as_of: '2025-06-22', text: '$4.20 flat (launch)' },
      { as_of: '2025-07', text: '$6.90 flat' },
      { as_of: '2025-07-31', text: '$1 base + $1/mi (app v25.7.10)' },
      { as_of: '2026-03-07', text: '$3.25 base + $1/mi' },
      { as_of: '2026-03-12', text: '$3.00 base + $1.40/mi' }
    ],
    // Observed medians published by RobotaxiTracker (past 90 days, as
    // supplied to the site in Oct 2026; all vehicle types together).
    tracker: { median_fare: 10.42, per_mile: 3.50, avg_miles: 4.1, rides: 1395, window: 'past 90 days', as_of: '2026-10', source: 'RobotaxiTracker' },
    fleet: { total: 275, cybercab: 105, as_of: '2026-10', source: 'RobotaxiTracker' },
    // Reported Austin pickup waits (minutes), oldest first.
    waits: [
      { minutes: 5, text: '1.36-mile trip quoted a 5-minute wait (X user @muskonomy, Aug 2025)' },
      { minutes: 12.5, text: 'Austin riders report 10-15 minute waits' },
      { minutes: 15, text: 'Jefferies field test, 15 rides, Feb 2026: about 15 minutes on average; no car available 50-60% of the time' },
      { minutes: 26, text: "Rider video: 26-minute arrival estimate at Terry Black's BBQ" }
    ],
    wait_tiers: { quiet: [5, 10], typical: [10, 15], busy: [15, 26] }
  },
  dallas: {
    rate_card: { base: 3.25, per_mile: 1.00, as_of: '2026-04-20', source: 'FOX 4 (launch reporting)' },
    rate_history: [{ as_of: '2026-04-20', text: '$3.25 base + $1/mi (introductory, at launch)' }],
    tracker: { median_fare: 5.88, per_mile: 4.04, avg_miles: 2.2, rides: 349, window: 'past 90 days', as_of: '2026-10', source: 'RobotaxiTracker' },
    fleet: { total: 67, cybercab: 0, as_of: '2026-10', source: 'RobotaxiTracker (all Model Y; no Cybercab in public service)' },
    waits: [],
    wait_tiers: null
  }
};
// Obi (rideobi.com, San Francisco, Mar 1 - Apr 14 2026): Tesla's average ride
// price ranged $8.31-$14.59 by day. Around the midpoint that is about -27% /
// +27%: the only external evidence for how far demand moves prices, so it
// sets the external tiers and serves as a sanity anchor for fitted ones.
export const OBI_DAILY_RANGE = { low: 8.31, high: 14.59, source: 'Obi, Tesla Robotaxi pricing report, Mar-Apr 2026 (San Francisco)' };
const OBI_MID = (OBI_DAILY_RANGE.low + OBI_DAILY_RANGE.high) / 2;
export const OBI_MULTIPLIERS = { quiet: OBI_DAILY_RANGE.low / OBI_MID, typical: 1, busy: OBI_DAILY_RANGE.high / OBI_MID };

// ---- Pickup areas (coarse; from the ZIP code in a receipt's pickup address,
// or picked by the rider in a report). Approximate neighborhood groupings.
export const AREAS = {
  austin: [
    { key: 'downtown', label: 'Downtown', zips: ['78701'] },
    { key: 'south', label: 'South Congress & South Austin', zips: ['78704', '78745'] },
    { key: 'east', label: 'East Austin & Riverside', zips: ['78702', '78721', '78722', '78741'] },
    { key: 'central', label: 'UT & Central', zips: ['78705', '78712', '78751', '78756'] },
    { key: 'north', label: 'North Austin', zips: ['78723', '78731', '78752', '78753', '78757', '78758', '78759'] },
    { key: 'west', label: 'West Austin', zips: ['78703', '78746'] }
  ],
  dallas: [
    { key: 'downtown', label: 'Downtown & Deep Ellum', zips: ['75201', '75202', '75226'] },
    { key: 'uptown', label: 'Uptown & Oak Lawn', zips: ['75204', '75219'] },
    { key: 'park_cities', label: 'Highland Park & University Park', zips: ['75205', '75225'] },
    { key: 'east', label: 'Lower Greenville & Lakewood', zips: ['75206', '75214'] },
    { key: 'love_field', label: 'Love Field & Medical District', zips: ['75209', '75235'] }
  ]
};
export function areaKeys(city) { return (AREAS[city] || []).map(a => a.key); }
export function areaFromAddress(city, text) {
  if (typeof text !== 'string') return null;
  const zips = text.match(/\b7[5-9]\d{3}\b/g);
  if (!zips) return null;
  const zip = zips[zips.length - 1];
  const hit = (AREAS[city] || []).find(a => a.zips.includes(zip));
  return hit ? hit.key : null;
}

// ---- Time slots
export function daypart(hour) {
  if (hour < 6) return 'overnight';
  if (hour < 10) return 'morning';
  if (hour < 15) return 'midday';
  if (hour < 19) return 'afternoon';
  return 'evening';
}
// Weekend = Friday evening through Sunday (Friday night rides like a weekend night).
export function isWeekend(dow, hour) { return dow === 0 || dow === 6 || (dow === 5 && hour >= 19); }
export function slotKey(dow, hour) { return `${isWeekend(dow, hour) ? 'weekend' : 'weekday'}:${daypart(hour)}`; }
export const SLOT_KEYS = ['weekday', 'weekend'].flatMap(d => ['morning', 'midday', 'afternoon', 'evening', 'overnight'].map(p => `${d}:${p}`));

// Local day of week (0 = Sunday) and hour of a UTC instant in a time zone.
// (Formatters are costly to build, so one is kept per time zone.)
const FORMATTERS = new Map();
export function localParts(ms, timeZone = 'America/Chicago') {
  if (timeZone === 'America/Chicago') return centralParts(ms);
  let fmt = FORMATTERS.get(timeZone);
  if (!fmt) FORMATTERS.set(timeZone, fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }));
  const parts = fmt.formatToParts(new Date(ms));
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), hour: Number(get('hour')) % 24 };
}

// US Central without Intl: CDT (UTC-5) from the second Sunday of March,
// 2:00 local, to the first Sunday of November, 2:00 local; CST (UTC-6) otherwise.
const DST_CACHE = new Map();
function dstBounds(year) {
  let b = DST_CACHE.get(year);
  if (b) return b;
  const sunday = (month, nth) => { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + (nth - 1) * 7; };
  b = { start: Date.UTC(year, 2, sunday(2, 2), 8), end: Date.UTC(year, 10, sunday(10, 1), 7) };
  DST_CACHE.set(year, b);
  return b;
}
function centralParts(ms) {
  const b = dstBounds(new Date(ms).getUTCFullYear());
  const d = new Date(ms + (ms >= b.start && ms < b.end ? -5 : -6) * 3600000);
  return { dow: d.getUTCDay(), hour: d.getUTCHours() };
}

// ---- Statistics
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
// Sorts once; the returned function answers any quantile of the same items.
export function quantiles(items) {
  const xs = items.filter(x => Number.isFinite(x.v) && x.w > 0).sort((a, b) => a.v - b.v);
  const total = xs.reduce((s, x) => s + x.w, 0);
  return p => quantileSorted(xs, total, p);
}
export function weightedQuantile(items, p) { return quantiles(items)(p); }
function quantileSorted(xs, total, p) {
  // xs: [{ v, w }] sorted by v (w > 0). Step quantile on the cumulative weight.
  if (!xs.length) return null;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < xs.length; i++) {
    cum += xs[i].w;
    if (cum >= target - 1e-12) {
      // Halfway between two values when the target lands exactly on a boundary.
      if (Math.abs(cum - target) < 1e-12 && i + 1 < xs.length) return (xs[i].v + xs[i + 1].v) / 2;
      return xs[i].v;
    }
  }
  return xs[xs.length - 1].v;
}
export const weightedMedian = items => weightedQuantile(items, 0.5);
export function effectiveN(weights) {
  const s = weights.reduce((a, w) => a + w, 0), s2 = weights.reduce((a, w) => a + w * w, 0);
  return s2 > 0 ? (s * s) / s2 : 0;
}
export function recencyWeight(ts, nowMs, halfLifeDays = HALF_LIFE_DAYS) {
  const age = Math.max(0, (nowMs - ts) / DAY_MS);
  return Math.pow(0.5, age / halfLifeDays);
}

// ---- Cleaning
// Returns { kept, excluded: { invalid, outdated, duplicate, outlier, beyond_cap? } }.
// obs: { id, key?, fare, miles, ts, ... }. `key` collapses duplicates
// (the same physical ride or report seen twice); the newest copy wins.
export function cleanFares(obs, nowMs, { windowDays = FARE_WINDOW_DAYS } = {}) {
  const L = FARE_LIMITS;
  const excluded = { invalid: 0, outdated: 0, duplicate: 0, outlier: 0 };
  const seen = new Map();
  for (const o of obs) {
    const ok = Number.isFinite(o.fare) && Number.isFinite(o.miles) && Number.isFinite(o.ts)
      && o.fare >= L.minUsd && o.fare <= L.maxUsd && o.miles >= L.minMiles && o.miles <= L.maxMiles
      && o.fare / o.miles >= L.minPerMile && o.fare / o.miles <= L.maxPerMile && o.ts <= nowMs + DAY_MS;
    if (!ok) { excluded.invalid++; continue; }
    if (nowMs - o.ts > windowDays * DAY_MS) { excluded.outdated++; continue; }
    const k = o.key || o.id;
    if (k != null && seen.has(k)) {
      excluded.duplicate++;
      if (o.ts > seen.get(k).ts) seen.set(k, o);
      continue;
    }
    seen.set(k != null ? k : Symbol('o'), o);
  }
  let kept = [...seen.values()];
  if (kept.length > MAX_FARE_OBS) {
    kept = kept.sort((x, y) => y.ts - x.ts).slice(0, MAX_FARE_OBS);
    excluded.beyond_cap = seen.size - MAX_FARE_OBS;
  }
  return { kept, excluded };
}

// Drop fares whose ratio to the fitted curve is far from the rest:
// |log ratio - median| > 3.5 robust SDs (MAD x 1.4826), but never closer
// than +/-60% of the curve: demand pricing legitimately moves fares by a
// third or more, and those fares are the evidence the tiers are fitted from.
const OUTLIER_MIN_LOG = Math.log(1.6);
function dropRatioOutliers(rows, curve) {
  const logs = rows.map(r => Math.log(r.fare / curveAt(curve, r.miles)));
  const med = weightedMedian(logs.map(v => ({ v, w: 1 })));
  const mad = weightedMedian(logs.map(v => ({ v: Math.abs(v - med), w: 1 })));
  const lim = Math.max(OUTLIER_MIN_LOG, 3.5 * mad * 1.4826);
  const kept = [], dropped = [];
  rows.forEach((r, i) => (Math.abs(logs[i] - med) <= lim ? kept : dropped).push(r));
  return { kept, dropped };
}

// ---- The fare curve: fare = a + b x miles, a robust slope-median fit.
// Fares are sorted by distance and each is paired with the fare half the
// sample further along (so every pair spans a real distance); the slope is
// the weighted median of those pair slopes, the base the weighted median of
// what is left. Like Theil-Sen, a few wild fares can't move it, but it costs
// O(n log n), which keeps the daily job inside a Worker's CPU budget.
export const curveAt = (curve, miles) => Math.max(0.5, curve.a + curve.b * miles);
export function fitCurve(rows) {
  // rows: [{ fare, miles, w }]
  const byMiles = [...rows].sort((x, y) => x.miles - y.miles);
  const h = Math.floor(byMiles.length / 2);
  const slopes = [];
  for (let i = 0; i + h < byMiles.length; i++) {
    const p = byMiles[i], q = byMiles[i + h], dm = q.miles - p.miles;
    if (dm < 0.5) continue;
    slopes.push({ v: (q.fare - p.fare) / dm, w: p.w * q.w });
  }
  let b;
  if (slopes.length >= 3) b = Math.min(15, Math.max(0, weightedMedian(slopes)));
  else b = Math.max(0, weightedMedian(rows.map(r => ({ v: r.fare / r.miles, w: r.w }))));
  const a = slopes.length >= 3 ? Math.min(30, Math.max(0, weightedMedian(rows.map(r => ({ v: r.fare - b * r.miles, w: r.w }))))) : 0;
  return { a: round(a), b: round(b, 3) };
}

// ---- Tiers from positive values (fare/curve ratios, or wait minutes).
// items: [{ v, w, slot, area? }]. Returns the tier centers and ranges, the
// tier each well-sampled time slot looks like, and the within-slot spread.
export function fitTiers(items, { minTierN = MIN_TIER_N, minTierNeff = MIN_TIER_NEFF } = {}) {
  const neff = effectiveN(items.map(x => x.w));
  const q = quantiles(items);
  const median = q(0.5);
  // Spread left once the time slot is known: each value over its slot's
  // median (slots with enough values), else over the overall median.
  const bySlot = groupBy(items, x => x.slot);
  const slotMedian = {};
  for (const [k, xs] of bySlot) if (xs.length >= MIN_SLOT_N) slotMedian[k] = weightedMedian(xs);
  const resid = items.map(x => ({ v: x.v / (slotMedian[x.slot] || median), w: x.w }));
  const rq = quantiles(resid);
  const lo = rq(0.1), hi = rq(0.9);
  const tiered = items.length >= minTierN && neff >= minTierNeff;
  const centers = tiered
    ? { quiet: q(TIER_CENTER_P.quiet), typical: median, busy: q(TIER_CENTER_P.busy) }
    : { quiet: median, typical: median, busy: median };
  const tiers = {};
  for (const t of TIERS) tiers[t] = { center: centers[t], lo: centers[t] * Math.min(1, lo), hi: centers[t] * Math.max(1, hi) };
  if (!tiered) {
    // One honest range: the overall 10th-90th percentile.
    const r = { center: median, lo: Math.min(median, q(0.1)), hi: Math.max(median, q(0.9)) };
    for (const t of TIERS) tiers[t] = { ...r };
  }
  // Which tier each slot resembles: its median beyond the 35th/65th
  // percentile AND clearly different from the overall median (more than two
  // standard errors of a median, on the log scale), so a handful of noisy
  // rides can't label a slot Quiet or Busy.
  const q35 = q(0.35), q65 = q(0.65);
  const logs = items.map(x => ({ v: Math.log(x.v / median), w: 1 }));
  const sigma = 1.4826 * weightedMedian(logs.map(x => ({ v: Math.abs(x.v), w: 1 })));
  const slots = {};
  for (const [k, xs] of bySlot) {
    if (xs.length < MIN_SLOT_N) { slots[k] = { n: xs.length, tier: null }; continue; }
    const m = slotMedian[k];
    const d = Math.log(m / median), se = 1.253 * sigma / Math.sqrt(xs.length);
    const tier = !tiered ? 'typical' : (m <= q35 && d < -2 * se) ? 'quiet' : (m >= q65 && d > 2 * se) ? 'busy' : 'typical';
    slots[k] = { n: xs.length, median: m, tier };
  }
  return { tiered, n: items.length, n_eff: neff, median, tiers, slots, spread: { lo, hi } };
}

function groupBy(xs, f) {
  const m = new Map();
  for (const x of xs) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// The tier assumed for a slot: a fitted slot tier, overridden to Busy when
// riders often found no car (>= 25% of >= 6 reports in that slot).
export function slotTier(slots, unavailability, slot) {
  const u = unavailability && unavailability[slot];
  if (u && u.n >= 6 && u.share >= 0.25) return 'busy';
  return (slots[slot] && slots[slot].tier) || 'typical';
}

// ---- Fare model for one vehicle group
// rows: cleaned fares [{ fare, miles, ts, slot, area, vehicle }]
export function buildFareModel(rows, nowMs, { unavailability = null, useTimeTiers = true } = {}) {
  if (rows.length < MIN_FIT_N) return null;
  const weighted = rows.map(r => ({ ...r, w: recencyWeight(r.ts, nowMs) }));
  let curve = fitCurve(weighted);
  const first = dropRatioOutliers(weighted, curve);
  const outliers = first.dropped.length;
  if (outliers) curve = fitCurve(first.kept);
  const kept = first.kept;
  if (kept.length < MIN_FIT_N) return null;
  const items = kept.map(r => ({ v: r.fare / curveAt(curve, r.miles), w: r.w, slot: r.slot, area: r.area }));
  const t = fitTiers(items);
  // Area adjustment, shrunk toward 1: 1 + (m - 1) x n / (n + 15), only for
  // areas with at least 15 fares.
  const area_mult = {};
  for (const [k, xs] of groupBy(items.filter(x => x.area), x => x.area)) {
    if (xs.length < 15) continue;
    const m = weightedMedian(xs) / t.median;
    area_mult[k] = round(1 + (m - 1) * xs.length / (xs.length + 15), 3);
  }
  const fares = kept.map(r => ({ v: r.fare, w: 1 }));
  const totalFare = kept.reduce((s, r) => s + r.fare, 0), totalMiles = kept.reduce((s, r) => s + r.miles, 0);
  const newest = Math.max(...kept.map(r => r.ts));
  return {
    basis: 'observed',
    n: kept.length,
    n_eff: round(t.n_eff, 1),
    outliers_dropped: outliers,
    newest_days: round((nowMs - newest) / DAY_MS, 1),
    a: curve.a, b: curve.b,
    tiered: t.tiered,
    tiers: normTiers(t.tiers),
    slots: t.slots,
    time_tiers: useTimeTiers && t.tiered,
    area_mult,
    stats: { median_fare: round(weightedMedian(fares)), per_mile: round(totalFare / totalMiles), median_miles: round(weightedMedian(kept.map(r => ({ v: r.miles, w: 1 }))), 1) },
    _unavailability: unavailability
  };
}
function normTiers(tiers) {
  const out = {};
  for (const t of TIERS) out[t] = { center: round(tiers[t].center, 3), lo: round(tiers[t].lo, 3), hi: round(tiers[t].hi, 3) };
  return out;
}

// Fare range for a trip under a tier (also in js/calc.js etaFareRange, the
// browser copy for the distance slider; keep the two equal).
export function fareRange(model, miles, tier = 'typical', area = null) {
  if (!model) return null;
  const t = model.tiers[tier] || model.tiers.typical;
  const base = (model.a + model.b * miles) * ((area && model.area_mult && model.area_mult[area]) || 1);
  const at = Math.max(0.5, base);
  return { center: at * t.center, lo: at * t.lo, hi: at * t.hi };
}

// The external fallback: the latest reported rate card's shape, scaled so a
// trip of the tracker's average length costs the tracker's median fare; the
// tiers are Obi's day-to-day range, split in thirds.
export function externalFareModel(city) {
  const e = EXTERNAL[city];
  if (!e || !e.rate_card || !e.tracker) return null;
  const k = e.tracker.median_fare / (e.rate_card.base + e.rate_card.per_mile * e.tracker.avg_miles);
  const third = (OBI_MULTIPLIERS.busy - OBI_MULTIPLIERS.quiet) / 3;
  const lo = OBI_MULTIPLIERS.quiet;
  return {
    basis: 'external',
    n: 0,
    scale: round(k, 3),
    a: round(e.rate_card.base * k), b: round(e.rate_card.per_mile * k, 3),
    tiered: true,
    tiers: normTiers({
      quiet: { center: lo + third / 2, lo, hi: lo + third },
      typical: { center: 1, lo: lo + third, hi: lo + 2 * third },
      busy: { center: lo + 2.5 * third, lo: lo + 2 * third, hi: OBI_MULTIPLIERS.busy }
    }),
    slots: {},
    time_tiers: false,
    area_mult: {}
  };
}

// ---- Waits
// rows: [{ minutes, ts, slot, area }] quoted waits (approved reports).
export function buildWaitModel(rows, nowMs, { unavailability = null } = {}) {
  const clean = rows.filter(r => Number.isFinite(r.minutes) && r.minutes >= WAIT_LIMITS.min && r.minutes <= WAIT_LIMITS.max && nowMs - r.ts <= WAIT_WINDOW_DAYS * DAY_MS);
  if (clean.length < MIN_WAIT_N) return null;
  // Floor at 1 minute so the ratios stay finite.
  const items = clean.map(r => ({ v: Math.max(1, r.minutes), w: recencyWeight(r.ts, nowMs), slot: r.slot, area: r.area }));
  const t = fitTiers(items);
  const area_mult = {}, area_n = {};
  for (const [k, xs] of groupBy(items.filter(x => x.area), x => x.area)) {
    area_n[k] = xs.length;
    if (xs.length < MIN_AREA_N) continue;
    const m = weightedMedian(xs) / t.median;
    area_mult[k] = round(1 + (m - 1) * xs.length / (xs.length + MIN_AREA_N), 3);
  }
  return {
    basis: 'observed',
    n: clean.length,
    n_eff: round(t.n_eff, 1),
    newest_days: round((nowMs - Math.max(...clean.map(r => r.ts))) / DAY_MS, 1),
    tiered: t.tiered,
    tiers: normTiers(t.tiers),     // minutes
    slots: t.slots,
    time_tiers: t.tiered,
    area_mult, area_n,
    _unavailability: unavailability
  };
}
export function externalWaitModel(city) {
  const e = EXTERNAL[city];
  if (!e || !e.wait_tiers) return null;
  const tiers = {};
  for (const t of TIERS) { const [lo, hi] = e.wait_tiers[t]; tiers[t] = { center: (lo + hi) / 2, lo, hi }; }
  return { basis: 'external', n: e.waits.length, tiered: true, tiers, slots: {}, time_tiers: false, area_mult: {}, area_n: {}, sources: e.waits.map(w => w.text) };
}
export function waitRange(model, tier = 'typical', area = null) {
  if (!model) return null;
  const t = model.tiers[tier] || model.tiers.typical;
  const m = (area && model.area_mult && model.area_mult[area]) || 1;
  return { center: t.center * m, lo: t.lo * m, hi: t.hi * m };
}

// Rider-reported actual pickup time vs the app's quote (minutes, + = later).
export function actualVsQuoted(rows) {
  const both = rows.filter(r => Number.isFinite(r.quoted) && Number.isFinite(r.actual));
  if (both.length < 5) return { n: both.length, median_delay: null };
  return { n: both.length, median_delay: round(weightedMedian(both.map(r => ({ v: r.actual - r.quoted, w: 1 }))), 1) };
}

// Share of reports where the app showed no car available, per slot and overall.
export function unavailabilityBySlot(reports) {
  const out = {};
  for (const [k, xs] of groupBy(reports, r => r.slot)) out[k] = { n: xs.length, share: round(xs.filter(r => r.no_cars).length / xs.length, 3) };
  const all = reports.length ? { n: reports.length, share: round(reports.filter(r => r.no_cars).length / reports.length, 3) } : { n: 0, share: null };
  return { slots: out, all };
}

// ---- Calibration: hold out the newest share of observations, fit on the
// rest, score on them. `build(train)` returns a model; `predict(model, row,
// tier)` returns { center, lo, hi }; `actual(row)` the observed value.
// `baselines` maps a name to train -> (row -> a point prediction) (the old
// formulas). Returns null when there are too few observations to check.
export function holdoutCheck(rows, { build, predict, actual, baselines = {}, testShare = 0.2, nowMs, unavailability = null, groupKeys = {} }) {
  if (rows.length < MIN_FIT_N + MIN_HOLDOUT_TEST) return null;
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const nTest = Math.max(MIN_HOLDOUT_TEST, Math.round(sorted.length * testShare));
  const train = sorted.slice(0, sorted.length - nTest), test = sorted.slice(sorted.length - nTest);
  const model = build(train);
  if (!model) return null;
  const score = (tierOf) => {
    const errs = [], pct = [], inside = [];
    for (const r of test) {
      const p = predict(model, r, tierOf(r));
      const y = actual(r);
      errs.push(Math.abs(p.center - y)); pct.push(Math.abs(p.center - y) / y); inside.push(y >= p.lo - 1e-9 && y <= p.hi + 1e-9);
    }
    return { errs, pct, inside };
  };
  const timed = score(r => slotTier(model.slots || {}, unavailability, r.slot));
  const flat = score(() => 'typical');
  const mae = xs => round(xs.reduce((s, x) => s + x, 0) / xs.length);
  const med = xs => round(weightedMedian(xs.map(v => ({ v, w: 1 }))));
  const useTime = !!model.time_tiers && test.length >= MIN_TIME_TEST && mae(timed.errs) < mae(flat.errs);
  const best = useTime ? timed : flat;
  // Per tier (the tier each held-out ride was assumed to be in).
  const per_tier = {};
  test.forEach((r, i) => {
    const t = useTime ? slotTier(model.slots || {}, unavailability, r.slot) : 'typical';
    const e = per_tier[t] || (per_tier[t] = { n: 0, abs: 0, inside: 0 });
    e.n++; e.abs += best.errs[i]; e.inside += best.inside[i] ? 1 : 0;
  });
  for (const t of Object.keys(per_tier)) { const e = per_tier[t]; per_tier[t] = { n: e.n, mae: round(e.abs / e.n), within: round(e.inside / e.n, 3) }; }
  // Breakdowns by any grouping the caller names (vehicle type, part of day, area).
  const by = {};
  for (const [name, keyOf] of Object.entries(groupKeys)) {
    const groups = {};
    test.forEach((r, i) => {
      const k = keyOf(r);
      if (k == null) return;
      const g = groups[k] || (groups[k] = { n: 0, abs: 0, inside: 0 });
      g.n++; g.abs += best.errs[i]; g.inside += best.inside[i] ? 1 : 0;
    });
    by[name] = Object.fromEntries(Object.entries(groups).filter(([, g]) => g.n >= 3).map(([k, g]) => [k, { n: g.n, mae: round(g.abs / g.n), within: round(g.inside / g.n, 3) }]));
  }
  const base = {};
  for (const [name, f] of Object.entries(baselines)) {
    const predict1 = f(train);
    const preds = test.map(r => predict1(r));
    if (preds.some(p => !Number.isFinite(p))) continue;
    const errs = test.map((r, i) => Math.abs(preds[i] - actual(r)));
    base[name] = { mae: mae(errs), mape: round(test.reduce((s, r, i) => s + errs[i] / actual(r), 0) / test.length, 3) };
  }
  return {
    n_train: train.length, n_test: test.length,
    test_from: new Date(test[0].ts).toISOString(), test_to: new Date(test[test.length - 1].ts).toISOString(),
    mae: mae(best.errs), median_ae: med(best.errs), mape: round(best.pct.reduce((s, x) => s + x, 0) / best.pct.length, 3),
    within_range: round(best.inside.filter(Boolean).length / best.inside.length, 3),
    time_tiers_helped: useTime,
    time_tiers_mae: model.time_tiers && test.length >= MIN_TIME_TEST ? mae(timed.errs) : null,
    typical_only_mae: mae(flat.errs),
    per_tier, by, baselines: base
  };
}

// Widen every tier's range (in log space, around its center) until at least
// `target` of the held-out values would have fallen inside; at most 2x.
export function widenTiers(model, check, target = 0.75) {
  if (!model || !check || check.n_test < MIN_TIME_TEST || check.within_range >= target) return { model, widened_by: 1 };
  // The shortfall is measured on held-out data; scale the log-width.
  const scale = Math.min(2, Math.max(1, target / Math.max(0.05, check.within_range)));
  const tiers = {};
  for (const t of TIERS) {
    const { center, lo, hi } = model.tiers[t];
    tiers[t] = { center, lo: round(center * Math.pow(lo / center, scale), 3), hi: round(center * Math.pow(hi / center, scale), 3) };
  }
  return { model: { ...model, tiers }, widened_by: round(scale, 2) };
}

// ---- Confidence (computed, never assigned): sample size, freshness and the
// held-out score. 'insufficient' when there is no estimate at all.
export function confidence(model, check, { borrowed = false } = {}) {
  if (!model) return { level: 'insufficient', reasons: ['No estimate: not enough data.'] };
  if (model.basis === 'external') return { level: 'low', reasons: ['No observations of its own yet; built from published reports.'] };
  const reasons = [];
  const neff = model.n_eff, fresh = model.newest_days;
  const checked = check && check.n_test >= 15;
  let level = 'low';
  if (neff >= 40 && fresh <= 14 && checked && check.within_range >= 0.7) level = 'high';
  else if (neff >= 12 && fresh <= 45 && (!checked || check.within_range >= 0.55)) level = 'medium';
  reasons.push(`${model.n} observations (effective ${neff} after weighting recent ones more).`);
  reasons.push(`Newest is ${fresh} days old.`);
  reasons.push(checked ? `${Math.round(check.within_range * 100)}% of ${check.n_test} held-out observations fell inside the range.` : 'Too few held-out observations to check accuracy yet.');
  if (borrowed && level === 'high') { level = 'medium'; reasons.push('Not separated by vehicle type.'); }
  return { level, reasons };
}

// Strip internal fields before storing.
export function publicModel(m) {
  if (!m) return null;
  const { _unavailability, ...rest } = m;
  return rest;
}
