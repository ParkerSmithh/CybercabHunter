// Spotting Streaks (the Community page's Streaks section, public/js/streaks.js).
//
//   GET /api/streaks/me                      signed in; never cached
//     -> { timezone, today, daily: { current, longest, today_done },
//          weekly: { current, longest, week_done }, verified: { sightings, days },
//          calendar: { from, to, days: [{ date, count }] },   (days with sightings only)
//          milestones: [{ type, n, unlocked, unlocked_on }] }
//   GET /api/streaks/leaderboard?board=daily|weekly|longest   public, edge-cached 5 min
//     -> { board, entries: [{ rank, name, handle, avatar_url, profile,
//          daily_current, weekly_current, longest_daily, longest_weekly }] }
//
// THE RULES (computed live from the database on every request, never stored,
// so they are always right after a review, a deletion or a status change):
//   - Only the rider's own photo/plate sightings (submissions.submission_type =
//     'vehicle_sighting') with status = 'approved' count. Pending, needs-review
//     and rejected sightings never do; a deleted submission is simply gone.
//   - A sighting counts toward the day it was SUBMITTED (submissions.submitted_at,
//     set by the server), not the day a moderator approved it, and not the
//     "spotted at" time the rider typed (which they could set to fill a gap).
//   - Days and weeks are America/Chicago (the site's zone; accounts have no
//     time zone setting). Weeks run Monday through Sunday.
//   - Any number of verified sightings in a day (or week) is one streak day
//     (or week).
//   - The current streak counts back from today (or this week) if it already
//     qualifies, otherwise from yesterday (or last week): an unfinished day or
//     week never breaks a streak.
//   - Milestones unlock from the LONGEST streak ever reached, so they stay
//     unlocked after a streak ends; unlocked_on is the day (or the week's
//     Monday) the threshold was first reached.
// PRIVACY: the rankings list only riders with leaderboard_opt_in = 1 (the
// Profile page's "Community leaderboard & public profile" switch), with the
// same public fields as the main leaderboard; never ids, emails or sighting
// details. A rider who opted out still sees their own streaks.

import { tesla } from './tesla.js';
import { safeAvatar } from './community.js';

export const STREAK_TZ = 'America/Chicago';
export const DAILY_MILESTONES = [3, 7, 14, 30, 60, 100];
export const WEEKLY_MILESTONES = [2, 4, 8, 12, 26, 52];
const DAY = 864e5;
const CALENDAR_DAYS = 371;          // 53 weeks
const BOARD_CACHE_SECONDS = 300;
const TOP_N = 10;
const BOARDS = { daily: 'Top daily streaks', weekly: 'Top weekly streaks', longest: 'Longest all-time streaks' };
const APPROVED_SIGHTING = `submission_type = 'vehicle_sighting' AND status = 'approved'`;

// ---- Austin time without Intl (fast enough for every rider's rows) ----
// US rules: CDT (UTC-5) from the second Sunday in March, 2:00 CST (08:00 UTC),
// to the first Sunday in November, 2:00 CDT (07:00 UTC); CST (UTC-6) otherwise.
const dstCache = new Map();
function dstBounds(year) {
  if (!dstCache.has(year)) {
    const mar1 = new Date(Date.UTC(year, 2, 1)).getUTCDay(), nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const secondSunMar = 1 + ((7 - mar1) % 7) + 7, firstSunNov = 1 + ((7 - nov1) % 7);
    dstCache.set(year, [Date.UTC(year, 2, secondSunMar, 8), Date.UTC(year, 10, firstSunNov, 7)]);
  }
  return dstCache.get(year);
}
// Days since 1970-01-01 of the Austin calendar date at this instant.
export function austinDayIndex(ms) {
  const [start, end] = dstBounds(new Date(ms).getUTCFullYear());
  const offset = ms >= start && ms < end ? -5 : -6;
  return Math.floor((ms + offset * 3600e3) / DAY);
}
export const dayKey = idx => new Date(idx * DAY).toISOString().slice(0, 10);
// Monday-based week number: day 0 (1970-01-01) was a Thursday.
export const weekIndex = day => Math.floor((day + 3) / 7);
export const weekMonday = week => week * 7 - 3;
// "YYYY-MM-DD HH:MM:SS" (D1 datetime('now'), UTC) or ISO -> ms.
const parseUtc = s => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z');

// One run's streak numbers from a set of qualifying units (days or weeks).
function runs(units, current) {
  const sorted = [...units].sort((a, b) => a - b);
  let longest = 0, run = 0, prev = null;
  const reached = [];   // reached[n - 1] = the unit where a run first reached n
  for (const u of sorted) {
    if (u > current) break;            // never counts the future
    run = prev !== null && u === prev + 1 ? run + 1 : 1;
    prev = u;
    if (run > longest) { longest = run; reached[run - 1] = u; }
  }
  const startFrom = units.has(current) ? current : current - 1;
  let streak = 0;
  for (let u = startFrom; units.has(u); u--) streak++;
  return { current: streak, longest, done: units.has(current), reached };
}

