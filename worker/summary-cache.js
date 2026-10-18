// Shared, precomputed results with a D1 read budget (the community_summary
// table, migrations/0040: one row per key). A page view reads ONE row and
// never runs the aggregation behind it. The aggregation runs only when the
// row is missing or stale, and a stale row is refreshed by exactly one
// request while every other request keeps serving the previous value.
//
// BUDGET: each result records how many rows its computation read (`cost`).
// The row stays fresh for cost / dailyRows of a day, clamped to
// [minTtlMs, maxTtlMs], so a key's refreshes read at most about
// max(dailyRows, cost × day / maxTtlMs) rows a day however busy the site is.
// A small, cheap result refreshes often (every minTtlMs); a big one slows down
// on its own as the data grows.
//
// STAMPEDES: within one Worker isolate, concurrent callers share one
// in-flight computation. Across isolates, a stale row is claimed with a
// compare-and-swap on computed_at (UPDATE ... WHERE computed_at = <old>), so
// one request recomputes and the rest serve the stale value; a missing row is
// claimed with INSERT ... ON CONFLICT DO NOTHING, and the losers wait briefly
// for the winner's value before computing themselves.
//
// The table holds server-side data only. Values are never sent to a browser
// as-is; each caller decides what leaves the server.

const DAY_MS = 86400000;
const CLAIM_WAIT_MS = [100, 200, 400, 800];   // a missing row: how long losers wait for the winner
const inflight = new Map();                   // key -> Promise (this isolate)

const iso = ms => new Date(ms).toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// How long a result stays fresh, from what it cost to compute.
export function ttlFor(cost, { minTtlMs, maxTtlMs, dailyRows }) {
  const ttl = (Math.max(0, Number(cost) || 0) / Math.max(1, dailyRows)) * DAY_MS;
  return Math.round(Math.min(maxTtlMs, Math.max(minTtlMs, ttl)));
}

// Sums D1's rows_read over query results (production and local D1 report it);
// `fallback` is used where a driver doesn't (the in-memory test database).
export function rowsRead(results, fallback = 0) {
  let total = 0, known = false;
  for (const r of [].concat(results)) {
    const n = r && r.meta && r.meta.rows_read;
    if (Number.isFinite(n)) { total += n; known = true; }
  }
  return known ? total : fallback;
}

async function readRow(sql, key) {
  const row = await sql.prepare(`SELECT value, computed_at FROM community_summary WHERE key = ?`).bind(key).first();
  if (!row) return null;
  let parsed = null;
  try { parsed = JSON.parse(row.value); } catch (e) { parsed = null; }
  return { computed_at: row.computed_at, entry: parsed && typeof parsed === 'object' && 'v' in parsed ? parsed : null };
}

async function writeRow(sql, key, entry, computedAt) {
  await sql.prepare(`INSERT INTO community_summary (key, value, computed_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at`)
    .bind(key, JSON.stringify(entry), computedAt).run();
}

async function computeAndStore(env, key, compute, opts, now) {
  const { value, cost } = await compute(env, now);
  const entry = { v: value, cost: Math.max(0, Number(cost) || 0), ttl_ms: ttlFor(cost, opts) };
  await writeRow(env.cybercabhunter_db, key, entry, iso(now));
  return { value, computed_at: iso(now), stale: false, cost: entry.cost };
}

// The stored value for `key`, refreshed by `compute(env, now) -> { value, cost }`
// when missing or stale. Returns { value, computed_at, stale }.
export async function budgetedSummary(env, key, compute, opts) {
  const { now = Date.now(), force = false, shareInflight = true } = opts;
  if (shareInflight && inflight.has(key)) return inflight.get(key);
  const run = (async () => {
    const sql = env.cybercabhunter_db;
    const row = await readRow(sql, key);
    const fresh = row && row.entry && !force && now - Date.parse(row.computed_at) < (row.entry.ttl_ms || 0);
    if (fresh) return { value: row.entry.v, computed_at: row.computed_at, stale: false };
    if (row && row.entry) {
      // Stale (or forced): one request claims the refresh; the rest serve the old value.
      const claim = await sql.prepare(`UPDATE community_summary SET computed_at = ? WHERE key = ? AND computed_at = ?`).bind(iso(now), key, row.computed_at).run();
      if (!claim || !claim.meta || claim.meta.changes !== 1) return { value: row.entry.v, computed_at: row.computed_at, stale: true };
      try { return await computeAndStore(env, key, compute, opts, now); } catch (e) {
        // Let the next request try again; keep serving what we had.
        await sql.prepare(`UPDATE community_summary SET computed_at = ? WHERE key = ?`).bind(row.computed_at, key).run().catch(() => {});
        return { value: row.entry.v, computed_at: row.computed_at, stale: true };
      }
    }
    // Missing: claim it with a placeholder row; losers wait for the winner.
    // A placeholder left by a winner that died (older than 30 s) is taken over.
    let won = false;
    if (!row) {
      const ins = await sql.prepare(`INSERT INTO community_summary (key, value, computed_at) VALUES (?, '{}', ?) ON CONFLICT(key) DO NOTHING`).bind(key, iso(now)).run();
      won = !!(ins && ins.meta && ins.meta.changes === 1);
    } else if (now - Date.parse(row.computed_at) > 30000 || !Number.isFinite(Date.parse(row.computed_at))) {
      const take = await sql.prepare(`UPDATE community_summary SET computed_at = ? WHERE key = ? AND computed_at = ?`).bind(iso(now), key, row.computed_at).run();
      won = !!(take && take.meta && take.meta.changes === 1);
    }
    if (won) {
      try { return await computeAndStore(env, key, compute, opts, now); } catch (e) {
        await sql.prepare(`DELETE FROM community_summary WHERE key = ? AND value = '{}'`).bind(key).run().catch(() => {});
        throw e;
      }
    }
    for (const ms of CLAIM_WAIT_MS) {
      await sleep(ms);
      const again = await readRow(sql, key);
      if (again && again.entry) return { value: again.entry.v, computed_at: again.computed_at, stale: false };
    }
    return computeAndStore(env, key, compute, opts, now);   // the winner never finished: compute ourselves
  })();
  if (!shareInflight) return run;
  inflight.set(key, run);
  try { return await run; } finally { inflight.delete(key); }
}

// Changes a stored value in place (e.g. dropping a rider who turned their
// public profile off), without recomputing it or changing its freshness.
// `patch(value)` returns the new value, or undefined for "nothing to change".
// Returns true when a change was written.
export async function patchSummary(env, key, patch) {
  const sql = env.cybercabhunter_db;
  const row = await readRow(sql, key);
  if (!row || !row.entry) return false;
  const next = patch(row.entry.v);
  if (next === undefined) return false;
  const res = await sql.prepare(`UPDATE community_summary SET value = ? WHERE key = ? AND computed_at = ?`)
    .bind(JSON.stringify({ ...row.entry, v: next }), key, row.computed_at).run();
  return !!(res && res.meta && res.meta.changes === 1);
}

// Makes the next read refresh `key` (the stored value is still served to
// anyone who loses the refresh claim, so only use it when that value is
// safe to show, e.g. after patchSummary removed what must not be shown).
export async function markSummaryStale(env, key) {
  await env.cybercabhunter_db.prepare(`UPDATE community_summary SET computed_at = '2000-01-01T00:00:00.000Z' WHERE key = ? AND value <> '{}'`).bind(key).run();
}
