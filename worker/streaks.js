// Spotting Streaks (the Community page's Streaks section, public/js/streaks.js).
//
//   GET /api/streaks/me                      signed in; never cached
//     -> { timezone, today, daily: { current, longest, today_done },
//          weekly: { current, longest, week_done }, verified: { sightings, days },
//          calendar: { from, to, days: [{ date, count }] },   (days with sightings only)
//          milestones: [{ type, n, unlocked, unlocked_on }] }
//   The public streak rankings and community totals are precomputed once a
//   day: worker/community-summary.js (/api/streaks/leaderboard, /api/community/summary).
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

export const STREAK_TZ = 'America/Chicago';
export const DAILY_MILESTONES = [3, 7, 14, 30, 60, 100];
export const WEEKLY_MILESTONES = [2, 4, 8, 12, 26, 52];
const DAY = 864e5;
const CALENDAR_DAYS = 371;          // 53 weeks
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
