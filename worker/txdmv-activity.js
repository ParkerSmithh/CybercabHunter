// Texas DMV registration activity: what changed between Cybercab Hunter's daily
// snapshots of TxDMV's TxMCCS roster (worker/txdmv.js), VIN decoding, and the
// read APIs for the DMV tracker (public/dmv.html, the iOS app).
//
// WHAT THE SOURCE IS. TxDMV's public TxMCCS roster of the vehicles Tesla
// Robotaxi, LLC lists under its SB 2807 automated-vehicle authorization. Each
// row is { vin, make, model, modelYear } and nothing else: no registration
// dates, no counties, no owners, and no dataset/publication date. So:
//   - "first detected" = the first of OUR snapshots that listed the VIN;
//   - "dataset date"   = the Central date of the poll that read the roster
//                        (the source carries no date of its own);
//   - there is no "DMV registration date" anywhere, and none is shown.
//
// ACTIVITY (processDmvActivity, after each daily poll, idempotent). Each
// snapshot not yet processed is compared with the previous ACCEPTED snapshot,
// VIN by VIN (never total minus total):
//   added    = listed now, never listed in any earlier snapshot
//   returned = listed now, listed before, but not in the previous snapshot
//   missing  = in the previous snapshot, not now (never called "deregistered")
//   net      = total - previous total
// One dmv_events row per snapshot (its primary key), so a re-run or a re-import
// of the same day never doubles an event. The first snapshot is the BASELINE:
// its VINs' real dates are unknown, so none counts as an addition. A snapshot
// that lost more than half the roster is HELD (no changes recorded; the next
// one compares against the last accepted snapshot) — a truncated read must not
// look like a mass deregistration. fetchRoster already refuses a roster whose
// unique VINs don't add up to the source's own total.
//
// DECODING (decodePendingVins, controlled background pass, cached in D1). NHTSA
// vPIC's batch decoder (the official one; it knows "Cybercab") is the primary
// source, cross-checked against TxDMV's own model label:
//   both agree               -> verified
//   only vPIC knows          -> vpic
//   only TxDMV's label       -> source_label   (vPIC not reached yet)
//   they disagree            -> conflict, shown as UNKNOWN
// A VIN is never called a Cybercab just because it isn't a Model Y. The plant is
// where the car was BUILT (from the VIN), never where it is.

import { classifyModel, centralDate, TESLA_AUTHORIZATION } from './txdmv.js';
import { publicVehicleEligibleSql } from './ride-status.js';

const VPIC = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/';
const VPIC_BATCH = 20;   // VINs per vPIC call: ~70 KB of JSON, a few ms of CPU to parse
const HOLD_RATIO = 0.5;
const CACHE_SECONDS = 300;
const STATUS_KEY = 'txdmv:last_attempt';
export const SOURCE = {
  name: 'TxDMV Motor Carrier Credentialing System (TxMCCS)',
  company: 'Tesla Robotaxi, LLC',
  authorization: TESLA_AUTHORIZATION,
  law: 'SB 2807',
  url: 'https://txmccs.txdmv.gov/automated-vehicles',
  fields: ['VIN', 'make', 'model', 'model year'],
  schedule: 'Checked once a day at about 6:30 AM Central. TxDMV does not publish when its roster changes.',
  decoder: { name: 'NHTSA vPIC', url: 'https://vpic.nhtsa.dot.gov/decoder/' }
};
export const MILESTONES = { cybercab_listed: 50, total_listed: 100 };   // every N
const CLASSES = ['cybercab', 'model_y', 'other_tesla', 'unknown'];

// ---------- pure helpers ----------

// ISO 3779 check digit (position 9).
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function vinCheckDigitOk(vin) {
  const v = String(vin || '').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i];
    const n = /\d/.test(c) ? Number(c) : TRANSLIT[c];
    sum += n * WEIGHTS[i];
  }
  const r = sum % 11;
  return v[8] === (r === 10 ? 'X' : String(r));
}

// TxDMV's label as a decode class.
export function sourceClass(model, make, vin) {
  const c = classifyModel(model, vin);
  if (c !== 'other') return c;
  return String(model || '').trim() && /tesla/i.test(String(make || '')) ? 'other_tesla' : 'unknown';
}

// vPIC's answer as a decode class (only a clean Tesla decode names a model).
export function vpicClass(r) {
  if (!r || !/^TESLA/i.test(String(r.Make || ''))) return 'unknown';
  const m = String(r.Model || '').trim().toLowerCase();
  if (m === 'cybercab') return 'cybercab';
  if (m === 'model y') return 'model_y';
  return m ? 'other_tesla' : 'unknown';
}

// TxDMV label + vPIC -> { model_class, status }.
export function combineDecode(txdmv, vpic) {
  const specific = c => c === 'cybercab' || c === 'model_y' || c === 'other_tesla';
  if (!vpic || !specific(vpic)) return specific(txdmv) ? { model_class: txdmv, status: 'source_label' } : { model_class: 'unknown', status: 'unknown' };
  if (!specific(txdmv)) return { model_class: vpic, status: 'vpic' };
  if (txdmv === vpic) return { model_class: vpic, status: 'verified' };
  return { model_class: 'unknown', status: 'conflict' };
}

// The VIN-level comparison of two rosters. `firstSeen` maps VIN -> first_seen_date.
export function compareRosters(prevVins, curVins, date, firstSeen) {
  const prev = new Set(prevVins), cur = new Set(curVins);
  const added = [], returned = [], missing = [];
  for (const v of cur) if (!prev.has(v)) (firstSeen.get(v) && firstSeen.get(v) < date ? returned : added).push(v);
  for (const v of prev) if (!cur.has(v)) missing.push(v);
  return { added, returned, missing };
}

