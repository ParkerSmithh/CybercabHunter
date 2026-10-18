// D1 rows-read measurement for the Social data paths (a dev tool, not part
// of the normal test run). It runs the REAL Worker code against Cloudflare's
// local D1 (Miniflare via wrangler's getPlatformProxy), which reports
// `rows_read` per query exactly as production meters it, over a seeded
// database at several post counts. Nothing here touches production.
//
//   node tests/budget/social-reads.mjs [--repo=/path/to/checkout] [--posts=300,1000,3000] [--json=out.json]
//
// --repo measures another checkout's worker code (e.g. a worktree of main,
// for before/after); migrations always come from that checkout too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeKV, fakeR2 } from '../helpers/d1-sqlite.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const REPO = path.resolve(args.repo || path.join(HERE, '..', '..'));
const POSTS = (args.posts || '300,1000,3000').split(',').map(Number);
const WRANGLER = path.join(HERE, '..', '..', 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
const WRANGLER_BIN = path.join(HERE, '..', '..', 'node_modules', '.bin', 'wrangler');
const { getPlatformProxy } = await import(WRANGLER);
const worker = (await import(path.join(REPO, 'worker', 'index.js'))).default;

const USERS = 300, VEHICLES_PUBLIC = 300, VEHICLES_PRIVATE = 100;

// --edge: simulate one Cloudflare data centre's cache (caches.default), so
// edge-cached responses are measured as a visitor would get them. Entries
// never expire within a run: "per view" is then a view within the TTL.
if (args.edge) {
  const store = new Map();
  globalThis.caches = { default: {
    async match(req) { const r = store.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { if (/max-age=\d+/.test(res.headers.get('Cache-Control') || '')) store.set(req.url, res.clone()); },
    clear() { store.clear(); }
  } };
}

// Counts rows_read across every statement the Worker runs.
function meteredD1(db) {
  const meter = { rows: 0, queries: 0 };
  const add = (r, sql) => { meter.queries++; const n = Number(r && r.meta && r.meta.rows_read) || 0; meter.rows += n; if (process.env.TRACE && n > 50) console.log('   ', n, String(sql || '').replace(/\s+/g, ' ').slice(0, 160)); return r; };
  const wrapStmt = (stmt, sql) => ({
    _inner: stmt,
    bind: (...a) => wrapStmt(stmt.bind(...a), sql),
    async all() { return add(await stmt.all(), sql); },
    async run() { return add(await stmt.run(), sql); },
    async raw(o) { const r = add(await stmt.all(), sql); return (r.results || []).map(row => Object.values(row)); },
    async first(col) { const r = add(await stmt.all(), sql); const row = (r.results || [])[0] || null; return row && col ? row[col] : row; }
  });
  return {
    meter,
    prepare: sql => wrapStmt(db.prepare(sql), sql),
    async batch(stmts) { const out = await db.batch(stmts.map(s => s._inner)); out.forEach(add); return out; },
    exec: sql => db.exec(sql),
    dump: () => db.dump()
  };
}

async function setup(nPosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-reads-'));
  const config = path.join(dir, 'wrangler.jsonc');
  fs.writeFileSync(config, JSON.stringify({
    name: 'social-reads', main: 'w.js', compatibility_date: '2024-09-23',
    d1_databases: [{ binding: 'DB', database_name: 'social-reads', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: path.join(REPO, 'migrations') }]
  }));
  fs.writeFileSync(path.join(dir, 'w.js'), 'export default { fetch() { return new Response("x"); } };');
  execFileSync(WRANGLER_BIN, ['d1', 'migrations', 'apply', 'social-reads', '--local', '--persist-to', path.join(dir, 'state'), '-c', config], { stdio: 'pipe', env: { ...process.env, CI: 'true' } });
  const proxy = await getPlatformProxy({ configPath: config, persist: { path: path.join(dir, 'state', 'v3') } });
  const db = proxy.env.DB;
  await seed(db, nPosts);
  return { proxy, db, dir };
}

const pad = (n, w) => String(n).padStart(w, '0');
const hex32 = (prefix, n) => (prefix + pad(n.toString(16), 32)).slice(-32);
async function inBatches(db, stmts, size = 200) { for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size)); }

