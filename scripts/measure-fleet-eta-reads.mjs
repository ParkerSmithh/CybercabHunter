// D1 rows read by the Fleet ETA feature (worker/fleet-eta.js), per page load,
// per API call and per daily run, plus a projected daily total.
//
//   node scripts/measure-fleet-eta-reads.mjs
//     LOCAL (default): a throwaway local D1 (wrangler's local engine, which
//     reports rows_read exactly as production bills it), built from
//     migrations/ and filled with production-sized SYNTHETIC data. Writes
//     nothing outside a temp directory, which it deletes.
//   node scripts/measure-fleet-eta-reads.mjs --remote [config] [binding]
//     READ-ONLY against a real database (default wrangler.preview.jsonc):
//     runs only the daily job's SELECTs and the page's stats-row read through
//     `wrangler d1 execute --remote`. Never writes; never prints result rows.
//
// Options: --size stress|current  synthetic data size (default stress)
//          --views N  page views per day for the projection (default 2000)
//          --reports N rider reports per day (default 50)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i === -1 ? dflt : process.argv[i + 1]; };
const VIEWS = Number(arg('--views', 2000)), REPORTS = Number(arg('--reports', 50));
const remote = process.argv.includes('--remote');
const ROOT = new URL('..', import.meta.url).pathname;

// A D1 wrapper that adds up meta.rows_read per labelled step.
function metered(db) {
  const steps = [];
  let current = null;
  const wrap = stmt => {
    const rec = r => { if (current) { const n = Number(r && r.meta && r.meta.rows_read || 0); current.rows_read += n; current.queries++; if (process.env.DEBUG_QUERIES) console.error(`${String(n).padStart(8)}  ${current.label.slice(0, 22)}  ${stmt.__sql}`); } return r; };
    const s = {
      bind(...v) { const b = stmt.bind(...v); b.__sql = stmt.__sql; return wrap(b); },
      async all() { return rec(await stmt.all()); },
      async run() { return rec(await stmt.run()); },
      async first() { const r = await stmt.all(); rec(r); return (r.results && r.results[0]) || null; },
      _inner: stmt
    };
    return s;
  };
  return {
    sql: { prepare: q => { const st = db.prepare(q); st.__sql = q.replace(/\s+/g, ' ').slice(0, 110); return wrap(st); }, batch: async ss => { const out = await db.batch(ss.map(s => s._inner)); out.forEach(r => { if (current) { current.rows_read += Number(r.meta.rows_read || 0); current.queries++; } }); return out; } },
    async step(label, fn) { current = { label, rows_read: 0, queries: 0 }; steps.push(current); try { return await fn(); } finally { current = null; } },
    steps
  };
}

// migrations/*.sql -> statements (CREATE TRIGGER ... END; kept whole).
function splitSql(text) {
  const out = []; let buf = []; let inTrigger = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/--.*$/, '');
    if (!line.trim()) continue;
    buf.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) { out.push(buf.join('\n')); buf = []; inTrigger = false; }
  }
  return out;
}

