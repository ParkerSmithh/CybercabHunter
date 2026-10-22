// The Community page's precomputed numbers (D1 read budget: never aggregate
// on a pageview). Computed ONCE A DAY by the daily cron (FLEET_STATS_CRON,
// 6 AM CT; worker/index.js) — and once on first use if the row is missing or
// more than 36 hours old — into ONE row of community_summary
// (migrations/0040). Every page request reads that single row (edge-cached
// 5 minutes on top).
//
//   GET /api/community/summary                 public, edge-cached 5 min
//     -> { computed_at, sightings: { verified, photos_submitted, cities,
//          site_start, last_14_days: [{ date, n }] }, streaks: { active_daily,
//          active_weekly, record_daily, record_weekly, verified_this_week } }
//   GET /api/streaks/leaderboard?board=daily|weekly|longest   public, edge-cached 5 min
//     -> { board, label, boards, entries, stats, computed_at }  (streaks as of the daily run)
//
// The rules are worker/streaks.js's, unchanged (approved vehicle sightings
// only, on the Austin day submitted). Counts are over every spotter and name
// no one; the rankings list only riders with leaderboard_opt_in = 1, with the
// same public fields as the main leaderboard; the system account never counts.
// The rider's own /api/streaks/me stays live (one rider's rows, by index).
//
// Who is shown, and as what, is CURRENT: the daily row stores only each
// board's order (rider ids and streak numbers, never a name or photo, for
// the top RANK_POOL riders whatever their privacy setting). Each response
// reads those riders' name, username, photo and switch from users by primary
// key (one query, at most RANK_POOL rows, once per edge-cache period) and
// keeps the opted-in ones: a rename, a new photo or the privacy switch (off
// or back on) shows on the next request, and a deleted account is gone. The
// streak numbers and the order stay the daily run's; ranks are counted
// among the riders shown, so a hidden rider leaves no gap.

import { computeStreaks, austinDayIndex, dayKey, weekIndex, weekMonday, STREAK_TZ } from './streaks.js';
import { safeAvatar } from './community.js';
import { profileCached } from './profile-cache.js';
import { rankFor } from './progression-levels.js';

const KEY = 'community';
const MAX_AGE_MS = 36 * 3600e3;
const CACHE_SECONDS = 300;
const TOP_N = 10;
// Riders stored per board: enough that hiding some (privacy off) still fills the top 10.
const RANK_POOL = 50;
const SPARK_DAYS = 14;
const BOARDS = { daily: 'Top daily streaks', weekly: 'Top weekly streaks', longest: 'Longest all-time streaks' };
const APPROVED = `s.submission_type = 'vehicle_sighting' AND s.status = 'approved'`;
const parseUtc = s => Date.parse(String(s).replace(' ', 'T') + (/[zZ]$/.test(s) ? '' : 'Z'));
const displayName = u => (u.display_name && String(u.display_name).trim()) || (u.handle ? `@${u.handle}` : 'Spotter');
// "austin, tx" / "Austin" -> "Austin": the city part, title case.
const cityOf = raw => String(raw || '').split(',')[0].trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());

const BOARD_KEY = { daily: r => [r.daily_current, r.longest_daily, r.weekly_current], weekly: r => [r.weekly_current, r.longest_weekly, r.daily_current], longest: r => [r.longest_daily, r.longest_weekly, r.daily_current] };

// One board's stored order (the daily run): the top RANK_POOL riders with a
// streak, opted in or not, as { uid, streak numbers } only. Ties keep the
// existing order (the name then, alphabetically).
function orderBoard(riders, board) {
  const key = BOARD_KEY[board];
  const cmp = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i]; return displayName(a.user).localeCompare(displayName(b.user)); };
  return riders.filter(r => key(r)[0] > 0).sort(cmp).slice(0, RANK_POOL)
    .map(r => ({ uid: r.user.uid, daily_current: r.daily_current, weekly_current: r.weekly_current, longest_daily: r.longest_daily, longest_weekly: r.longest_weekly }));
}