// A representative community: 300 riders (public, with XP), 400 registry
// vehicles (300 public with counted rides), N posts over 60 days (20 % with
// photos, 30 % ride reviews, real like/comment counts).
async function seed(db, nPosts) {
  const s = [];
  for (let i = 0; i < USERS; i++) {
    s.push(db.prepare(`INSERT INTO users (id, display_name, handle, profile_visibility, leaderboard_opt_in) VALUES (?, ?, ?, 'public', ?)`).bind(`u${i}`, `Rider ${i}`, `rider_${i}`, i % 10 === 0 ? 0 : 1));
    s.push(db.prepare(`INSERT INTO user_xp (user_id, xp) VALUES (?, ?)`).bind(`u${i}`, (i * 137) % 9000));
  }
  for (let i = 0; i < VEHICLES_PUBLIC + VEHICLES_PRIVATE; i++) {
    const id = `${pad(i.toString(16), 8)}-0000-4000-8000-${pad(i, 12)}`;
    const pub = i < VEHICLES_PUBLIC;
    s.push(db.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, model, service_area, visibility, vin, approval_basis, last_seen_at) VALUES (?, ?, 'Cybercab', 'Austin', ?, ?, ?, datetime('now', ?))`)
      .bind(id, `XVF${pad(1000 + i, 4)}`, pub ? 'public' : 'private', i % 2 ? `7SAYGDEF${pad(i, 9)}` : null, pub ? 'manual' : null, `-${i} hours`));
    if (pub) for (let k = 0; k < 2; k++) {
      const sub = `sub-${i}-${k}`, u = `u${(i + k) % USERS}`;
      s.push(db.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, evidence_type) VALUES (?, ?, 'ride_receipt', 'approved', 'email_receipt')`).bind(sub, u));
      // Fixed timestamps, so every run (and every checkout) sees the same data.
      s.push(db.prepare(`INSERT INTO trips (id, submission_id, user_id, provider, service_area, ride_date, distance, robotaxi_vehicle_id, source, created_at) VALUES (?, ?, ?, 'tesla', 'Austin', date('2026-10-01', ?), 3.5, ?, 'receipt_email', datetime('2026-06-01', ?))`).bind(`trip-${i}-${k}`, sub, u, `-${(i + k) % 90} days`, id, `+${i * 2 + k} hours`));
    }
  }
  for (let i = 0; i < nPosts; i++) {
    const id = hex32('a', i);
    const hoursAgo = Math.floor((i / nPosts) ** 2 * 24 * 60);   // more recent posts are denser
    s.push(db.prepare(`INSERT INTO social_posts (id, user_id, body, category, like_count, comment_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`)
      .bind(id, `u${i % USERS}`, `Post number ${i} about a Cybercab sighting downtown`, ['general', 'sighting', 'question', 'news', 'review'][i % 5], (i * 7) % 13, (i * 3) % 5, `-${hoursAgo} hours`, `-${hoursAgo} hours`));
    if (i % 5 === 0) s.push(db.prepare(`INSERT INTO social_post_photos (id, post_id, position, r2_key, content_type) VALUES (?, ?, 0, ?, 'image/jpeg')`).bind(hex32('b', i), id, `social/x/${id}/p`));
    if (i % 10 < 3) s.push(db.prepare(`INSERT INTO social_post_reviews (post_id, rating) VALUES (?, ?)`).bind(id, 1 + (i % 5)));
  }
  await inBatches(db, s);
}

