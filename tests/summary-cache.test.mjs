// Stored, budgeted results (worker/summary-cache.js) and the four Social
// read paths built on them: the sidebar, For You / Most popular, the
// leaderboard (Top Contributors) and the Cybercab search.
//   1. the cache: served as stored within its lifetime; one recompute when it
//      expires; concurrent misses and concurrent refreshes don't stampede;
//      a failed refresh keeps serving the old value; the budget sets the lifetime
//   2. privacy and moderation stay immediate on top of stored data
//   3. new posts and vehicles still show at once
// Real SQL (every migration) + the REAL Worker router.
// Run: node tests/summary-cache.test.mjs

import { makeEnv, makeCheck, seedVehicle, approveVehicle } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { budgetedSummary, patchSummary, markSummaryStale, ttlFor, rowsRead } from '../worker/summary-cache.js';
import { searchVehicleIndex } from '../worker/social.js';

const t = makeCheck();
const { check } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60e3, DAY = 86400e3;
const OPTS = { minTtlMs: 10 * MIN, maxTtlMs: DAY, dailyRows: 1000 };

async function app() {
  const ctx = await makeEnv({ users: ['alice', 'bob', 'mod'] });
  for (const u of ['alice', 'bob', 'mod']) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`)._exec();
  ctx.d1.prepare(`UPDATE users SET role = 'moderator', leaderboard_opt_in = 1, display_name = 'Owner' WHERE id = 'mod'`)._exec();
  return ctx;
}
async function call(ctx, method, path, { session, json, form } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = new FormData(); for (const [k, v] of Object.entries(form)) body.append(k, v); }
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, json: out };
}
const expire = (ctx, key) => ctx.d1.prepare(`UPDATE community_summary SET computed_at = '2000-01-01T00:00:00.000Z' WHERE key = ?`).bind(key)._exec();
const stored = (ctx, key) => ctx.d1.query(`SELECT value, computed_at FROM community_summary WHERE key = ?`, key)[0];

async function run() {
  console.log('1. The budgeted cache');
  {
    check('the lifetime follows the cost: cheap → the minimum, big → longer, capped at the maximum',
      ttlFor(5, OPTS) === OPTS.minTtlMs && ttlFor(500, OPTS) === DAY / 2 && ttlFor(50000, OPTS) === DAY);
    check('rows_read is summed where the driver reports it, else the estimate is used',
      rowsRead([{ meta: { rows_read: 7 } }, { meta: { rows_read: 3 } }], 99) === 10 && rowsRead([{ meta: {} }], 42) === 42);
    const ctx = await app();
    let calls = 0, value = 1;
    const compute = async () => { calls++; await sleep(20); return { value: value, cost: 50 }; };
    const t0 = Date.parse('2026-10-18T12:00:00Z');
    const a = await budgetedSummary(ctx.env, 'k', compute, { ...OPTS, now: t0 });
    check('a miss computes once and stores the value', calls === 1 && a.value === 1 && JSON.parse(stored(ctx, 'k').value).v === 1);
    value = 2;
    const b = await budgetedSummary(ctx.env, 'k', compute, { ...OPTS, now: t0 + 5 * MIN });
    check('within its lifetime the stored value is served (no recompute), even if the data changed', calls === 1 && b.value === 1);
    const life = JSON.parse(stored(ctx, 'k').value).ttl_ms;
    check('the lifetime was set from the cost (50 rows of a 1,000/day budget → 72 min)', life === 72 * MIN);
    // Expired: many concurrent callers in different isolates (no shared in-flight).
    const later = t0 + life + MIN;
    const results = await Promise.all(Array.from({ length: 6 }, () => budgetedSummary(ctx.env, 'k', compute, { ...OPTS, now: later, shareInflight: false })));
    check('expired: concurrent refreshes do not stampede — exactly one recompute', calls === 2);
    check('...the refreshing request gets the new value, the others the stored one meanwhile', results.filter(r => r.value === 2).length === 1 && results.filter(r => r.value === 1 && r.stale).length === 5);
    check('...and the next read serves the new value', (await budgetedSummary(ctx.env, 'k', compute, { ...OPTS, now: later + 1000 })).value === 2 && calls === 2);
    // Missing: concurrent first misses across isolates.
    let calls2 = 0;
    const compute2 = async () => { calls2++; await sleep(60); return { value: 'x', cost: 5 }; };
    const firsts = await Promise.all(Array.from({ length: 5 }, () => budgetedSummary(ctx.env, 'k2', compute2, { ...OPTS, now: t0, shareInflight: false })));
    check('concurrent misses on a new key: one computes, the rest wait for its value', calls2 === 1 && firsts.every(r => r.value === 'x'));
    // Within one isolate the in-flight computation is shared.
    let calls3 = 0;
    const compute3 = async () => { calls3++; await sleep(30); return { value: 'y', cost: 5 }; };
    await Promise.all(Array.from({ length: 5 }, () => budgetedSummary(ctx.env, 'k3', compute3, { ...OPTS, now: t0 })));
    check('in one isolate, concurrent callers share one computation', calls3 === 1);
    // A failed refresh keeps the old value and lets the next request retry.
    expire(ctx, 'k');
    const failing = async () => { throw new Error('boom'); };
    const f = await budgetedSummary(ctx.env, 'k', failing, { ...OPTS, now: later + 2000 });
    check('a failed refresh serves the stored value and stays due for a retry', f.value === 2 && f.stale && stored(ctx, 'k').computed_at === '2000-01-01T00:00:00.000Z');
    check('patchSummary edits the stored value in place, keeping its freshness', await patchSummary(ctx.env, 'k', v => v + 1) && JSON.parse(stored(ctx, 'k').value).v === 3);
    await markSummaryStale(ctx.env, 'k');
    check('markSummaryStale makes the next read refresh', stored(ctx, 'k').computed_at.startsWith('2000'));
  }

  console.log('2. Privacy and moderation stay immediate');
  {
    const ctx = await app();
    approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'a1b2c3d4-0000-4000-8000-000000000001', plate: 'XVF3582' }), { withRide: true, userId: 'alice' });
    approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'b2c3d4e5-0000-4000-8000-000000000002', plate: 'XVF3210' }), { withRide: true, userId: 'bob' });
    let board = (await call(ctx, 'GET', '/api/community/leaderboard')).json;
    check('the leaderboard lists both riders (stored figures)', board.entries.length === 2 && !!stored(ctx, 'leaderboard'));
    await call(ctx, 'PATCH', '/api/profile', { session: 's-bob', json: { leaderboard_opt_in: false } });
    board = (await call(ctx, 'GET', '/api/community/leaderboard')).json;
    check('turning the public profile off removes the rider at once, without waiting for a refresh', board.entries.length === 1 && !JSON.stringify(board).includes('Bob B') && !stored(ctx, 'leaderboard').value.includes('Bob B'));
    await call(ctx, 'PATCH', '/api/profile', { session: 's-alice', json: { display_name: 'Alice Renamed', handle: 'alice_a', leaderboard_opt_in: true } });
    board = (await call(ctx, 'GET', '/api/community/leaderboard')).json;
    check('a new display name shows at once', board.entries[0].name === 'Alice Renamed');
    // Social: a removed post leaves Trending and For You at once.
    const p = (await call(ctx, 'POST', '/api/social/posts', { session: 's-alice', form: { body: 'Trending soon' } })).json.post;
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    expire(ctx, 'social_sidebar');
    check('Trending lists the liked post', (await call(ctx, 'GET', '/api/social/sidebar')).json.trending.some(x => x.id === p.id));
    check('For You lists it (stored ranking)', (await call(ctx, 'GET', '/api/social/feed?filter=foryou')).json.posts.some(x => x.id === p.id) && !!stored(ctx, 'social_rank_foryou'));
    await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-mod', json: { reason: 'test' } });
    check('a moderator removal takes it out of Trending at once (no refresh)', !(await call(ctx, 'GET', '/api/social/sidebar')).json.trending.some(x => x.id === p.id) && JSON.parse(stored(ctx, 'social_sidebar').value).v.trending.includes(p.id));
    check('...and out of For You at once', !(await call(ctx, 'GET', '/api/social/feed?filter=foryou')).json.posts.some(x => x.id === p.id));
    // Cybercab search: a vehicle made private disappears from the picker at once.
    check('search finds XVF3582 (stored index)', (await call(ctx, 'GET', '/api/social/vehicles?q=xvf35')).json.vehicles.length === 1 && !!stored(ctx, 'social_vehicle_index'));
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE license_plate = 'XVF3582'`);
    check('a vehicle made private is never shown, though the stored index still lists it', (await call(ctx, 'GET', '/api/social/vehicles?q=xvf35')).json.vehicles.length === 0 && stored(ctx, 'social_vehicle_index').value.includes('XVF3582'));
  }

  console.log('3. New things still show at once');
  {
    const ctx = await app();
    approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'a1b2c3d4-0000-4000-8000-000000000001', plate: 'XVF3582' }), { withRide: true, userId: 'alice' });
    const first = (await call(ctx, 'POST', '/api/social/posts', { session: 's-alice', form: { body: 'Older post' } })).json.post;
    await call(ctx, 'GET', '/api/social/feed?filter=foryou');   // stores the ranking
    const newer = (await call(ctx, 'POST', '/api/social/posts', { session: 's-bob', form: { body: 'Brand new post' } })).json.post;
    const fy = (await call(ctx, 'GET', '/api/social/feed?filter=foryou')).json;
    check('a post published after the ranking was stored shows in For You at once', fy.posts.some(x => x.id === newer.id) && fy.posts.some(x => x.id === first.id) && !JSON.parse(stored(ctx, 'social_rank_foryou').value).v.ids.includes(newer.id));
    await call(ctx, 'GET', '/api/social/vehicles?q=');   // stores the vehicle index
    approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'c3d4e5f6-0000-4000-8000-000000000003', plate: 'NEW1234' }), { withRide: true, userId: 'bob' });
    check('a vehicle made public after the index was stored is found by its full plate', (await call(ctx, 'GET', '/api/social/vehicles?q=new1234')).json.vehicles.map(v => v.license_plate).join() === 'NEW1234');
    check('...and by its id prefix', (await call(ctx, 'GET', '/api/social/vehicles?q=c3d4e5f6')).json.vehicles.length === 1);
    // In-memory matching mirrors the SQL rules.
    const idx = [['a1', 'XVF-3582', '7SAYGDEF5TA000123', 'Austin', 'manual'], ['b2', 'XVF3210', null, 'Austin', null], ['c3', null, '7SAYGDEF9TA000999', null, null]];
    check('index matching: partial plate (any case, dashes ignored), VIN, exact-first order, recency for blanks',
      searchVehicleIndex(idx, 'xvf3').map(v => v.id).join() === 'a1,b2' && searchVehicleIndex(idx, 'XVF3210')[0].id === 'b2' && searchVehicleIndex(idx, '000999').map(v => v.id).join() === 'c3' && searchVehicleIndex(idx, '').length === 3 && searchVehicleIndex(idx, '%%').length === 0);
  }

  console.log('4. Feed page 1 for signed-out visitors: a 60-second edge cache');
  {
    // A stand-in for Cloudflare's per-data-centre cache (caches.default),
    // honouring Cache-Control max-age against a clock we control.
    let clock = Date.now();
    const store = new Map();
    const realCaches = globalThis.caches;
    globalThis.caches = { default: {
      async match(req) { const e = store.get(req.url); return e && e.expires > clock ? e.res.clone() : undefined; },
      async put(req, res) { const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || ''); if (m) store.set(req.url, { res: res.clone(), expires: clock + Number(m[1]) * 1000 }); }
    } };
    try {
      const ctx = await app();
      let reads = 0;
      const prepare = ctx.d1.prepare.bind(ctx.d1);
      ctx.env.cybercabhunter_db = { ...ctx.d1, prepare: q => { reads++; return prepare(q); }, batch: b => ctx.d1.batch(b) };
      const p = (await call(ctx, 'POST', '/api/social/posts', { session: 's-alice', form: { body: 'Visible to everyone' } })).json.post;
      const feed = async (qs = '', session) => {
        const headers = session ? { Authorization: `Bearer ${session}` } : {};
        const r = await worker.fetch(new Request(`https://cybercabhunter.com/api/social/feed${qs}`, { headers }), ctx.env, { waitUntil() {} });
        return { json: await r.json(), cc: r.headers.get('Cache-Control') };
      };
      const first = await feed('?filter=foryou');
      reads = 0;
      const second = await feed('?filter=foryou');
      check('signed out, page 1: the second view within 60 s is served from the edge (0 database reads)', second.json.posts.some(x => x.id === p.id) && reads === 0);
      check('the browser is told not to store it (the edge copy is shared, never the browser\'s)', first.cc === 'private, no-store' && second.cc === 'private, no-store');
      reads = 0;
      await feed('?filter=foryou&utm_source=x&junk=1');
      check('unknown query parameters share the same copy (they can\'t bypass the cache)', reads === 0);
      await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-mod', json: { reason: 'test' } });
      check('accepted tradeoff: a removed post can stay on the signed-out page for up to 60 s', (await feed('?filter=foryou')).json.posts.some(x => x.id === p.id));
      check('signed-in views are never cached: the removal shows at once', !(await feed('?filter=foryou', 's-bob')).json.posts.some(x => x.id === p.id));
      clock += 61000;
      check('after 60 s the signed-out page is rebuilt without it', !(await feed('?filter=foryou')).json.posts.some(x => x.id === p.id));
      const p2 = (await call(ctx, 'POST', '/api/social/posts', { session: 's-bob', form: { body: 'Another one' } })).json.post;
      await feed('?filter=latest');
      reads = 0;
      await feed('?filter=latest', 's-alice');
      check('a request with a session never reads the shared copy', reads > 0);
      reads = 0;
      await feed('?filter=latest&cursor=eyJ0IjoiMjA5OS0wMS0wMSAwMDowMDowMCIsImlkIjoiZiJ9');
      const r2 = reads; reads = 0;
      await feed('?filter=latest&cursor=eyJ0IjoiMjA5OS0wMS0wMSAwMDowMDowMCIsImlkIjoiZiJ9');
      check('later pages (with a cursor) are never cached', r2 > 0 && reads > 0);
      check('Saved is never cached and still needs a session', (await worker.fetch(new Request('https://cybercabhunter.com/api/social/feed?filter=saved'), ctx.env, { waitUntil() {} })).status === 401 && !!p2);
    } finally { globalThis.caches = realCaches; }
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
