// The DMV tracker (worker/txdmv-activity.js): registration activity between
// Cybercab Hunter's daily TxDMV snapshots, VIN decoding, and the read APIs.
// Real SQL (every migration), a stubbed TxMCCS and a stubbed NHTSA vPIC.
// Run: node tests/txdmv-activity.test.mjs

import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { runTxdmvPoll, TESLA_AUTHORIZATION } from '../worker/txdmv.js';
import { processDmvActivity, runDmvStep, MODE_KEY, PROGRESS_KEY, vinCheckDigitOk, combineDecode, compareRosters, vpicClass, sourceClass } from '../worker/txdmv-activity.js';

const t = makeCheck();
const { check } = t;
const COMPANY_ID = 'c0ffee00-0000-4000-8000-000000000001';
const cyber = n => ({ vin: `5YJAJEEU${String(n).padStart(9, '0')}`, make: 'TESLA', model: 'Cybercab', modelYear: 2026 });
const modelY = n => ({ vin: `7SAYGDED${String(n).padStart(9, '0')}`, make: 'Tesla', model: 'Model Y', modelYear: 2026 });

function txmccs(roster, { lieAboutTotal = false } = {}) {
  return async url => {
    const u = new URL(url);
    if (u.pathname === '/api/TruckStop/companies') return Response.json({ results: [{ businessEntityId: COMPANY_ID, companyName: 'Tesla Robotaxi, LLC', autonomousVehicleAuthorizationNumber: TESLA_AUTHORIZATION }], total: 1 });
    const limit = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('offset'));
    const sorted = [...roster].sort((a, b) => (a.vin < b.vin ? -1 : 1));
    return Response.json({ vehicles: sorted.slice(offset, offset + limit), total: sorted.length + (lieAboutTotal ? 3 : 0) });
  };
}
// vPIC: decodes by prefix unless overridden; `down` answers 503.
function vpic({ down = false, override = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    if (down) return new Response('busy', { status: 503 });
    const data = new URLSearchParams(init.body).get('data').split(';');
    return Response.json({ Results: data.map(vin => {
      const o = override[vin];
      const model = o !== undefined ? o : vin.startsWith('5YJA') ? 'Cybercab' : vin.startsWith('7SAY') ? 'Model Y' : '';
      return { VIN: vin, Make: model ? 'TESLA' : '', Manufacturer: model ? 'TESLA, INC.' : '', Model: model, ModelYear: '2026',
        PlantCity: vin.startsWith('5YJA') ? 'AUSTIN' : 'FREMONT', PlantState: vin.startsWith('5YJA') ? 'TEXAS' : 'CALIFORNIA', PlantCountry: 'UNITED STATES (USA)',
        VehicleType: 'PASSENGER CAR', BodyClass: 'Hatchback', ErrorCode: '0' };
    }) });
  };
  return { impl, calls };
}
const day = d => Date.parse(`${d}T17:00:00Z`);
const api = async (ctx, path) => (await worker.fetch(new Request(`https://x${path}`), ctx.env, {})).json();
const q = (ctx, s, ...b) => ctx.d1.query(s, ...b);
const poll = (ctx, roster, d, o) => runTxdmvPoll(ctx.env, { fetchImpl: txmccs(roster, o), nowMs: day(d) });
const process_ = (ctx, d, v = vpic()) => processDmvActivity(ctx.env, { fetchImpl: v.impl, nowMs: day(d) });