async function request(env, d1, p, session) {
  const headers = { Origin: 'https://cybercabhunter.com' };
  if (session) headers.Authorization = `Bearer ${session}`;
  d1.meter.rows = 0; d1.meter.queries = 0;
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${p}`, { headers }), env, { waitUntil() {} });
  await r.arrayBuffer();
  if (r.status !== 200) throw new Error(`${p}: ${r.status}`);
  return { rows: d1.meter.rows, queries: d1.meter.queries };
}
// Makes every stored summary stale, so the next request pays for a refresh.
const staleAll = db => db.prepare(`UPDATE community_summary SET computed_at = '2000-01-01T00:00:00.000Z'`).run().catch(() => {});
const hasSummary = async db => { try { return (await db.prepare(`SELECT COUNT(*) AS n FROM community_summary`).first('n')) > 0; } catch (e) { return false; } };

const PATHS = [
  ['sidebar', '/api/social/sidebar', null],
  ['for_you (signed out)', '/api/social/feed?filter=foryou', null],
  ['for_you (signed in)', '/api/social/feed?filter=foryou', 's-u1'],
  ['photos popular', '/api/social/feed?filter=photos&sort=popular', null],
  ['latest (reference)', '/api/social/feed?filter=latest', null],
  ['latest (signed in)', '/api/social/feed?filter=latest', 's-u1'],
  ['photos newest', '/api/social/feed?filter=photos', null],
  ['top contributors', '/api/community/leaderboard', null],
  ['vehicle search "xvf12"', '/api/social/vehicles?q=xvf12', null],
  ['vehicle search ""', '/api/social/vehicles?q=', null]
];

const out = { repo: REPO, measured_at: new Date().toISOString(), results: {} };
if (args.boards) {
  // Output check: the leaderboard JSON of every board, on the seeded data.
  const { proxy, db, dir } = await setup(POSTS[0]);
  const d1 = meteredD1(db);
  const env = { cybercabhunter_db: d1, TESLA_SESSIONS: fakeKV(), EVIDENCE_BUCKET: fakeR2(), FRONTEND_URL: 'https://cybercabhunter.com/' };
  const boards = {};
  for (const b of ['overall', 'discovered', 'miles', 'rides', 'vehicles', 'xp']) {
    const r = await worker.fetch(new Request(`https://cybercabhunter.com/api/community/leaderboard?board=${b}`), env, { waitUntil() {} });
    boards[b] = await r.text();
  }
  fs.writeFileSync(args.boards, JSON.stringify(boards));
  await proxy.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
for (const n of POSTS) {
  const { proxy, db, dir } = await setup(n);
  const d1 = meteredD1(db);
  const kv = fakeKV();
  await kv.put('session:s-u1', JSON.stringify({ user_id: 'u1' }));
  const env = { cybercabhunter_db: d1, TESLA_SESSIONS: kv, EVIDENCE_BUCKET: fakeR2(), FRONTEND_URL: 'https://cybercabhunter.com/' };
  const res = {};
  for (const [name, p, session] of PATHS) {
    if (globalThis.caches && globalThis.caches.default.clear) globalThis.caches.default.clear();
    const first = await request(env, d1, p, session);       // cold: a summary may be computed here
    const warm = await request(env, d1, p, session);        // steady state: what a normal view costs
    let refresh = null;
    if (await hasSummary(db)) {
      await staleAll(db);
      if (globalThis.caches && globalThis.caches.default.clear) globalThis.caches.default.clear();
      refresh = await request(env, d1, p, session); await request(env, d1, p, session);
    }
    res[name] = { cold: first.rows, per_view: warm.rows, refresh: refresh ? refresh.rows : null };
  }
  out.results[n] = res;
  console.log(`\n${n} posts, ${USERS} riders, ${VEHICLES_PUBLIC + VEHICLES_PRIVATE} vehicles — rows read`);
  console.log('path'.padEnd(26), 'per view'.padStart(9), 'cold'.padStart(9), 'refresh'.padStart(9));
  for (const [name, r] of Object.entries(res)) console.log(name.padEnd(26), String(r.per_view).padStart(9), String(r.cold).padStart(9), String(r.refresh ?? '—').padStart(9));
  await proxy.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2));