// dayCounts: Map(dayIndex -> verified sightings that day). todayIdx: today in Austin.
export function computeStreaks(dayCounts, todayIdx) {
  const days = new Set([...dayCounts.keys()].filter(d => d <= todayIdx));
  const weeks = new Set([...days].map(weekIndex));
  const d = runs(days, todayIdx), w = runs(weeks, weekIndex(todayIdx));
  const milestone = (type, list, r, toDate) => list.map(n => ({ type, n, unlocked: r.longest >= n, unlocked_on: r.longest >= n ? dayKey(toDate(r.reached[n - 1])) : null }));
  return {
    daily: { current: d.current, longest: d.longest, today_done: d.done },
    weekly: { current: w.current, longest: w.longest, week_done: w.done },
    milestones: [...milestone('daily', DAILY_MILESTONES, d, x => x), ...milestone('weekly', WEEKLY_MILESTONES, w, weekMonday)]
  };
}

// Rows of { hr: 'YYYY-MM-DD HH' (UTC), n } -> Map(dayIndex -> count).
// Grouping by UTC hour in SQL keeps the rows few; the Austin offset is whole hours.
function toDayCounts(rows) {
  const out = new Map();
  for (const r of rows) {
    const ms = parseUtc(`${r.hr}:00:00`);
    if (!Number.isFinite(ms)) continue;
    const day = austinDayIndex(ms);
    out.set(day, (out.get(day) || 0) + (Number(r.n) || 0));
  }
  return out;
}

export async function apiMyStreaks(request, env, { now = Date.now() } = {}) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const { results } = await env.cybercabhunter_db.prepare(`
    SELECT substr(submitted_at, 1, 13) AS hr, COUNT(*) AS n
    FROM submissions
    WHERE user_id = ? AND ${APPROVED_SIGHTING}
    GROUP BY hr
  `).bind(userId).all();
  const counts = toDayCounts(results || []);
  const today = austinDayIndex(now);
  const s = computeStreaks(counts, today);
  const from = today - (CALENDAR_DAYS - 1);
  const calendar = [...counts.entries()].filter(([day]) => day >= from && day <= today).sort((a, b) => a[0] - b[0]).map(([day, count]) => ({ date: dayKey(day), count }));
  let sightings = 0; for (const [day, n] of counts) if (day <= today) sightings += n;
  return Response.json({
    timezone: STREAK_TZ,
    today: dayKey(today),
    week_start: dayKey(weekMonday(weekIndex(today))),
    daily: s.daily,
    weekly: s.weekly,
    verified: { sightings, days: [...counts.keys()].filter(d => d <= today).length },
    calendar: { from: dayKey(from), to: dayKey(today), days: calendar },
    milestones: s.milestones
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// Every opted-in rider's streaks, ranked for one board.
export async function apiStreakLeaderboard(request, env, ctx, { now = Date.now() } = {}) {
  const board = new URL(request.url).searchParams.get('board') || 'daily';
  if (!Object.prototype.hasOwnProperty.call(BOARDS, board)) return Response.json({ success: false, error: 'invalid_board' }, { status: 400 });
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const sys = env.MUSE_CONNECTOR_USER_ID || '\u0000';
  const { results } = await env.cybercabhunter_db.prepare(`
    SELECT s.user_id AS uid, substr(s.submitted_at, 1, 13) AS hr, COUNT(*) AS n,
           u.display_name, u.handle, u.avatar_url
    FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.${APPROVED_SIGHTING.replace(' AND status', ' AND s.status')} AND u.leaderboard_opt_in = 1 AND u.id <> ?
    GROUP BY s.user_id, hr
  `).bind(sys).all();
  const byUser = new Map();
  for (const r of results || []) {
    if (!byUser.has(r.uid)) byUser.set(r.uid, { user: r, rows: [] });
    byUser.get(r.uid).rows.push(r);
  }
  const today = austinDayIndex(now);
  const riders = [...byUser.values()].map(({ user, rows }) => {
    const s = computeStreaks(toDayCounts(rows), today);
    return { user, daily_current: s.daily.current, weekly_current: s.weekly.current, longest_daily: s.daily.longest, longest_weekly: s.weekly.longest };
  });
  const key = { daily: r => [r.daily_current, r.longest_daily, r.weekly_current], weekly: r => [r.weekly_current, r.longest_weekly, r.daily_current], longest: r => [r.longest_daily, r.longest_weekly, r.daily_current] }[board];
  const name = r => (r.user.display_name && String(r.user.display_name).trim()) || (r.user.handle ? `@${r.user.handle}` : 'Spotter');
  const cmp = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i]; return name(a).localeCompare(name(b)); };
  const ranked = riders.filter(r => key(r)[0] > 0).sort(cmp).slice(0, TOP_N);
  const entries = [];
  ranked.forEach((r, i) => {
    const rank = i > 0 && key(ranked[i - 1])[0] === key(r)[0] ? entries[i - 1].rank : i + 1;
    entries.push({ rank, name: name(r), handle: r.user.handle || null, avatar_url: safeAvatar(r.user.avatar_url), profile: !!r.user.handle,
      daily_current: r.daily_current, weekly_current: r.weekly_current, longest_daily: r.longest_daily, longest_weekly: r.longest_weekly });
  });
  const response = Response.json({ board, label: BOARDS[board], timezone: STREAK_TZ, boards: Object.entries(BOARDS).map(([id, label]) => ({ id, label })), entries },
    { headers: { 'Cache-Control': `public, max-age=${BOARD_CACHE_SECONDS}` } });
  if (cache) { const stored = cache.put(cacheKey, response.clone()).catch(() => {}); if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored); }
  return response;
}