// ---------- processing ----------
//
// Workers Free gives each invocation 50 subrequests (fetch, D1 and KV calls
// together) and 10 ms of CPU. So the work runs as small steps (runDmvStep), each
// one resumable and idempotent: a snapshot's comparison is ONE guarded D1 batch
// done entirely in SQL (the Worker never parses a roster), and decoding takes
// one vPIC call of VPIC_BATCH VINs. D1 itself is the progress record: a snapshot
// is done when its dmv_events row exists, a VIN when its dmv_vin_decode row is
// verified. An interrupted step leaves nothing half-written (a batch is a
// transaction); the next step carries on where it stopped.
//
// Off until the owner turns it on (never from a public request), with wrangler:
//   wrangler kv key put --binding TESLA_SESSIONS --remote txdmv:activity:mode <mode>
//   off / absent  nothing runs
//   on            one step a day, right after the 6:30 AM TxDMV poll (same invocation)
//   backfill      also one step on the existing news cron at :25 and :55 while a
//                 backlog remains; switches itself back to "on" when it's done
// Pausing = putting "off". D1 holds the progress, so nothing is lost.
export const MODE_KEY = 'txdmv:activity:mode';
export const PROGRESS_KEY = 'txdmv:activity:progress';
export const STEP_LIMITS = { snapshots: 3, decodeCalls: 3 };
// Subrequests one step may use (D1 + KV + fetch all count on Workers Free, 50 per
// invocation). The daily step gets what the poll left, minus a margin.
export const STEP_BUDGET = 18;
export const INVOCATION_SUBREQUESTS = 50;
export const SAFETY_MARGIN = 10;

// TxDMV's label as a class, in SQL (the same rules as classifyModel).
const labelSql = (m, v) => `CASE replace(lower(trim(COALESCE(${m}, ''))), '  ', ' ')
    WHEN 'cybercab' THEN 'cybercab' WHEN 'model y' THEN 'model_y'
    WHEN '' THEN CASE WHEN upper(${v}) LIKE '5YJA%' THEN 'cybercab' WHEN upper(${v}) LIKE '7SAY%' THEN 'model_y' ELSE 'other' END
    ELSE 'other' END`;

// One bounded step: up to limits.snapshots snapshot comparisons, then up to
// limits.decodeCalls vPIC calls, never more than `budget` subrequests (each unit
// is checked before it starts, so the step stops cleanly instead of failing
// half way). `force` skips the mode switch (tests, local dev).
export async function runDmvStep(env, { fetchImpl = fetch, nowMs = Date.now(), limits = STEP_LIMITS, budget = STEP_BUDGET, force = false, source = 'manual' } = {}) {
  const sql = env.cybercabhunter_db;
  const t0 = Date.now();
  const out = { mode: 'on', processed: [], decoded: 0, decode_error: null, worked: false, subrequests: 0, pending_snapshots: 0 };
  const spend = n => { if (out.subrequests + n > budget - 1) return false; out.subrequests += n; return true; };   // -1: the progress note
  if (!force) {
    if (!spend(1)) return out;
    out.mode = (await env.TESLA_SESSIONS.get(MODE_KEY)) || 'off';
    if (out.mode !== 'on' && out.mode !== 'backfill') return out;
  }
  try {
    if (!spend(1)) return out;
    const { results: pending } = await sql.prepare(`SELECT s.snapshot_date, COUNT(*) OVER () AS n FROM dmv_snapshots s
        WHERE NOT EXISTS (SELECT 1 FROM dmv_events e WHERE e.snapshot_date = s.snapshot_date)
        ORDER BY s.snapshot_date LIMIT ?`).bind(limits.snapshots).all();
    out.pending_snapshots = Number(((pending || [])[0] || {}).n) || 0;
    for (const { snapshot_date: date } of pending || []) {
      if (!spend(2)) break;
      const r = await processSnapshot(sql, date, nowMs);
      out.processed.push(r);
      if (r.status === 'skipped') break;       // another run got there first: stop, the next step resumes
      out.pending_snapshots--;
    }
    // Decoding only once every snapshot is compared (each new VIN's decode row is
    // written by its snapshot), one vPIC call at a time.
    for (let call = 0; call < limits.decodeCalls && out.pending_snapshots === 0; call++) {
      if (!spend(3)) break;
      let n;
      try { n = await decodePendingVins(env, { fetchImpl, nowMs, maxCalls: 1 }); }
      catch (e) { out.decode_error = String((e && e.message) || e).slice(0, 120); break; }   // vPIC down: back off, don't retry now
      out.decoded += n;
      if (!n) { out.decode_queue_empty = true; break; }
    }
  } catch (e) {
    // D1 failure or limit: stop; the step's batches are all-or-nothing, the next one resumes.
    out.error = String((e && e.message) || e).slice(0, 120);
  }
  out.worked = out.processed.some(p => p.status !== 'skipped') || out.decoded > 0;
  if (out.worked && spend(1)) { try { await refreshSummary(sql, nowMs); } catch (e) { out.error = out.error || 'summary_failed'; } }
  out.ms = Date.now() - t0;
  if ((out.worked || out.error || out.decode_error) && !force) {
    const note = { at: new Date(nowMs).toISOString(), source, mode: out.mode, ms: out.ms, subrequests: out.subrequests + 1,
      processed: out.processed.map(p => `${p.date}:${p.status}${p.added ? `+${p.added}` : ''}${p.missing ? `-${p.missing}` : ''}`),
      decoded: out.decoded, pending_snapshots: out.pending_snapshots, decode_error: out.decode_error, error: out.error || null };
    console.log(JSON.stringify({ dmv_step: note }));          // Workers Logs / wrangler tail
    try { await env.TESLA_SESSIONS.put(PROGRESS_KEY, JSON.stringify(note)); } catch (e) { /* the note only */ }
  }
  return out;
}

