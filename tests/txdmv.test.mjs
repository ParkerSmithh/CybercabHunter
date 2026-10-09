// The TxDMV automated-vehicle roster (worker/txdmv.js): the daily pull against
// a stubbed TxMCCS, the D1 snapshots, the panel API and the "Every VIN" API.
// The live endpoint was verified by hand (see the report / worker header);
// this pins the behaviour: one snapshot a day, never overwritten; a failed or
// partial pull writes nothing and the last good snapshot keeps its real poll
// time; new = first listed after the baseline; matches = exact VINs of
// publicly eligible registry vehicles; the VIN list carries only the source's
// four fields.
// Run: node tests/txdmv.test.mjs

import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { runTxdmvPoll, classifyModel, centralDate, TESLA_AUTHORIZATION } from '../worker/txdmv.js';

const t = makeCheck();
const { check } = t;
const COMPANY_ID = '81edcff1-8a6e-4ed0-be1f-60668515e223';
const cyber = n => ({ vin: `5YJAJEEU${String(n).padStart(9, '0')}`.slice(0, 17), make: 'TESLA', model: 'Cybercab', modelYear: 2026 });
const modelY = n => ({ vin: `7SAYGDED${String(n).padStart(9, '0')}`.slice(0, 17), make: 'Tesla', model: 'Model Y', modelYear: 2026 });

// A stub TxMCCS serving `roster` in pages of `page` (the real limit is 100).
function txmccs(roster, { fail = null, lieAboutTotal = false } = {}) {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    if (fail) return new Response('down', { status: fail });
    const u = new URL(url);
    if (u.pathname === '/api/TruckStop/companies') {
      return Response.json({ results: [{ businessEntityId: COMPANY_ID, companyName: 'Tesla Robotaxi, LLC', autonomousVehicleAuthorizationNumber: TESLA_AUTHORIZATION, autonomousVehicleStatus: 'authorized' }], total: 1 });
    }
    const limit = Number(u.searchParams.get('limit')), offset = Number(u.searchParams.get('offset'));
    const sorted = [...roster].sort((a, b) => (a.vin < b.vin ? -1 : 1));
    return Response.json({ vehicles: sorted.slice(offset, offset + limit), total: sorted.length + (lieAboutTotal ? 5 : 0) });
  };
  return { impl, calls };
}
const day = d => Date.parse(`${d}T17:00:00Z`);   // midday Central
const api = async (ctx, path) => (await worker.fetch(new Request(`https://x${path}`), ctx.env, {})).json();
const q = (ctx, s, ...b) => ctx.d1.query(s, ...b);