// The public board: the stored order, kept to riders who are opted in NOW,
// with their CURRENT name, username and photo (`users`: id -> row), top 10.
// Same value, same rank (shown once, never duplicated).
export function rankBoard(order, board, users) {
  const key = BOARD_KEY[board];
  const shown = (order || []).map(r => ({ r, u: users.get(r.uid) }))
    .filter(x => x.u && Number(x.u.leaderboard_opt_in) === 1).slice(0, TOP_N);
  const out = [];
  shown.forEach(({ r, u }, i) => {
    const v = key(r)[0];
    const tied = (i > 0 && key(shown[i - 1].r)[0] === v) || (i + 1 < shown.length && key(shown[i + 1].r)[0] === v);
    const rank = i > 0 && key(shown[i - 1].r)[0] === v ? out[i - 1].rank : i + 1;
    out.push({ rank, tied, name: displayName(u), handle: u.handle || null, avatar_url: safeAvatar(u.avatar_url), profile: !!u.handle,
      daily_current: r.daily_current, weekly_current: r.weekly_current, longest_daily: r.longest_daily, longest_weekly: r.longest_weekly });
  });
  return out;
}

// The current public fields of the riders on a stored board (one query by primary key).
async function currentRiders(env, order) {
  const ids = [...new Set((order || []).map(r => r.uid).filter(id => typeof id === 'string'))].slice(0, RANK_POOL);
  if (!ids.length) return new Map();
  const { results } = await env.cybercabhunter_db.prepare(
    `SELECT id, display_name, handle, avatar_url, leaderboard_opt_in FROM users WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  return new Map((results || []).map(u => [u.id, u]));
}

// The whole computation: three small queries over approved sightings.
export async function computeCommunitySummary(env, now = Date.now()) {
  const sql = env.cybercabhunter_db;
  const sys = env.MUSE_CONNECTOR_USER_ID || '\u0000';
  const xpWeek = dayKey(weekMonday(weekIndex(austinDayIndex(now))));
  const [byHour, totals, cities, xpRow] = await Promise.all([
    sql.prepare(`
      SELECT s.user_id AS uid, substr(s.submitted_at, 1, 13) AS hr, COUNT(*) AS n,
             u.display_name, u.handle, u.avatar_url, u.leaderboard_opt_in AS opt_in
      FROM submissions s JOIN users u ON u.id = s.user_id
      WHERE ${APPROVED} AND u.id <> ?
      GROUP BY s.user_id, hr`).bind(sys).all(),
    sql.prepare(`
      SELECT SUM(s.evidence_type = 'photo') AS photos, MIN(s.submitted_at) AS first
      FROM submissions s WHERE s.submission_type = 'vehicle_sighting' AND s.user_id <> ?`).bind(sys).first(),
    sql.prepare(`
      SELECT DISTINCT lower(trim(o.service_area)) AS area
      FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id
      WHERE ${APPROVED} AND s.user_id <> ? AND o.service_area IS NOT NULL AND trim(o.service_area) <> ''`).bind(sys).all(),
    // Spotter XP totals (worker/progression.js): small tables, once a day.
    sql.prepare(`SELECT COALESCE(SUM(x.xp), 0) AS total, SUM(x.xp > 0) AS spotters, MAX(x.xp) AS top,
        (SELECT COUNT(*) FROM xp_awards a WHERE a.ref_type = 'mission' AND a.active = 1 AND a.period = ? AND a.user_id <> ?) AS missions
      FROM user_xp x WHERE x.user_id <> ?`).bind(xpWeek, sys, sys).first().catch(() => null)
  ]);
  const today = austinDayIndex(now), thisWeek = weekIndex(today);
  const users = new Map(), spark = new Map();
  let verified = 0, verifiedThisWeek = 0;
  for (const r of byHour.results || []) {
    const ms = parseUtc(`${r.hr}:00:00`);
    if (!Number.isFinite(ms)) continue;
    const day = austinDayIndex(ms), n = Number(r.n) || 0;
    if (day > today) continue;
    verified += n;
    if (weekIndex(day) === thisWeek) verifiedThisWeek += n;
    if (day > today - SPARK_DAYS) spark.set(day, (spark.get(day) || 0) + n);
    if (!users.has(r.uid)) users.set(r.uid, { user: r, counts: new Map() });
    const c = users.get(r.uid).counts;
    c.set(day, (c.get(day) || 0) + n);
  }
  const everyone = [...users.values()].map(({ user, counts }) => {
    const s = computeStreaks(counts, today);
    return { user, daily_current: s.daily.current, weekly_current: s.weekly.current, longest_daily: s.daily.longest, longest_weekly: s.weekly.longest };
  });
  const order = { daily: orderBoard(everyone, 'daily'), weekly: orderBoard(everyone, 'weekly'), longest: orderBoard(everyone, 'longest') };
  const snapshot = new Map(everyone.map(r => [r.user.uid, { ...r.user, leaderboard_opt_in: r.user.opt_in }]));
  const firstMs = totals && totals.first ? parseUtc(totals.first) : NaN;
  return {
    computed_at: new Date(now).toISOString(),
    timezone: STREAK_TZ,
    sightings: {
      verified,
      photos_submitted: Number(totals && totals.photos) || 0,
      cities: new Set((cities.results || []).map(r => cityOf(r.area)).filter(Boolean)).size,
      site_start: Number.isFinite(firstMs) ? dayKey(austinDayIndex(firstMs)) : null,
      last_14_days: Array.from({ length: SPARK_DAYS }, (_, i) => { const d = today - (SPARK_DAYS - 1 - i); return { date: dayKey(d), n: spark.get(d) || 0 }; })
    },
    streaks: {
      active_daily: everyone.filter(r => r.daily_current > 0).length,
      active_weekly: everyone.filter(r => r.weekly_current > 0).length,
      record_daily: Math.max(0, ...everyone.map(r => r.longest_daily)),
      record_weekly: Math.max(0, ...everyone.map(r => r.longest_weekly)),
      verified_this_week: verifiedThisWeek
    },
    xp: {
      total: Math.max(0, Number(xpRow && xpRow.total) || 0),
      spotters: Number(xpRow && xpRow.spotters) || 0,
      missions_this_week: Number(xpRow && xpRow.missions) || 0,
      top_rank: rankFor(Number(xpRow && xpRow.top) || 0).name
    },
    // Order only (ids and streak numbers): names, photos and privacy are read live (rankBoard).
    board_order: order,
    // The previous Worker's shape (named, as of this run). Read ONLY by that
    // version, if production is ever rolled back to it: it serves s.boards
    // and would fail without it. This version never serves it.
    boards: { daily: rankBoard(order.daily, 'daily', snapshot), weekly: rankBoard(order.weekly, 'weekly', snapshot), longest: rankBoard(order.longest, 'longest', snapshot) }
  };
}

export async function recomputeCommunitySummary(env, now = Date.now()) {
  const summary = await computeCommunitySummary(env, now);
  await env.cybercabhunter_db.prepare(`INSERT INTO community_summary (key, value, computed_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, computed_at = excluded.computed_at`).bind(KEY, JSON.stringify(summary), summary.computed_at).run();
  return summary;
}

// One row; recomputed only when missing or stale (the daily cron keeps it fresh).
export async function getCommunitySummary(env, now = Date.now()) {
  const row = await env.cybercabhunter_db.prepare(`SELECT value, computed_at FROM community_summary WHERE key = ?`).bind(KEY).first();
  if (row && now - Date.parse(row.computed_at) < MAX_AGE_MS) {
    // A row written before a field existed (e.g. xp, board_order) is recomputed once.
    try { const v = JSON.parse(row.value); if (v && v.xp && v.board_order) return v; } catch (e) { /* recompute below */ }
  }
  return recomputeCommunitySummary(env, now);
}

async function cached(request, ctx, build) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const response = await build();
  if (cache && response.status === 200) { const stored = cache.put(cacheKey, response.clone()).catch(() => {}); if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored); }
  return response;
}

export async function apiCommunitySummary(request, env, ctx, { now = Date.now() } = {}) {
  return cached(request, ctx, async () => {
    const s = await getCommunitySummary(env, now);
    return Response.json({ computed_at: s.computed_at, timezone: s.timezone, sightings: s.sightings, streaks: s.streaks, xp: s.xp || null },
      { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  });
}

export async function apiStreakLeaderboard(request, env, ctx, { now = Date.now() } = {}) {
  const board = new URL(request.url).searchParams.get('board') || 'daily';
  if (!Object.prototype.hasOwnProperty.call(BOARDS, board)) return Response.json({ success: false, error: 'invalid_board' }, { status: 400 });
  return profileCached(env, ctx, { name: 'streaks', params: { board }, ttl: CACHE_SECONDS }, async () => {
    const s = await getCommunitySummary(env, now);
    const order = s.board_order[board];
    const entries = rankBoard(order, board, await currentRiders(env, order));
    return Response.json({ board, label: BOARDS[board], timezone: s.timezone, computed_at: s.computed_at,
      boards: Object.entries(BOARDS).map(([id, label]) => ({ id, label })), entries, stats: s.streaks },
      { headers: { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` } });
  });
}