// The read APIs' precomputed totals (dmv_summary): one statement, all in SQL.
export function refreshSummary(sql, nowMs = Date.now()) {
  return sql.prepare(`INSERT INTO dmv_summary (id, snapshot_date, totals, years, decode_due, updated_at)
      SELECT 1, l.d,
        (SELECT json_group_object(cls, n) FROM (SELECT ${ROSTER_CLASS_SQL} AS cls, COUNT(*) AS n FROM dmv_av_vehicles v
           LEFT JOIN dmv_vin_decode dd ON dd.vin = v.vin WHERE v.last_seen_date = l.d GROUP BY cls)),
        (SELECT json_group_array(y) FROM (SELECT DISTINCT model_year AS y FROM dmv_av_vehicles WHERE model_year IS NOT NULL ORDER BY y DESC)),
        (SELECT COUNT(*) FROM dmv_vin_decode WHERE next_attempt_at IS NOT NULL), ?
      FROM (SELECT MAX(snapshot_date) AS d FROM dmv_snapshots) l WHERE l.d IS NOT NULL
      ON CONFLICT(id) DO UPDATE SET snapshot_date = excluded.snapshot_date, totals = excluded.totals,
        years = excluded.years, decode_due = excluded.decode_due, updated_at = excluded.updated_at`).bind(new Date(nowMs).toISOString()).run();
}
// The summary when it is for `date` (else null: count live).
async function summaryFor(sql, date) {
  const r = await sql.prepare('SELECT totals, years, decode_due FROM dmv_summary WHERE id = 1 AND snapshot_date = ?').bind(date).first();
  return r ? { totals: JSON.parse(r.totals || '{}'), years: JSON.parse(r.years || '[]'), decode_due: r.decode_due } : null;
}

// Every step until nothing is left: tests and local dev only (one Free
// invocation must never do this; production runs one step per invocation).
export async function processDmvActivity(env, { fetchImpl = fetch, nowMs = Date.now(), maxSteps = 200 } = {}) {
  const out = { processed: [], decoded: 0, decode_error: null, steps: 0 };
  for (let i = 0; i < maxSteps; i++) {
    const r = await runDmvStep(env, { fetchImpl, nowMs, force: true });
    out.steps++;
    out.processed.push(...r.processed);
    out.decoded += r.decoded;
    if (r.decode_error) { out.decode_error = r.decode_error; if (!r.processed.length) break; }
    if (!r.worked) break;
  }
  return out;
}

// One snapshot: one small read (counts and the previous accepted snapshot), then
// one batch that compares the two rosters VIN by VIN in SQL and writes the
// changes, milestones and the event. Every statement carries the same guard —
// this snapshot has no event yet, no earlier snapshot is pending, and the
// previous accepted snapshot is still the one read — so a repeated or
// overlapping run writes nothing, and the batch is all-or-nothing.
async function processSnapshot(sql, date, nowMs) {
  const s = await sql.prepare(`SELECT s.total, s.cybercab_count AS cc, json_array_length(s.raw_json) AS n,
        p.snapshot_date AS prev_date, p.total AS prev_total, p.cybercab_count AS prev_cc, json_array_length(p.raw_json) AS prev_n
      FROM dmv_snapshots s
      LEFT JOIN dmv_snapshots p ON p.snapshot_date = (SELECT e.snapshot_date FROM dmv_events e
        WHERE e.snapshot_date < s.snapshot_date AND e.status IN ('baseline', 'ok') ORDER BY e.snapshot_date DESC LIMIT 1)
      WHERE s.snapshot_date = ?`).bind(date).first();
  if (!s) return { date, status: 'skipped' };
  const prev = s.prev_date || null;
  const processedAt = new Date(nowMs).toISOString();
  const GUARD = `NOT EXISTS (SELECT 1 FROM dmv_events WHERE snapshot_date = ?1)
      AND NOT EXISTS (SELECT 1 FROM dmv_snapshots s2 WHERE s2.snapshot_date < ?1
                      AND NOT EXISTS (SELECT 1 FROM dmv_events e2 WHERE e2.snapshot_date = s2.snapshot_date))
      AND (SELECT MAX(snapshot_date) FROM dmv_events WHERE snapshot_date < ?1 AND status IN ('baseline', 'ok')) IS ?2`;
  const event = (status, counts) => sql.prepare(`INSERT INTO dmv_events
      (snapshot_date, prev_snapshot_date, status, added, returned, missing, net, total, processed_at)
      SELECT ?1, ?2, ?3, ${counts}, ?4, ?5, ?6 WHERE ${GUARD}`)
    .bind(date, prev, status, prev ? s.total - s.prev_total : 0, s.total, processedAt);
  const zero = '0, 0, 0';
  const roster = d => `(SELECT json_extract(j.value, '$.vin') AS vin, json_extract(j.value, '$.model') AS model, json_extract(j.value, '$.make') AS make
      FROM json_each((SELECT raw_json FROM dmv_snapshots WHERE snapshot_date = ${d})) j)`;
  const readBack = sql.prepare('SELECT status, added, returned, missing, processed_at FROM dmv_events WHERE snapshot_date = ?').bind(date);
  const finish = async (stmts, status) => {
    const res = await sql.batch([...stmts, readBack]);
    const row = ((res[res.length - 1] || {}).results || [])[0];
    if (!row || row.processed_at !== processedAt) return { date, status: 'skipped' };
    return { date, status: row.status, added: row.added, returned: row.returned, missing: row.missing, total: s.total };
  };

  // Each VIN's decode row starts from TxDMV's label the moment it is first seen,
  // due for vPIC now (the queue decodePendingVins works through).
  const labelRows = (where) => sql.prepare(`INSERT OR IGNORE INTO dmv_vin_decode
        (vin, model_class, status, manufacturer, source, decoded_at, attempts, next_attempt_at)
      SELECT vin, cls, CASE cls WHEN 'unknown' THEN 'unknown' ELSE 'source_label' END, make, 'txdmv', ?3, 0, ?3
      FROM (SELECT c.vin, c.make, CASE ${labelSql('c.model', 'c.vin')} WHEN 'other' THEN
                   CASE WHEN trim(COALESCE(c.model, '')) <> '' AND lower(COALESCE(c.make, '')) LIKE '%tesla%' THEN 'other_tesla' ELSE 'unknown' END
                 ELSE ${labelSql('c.model', 'c.vin')} END AS cls
            FROM ${roster('?1')} c WHERE c.vin IS NOT NULL ${where})
      WHERE ${GUARD}`).bind(date, prev, processedAt);

  if (!prev) return finish([labelRows(''), event('baseline', zero)]);
  if (!s.n || s.n < s.prev_n * HOLD_RATIO) return finish([event('held', zero)]);

  const stmts = [
    // In this snapshot, not in the previous one: added, or returned when first seen earlier.
    sql.prepare(`INSERT INTO dmv_changes (snapshot_date, vin, change, source_class)
        SELECT ?1, c.vin, CASE WHEN v.first_seen_date IS NOT NULL AND v.first_seen_date < ?1 THEN 'returned' ELSE 'added' END,
               ${labelSql('c.model', 'c.vin')}
        FROM ${roster('?1')} c LEFT JOIN dmv_av_vehicles v ON v.vin = c.vin
        WHERE c.vin IS NOT NULL AND c.vin NOT IN (SELECT p.vin FROM ${roster('?2')} p WHERE p.vin IS NOT NULL)
          AND ${GUARD}`).bind(date, prev),
    // In the previous snapshot, not in this one: missing (never "deregistered").
    sql.prepare(`INSERT INTO dmv_changes (snapshot_date, vin, change, source_class)
        SELECT ?1, p.vin, 'missing', ${labelSql('p.model', 'p.vin')}
        FROM ${roster('?2')} p
        WHERE p.vin IS NOT NULL AND p.vin NOT IN (SELECT c.vin FROM ${roster('?1')} c WHERE c.vin IS NOT NULL)
          AND ${GUARD}`).bind(date, prev),
    labelRows(`AND c.vin NOT IN (SELECT p.vin FROM ${roster('?2')} p WHERE p.vin IS NOT NULL)`)
  ];
  // Milestones crossed at this snapshot (never ones already passed at the baseline).
  for (const [metric, step] of Object.entries(MILESTONES)) {
    const was = metric === 'cybercab_listed' ? s.prev_cc : s.prev_total;
    const now = metric === 'cybercab_listed' ? s.cc : s.total;
    for (let t = (Math.floor(was / step) + 1) * step; t <= now; t += step) {
      stmts.push(sql.prepare(`INSERT OR IGNORE INTO dmv_milestones (metric, threshold, snapshot_date, value) SELECT ?3, ?4, ?1, ?5 WHERE ${GUARD}`).bind(date, prev, metric, t, now));
    }
  }
  stmts.push(event('ok', `(SELECT COUNT(*) FROM dmv_changes WHERE snapshot_date = ?1 AND change = 'added'),
        (SELECT COUNT(*) FROM dmv_changes WHERE snapshot_date = ?1 AND change = 'returned'),
        (SELECT COUNT(*) FROM dmv_changes WHERE snapshot_date = ?1 AND change = 'missing')`));
  return finish(stmts);
}