async function run() {
  console.log('1. Model split and dates');
  check('TxDMV\'s model field decides', classifyModel('Cybercab', '7SAY0000000000000') === 'cybercab' && classifyModel('Model Y', '5YJA0000000000000') === 'model_y');
  check('the VIN only fills in a blank model (5YJA = Cybercab, 7SAY = Model Y)', classifyModel('', '5YJAJEEU000000001') === 'cybercab' && classifyModel(null, '7SAYGDED000000001') === 'model_y' && classifyModel('', 'ABCD0000000000000') === 'other' && classifyModel('Semi', '5YJA0000000000000') === 'other');
  check('snapshot dates are Central dates', centralDate(Date.parse('2026-10-09T04:30:00Z')) === '2026-10-08' && centralDate(Date.parse('2026-10-09T06:00:00Z')) === '2026-10-09');

  const ctx = await makeEnv();
  ctx.env.DMV_HISTORY_OVERRIDE = [];   // sections 2-7: our own snapshots only (section 8 imports a history)
  // Day 1: 3 Cybercabs + 2 Model Ys, served 2 per page (pagination).
  let roster = [cyber(1), cyber(2), cyber(3), modelY(1), modelY(2)];
  console.log('2. The first poll: the baseline');
  {
    const s = txmccs(roster);
    const r = await runTxdmvPoll(ctx.env, { fetchImpl: s.impl, nowMs: day('2026-10-01') });
    check('a snapshot with the true counts', r.ok && r.total === 5 && r.cybercab === 3 && r.model_y === 2 && r.other === 0 && r.baseline === true, JSON.stringify(r));
    check('it read every page, sorted by VIN, 100 at a time', s.calls.filter(u => /automated-motor-vehicles/.test(u)).every(u => /limit=100/.test(u) && /sortBy=vin/.test(u)));
    const row = q(ctx, 'SELECT * FROM dmv_snapshots')[0];
    check('one row: date, counts, authorization, the roster (source fields only), poll time', row.snapshot_date === '2026-10-01' && row.total === 5 && row.authorization_number === TESLA_AUTHORIZATION && JSON.parse(row.raw_json).length === 5 && Object.keys(JSON.parse(row.raw_json)[0]).sort().join() === 'make,model,model_year,vin' && /^\d{4}-\d\d-\d\dT/.test(row.polled_at));
    check('every VIN recorded as baseline (its real registration date is unknown)', q(ctx, 'SELECT COUNT(*) AS n FROM dmv_av_vehicles WHERE in_baseline = 1')[0].n === 5);
    const a = await api(ctx, '/api/dmv-registrations');
    check('the panel: total 5 (3 / 2), nothing counted as new on day one', a.snapshot.total === 5 && a.snapshot.cybercab === 3 && a.snapshot.model_y === 2 && a.new.d30 === 0 && a.tracking_since === '2026-10-01');
  }

  console.log('3. Same day again: never overwritten');
  {
    const before = q(ctx, 'SELECT polled_at FROM dmv_snapshots')[0].polled_at;
    const r = await runTxdmvPoll(ctx.env, { fetchImpl: txmccs([...roster, cyber(9)]).impl, nowMs: day('2026-10-01') + 3600e3 });
    check('a second run the same day is skipped, the row unchanged', r.skipped === 'already_polled_today' && q(ctx, 'SELECT COUNT(*) AS n FROM dmv_snapshots')[0].n === 1 && q(ctx, 'SELECT polled_at FROM dmv_snapshots')[0].polled_at === before);
  }

  console.log('4. Later days: new VINs, a removed VIN');
  {
    roster = [cyber(1), cyber(2), cyber(3), cyber(4), modelY(1), modelY(2), modelY(3)];
    await runTxdmvPoll(ctx.env, { fetchImpl: txmccs(roster).impl, nowMs: day('2026-10-05') });
    roster = roster.filter(v => v.vin !== modelY(1).vin).concat(cyber(5));    // one Model Y gone, one more Cybercab
    const r = await runTxdmvPoll(ctx.env, { fetchImpl: txmccs(roster).impl, nowMs: day('2026-10-09') });
    check('day three: 7 (5 Cybercabs, 2 Model Ys)', r.total === 7 && r.cybercab === 5 && r.model_y === 2);
    const a = await api(ctx, '/api/dmv-registrations');
    check('new in the window = first listed after the baseline and still listed: 3 (2 Cybercabs, 1 Model Y)', a.new.d30 === 3 && a.new.cybercab_30d === 2 && a.new.model_y_30d === 1, JSON.stringify(a.new));
    check('new in the last 7 days counts from the latest snapshot', a.new.d7 === 3);
    check('the chart\'s points are exactly the snapshot rows', JSON.stringify(a.series) === JSON.stringify(q(ctx, 'SELECT snapshot_date AS date, total, cybercab_count AS cybercab, model_y_count AS model_y FROM dmv_snapshots ORDER BY snapshot_date')));
    check('history is kept: three rows, oldest untouched', q(ctx, 'SELECT COUNT(*) AS n FROM dmv_snapshots')[0].n === 3 && q(ctx, `SELECT total FROM dmv_snapshots WHERE snapshot_date = '2026-10-01'`)[0].total === 5);
  }

  console.log('5. A failed or partial pull writes nothing');
  {
    const good = await api(ctx, '/api/dmv-registrations');
    const down = await runTxdmvPoll(ctx.env, { fetchImpl: txmccs(roster, { fail: 503 }).impl, nowMs: day('2026-10-10') });
    check('TxDMV down: no row, the error recorded', down.ok === false && /503/.test(down.error) && !q(ctx, `SELECT 1 FROM dmv_snapshots WHERE snapshot_date = '2026-10-10'`).length);
    const partial = await runTxdmvPoll(ctx.env, { fetchImpl: txmccs(roster, { lieAboutTotal: true }).impl, nowMs: day('2026-10-10') });
    check('pages that don\'t add up to the source\'s total: no row', partial.ok === false && /incomplete/.test(partial.error) && !q(ctx, `SELECT 1 FROM dmv_snapshots WHERE snapshot_date = '2026-10-10'`).length);
    const after = await api(ctx, '/api/dmv-registrations');
    check('the panel still shows the last good snapshot with its real poll time, and says the latest check failed', after.snapshot.date === '2026-10-09' && after.snapshot.polled_at === good.snapshot.polled_at && after.last_attempt && after.last_attempt.ok === false);
  }

  console.log('6. Matched to tracked plates');
  {
    // A public registry Cybercab whose VIN is on the roster (with a counted ride),
    // one whose VIN is not, and a private vehicle whose VIN is (never counted).
    const add = (id, vin, vis) => ctx.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, vin, model) VALUES (?, ?, ?, ?, 'Cybercab')`).bind(id, `P-${id}`, vis, vin)._exec();
    add('v-match', ` ${cyber(2).vin.toLowerCase()} `, 'public'); seedRide(ctx.d1, { userId: 'u1', vehicleId: 'v-match', status: 'approved' });
    add('v-other', '5YJAJEEU999999999', 'public'); seedRide(ctx.d1, { userId: 'u1', vehicleId: 'v-other', status: 'approved' });
    add('v-private', cyber(3).vin, 'private');
    ctx.d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type, submitted_at) VALUES ('sg1', 'u1', 'vehicle_sighting', 'approved', 'photo', datetime('now', '-2 days'))`)._exec();
    ctx.d1.prepare(`INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, observed_at, verification_status) VALUES ('o1', 'v-match', 'u1', 'sg1', datetime('now', '-2 days'), 'verified')`)._exec();
    const a = await api(ctx, '/api/dmv-registrations');
    check('exact VIN match (case / spaces ignored) on publicly eligible vehicles only: 1', a.matched.count === 1, JSON.stringify(a.matched));
    check('...of which spotted (approved sighting) in the last 30 days: 1', a.matched.spotted_30d === 1);
  }

  console.log('7. Every VIN');
  {
    const all = await api(ctx, '/api/dmv-registrations/vins?limit=50');
    check('today\'s roster only (the removed Model Y is gone), sorted by VIN', all.total === 7 && all.vehicles.length === 7 && !all.vehicles.some(v => v.vin === modelY(1).vin) && all.vehicles.map(v => v.vin).join() === [...all.vehicles.map(v => v.vin)].sort().join());
    check('exactly the source\'s fields: VIN, make, model, model year — nothing else', all.vehicles.every(v => Object.keys(v).join() === 'vin,make,model,model_year'));
    const cy = await api(ctx, '/api/dmv-registrations/vins?model=cybercab');
    const found = await api(ctx, `/api/dmv-registrations/vins?q=${cyber(4).vin.slice(-6)}`);
    check('filter by model and search by VIN', cy.total === 5 && found.total === 1 && found.vehicles[0].vin === cyber(4).vin);
  }

  console.log('8. The imported history (before our first snapshot only, approximate)');
  {
    // Ours start 2026-10-01 (5) and reach 7 on 10-09; the imported history runs
    // 08-01 -> 09-20 and has a stray point on/after our first day (never used).
    ctx.env.DMV_HISTORY_OVERRIDE = [
      { date: '2026-08-01', cybercab: 0, model_y: 1, total: 1 },
      { date: '2026-09-05', cybercab: 1, model_y: 1, total: 2 },
      { date: '2026-09-20', cybercab: 2, model_y: 2, total: 4 },
      { date: '2026-10-01', cybercab: 99, model_y: 99, total: 198 }
    ];
    const a = await api(ctx, '/api/dmv-registrations');
    const imported = a.series.filter(p => p.approx), own = a.series.filter(p => !p.approx);
    check('imported points come first, flagged approx, and stop before our first snapshot', imported.map(p => p.date).join() === '2026-08-01,2026-09-05,2026-09-20' && a.series.slice(0, 3).every(p => p.approx) && !a.series.some(p => p.total === 198));
    check('our own points are exactly the snapshot rows, untouched', JSON.stringify(own) === JSON.stringify(q(ctx, 'SELECT snapshot_date AS date, total, cybercab_count AS cybercab, model_y_count AS model_y FROM dmv_snapshots ORDER BY snapshot_date')));
    check('the source is named and credited, up to the day polling began', a.history_source && a.history_source.name === 'Robotaxi Tracker' && /robotaxitracker\.com/.test(a.history_source.url) && a.history_source.from === '2026-08-01' && a.history_source.until === '2026-10-01');
    // 30 days back from 10-09 is 09-09 (inside the imported stretch: 2 then).
    check('a 30-day window reaching into it counts the change: 7 - 2 = +5 (+4 Cybercab, +1 Model Y), approx', a.new.d30 === 5 && a.new.cybercab_30d === 4 && a.new.model_y_30d === 1 && a.new.approx === true, JSON.stringify(a.new));
    check('a 7-day window inside our own polling still counts by VIN (3), as before', a.new.d7 === 3);
    check('the snapshot itself is always our own latest pull', a.snapshot.total === 7 && a.snapshot.date === '2026-10-09');
    check('the shipped history ends before our first real snapshot (2026-10-09) and never decreases', (await import('../worker/txdmv-history.js')).DMV_HISTORY.every((p, i, all) => p.date < '2026-10-09' && p.total === p.cybercab + p.model_y && (!i || (p.cybercab >= all[i - 1].cybercab && p.model_y >= all[i - 1].model_y))));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