async function run() {
  console.log('1. Pure rules');
  check('check digit: real Cybercab and Model Y VINs pass', vinCheckDigitOk('5YJAJEEU0TA001291') && vinCheckDigitOk('7SAYGDEE0TF541312'));
  check('check digit: a one-character change fails', !vinCheckDigitOk('5YJAJEEU0TA001292') && !vinCheckDigitOk('SHORT'));
  check('vPIC class: only a Tesla decode names a model', vpicClass({ Make: 'TESLA', Model: 'Cybercab' }) === 'cybercab' && vpicClass({ Make: 'TESLA', Model: 'Model Y' }) === 'model_y' && vpicClass({ Make: 'TESLA', Model: 'Model 3' }) === 'other_tesla' && vpicClass({ Make: '', Model: '' }) === 'unknown' && vpicClass({ Make: 'FORD', Model: 'Cybercab' }) === 'unknown');
  check('TxDMV label class', sourceClass('Cybercab', 'Tesla', 'X') === 'cybercab' && sourceClass('Model 3', 'Tesla', 'X') === 'other_tesla' && sourceClass('', '', 'ABCD0000000000000') === 'unknown');
  check('agree -> verified; vPIC only -> vpic; label only -> source_label; disagree -> unknown (conflict)',
    combineDecode('cybercab', 'cybercab').status === 'verified' && combineDecode('unknown', 'model_y').model_class === 'model_y' && combineDecode('unknown', 'model_y').status === 'vpic'
    && combineDecode('cybercab', 'unknown').status === 'source_label' && combineDecode('cybercab', 'model_y').model_class === 'unknown' && combineDecode('cybercab', 'model_y').status === 'conflict');
  check('never "Cybercab" just because it isn\'t a Model Y', combineDecode('unknown', 'unknown').model_class === 'unknown');
  const cmp = compareRosters(['A', 'B', 'C'], ['B', 'C', 'D', 'E'], '2026-10-05', new Map([['D', '2026-10-05'], ['E', '2026-10-02']]));
  check('VIN-level comparison: added, returned and missing apart (not total minus total)', cmp.added.join() === 'D' && cmp.returned.join() === 'E' && cmp.missing.join() === 'A');

  const ctx = await makeEnv();
  ctx.env.DMV_HISTORY_OVERRIDE = [];
  let roster = [cyber(1), cyber(2), cyber(3), modelY(1), modelY(2)];

  console.log('2. The first snapshot is the baseline');
  await poll(ctx, roster, '2026-10-01');
  const pre = await api(ctx, '/api/dmv/overview');
  const preDir = await api(ctx, '/api/dmv/vins?model=cybercab');
  check('before the first processing run (right after the migration): totals use TxDMV\'s own labels, not "unknown"',
    pre.totals.cybercab === 3 && pre.totals.model_y === 2 && pre.totals.unknown === 0 && pre.latest_update === null && pre.processing_pending === 1 && preDir.total === 3 && preDir.vehicles.every(x => x.model_class === 'cybercab' && x.decode_status === 'source_label' && !x.is_new));
  let v = vpic();
  let r = await process_(ctx, '2026-10-01', v);
  const e1 = q(ctx, 'SELECT * FROM dmv_events')[0];
  check('one baseline event, nothing counted as new', e1.status === 'baseline' && e1.added === 0 && e1.total === 5 && q(ctx, 'SELECT COUNT(*) AS n FROM dmv_changes')[0].n === 0);
  check('every VIN decoded: vPIC + TxDMV agree -> verified, with the plant', q(ctx, "SELECT COUNT(*) AS n FROM dmv_vin_decode WHERE status = 'verified'")[0].n === 5 && q(ctx, "SELECT plant_city FROM dmv_vin_decode WHERE vin = ?", cyber(1).vin)[0].plant_city === 'AUSTIN' && r.decoded === 5);
  check('vPIC is called once for the five VINs (20 VINs a call)', v.calls.length === 1);

  console.log('3. Same roster again: an event with no changes; re-running changes nothing');
  await poll(ctx, roster, '2026-10-02');
  await process_(ctx, '2026-10-02');
  await process_(ctx, '2026-10-02');
  await poll(ctx, roster, '2026-10-02');   // the same day again: the poll skips it
  await process_(ctx, '2026-10-02');
  check('two events in all (no duplicates from re-runs or a re-import)', q(ctx, 'SELECT COUNT(*) AS n FROM dmv_events')[0].n === 2);
  check('day 2: ok, 0 added, 0 missing, net 0', (e => e.status === 'ok' && e.added === 0 && e.missing === 0 && e.net === 0)(q(ctx, "SELECT * FROM dmv_events WHERE snapshot_date = '2026-10-02'")[0]));
  const vpicAgain = vpic();
  await process_(ctx, '2026-10-02', vpicAgain);
  check('verified VINs are not re-decoded', vpicAgain.calls.length === 0);

  console.log('4. Three new VINs and one gone');
  roster = [cyber(1), cyber(2), cyber(3), cyber(4), cyber(5), modelY(1), modelY(3)];   // +c4 +c5 +y3, -y2
  await poll(ctx, roster, '2026-10-03');
  await process_(ctx, '2026-10-03');
  const e3 = q(ctx, "SELECT * FROM dmv_events WHERE snapshot_date = '2026-10-03'")[0];
  check('added 3, missing 1, net +2 (tracked separately)', e3.added === 3 && e3.missing === 1 && e3.net === 2 && e3.total === 7, JSON.stringify(e3));
  check('the changes name the VINs', q(ctx, "SELECT vin FROM dmv_changes WHERE snapshot_date = '2026-10-03' AND change = 'missing'")[0].vin === modelY(2).vin);

  console.log('5. A missing VIN comes back: returned, not new');
  roster = [...roster, modelY(2)];
  await poll(ctx, roster, '2026-10-04');
  await process_(ctx, '2026-10-04');
  const e4 = q(ctx, "SELECT * FROM dmv_events WHERE snapshot_date = '2026-10-04'")[0];
  check('returned 1, added 0', e4.returned === 1 && e4.added === 0 && e4.net === 1);

  console.log('6. A truncated roster is held, and the next day compares with the last good one');
  // Insert a snapshot as if the source had served only 2 of 8 (fetchRoster's own check
  // already refuses mismatched totals; this is the source itself shrinking).
  ctx.d1.prepare(`INSERT INTO dmv_snapshots (snapshot_date, total, cybercab_count, model_y_count, other_count, authorization_number, raw_json, polled_at) VALUES ('2026-10-05', 2, 2, 0, 0, ?, ?, '2026-10-05T11:30:00Z')`)
    .bind(TESLA_AUTHORIZATION, JSON.stringify([cyber(1), cyber(2)].map(x => ({ vin: x.vin, make: x.make, model: x.model, model_year: 2026 }))))._exec();
  await process_(ctx, '2026-10-05');
  const e5 = q(ctx, "SELECT * FROM dmv_events WHERE snapshot_date = '2026-10-05'")[0];
  check('held: no changes recorded for it', e5.status === 'held' && q(ctx, "SELECT COUNT(*) AS n FROM dmv_changes WHERE snapshot_date = '2026-10-05'")[0].n === 0);
  await poll(ctx, [...roster, modelY(4)], '2026-10-06');
  await process_(ctx, '2026-10-06');
  const e6 = q(ctx, "SELECT * FROM dmv_events WHERE snapshot_date = '2026-10-06'")[0];
  check('day 6 is compared with day 4 (not the held day): +1, nothing missing', e6.prev_snapshot_date === '2026-10-04' && e6.added === 1 && e6.missing === 0);

  console.log('7. An incomplete download writes nothing');
  await poll(ctx, [...roster, modelY(4), modelY(5)], '2026-10-07', { lieAboutTotal: true });
  await process_(ctx, '2026-10-07');
  check('no snapshot and no event for the failed day', q(ctx, "SELECT COUNT(*) AS n FROM dmv_snapshots WHERE snapshot_date = '2026-10-07'")[0].n === 0 && q(ctx, "SELECT COUNT(*) AS n FROM dmv_events WHERE snapshot_date = '2026-10-07'")[0].n === 0);

  console.log('8. Decoding: vPIC down, conflicts, unknowns');
  const odd = { vin: 'ZZZZZZZZZZZZZZZZZ', make: '', model: '', modelYear: null };
  const fight = cyber(9);   // TxDMV says Cybercab; vPIC (overridden) says Model Y
  roster = [...roster, modelY(4), odd, fight];
  await poll(ctx, roster, '2026-10-08');
  r = await process_(ctx, '2026-10-08', vpic({ down: true }));
  check('vPIC down: the run still records the event, keeps TxDMV labels, notes the error', r.decode_error === 'vpic_http_503' && q(ctx, 'SELECT status FROM dmv_vin_decode WHERE vin = ?', fight.vin)[0].status === 'source_label' && q(ctx, "SELECT COUNT(*) AS n FROM dmv_events WHERE snapshot_date = '2026-10-08'")[0].n === 1);
  const backoff = q(ctx, 'SELECT attempts, next_attempt_at FROM dmv_vin_decode WHERE vin = ?', fight.vin)[0];
  check('vPIC down: those VINs back off (1 h), not retried in a loop', backoff.attempts === 1 && backoff.next_attempt_at > new Date(day('2026-10-08')).toISOString());
  const early = vpic();
  await processDmvActivity(ctx.env, { fetchImpl: early.impl, nowMs: day('2026-10-08') + 10 * 60e3 });
  check('…and nothing calls vPIC again before the backoff is over', early.calls.length === 0);
  await processDmvActivity(ctx.env, { fetchImpl: vpic({ override: { [fight.vin]: 'Model Y' } }).impl, nowMs: day('2026-10-08') + 3 * 3600e3 });
  const df = q(ctx, 'SELECT * FROM dmv_vin_decode WHERE vin = ?', fight.vin)[0];
  check('a disagreement is shown as unknown (conflict), never guessed', df.model_class === 'unknown' && df.status === 'conflict');
  const dz = q(ctx, 'SELECT * FROM dmv_vin_decode WHERE vin = ?', odd.vin)[0];
  check('an undecodable VIN stays unknown', dz.model_class === 'unknown');

  console.log('9. Milestones are crossed, not invented');
  const ctx2 = await makeEnv();
  ctx2.env.DMV_HISTORY_OVERRIDE = [];
  const many = n => Array.from({ length: n }, (_, i) => cyber(100 + i));
  await runTxdmvPoll(ctx2.env, { fetchImpl: txmccs(many(98)), nowMs: day('2026-10-01') });
  await processDmvActivity(ctx2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-01') });
  check('none at the baseline (50 was passed before tracking)', ctx2.d1.query('SELECT COUNT(*) AS n FROM dmv_milestones')[0].n === 0);
  await runTxdmvPoll(ctx2.env, { fetchImpl: txmccs(many(104)), nowMs: day('2026-10-02') });
  await processDmvActivity(ctx2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-02') });
  await processDmvActivity(ctx2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-02') });
  const ms = ctx2.d1.query('SELECT * FROM dmv_milestones ORDER BY metric');
  check('100 Cybercabs and 100 vehicles, once each, on the day they were crossed', ms.length === 2 && ms.every(m => m.threshold === 100 && m.snapshot_date === '2026-10-02' && m.value === 104));

  console.log('10. The APIs');
  const ov = await api(ctx, '/api/dmv/overview');
  check('overview: latest snapshot, totals by decoded class', ov.latest.date === '2026-10-08' && ov.totals.total === 11 && ov.totals.cybercab + ov.totals.model_y + ov.totals.other_tesla + ov.totals.unknown === 11 && ov.totals.unknown === 2, JSON.stringify(ov.totals));
  check('overview: the latest update with its breakdown', ov.latest_update.date === '2026-10-08' && ov.latest_update.added === 2 && ov.latest_update.added_by_model.unknown === 2);
  check('overview: source, freshness, insights from stored records', ov.source.authorization === TESLA_AUTHORIZATION && ov.freshness.last_success && ov.insights.length > 0 && ov.insights.every(i => !/deploy/i.test(i.text)));
  check('overview: the source fields and no registration date', ov.source.fields.join() === 'VIN,make,model,model year' && !JSON.stringify(ov).includes('registration_date'));
  const act = await api(ctx, '/api/dmv/activity');
  check('activity: updates with additions, newest first (held and baseline left out)', act.events.map(e => e.date).join() === '2026-10-08,2026-10-06,2026-10-03' && act.baseline.date === '2026-10-01', act.events.map(e => e.date).join());
  check('activity: a model filter', (await api(ctx, '/api/dmv/activity?model=model_y')).events.map(e => e.date).join() === '2026-10-06,2026-10-03');
  check('activity: missing-only and a date range', (await api(ctx, '/api/dmv/activity?kind=missing')).events.map(e => e.date).join() === '2026-10-03' && (await api(ctx, '/api/dmv/activity?from=2026-10-04&to=2026-10-07')).events.map(e => e.date).join() === '2026-10-06');
  const det = await api(ctx, '/api/dmv/activity/2026-10-03');
  check('detail: the update\'s new VINs with decoded models', det.total === 3 && det.vehicles.every(x => x.first_seen_date === '2026-10-03') && det.vehicles.filter(x => x.model_class === 'cybercab').length === 2);
  check('detail: the missing list', (await api(ctx, '/api/dmv/activity/2026-10-03?change=missing')).vehicles[0].vin === modelY(2).vin);
  const dir = await api(ctx, '/api/dmv/vins?sort=first_seen');
  check('directory: listed VINs, newest first, NEW only on the latest update\'s additions', dir.total === 11 && dir.vehicles[0].first_detected === '2026-10-08' && dir.vehicles.filter(x => x.is_new).length === 2 && dir.vehicles.find(x => x.vin === cyber(4).vin).is_new === false);
  check('directory: recent=1, model and year filters', (await api(ctx, '/api/dmv/vins?recent=1')).total === 2 && (await api(ctx, '/api/dmv/vins?model=model_y')).vehicles.every(x => x.model_class === 'model_y') && (await api(ctx, '/api/dmv/vins?year=2025')).total === 0);
  check('the original VIN API still returns only the source\'s four fields', (await api(ctx, '/api/dmv-registrations/vins')).vehicles.every(x => Object.keys(x).join() === 'vin,make,model,model_year'));
  const one = await api(ctx, `/api/dmv/vins/${cyber(4).vin}`);
  check('one VIN: source fields, decode (plant = where built), tracking history', one.source.model === 'Cybercab' && one.decode.status === 'verified' && /AUSTIN/.test(one.decode.plant) && one.tracking.first_detected === '2026-10-03' && one.tracking.history[0].change === 'added' && one.registry === null);
  check('one VIN: unknown VIN is a 404', (await worker.fetch(new Request('https://x/api/dmv/vins/AAAAAAAAAAAAAAAAA'), ctx.env, {})).status === 404);
  const g = await api(ctx, '/api/dmv/growth?range=all');
  check('growth: actual snapshots only, additions on change days', g.points.length === 7 && g.points[0].baseline && g.points.find(p => p.date === '2026-10-03').added.cybercab === 2 && g.enough_history);

  console.log('11. Workers Free: small, bounded, resumable steps');
  const fresh = async () => {
    const c = await makeEnv(); c.env.DMV_HISTORY_OVERRIDE = [];
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
    const rosters = [[cyber(1), modelY(1)], [cyber(1), modelY(1), cyber(2)], [cyber(1), cyber(2), modelY(2)], [cyber(1), cyber(2), modelY(2), modelY(1)], [cyber(1), cyber(2), modelY(2), modelY(1), cyber(3)]];
    for (let i = 0; i < days.length; i++) await poll(c, rosters[i], days[i]);
    return c;
  };
  const tables = c => JSON.stringify(['dmv_events', 'dmv_changes', 'dmv_milestones'].map(tb => c.d1.query(`SELECT * FROM ${tb} ORDER BY 1, 2, 3`).map(r => ({ ...r, processed_at: undefined }))))
    + JSON.stringify(c.d1.query('SELECT vin, model_class, status FROM dmv_vin_decode ORDER BY vin'));
  // A reference: everything at once.
  const ref = await fresh();
  await processDmvActivity(ref.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') });

  const c1 = await fresh();
  let off = await runDmvStep(c1.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') });
  check('mode unset: nothing runs (one KV read, no D1 work)', off.mode === 'off' && !off.worked && off.subrequests === 1 && c1.d1.query('SELECT COUNT(*) AS n FROM dmv_events')[0].n === 0);
  await c1.env.TESLA_SESSIONS.put(MODE_KEY, 'on');
  const s1 = await runDmvStep(c1.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05'), limits: { snapshots: 2, decodeCalls: 3 } });
  check('a step does at most its limit of snapshots, oldest first, and no decoding while snapshots are pending', s1.processed.map(p => p.date).join() === '2026-10-01,2026-10-02' && s1.decoded === 0 && s1.pending_snapshots === 3);
  check('…and leaves a progress note', JSON.parse(await c1.env.TESLA_SESSIONS.get(PROGRESS_KEY)).processed.length === 2);
  const tight = await runDmvStep(c1.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05'), budget: 5 });
  check('a small subrequest budget: stops cleanly before the next unit, never over budget', tight.processed.length === 1 && tight.subrequests <= 4);
  // Interrupted: D1 fails mid-step. Nothing half-written; the next step resumes.
  const realBatch = c1.env.cybercabhunter_db.batch.bind(c1.env.cybercabhunter_db);
  let failNext = true;
  c1.env.cybercabhunter_db.batch = async stmts => { if (failNext) { failNext = false; throw new Error('D1_ERROR: simulated limit'); } return realBatch(stmts); };
  const before = tables(c1);
  const broken = await runDmvStep(c1.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') });
  check('an interrupted step writes nothing and reports the error', broken.error && /simulated/.test(broken.error) && tables(c1) === before);
  for (let i = 0; i < 10; i++) { const st = await runDmvStep(c1.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') }); if (!st.worked) break; }
  check('resumed step by step: identical to processing everything at once', tables(c1) === tables(ref));
  // Overlapping runs (two invocations at once) and re-runs: no duplicates.
  const c2 = await fresh();
  await Promise.all([processDmvActivity(c2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') }), processDmvActivity(c2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') })]);
  await processDmvActivity(c2.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-06') });
  check('two overlapping runs and a re-run: no duplicate events or changes', tables(c2) === tables(ref));
  // A truncated roster is held, never turned into "missing" VINs.
  const c3 = await fresh();
  await processDmvActivity(c3.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-05') });
  c3.d1.prepare(`INSERT INTO dmv_snapshots (snapshot_date, total, cybercab_count, model_y_count, other_count, authorization_number, raw_json, polled_at) VALUES ('2026-10-06', 1, 1, 0, 0, 'X', ?, '2026-10-06T11:30:00Z')`).bind(JSON.stringify([{ vin: cyber(1).vin, make: 'TESLA', model: 'Cybercab', model_year: 2026 }]))._exec();
  await processDmvActivity(c3.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-06') });
  check('an unexpectedly small roster is held: no missing VINs recorded', c3.d1.query("SELECT status FROM dmv_events WHERE snapshot_date = '2026-10-06'")[0].status === 'held' && c3.d1.query("SELECT COUNT(*) AS n FROM dmv_changes WHERE snapshot_date = '2026-10-06'")[0].n === 0);
  // vPIC keeps failing: bounded attempts, then left alone (TxDMV label kept).
  const c4 = await fresh();
  let t4 = day('2026-10-05');
  for (let i = 0; i < 40; i++) { await processDmvActivity(c4.env, { fetchImpl: vpic({ down: true }).impl, nowMs: t4 }); t4 += 8 * 24 * 3600e3; }
  const dead = c4.d1.query('SELECT MAX(attempts) AS a, COUNT(*) FILTER (WHERE next_attempt_at IS NOT NULL) AS due, COUNT(*) FILTER (WHERE status = \'verified\') AS v FROM dmv_vin_decode')[0];
  check('vPIC always down: at most 10 attempts per VIN, then no more calls; nothing marked verified', dead.a === 10 && dead.due === 0 && dead.v === 0);
  const ov4 = await api(c4, '/api/dmv/overview');
  check('…and the totals still use TxDMV\'s labels', ov4.totals.cybercab === 3 && ov4.totals.model_y === 2);

  console.log('12. Reads stay cheap (D1 rows-read budget)');
  const live = await api(ctx, '/api/dmv/overview');
  const sumRow = q(ctx, 'SELECT * FROM dmv_summary')[0];
  check('a processing step leaves a summary for the latest snapshot', sumRow && sumRow.snapshot_date === '2026-10-08');
  ctx.d1.exec('DELETE FROM dmv_summary');
  const counted = await api(new Proxy(ctx, {}), '/api/dmv/overview?nocache=1');
  check('overview from the summary equals counting live', JSON.stringify(live.totals) === JSON.stringify(counted.totals));
  await processDmvActivity(ctx.env, { fetchImpl: vpic().impl, nowMs: day('2026-10-09') });
  const p1 = await api(ctx, '/api/dmv/vins?limit=4&model=cybercab'), p2 = await api(ctx, '/api/dmv/vins?limit=4&model=cybercab&offset=4');
  check('directory: total and years on the first page only (later pages read just their rows)', typeof p1.total === 'number' && Array.isArray(p1.years) && p2.total === null && p2.years === null && p2.vehicles.length > 0);
  const liveCount = (await api(ctx, '/api/dmv/vins?limit=1&model=cybercab&q=5YJ')).total;
  check('directory: the summary total matches a live count', p1.total === liveCount, `${p1.total} vs ${liveCount}`);
  const regs = await api(ctx, '/api/dmv-registrations');
  check('the existing panel endpoint carries the latest update (Home needs no second request)', regs.latest_update && regs.latest_update.date === '2026-10-08' && regs.latest_update.added === 2);
}

run().then(() => t.finish()).catch(e => { console.error(e); process.exit(1); });