// Decode VINs with no decode yet (or not verified and over a week old):
// TxDMV's label at once, then vPIC in batches of 50. A vPIC failure keeps the
// labels and stops for this run.
// The decode queue: rows due for vPIC (next_attempt_at <= now), oldest first,
// one vPIC call of VPIC_BATCH VINs each. Verified rows leave the queue for good;
// anything else is retried with backoff (1 h doubling to 7 days, at most
// MAX_DECODE_ATTEMPTS), so a vPIC outage never loops and never blocks the
// import. TxDMV's label stays in place meanwhile; nothing becomes "verified"
// unless vPIC and TxDMV agree.
const MAX_DECODE_ATTEMPTS = 10;
const BACKOFF_SQL = (now) => `CASE WHEN attempts + 1 >= ${MAX_DECODE_ATTEMPTS} THEN NULL
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '+' || min(1 << attempts, 168) || ' hours') END`;
export async function decodePendingVins(env, { fetchImpl = fetch, nowMs = Date.now(), maxCalls = 1 } = {}) {
  const sql = env.cybercabhunter_db;
  const now = new Date(nowMs).toISOString();
  let decoded = 0;
  for (let call = 0; call < maxCalls; call++) {
    const { results } = await sql.prepare(`SELECT d.vin, v.make, v.model FROM dmv_vin_decode d
        JOIN dmv_av_vehicles v ON v.vin = d.vin
        WHERE d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
        ORDER BY d.next_attempt_at, d.vin LIMIT ?`).bind(now, VPIC_BATCH).all();
    const rows = results || [];
    if (!rows.length) break;
    const byVin = new Map(rows.map(r => [r.vin, { cls: sourceClass(r.model, r.make, r.vin), ok: vinCheckDigitOk(r.vin) ? 1 : 0 }]));
    const vins = JSON.stringify(rows.map(r => r.vin));
    let body;
    try {
      const resp = await fetchImpl(VPIC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CybercabHunter/1.0 (+https://cybercabhunter.com; VIN decode of the TxDMV AV roster)' },
        body: new URLSearchParams({ format: 'json', data: rows.map(r => r.vin).join(';') }).toString(),
        signal: AbortSignal.timeout(15000)
      });
      if (!resp.ok) throw new Error(`vpic_http_${resp.status}`);
      body = await resp.json();
    } catch (e) {
      // vPIC down or slow: these VINs back off; the rest of the step is unaffected.
      await sql.prepare(`UPDATE dmv_vin_decode SET next_attempt_at = ${BACKOFF_SQL('?1')}, attempts = attempts + 1
          WHERE vin IN (SELECT value FROM json_each(?2))`).bind(now, vins).run();
      throw e;
    }
    const decodes = [];
    for (const r of (body && body.Results) || []) {
      const vin = String(r.VIN || '').toUpperCase();
      const l = byVin.get(vin);
      if (!l) continue;
      const { model_class, status } = combineDecode(l.cls, vpicClass(r));
      const year = Number.parseInt(r.ModelYear, 10);
      decodes.push({
        vin, model_class, status,
        manufacturer: r.Manufacturer || r.Make || null,
        decoded_model: r.Model || null,
        model_year: Number.isInteger(year) ? year : null,
        plant_city: r.PlantCity || null, plant_state: r.PlantState || null, plant_country: r.PlantCountry || null,
        vehicle_type: r.VehicleType || null, body_class: r.BodyClass || null,
        check_digit_ok: l.ok
      });
    }
    // One statement: the decoded rows (verified ones leave the queue), and any VIN
    // vPIC didn't answer for backs off like a failure.
    await sql.batch([
      sql.prepare(`UPDATE dmv_vin_decode SET
            model_class = json_extract(j.value, '$.model_class'), status = json_extract(j.value, '$.status'),
            manufacturer = json_extract(j.value, '$.manufacturer'), decoded_model = json_extract(j.value, '$.decoded_model'),
            model_year = json_extract(j.value, '$.model_year'), plant_city = json_extract(j.value, '$.plant_city'),
            plant_state = json_extract(j.value, '$.plant_state'), plant_country = json_extract(j.value, '$.plant_country'),
            vehicle_type = json_extract(j.value, '$.vehicle_type'), body_class = json_extract(j.value, '$.body_class'),
            check_digit_ok = json_extract(j.value, '$.check_digit_ok'), source = 'vpic', decoded_at = ?1,
            next_attempt_at = CASE WHEN json_extract(j.value, '$.status') = 'verified' THEN NULL ELSE ${BACKOFF_SQL('?1')} END,
            attempts = attempts + 1
          FROM json_each(?2) j WHERE dmv_vin_decode.vin = json_extract(j.value, '$.vin')`).bind(now, JSON.stringify(decodes)),
      sql.prepare(`UPDATE dmv_vin_decode SET next_attempt_at = ${BACKOFF_SQL('?1')}, attempts = attempts + 1
          WHERE vin IN (SELECT value FROM json_each(?2)) AND (decoded_at <> ?1 OR source <> 'vpic')`).bind(now, vins)
    ]);
    decoded += decodes.length;
  }
  return decoded;
}