async function local() {
  const { getPlatformProxy } = await import('wrangler');
  const dir = await mkdtemp(join(tmpdir(), 'cch-eta-measure-'));
  const cfg = join(dir, 'wrangler.jsonc');
  await writeFile(cfg, JSON.stringify({ name: 'eta-measure', compatibility_date: '2024-09-23', d1_databases: [{ binding: 'DB', database_name: 'eta-measure', database_id: '00000000-0000-0000-0000-000000000000' }] }));
  const { env, dispose } = await getPlatformProxy({ configPath: cfg, persist: { path: join(dir, 'state') } });
  try {
    const db = env.DB;
    for (const f of fs.readdirSync(join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const stmts = splitSql(fs.readFileSync(join(ROOT, 'migrations', f), 'utf8'));
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50).map(s => db.prepare(s)));
    }
    const size = await seed(db);
    const m = metered(db);
    const eta = await import('../worker/fleet-eta.js');
    const stats = await import('../worker/fleet-stats.js');
    const kv = new Map();
    const KV = { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } };
    await KV.put('session:measure', JSON.stringify({ user_id: 'u0' }));
    const wenv = { cybercabhunter_db: m.sql, TESLA_SESSIONS: KV };
    const req = (method, path, body, ip = '203.0.113.1') => new Request(`https://cybercabhunter.com${path}`, { method, headers: { Authorization: 'Bearer measure', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: body ? JSON.stringify(body) : undefined });

    await m.step('GET /api/fleet-eta, before the first daily run (cache miss)', () => eta.apiFleetEta(req('GET', '/api/fleet-eta?city=austin'), wenv));
    await m.step('daily job: Austin (FLEET_STATS_CRON)', () => eta.recomputeFleetEta(wenv, Date.now(), ['austin']));
    await m.step('daily job: Dallas (TXDMV_CRON)', () => eta.recomputeFleetEta(wenv, Date.now(), ['dallas']));
    await m.step('GET /api/fleet-eta?city=austin (cache miss)', () => eta.apiFleetEta(req('GET', '/api/fleet-eta?city=austin'), wenv));
    await m.step('GET /api/fleet-eta?city=dallas (cache miss)', () => eta.apiFleetEta(req('GET', '/api/fleet-eta?city=dallas'), wenv));
    await m.step('POST /api/fare-reports (one report)', () => eta.apiCreateFareReport(req('POST', '/api/fare-reports', { city: 'austin', kind: 'quote', vehicle_type: 'unknown', quoted_wait_minutes: 9, observed_at: new Date().toISOString() }), wenv));
    await m.step('GET /api/fleet-stats?city=austin (existing live count, unchanged; for comparison)', () => stats.apiFleetStats(req('GET', '/api/fleet-stats?city=austin'), wenv));
    report(m.steps, size);
  } finally {
    await dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

// Synthetic data (see --size). Plain literals (no binds) keep it fast.
async function seed(db) {
  // --size stress (default): ~50x today's tables. --size current: roughly the
  // site's published counts in Oct 2026 (tens of public Cybercabs, hundreds of
  // rides and sightings, no rider reports yet).
  const N = arg('--size', 'stress') === 'current'
    ? { users: 300, austinVehicles: 120, dallasVehicles: 15, trips: 600, sightings: 300, cameras: 2000, reports: 0, dmv: 30 }
    : { users: 3000, austinVehicles: 450, dallasVehicles: 80, trips: 25000, sightings: 8000, cameras: 40000, reports: 6000, dmv: 120 };
  let r = 42; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const chunks = async (n, make, per = 400) => { for (let i = 0; i < n; i += per) { const rows = []; for (let j = i; j < Math.min(n, i + per); j++) rows.push(make(j)); await db.batch(rows.map(s => db.prepare(s))); } };
  const iso = ms => new Date(ms).toISOString();
  const now = Date.now(), day = 864e5;
  await chunks(N.users, i => `INSERT INTO users (id, display_name) VALUES ('u${i}', 'Rider ${i}')`);
  const nv = N.austinVehicles + N.dallasVehicles;
  await chunks(nv, i => `INSERT INTO robotaxi_vehicles (id, license_plate, model, service_area, visibility, origin, vin, approval_basis, first_seen_at, last_seen_at) VALUES ('v${i}', 'P${i}', '${i % 3 ? 'Cybercab' : 'Model Y'}', '${i < N.austinVehicles ? 'Austin' : 'Dallas'}', 'public', 'sighting', 'VIN${i}', 'vin-verified', datetime('now'), datetime('now'))`);
  await chunks(N.trips, i => `INSERT INTO submissions (id, user_id, submission_type, status, evidence_type) VALUES ('s${i}', 'u${i % N.users}', 'ride_receipt', 'approved', 'email_receipt')`);
  await chunks(N.trips, i => {
    const ts = now - rnd() * 365 * day, miles = (0.6 + rnd() * 10).toFixed(2), austin = i % 5 !== 0;
    const v = rnd() < 0.7 ? `'v${austin ? i % N.austinVehicles : N.austinVehicles + (i % N.dallasVehicles)}'` : 'NULL';
    return `INSERT INTO trips (id, submission_id, user_id, service_area, ride_date, pickup_time, started_at_utc, distance, fare_amount_cents, currency, robotaxi_vehicle_id, ride_key, pickup_description) VALUES ('t${i}', 's${i}', 'u${i % N.users}', '${austin ? 'Austin' : 'Dallas'}', '${iso(ts).slice(0, 10)}', '${iso(ts).slice(11, 16)}', '${iso(ts)}', ${miles}, ${Math.round((3 + 1.5 * miles) * (0.85 + rnd() * 0.3) * 100)}, 'USD', ${v}, 'k${i}', '1 Main St, Austin, TX 78701')`;
  });
  await chunks(N.sightings, i => `INSERT INTO submissions (id, user_id, submission_type, status, evidence_type) VALUES ('ss${i}', 'u${i % N.users}', 'vehicle_sighting', 'approved', 'photo')`);
  await chunks(N.sightings, i => `INSERT INTO vehicle_observations (id, robotaxi_vehicle_id, user_id, submission_id, observed_at, service_area) VALUES ('o${i}', ${i % 4 ? `'v${i % nv}'` : 'NULL'}, 'u${i % N.users}', 'ss${i}', '${iso(now - rnd() * 200 * day).replace('T', ' ').slice(0, 19)}', '${i % 6 ? 'Austin' : 'Dallas'}')`);
  await chunks(N.cameras, i => `INSERT INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, city) VALUES ('c${i}', 'cam${i % 800}', 'Cam', 30.2, -97.7, '${iso(now - (i / N.cameras) * 120 * day - i)}', '${i % 7 ? 'austin' : 'dallas'}')`);
  await chunks(N.reports, i => {
    const ts = now - rnd() * 170 * day;
    return `INSERT INTO fare_reports (id, user_id, city, pickup_area, kind, vehicle_type, distance_miles, quoted_fare_cents, quoted_wait_minutes, observed_hour_utc, local_dow, local_hour, status, ip_day_hash, dedupe_key, created_at) VALUES ('f${i}', 'u${i % N.users}', '${i % 5 ? 'austin' : 'dallas'}', 'downtown', 'quote', 'unknown', 3.2, 1100, ${5 + (i % 15)}, '${iso(Math.floor(ts / 36e5) * 36e5).replace('.000Z', 'Z')}', ${i % 7}, ${i % 24}, '${i % 3 ? 'approved' : 'pending'}', 'h${i % 500}', 'd${i}', '${iso(ts).replace(/\.\d{3}Z$/, 'Z')}')`;
  });
  await chunks(N.dmv, i => `INSERT INTO dmv_snapshots (snapshot_date, total, cybercab_count, model_y_count, authorization_number, raw_json, polled_at) VALUES ('${iso(now - i * day).slice(0, 10)}', ${500 + i}, ${200 + i}, ${300}, 'A1', '[]', '${iso(now - i * day)}')`);
  return N;
}

function report(steps, size) {
  const get = re => (steps.find(s => re.test(s.label)) || { rows_read: 0 }).rows_read;
  const pageMiss = Math.max(get(/city=austin \(cache miss\)/), get(/city=dallas \(cache miss\)/));
  const daily = get(/daily job: Austin/) + get(/daily job: Dallas/);
  const perReport = get(/POST \/api\/fare-reports/);
  // Worst case: every page view misses the edge cache and loads both cities.
  const projected = daily + VIEWS * 2 * pageMiss + REPORTS * perReport;
  console.log(JSON.stringify({
    at: new Date().toISOString(), mode: `local, synthetic data (--size ${arg('--size', 'stress')})`, data_size: size,
    steps: steps.map(s => ({ step: s.label, queries: s.queries, rows_read: s.rows_read })),
    projection: {
      assumptions: { page_views_per_day: VIEWS, cities_per_view: 2, every_view_misses_cache: true, reports_per_day: REPORTS },
      daily_job_rows: daily, page_rows: VIEWS * 2 * pageMiss, report_rows: REPORTS * perReport,
      total_rows_per_day: projected, budget: 50000, target: 5000, within_budget: projected <= 50000
    }
  }, null, 2));
}

// ---- remote, read-only -------------------------------------------------------
async function remoteRun() {
  const config = process.argv[process.argv.indexOf('--remote') + 1] && !process.argv[process.argv.indexOf('--remote') + 1].startsWith('--') ? process.argv[process.argv.indexOf('--remote') + 1] : 'wrangler.preview.jsonc';
  const binding = 'cybercabhunter_db';
  const logDir = await mkdtemp(join(tmpdir(), 'cch-eta-remote-'));
  const steps = []; let current = null;
  const quote = v => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const sql = {
    prepare(query) {
      let params = [];
      const st = {
        bind(...v) { params = v; return st; },
        async all() {
          if (!/^\s*SELECT/i.test(query)) throw new Error('remote mode is read-only');
          let i = 0;
          const command = query.replace(/\?/g, () => quote(params[i++]));
          const { stdout } = await execute(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', binding, '-c', config, '--remote', '--json', '--command', command],
            { env: { ...process.env, WRANGLER_LOG_PATH: join(logDir, 'w.log') }, maxBuffer: 64 * 1024 * 1024 });
          const [res] = JSON.parse(stdout);
          if (current) { current.rows_read += Number(res.meta.rows_read || 0); current.queries++; }
          return res;
        },
        async first() { return ((await st.all()).results || [])[0] || null; },
        async run() { throw new Error('remote mode is read-only'); }
      };
      return st;
    }
  };
  try {
    const eta = await import('../worker/fleet-eta.js');
    for (const city of ['austin', 'dallas']) {
      // The daily job's reads, without its write (buildCityPayload is pure).
      current = { label: `daily job reads: ${city}`, rows_read: 0, queries: 0 }; steps.push(current);
      const reads = await eta.dailyReads(sql, city, Date.now());
      eta.buildCityPayload(city, reads, Date.now());
      current = { label: `GET /api/fleet-eta?city=${city} (cache miss)`, rows_read: 0, queries: 0 }; steps.push(current);
      await sql.prepare('SELECT model_version, payload FROM fleet_eta_stats WHERE city = ?').bind(city).first().catch(() => null);
    }
    current = null;
    console.log(JSON.stringify({ at: new Date().toISOString(), mode: `remote read-only (${config})`, steps: steps.map(s => ({ step: s.label, queries: s.queries, rows_read: s.rows_read })) }, null, 2));
  } finally {
    await rm(logDir, { recursive: true, force: true });
  }
}

if (remote) await remoteRun(); else await local();