// ---------- read APIs (D1 only; never TxDMV or vPIC) ----------

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': status === 200 ? `public, max-age=${CACHE_SECONDS}` : 'no-store' } });
const unavailable = () => json({ success: false, error: 'registrations_unavailable' }, 503);
const CLASS_SQL = `COALESCE(dd.model_class, CASE c.source_class WHEN 'other' THEN 'unknown' ELSE c.source_class END)`;
// A roster VIN (dmv_av_vehicles v) not decoded yet — e.g. between the migration and the
// first processing run — falls back to TxDMV's own explicit label (never the VIN prefix).
const ROSTER_CLASS_SQL = `COALESCE(dd.model_class, CASE lower(trim(v.model)) WHEN 'cybercab' THEN 'cybercab' WHEN 'model y' THEN 'model_y' ELSE 'unknown' END)`;

async function cached(request, ctx, build) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  let response;
  try { response = await build(); } catch (e) { return unavailable(); }
  if (cache && response.status === 200) { const p = cache.put(key, response.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(p); }
  return response;
}

// Per-event class breakdowns of the added VINs: { date: { cybercab, model_y, other_tesla, unknown } }.
async function breakdowns(sql, dates) {
  if (!dates.length) return {};
  const { results } = await sql.prepare(`SELECT c.snapshot_date AS date, ${CLASS_SQL} AS cls, COUNT(*) AS n
      FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin
      WHERE c.change = 'added' AND c.snapshot_date IN (SELECT value FROM json_each(?))
      GROUP BY c.snapshot_date, cls`).bind(JSON.stringify(dates)).all();
  const out = Object.fromEntries(dates.map(d => [d, Object.fromEntries(CLASSES.map(c => [c, 0]))]));
  for (const r of results || []) out[r.date][CLASSES.includes(r.cls) ? r.cls : 'unknown'] += Number(r.n);
  return out;
}

const eventRow = (e, b) => ({
  date: e.snapshot_date,                  // the dataset (poll) date, America/Chicago
  processed_at: e.processed_at,
  polled_at: e.polled_at || null,
  previous_date: e.prev_snapshot_date,
  status: e.status,
  added: e.added, returned: e.returned, missing: e.missing, net: e.net, total: e.total,
  added_by_model: b || null
});

// Freshness: current / update_pending / import_failed / source_unavailable / stale.
function freshness(latest, attempt, nowMs) {
  const today = centralDate(nowMs);
  const yesterday = centralDate(nowMs - 864e5);
  let status = 'current';
  if (!latest) status = attempt && !attempt.ok ? 'source_unavailable' : 'historical_incomplete';
  else if (attempt && !attempt.ok && attempt.at > latest.polled_at) status = /http|timeout|fetch/i.test(attempt.error || '') ? 'source_unavailable' : 'import_failed';
  else if (latest.date === today) status = 'current';
  else if (latest.date === yesterday) status = 'update_pending';
  else status = 'stale';
  return status;
}

// GET /api/dmv/overview — the dashboard.
export function apiDmvOverview(request, env, ctx, { nowMs = Date.now() } = {}) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    let attempt = null;
    try { attempt = JSON.parse((await env.TESLA_SESSIONS.get(STATUS_KEY)) || 'null'); } catch (e) { attempt = null; }
    const latest = await sql.prepare(`SELECT snapshot_date AS date, total, polled_at FROM dmv_snapshots ORDER BY snapshot_date DESC LIMIT 1`).first();
    const base = { source: SOURCE, latest: null, totals: null, latest_update: null, previous_snapshot: null, freshness: { status: freshness(null, attempt, nowMs), last_attempt: attempt ? { at: attempt.at, ok: !!attempt.ok } : null }, milestones: [], insights: [], tracking_since: null };
    if (!latest) return json(base);
    const [summary, first, changeEvents, prevSnap, milestones, okEvents, recentAdded] = await sql.batch([
      sql.prepare('SELECT totals, decode_due FROM dmv_summary WHERE id = 1 AND snapshot_date = ?').bind(latest.date),
      sql.prepare(`SELECT MIN(snapshot_date) AS d, (SELECT COUNT(*) FROM dmv_snapshots s WHERE NOT EXISTS (SELECT 1 FROM dmv_events e WHERE e.snapshot_date = s.snapshot_date)) AS pending FROM dmv_snapshots`),
      sql.prepare(`SELECT e.*, s.polled_at FROM dmv_events e JOIN dmv_snapshots s ON s.snapshot_date = e.snapshot_date
          WHERE e.status = 'ok' AND (e.added > 0 OR e.missing > 0 OR e.returned > 0) ORDER BY e.snapshot_date DESC LIMIT 12`),
      sql.prepare(`SELECT snapshot_date AS date, total FROM dmv_snapshots WHERE snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1`).bind(latest.date),
      sql.prepare(`SELECT metric, threshold, snapshot_date AS date, value FROM dmv_milestones ORDER BY snapshot_date DESC, threshold DESC LIMIT 10`),
      sql.prepare(`SELECT snapshot_date, added FROM dmv_events WHERE status = 'ok' ORDER BY snapshot_date DESC LIMIT 60`),
      sql.prepare(`SELECT ${CLASS_SQL} AS cls, COUNT(*) AS n FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin
          WHERE c.change = 'added' AND c.snapshot_date > ? GROUP BY cls`).bind(new Date(Date.parse(`${latest.date}T12:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10))
    ]);
    // Totals by class: the precomputed summary (1 row) when it is for this
    // snapshot, else counted live (right after the migration, or after a poll
    // before its processing step).
    const sm = (summary.results || [])[0];
    let classRows = sm ? Object.entries(JSON.parse(sm.totals || '{}')).map(([cls, n]) => ({ cls, n })) : null;
    if (!classRows) {
      classRows = (await sql.prepare(`SELECT ${ROSTER_CLASS_SQL} AS cls, COUNT(*) AS n FROM dmv_av_vehicles v
          LEFT JOIN dmv_vin_decode dd ON dd.vin = v.vin WHERE v.last_seen_date = ? GROUP BY cls`).bind(latest.date).all()).results || [];
    }
    const totals = Object.fromEntries(CLASSES.map(c => [c, 0]));
    for (const r of classRows) totals[CLASSES.includes(r.cls) ? r.cls : 'unknown'] += Number(r.n);
    totals.total = latest.total;
    const changes = changeEvents.results || [];
    const b = await breakdowns(sql, changes.map(e => e.snapshot_date));
    const latestUpdate = changes[0] ? eventRow(changes[0], b[changes[0].snapshot_date]) : null;
    const prev = (prevSnap.results || [])[0] || null;

    // Insights: only from stored records.
    const insights = [];
    const daysAgo = d => Math.round((Date.parse(`${centralDate(nowMs)}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
    if (latestUpdate) {
      const lb = latestUpdate.added_by_model;
      const md = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      insights.push({ key: 'latest_update', text: `${latestUpdate.added} new VIN${latestUpdate.added === 1 ? '' : 's'} detected on ${md(latestUpdate.date)}${lb ? ` (${lb.cybercab} Cybercab, ${lb.model_y} Model Y${lb.other_tesla + lb.unknown ? `, ${lb.other_tesla + lb.unknown} other or unknown` : ''})` : ''}.` });
      insights.push({ key: 'since_change', text: daysAgo(latestUpdate.date) === 0 ? 'The roster changed in today\'s snapshot.' : `No new VINs in the ${daysAgo(latestUpdate.date)} day${daysAgo(latestUpdate.date) === 1 ? '' : 's'} since ${md(latestUpdate.date)}.` });
    }
    const added30 = Object.fromEntries(CLASSES.map(c => [c, 0]));
    for (const r of recentAdded.results || []) added30[CLASSES.includes(r.cls) ? r.cls : 'unknown'] += Number(r.n);
    const sum30 = CLASSES.reduce((s, c) => s + added30[c], 0);
    if (sum30 > 0) insights.push({ key: 'share_30d', text: `Model Y is ${Math.round(added30.model_y / sum30 * 100)}% and Cybercab ${Math.round(added30.cybercab / sum30 * 100)}% of the ${sum30} VINs first detected in the last 30 days.` });
    let streak = 0;
    for (const e of changes) { if ((b[e.snapshot_date] || {}).cybercab > 0) streak++; else break; }
    if (streak >= 2) insights.push({ key: 'cybercab_streak', text: `${streak} consecutive roster changes included new Cybercab VINs.` });
    insights.push({ key: 'freshness', text: `The latest snapshot was read ${daysAgo(latest.date) === 0 ? 'today' : `${daysAgo(latest.date)} day${daysAgo(latest.date) === 1 ? '' : 's'} ago`}.` });

    return json({
      ...base,
      latest: { date: latest.date, polled_at: latest.polled_at },
      totals,
      latest_update: latestUpdate,
      recent_updates: changes.slice(0, 5).map(e => eventRow(e, b[e.snapshot_date])),
      previous_snapshot: prev ? { date: prev.date, total: prev.total, net: latest.total - prev.total } : null,
      freshness: { ...base.freshness, status: freshness(latest, attempt, nowMs), last_success: latest.polled_at },
      tracking_since: (first.results || [])[0] ? first.results[0].d : null,
      milestones: (milestones.results || []).map(m => ({ ...m, label: m.metric === 'cybercab_listed' ? `${m.threshold} Cybercabs on the roster` : `${m.threshold} vehicles on the roster` })),
      insights,
      added_30d: { ...added30, total: sum30 },
      update_count: (okEvents.results || []).filter(e => e.added > 0).length,
      // Snapshots not yet compared (e.g. right after the migration, until the next daily run).
      processing_pending: Number(((first.results || [])[0] || {}).pending) || 0,
      decode_pending: sm ? Number(sm.decode_due) || 0 : null
    });
  });
}

// GET /api/dmv/activity?limit&offset&from&to&kind=additions|missing|all&model=
// Processed snapshots with changes (newest first), each with its breakdown.
export function apiDmvActivity(request, env, ctx) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    const p = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(p.get('limit')) || 20, 1), 100);
    const offset = Math.max(Number(p.get('offset')) || 0, 0);
    const date = s => (/^\d{4}-\d\d-\d\d$/.test(s || '') ? s : null);
    const where = [`e.status = 'ok'`];
    const binds = [];
    const kind = p.get('kind');
    if (kind === 'missing') where.push('e.missing > 0');
    else if (kind === 'all') where.push('(e.added > 0 OR e.missing > 0 OR e.returned > 0)');
    else where.push('e.added > 0');
    if (date(p.get('from'))) { where.push('e.snapshot_date >= ?'); binds.push(p.get('from')); }
    if (date(p.get('to'))) { where.push('e.snapshot_date <= ?'); binds.push(p.get('to')); }
    const model = p.get('model');
    if (CLASSES.includes(model)) {
      where.push(`EXISTS (SELECT 1 FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin WHERE c.snapshot_date = e.snapshot_date AND c.change = 'added' AND ${CLASS_SQL} = ?)`);
      binds.push(model);
    }
    const [rows, count, baseline] = await sql.batch([
      sql.prepare(`SELECT e.*, s.polled_at FROM dmv_events e JOIN dmv_snapshots s ON s.snapshot_date = e.snapshot_date WHERE ${where.join(' AND ')} ORDER BY e.snapshot_date DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
      sql.prepare(`SELECT COUNT(*) AS n FROM dmv_events e WHERE ${where.join(' AND ')}`).bind(...binds),
      sql.prepare(`SELECT snapshot_date AS date, total FROM dmv_events WHERE status = 'baseline' ORDER BY snapshot_date LIMIT 1`)
    ]);
    const events = rows.results || [];
    const b = await breakdowns(sql, events.map(e => e.snapshot_date));
    return json({
      total: Number(((count.results || [])[0] || {}).n) || 0, limit, offset,
      baseline: (baseline.results || [])[0] || null,
      events: events.map(e => eventRow(e, b[e.snapshot_date]))
    });
  });
}

// GET /api/dmv/activity/:date?change=added|missing|returned&model=&limit&offset — one update's VIN list.
export function apiDmvActivityDetail(request, env, ctx, date) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) return json({ success: false, error: 'not_found' }, 404);
    const p = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(p.get('limit')) || 100, 1), 200);
    const offset = Math.max(Number(p.get('offset')) || 0, 0);
    const change = ['added', 'missing', 'returned'].includes(p.get('change')) ? p.get('change') : 'added';
    const model = CLASSES.includes(p.get('model')) ? p.get('model') : null;
    const event = await sql.prepare(`SELECT e.*, s.polled_at FROM dmv_events e JOIN dmv_snapshots s ON s.snapshot_date = e.snapshot_date WHERE e.snapshot_date = ?`).bind(date).first();
    if (!event) return json({ success: false, error: 'not_found' }, 404);
    const where = ['c.snapshot_date = ?', 'c.change = ?'];
    const binds = [date, change];
    if (model) { where.push(`${CLASS_SQL} = ?`); binds.push(model); }
    const [rows, count] = await sql.batch([
      sql.prepare(`SELECT c.vin, c.change, ${CLASS_SQL} AS model_class, dd.status AS decode_status, v.make, v.model, v.model_year,
            dd.decoded_model, dd.plant_city, dd.plant_state, v.first_seen_date, v.last_seen_date
          FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin LEFT JOIN dmv_av_vehicles v ON v.vin = c.vin
          WHERE ${where.join(' AND ')} ORDER BY model_class, c.vin LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
      sql.prepare(`SELECT COUNT(*) AS n FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin WHERE ${where.join(' AND ')}`).bind(...binds)
    ]);
    const b = await breakdowns(sql, [date]);
    return json({ event: eventRow(event, b[date]), change, total: Number(((count.results || [])[0] || {}).n) || 0, limit, offset, vehicles: rows.results || [] });
  });
}

// GET /api/dmv/vins?q&model&year&sort=vin|first_seen|last_seen&recent=1&status=current|missing&limit&offset
// The VIN directory with tracking and decode fields (the original
// /api/dmv-registrations/vins keeps the source's four fields only).
export function apiDmvDirectory(request, env, ctx) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    const p = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(p.get('limit')) || 100, 1), 200);
    const offset = Math.max(Number(p.get('offset')) || 0, 0);
    const q = [...String(p.get('q') || '').toUpperCase()].filter(c => /[0-9A-Z]/.test(c)).join('').slice(0, 17);
    const head = await sql.prepare(`SELECT (SELECT MAX(snapshot_date) FROM dmv_snapshots) AS latest,
        (SELECT MAX(snapshot_date) FROM dmv_events WHERE status = 'ok' AND added > 0) AS new_date`).first();
    const latestDate = head && head.latest, newDate = head && head.new_date;
    const where = [], binds = [];
    if (p.get('status') === 'missing') { where.push('v.last_seen_date < ?'); binds.push(latestDate); }
    else if (p.get('status') !== 'all') { where.push('v.last_seen_date = ?'); binds.push(latestDate); }
    if (q) { where.push('v.vin LIKE ?'); binds.push(`%${q}%`); }
    const model = p.get('model');
    if (CLASSES.includes(model)) { where.push(`${ROSTER_CLASS_SQL} = ?`); binds.push(model); }
    const year = Number.parseInt(p.get('year'), 10);
    if (Number.isInteger(year)) { where.push('v.model_year = ?'); binds.push(year); }
    if (p.get('recent') === '1') { where.push('v.first_seen_date = ? AND v.in_baseline = 0'); binds.push(newDate || ''); }
    const order = { first_seen: 'v.first_seen_date DESC, v.vin', last_seen: 'v.last_seen_date DESC, v.vin' }[p.get('sort')] || 'v.vin';
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // The total and the model years on the first page only (later pages read just
    // their rows); from the precomputed summary when no search/year/recent filter
    // applies, so a plain page never counts the whole roster.
    const first = offset === 0;
    const simple = first && !q && !Number.isInteger(year) && p.get('recent') !== '1' && p.get('status') !== 'missing' && p.get('status') !== 'all' && (!model || CLASSES.includes(model));
    const sm = first && latestDate ? await summaryFor(sql, latestDate) : null;
    const smTotal = sm && simple ? (CLASSES.includes(model) ? Number(sm.totals[model]) || 0 : Object.values(sm.totals).reduce((a, n) => a + Number(n), 0)) : null;
    const stmts = [
      sql.prepare(`SELECT v.vin, v.make, v.model, v.model_year, v.first_seen_date, v.last_seen_date, v.in_baseline,
            ${ROSTER_CLASS_SQL} AS model_class, COALESCE(dd.status, CASE WHEN lower(trim(v.model)) IN ('cybercab', 'model y') THEN 'source_label' END) AS decode_status
          FROM dmv_av_vehicles v LEFT JOIN dmv_vin_decode dd ON dd.vin = v.vin ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset)
    ];
    // The join is only needed to count by model class.
    const needCount = first && smTotal === null, needYears = first && !sm;
    if (needCount) stmts.push(sql.prepare(`SELECT COUNT(*) AS n FROM dmv_av_vehicles v ${model && CLASSES.includes(model) ? 'LEFT JOIN dmv_vin_decode dd ON dd.vin = v.vin' : ''} ${w}`).bind(...binds));
    if (needYears) stmts.push(sql.prepare(`SELECT DISTINCT model_year AS y FROM dmv_av_vehicles WHERE model_year IS NOT NULL ORDER BY y DESC`));
    const res = await sql.batch(stmts);
    const rows = res[0], count = needCount ? res[1] : null, yearRows = needYears ? res[needCount ? 2 : 1] : null;
    return json({
      total: !first ? null : smTotal !== null ? smTotal : Number(((count.results || [])[0] || {}).n) || 0,
      limit, offset, latest_date: latestDate, new_date: newDate,
      years: !first ? null : sm ? sm.years : (yearRows.results || []).map(r => r.y),
      vehicles: (rows.results || []).map(r => ({
        vin: r.vin, make: r.make, model: r.model, model_year: r.model_year,
        model_class: r.model_class, decode_status: r.decode_status || null,
        first_detected: r.first_seen_date, last_confirmed: r.last_seen_date,
        baseline: !!r.in_baseline,
        // NEW only for the latest update's additions, and only while still listed.
        is_new: !r.in_baseline && !!newDate && r.first_seen_date === newDate && r.last_seen_date === latestDate,
        listed: r.last_seen_date === latestDate
      }))
    });
  });
}

// GET /api/dmv/vins/:vin — one vehicle: source fields, decode, tracking history, our registry.
export function apiDmvVin(request, env, ctx, rawVin) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    const vin = String(rawVin || '').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return json({ success: false, error: 'not_found' }, 404);
    const [veh, dec, hist, latest, reg] = await sql.batch([
      sql.prepare('SELECT * FROM dmv_av_vehicles WHERE vin = ?').bind(vin),
      sql.prepare('SELECT * FROM dmv_vin_decode WHERE vin = ?').bind(vin),
      sql.prepare('SELECT snapshot_date AS date, change FROM dmv_changes WHERE vin = ? ORDER BY snapshot_date').bind(vin),
      sql.prepare('SELECT MAX(snapshot_date) AS d, MIN(snapshot_date) AS first FROM dmv_snapshots'),
      sql.prepare(`SELECT v.id, v.license_plate, v.model,
            (SELECT COUNT(*) FROM vehicle_observations o JOIN submissions s ON s.id = o.submission_id
              WHERE o.robotaxi_vehicle_id = v.id AND s.submission_type = 'vehicle_sighting' AND s.status = 'approved') AS sightings
          FROM robotaxi_vehicles v WHERE v.vin = ? AND ${publicVehicleEligibleSql('v')} LIMIT 1`).bind(vin)
    ]);
    const v = (veh.results || [])[0];
    if (!v) return json({ success: false, error: 'not_found' }, 404);
    const d = (dec.results || [])[0] || null;
    const l = (latest.results || [])[0] || {};
    const r = (reg.results || [])[0] || null;
    return json({
      vin,
      source: { make: v.make, model: v.model, model_year: v.model_year, provider: SOURCE.name },
      decode: d ? {
        model_class: d.model_class, status: d.status, source: d.source, manufacturer: d.manufacturer, model: d.decoded_model,
        model_year: d.model_year, plant: [d.plant_city, d.plant_state, d.plant_country].filter(Boolean).join(', ') || null,
        vehicle_type: d.vehicle_type, body_class: d.body_class, check_digit_ok: d.check_digit_ok == null ? null : !!d.check_digit_ok, decoded_at: d.decoded_at
      } : null,
      tracking: {
        first_detected: v.first_seen_date, last_confirmed: v.last_seen_date,
        in_baseline: !!v.in_baseline, listed: v.last_seen_date === l.d, latest_snapshot: l.d, tracking_since: l.first,
        history: hist.results || []
      },
      registry: r ? { id: r.id, plate: r.license_plate, model: r.model, approved_sightings: Number(r.sightings) || 0 } : null
    });
  });
}

// GET /api/dmv/growth?range=7d|30d|90d|all — actual snapshots only (no
// predictions, no imported history): cumulative totals per snapshot day and
// the additions recorded on each day by class.
export function apiDmvGrowth(request, env, ctx) {
  return cached(request, ctx, async () => {
    const sql = env.cybercabhunter_db;
    const range = new URL(request.url).searchParams.get('range');
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range] || null;
    const latest = await sql.prepare('SELECT MAX(snapshot_date) AS d FROM dmv_snapshots').first();
    if (!latest || !latest.d) return json({ range: range || 'all', points: [], enough_history: false });
    const from = days ? new Date(Date.parse(`${latest.d}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10) : '0000';
    const [snaps, adds] = await sql.batch([
      sql.prepare(`SELECT s.snapshot_date AS date, s.total, s.cybercab_count AS cybercab, s.model_y_count AS model_y, e.status
          FROM dmv_snapshots s LEFT JOIN dmv_events e ON e.snapshot_date = s.snapshot_date WHERE s.snapshot_date > ? ORDER BY s.snapshot_date`).bind(from),
      sql.prepare(`SELECT c.snapshot_date AS date, ${CLASS_SQL} AS cls, COUNT(*) AS n FROM dmv_changes c LEFT JOIN dmv_vin_decode dd ON dd.vin = c.vin
          WHERE c.change = 'added' AND c.snapshot_date > ? GROUP BY c.snapshot_date, cls`).bind(from)
    ]);
    const a = {};
    for (const r of adds.results || []) { a[r.date] = a[r.date] || Object.fromEntries(CLASSES.map(c => [c, 0])); a[r.date][CLASSES.includes(r.cls) ? r.cls : 'unknown'] += Number(r.n); }
    const points = (snaps.results || []).map(s => ({ date: s.date, total: s.total, cybercab: s.cybercab, model_y: s.model_y, baseline: s.status === 'baseline', added: a[s.date] || null }));
    return json({ range: range || 'all', points, enough_history: points.length >= 2 });
  });
}
