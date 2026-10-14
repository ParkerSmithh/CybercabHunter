// Spotting Streaks (worker/streaks.js, public/js/streaks.js, public/community.html):
//   - the calculation: consecutive days / Monday-Sunday weeks, one per day or
//     week however many sightings, gaps break, an unfinished day or week never
//     does, longest runs, milestones that stay unlocked, the future ignored
//   - Austin time: late-night UTC submissions, both DST changes, week edges
//   - the API: only approved vehicle sightings, counted on the day SUBMITTED
//     (not approved, not the typed "spotted at"), recalculated live after a
//     revoke or delete, sign-in required, never cached
//   - the rankings: opted-in riders only, no private fields, three boards
//   - the page: Reviews / Streaks / Leaderboard tabs, Reviews by default
// Run: node tests/streaks.test.mjs

import fs from 'node:fs';
import worker from '../worker/index.js';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { computeStreaks, austinDayIndex, dayKey, weekIndex, weekMonday, apiMyStreaks } from '../worker/streaks.js';
import { apiStreakLeaderboard } from '../worker/community-summary.js';

const t = makeCheck();
const { check } = t;
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const D = s => Math.floor(Date.parse(`${s}T12:00:00Z`) / 864e5);          // 'YYYY-MM-DD' -> day index
const counts = (...days) => { const m = new Map(); for (const d of days) m.set(D(d), (m.get(D(d)) || 0) + 1); return m; };

async function run() {
  console.log('1. The calculation');
  {
    // Wed Oct 14, 2026 is "today" (week of Mon Oct 12).
    const today = D('2026-10-14');
    const a = computeStreaks(counts('2026-10-12', '2026-10-13', '2026-10-14'), today);
    check('three consecutive days ending today: 3, and today counts', a.daily.current === 3 && a.daily.longest === 3 && a.daily.today_done);
    const b = computeStreaks(counts('2026-10-11', '2026-10-12', '2026-10-13'), today);
    check('no sighting yet today: the streak stays 3 until today ends (not reset early)', b.daily.current === 3 && !b.daily.today_done);
    const c = computeStreaks(counts('2026-10-10', '2026-10-11', '2026-10-12'), today);
    check('a missed day (yesterday) breaks the daily streak', c.daily.current === 0 && c.daily.longest === 3);
    const many = computeStreaks(counts('2026-10-13', '2026-10-13', '2026-10-13', '2026-10-14', '2026-10-14'), today);
    check('several sightings on one day are one streak day', many.daily.current === 2 && many.daily.longest === 2);
    const longest = computeStreaks(counts('2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-10-13'), today);
    check('the longest streak is kept after it ends; the current one is separate', longest.daily.longest === 5 && longest.daily.current === 1);
    const future = computeStreaks(counts('2026-10-14', '2026-10-15', '2026-10-16'), today);
    check('a date after today is never counted', future.daily.current === 1 && future.daily.longest === 1);
    // Weeks: Monday-Sunday.
    const wk = computeStreaks(counts('2026-09-27', '2026-09-28', '2026-10-05', '2026-10-12'), today);   // Sun 9/27 (week of 9/21), Mon 9/28, Mon 10/5, Mon 10/12
    check('weeks run Monday to Sunday: Sun 9/27 and Mon 9/28 are different weeks, so 4 weeks in a row', wk.weekly.current === 4 && wk.weekly.longest === 4 && wk.weekly.week_done);
    const wk2 = computeStreaks(counts('2026-09-30', '2026-10-01', '2026-10-07'), today);
    check('this week not done yet: the weekly streak (2) stays alive until Sunday ends', wk2.weekly.current === 2 && !wk2.weekly.week_done);
    const wk3 = computeStreaks(counts('2026-09-30', '2026-10-01', '2026-10-02'), today);
    check('...many sightings in one week are one streak week; a missed week breaks it', wk3.weekly.longest === 1 && wk3.weekly.current === 0);
    check('weekMonday / weekIndex: Wed Oct 14 is in the week of Mon Oct 12; Sun Oct 11 is the week before', dayKey(weekMonday(weekIndex(today))) === '2026-10-12' && weekIndex(D('2026-10-11')) === weekIndex(today) - 1 && weekIndex(D('2026-10-12')) === weekIndex(today));
    // Milestones.
    const sevenDays = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
    const m = computeStreaks(counts(...sevenDays), today);
    const ms = (type, n) => m.milestones.find(x => x.type === type && x.n === n);
    check('daily milestones unlock at their thresholds (3 and 7 of 3/7/14/30/60/100)', ms('daily', 3).unlocked && ms('daily', 7).unlocked && !ms('daily', 14).unlocked && m.milestones.filter(x => x.type === 'daily').map(x => x.n).join() === '3,7,14,30,60,100');
    check('...and stay unlocked after the streak ended (current 0)', m.daily.current === 0 && ms('daily', 7).unlocked);
    check('...unlocked on the day the threshold was first reached', ms('daily', 3).unlocked_on === '2026-08-03' && ms('daily', 7).unlocked_on === '2026-08-07');
    check('weekly milestones 2/4/8/12/26/52; one week (Aug 3-7) after a Sat Aug 1-Sun Aug 2 week = 2 weeks', m.milestones.filter(x => x.type === 'weekly').map(x => x.n).join() === '2,4,8,12,26,52' && ms('weekly', 2).unlocked && ms('weekly', 2).unlocked_on === '2026-08-03' && !ms('weekly', 4).unlocked);
    const none = computeStreaks(new Map(), today);
    check('no verified sightings: zeros, nothing unlocked', none.daily.current === 0 && none.weekly.longest === 0 && none.milestones.every(x => !x.unlocked && x.unlocked_on === null));
  }

  console.log('2. Austin time');
  {
    check('11:30 PM CDT Oct 13 (04:30 UTC Oct 14) is still Oct 13 in Austin', dayKey(austinDayIndex(Date.parse('2026-10-14T04:30:00Z'))) === '2026-10-13');
    check('...12:30 AM CDT Oct 14 (05:30 UTC) is Oct 14', dayKey(austinDayIndex(Date.parse('2026-10-14T05:30:00Z'))) === '2026-10-14');
    check('winter (CST, UTC-6): 05:30 UTC Jan 15 is still Jan 14', dayKey(austinDayIndex(Date.parse('2026-01-15T05:30:00Z'))) === '2026-01-14');
    check('the DST changes (Mar 8 and Nov 1, 2026) match the browser\'s time zone data', (() => {
      const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
      for (let ms = Date.UTC(2026, 2, 7); ms < Date.UTC(2026, 2, 10); ms += 900e3) if (dayKey(austinDayIndex(ms)) !== f.format(ms)) return false;
      for (let ms = Date.UTC(2026, 9, 31); ms < Date.UTC(2026, 10, 3); ms += 900e3) if (dayKey(austinDayIndex(ms)) !== f.format(ms)) return false;
      return true;
    })());
  }

  console.log('3. The API');
  {
    const ctx = await makeEnv({ users: ['ann', 'bo', 'cy', 'priv', 'sys'] });
    const { d1, env } = ctx;
    env.MUSE_CONNECTOR_USER_ID = 'sys';
    for (const u of ['ann', 'bo', 'cy', 'priv', 'sys']) await env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
    d1.exec(`UPDATE users SET leaderboard_opt_in = 1, handle = id, display_name = upper(id)`);
    d1.exec(`UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'priv'`);
    let n = 0;
    const sub = (user, submittedAt, status = 'approved', type = 'vehicle_sighting', reviewedAt = null) =>
      d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(`s${++n}`, user, type, status, submittedAt, reviewedAt)._exec() || `s${n}`;
    const NOW = Date.parse('2026-10-14T18:00:00Z');   // Wed Oct 14, 1 PM CDT
    // ann: Oct 12 (submitted late at night UTC = still Oct 12 in Austin), Oct 13 (approved two days later), Oct 14.
    sub('ann', '2026-10-13 03:30:00');                                    // 10:30 PM CDT Oct 12
    sub('ann', '2026-10-13 15:00:00', 'approved', 'vehicle_sighting', '2026-10-15 09:00:00');   // approved later: still Oct 13
    sub('ann', '2026-10-14 14:00:00');
    sub('ann', '2026-10-14 15:00:00');                                    // a second one today: same day
    sub('ann', '2026-10-11 15:00:00', 'pending');                         // pending: never counts
    sub('ann', '2026-10-10 15:00:00', 'rejected');                        // rejected: never counts
    sub('ann', '2026-10-09 15:00:00', 'needs_review');
    sub('ann', '2026-10-11 16:00:00', 'approved', 'ride_receipt');        // not a sighting
    // bo: Oct 5..13 every day (9 days), nothing today yet.
    for (let d = 5; d <= 13; d++) sub('bo', `2026-10-${String(d).padStart(2, '0')} 16:00:00`);
    // cy: four Mondays in a row (weekly 4, daily 1).
    for (const d of ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']) sub('cy', `${d} 16:00:00`);
    // priv (opted out) and the system account: long streaks, never ranked.
    for (let d = 1; d <= 13; d++) { sub('priv', `2026-10-${String(d).padStart(2, '0')} 16:00:00`); sub('sys', `2026-10-${String(d).padStart(2, '0')} 16:00:00`); }

    const me = async (who, now = NOW) => { const r = await apiMyStreaks(new Request('https://x/api/streaks/me', { headers: who ? { Authorization: `Bearer session-${who}` } : {} }), env, { now }); return { status: r.status, cache: r.headers.get('cache-control'), json: await r.json() }; };
    const ann = await me('ann');
    check('ann: Oct 12, 13 and 14: a 3-day streak and today counts', ann.status === 200 && ann.json.daily.current === 3 && ann.json.daily.today_done && ann.json.today === '2026-10-14');
    check('...pending, needs-review, rejected sightings and ride receipts never count', ann.json.verified.sightings === 4 && ann.json.verified.days === 3);
    check('...a sighting submitted 10:30 PM Oct 12 (03:30 UTC Oct 13) is on Oct 12', ann.json.calendar.days.some(d => d.date === '2026-10-12' && d.count === 1));
    check('...the one approved two days later still counts on the day it was submitted (Oct 13)', ann.json.calendar.days.some(d => d.date === '2026-10-13' && d.count === 1));
    check('...two sightings today: the calendar shows 2, the streak counts one day', ann.json.calendar.days.find(d => d.date === '2026-10-14').count === 2);
    check('...private and never cached', /no-store/.test(ann.cache) && ann.json.timezone === 'America/Chicago' && ann.json.week_start === '2026-10-12');
    check('...no ids or other people\'s data in the response', !/"s\d+"|user_id|bo|priv/.test(JSON.stringify(ann.json)));
    const bo = await me('bo');
    check('bo: 9 days through yesterday, none today: still 9 (today isn\'t over)', bo.json.daily.current === 9 && !bo.json.daily.today_done && bo.json.daily.longest === 9);
    const boTomorrow = await me('bo', Date.parse('2026-10-15T18:00:00Z'));
    check('...and once a whole day passes without one, it breaks (longest stays 9, milestones stay)', boTomorrow.json.daily.current === 0 && boTomorrow.json.daily.longest === 9 && boTomorrow.json.milestones.find(x => x.type === 'daily' && x.n === 7).unlocked);
    const cy = await me('cy');
    check('cy: four Mondays: weekly 4 (this week done), daily 0', cy.json.weekly.current === 4 && cy.json.weekly.week_done && cy.json.daily.current === 0 && cy.json.milestones.find(x => x.type === 'weekly' && x.n === 4).unlocked);
    check('signed out: 401, nothing else', (await me(null)).status === 401);
    // Recalculated live: a moderator decision changes the streak on the next load.
    d1.exec(`UPDATE submissions SET status = 'rejected' WHERE user_id = 'ann' AND submitted_at = '2026-10-13 15:00:00'`);
    const revoked = await me('ann');
    check('a sighting revoked (approved -> rejected) stops counting at once: the streak breaks to today only', revoked.json.daily.current === 1 && revoked.json.daily.longest === 1 && revoked.json.verified.sightings === 3);
    d1.exec(`UPDATE submissions SET status = 'approved' WHERE user_id = 'ann' AND submitted_at = '2026-10-11 15:00:00'`);
    d1.exec(`UPDATE submissions SET status = 'approved' WHERE user_id = 'ann' AND submitted_at = '2026-10-13 15:00:00'`);
    const historical = await me('ann');
    check('a pending sighting from Oct 11 approved today extends the streak back to Oct 11 (4 days)', historical.json.daily.current === 4);
    d1.exec(`DELETE FROM submissions WHERE user_id = 'ann' AND submitted_at LIKE '2026-10-14%'`);
    const deleted = await me('ann');
    check('deleted sightings are gone from the count (today no longer done; 3 days through yesterday)', deleted.json.daily.current === 3 && !deleted.json.daily.today_done);
    check('the user cannot send a streak or a date: the endpoint reads only the database (GET, no body)', !/request\.json|searchParams\.get\('(current|longest|date|days)/.test(read('worker/streaks.js')));

    // ---- rankings ----
    const lb = async (board) => { const r = await apiStreakLeaderboard(new Request(`https://x/api/streaks/leaderboard${board ? `?board=${board}` : ''}`), env, null, { now: NOW }); return { status: r.status, json: await r.json() }; };
    const daily = await lb('daily');
    check('Top daily: bo (9) first, then ann (3); zero-streak riders not listed', daily.json.entries.map(e => e.handle).join() === 'bo,ann' && daily.json.entries[0].rank === 1 && daily.json.entries[0].daily_current === 9);
    check('...the opted-out rider and the system account are never listed', ![daily, await lb('weekly'), await lb('longest')].some(b => b.json.entries.some(e => /priv|sys/.test(e.handle + e.name))));
    const weekly = await lb('weekly');
    check('Top weekly: cy (4 weeks) first', weekly.json.entries[0].handle === 'cy' && weekly.json.entries[0].weekly_current === 4);
    const longest = await lb('longest');
    check('Longest all-time: by best daily streak (bo 9 first)', longest.json.entries[0].handle === 'bo' && longest.json.entries[0].longest_daily === 9);
    check('entries carry public fields only (no ids, emails or sighting details)', daily.json.entries.every(e => Object.keys(e).sort().join() === 'avatar_url,daily_current,handle,longest_daily,longest_weekly,name,profile,rank,tied,weekly_current'));
    check('unknown board: 400', (await lb('nope')).status === 400);
    // At-a-glance counts over every spotter (the opted-out rider too, never the system account), naming no one.
    // Active daily: ann, bo, priv; weekly: ann, bo, cy, priv. Record 13 (priv). This week (Mon Oct 12 on, after ann's Oct 14 ones were deleted): ann 2, bo 2, cy 1, priv 2.
    const st = daily.json.stats;
    check('stats: active streak counts over every spotter (opted out included, system account never)', st.active_daily === 3 && st.active_weekly === 4);
    check('...the all-time record and this week\'s verified sightings (Mon Oct 12 onward)', st.record_daily === 13 && st.verified_this_week === 2 + 2 + 1 + 2 && Object.keys(st).sort().join() === 'active_daily,active_weekly,record_daily,record_weekly,verified_this_week');
    const viaRoute = await worker.fetch(new Request('https://x/api/streaks/me', { headers: { Authorization: 'Bearer session-ann', Origin: 'https://cybercabhunter.com' } }), env, { waitUntil() {} });
    check('the routes are wired (/api/streaks/me, /api/streaks/leaderboard)', viaRoute.status === 200 && (await worker.fetch(new Request('https://x/api/streaks/leaderboard?board=weekly'), env, { waitUntil() {} })).status === 200);
  }

  console.log('4. The page');
  {
    const html = read('public/community.html'), js = read('public/js/streaks.js');
    check('three tabs in the Simulation page\'s style: Reviews, Streaks, Leaderboard', /id="communityTabs" role="tablist"/.test(html) && ['Reviews', 'Streaks', 'Leaderboard'].every(v => new RegExp(`id="communityTab${v}" type="button" role="tab" data-view="${v.toLowerCase()}"[^>]*class="city-filter`).test(html)));
    check('Reviews is selected by default; the other panels start hidden', /id="communityTabReviews"[^>]*aria-selected="true"/.test(html) && /id="communityPanelStreaks"[^>]*class="community-view hidden"/.test(html) && /id="communityPanelLeaderboard"[^>]*class="community-view hidden"/.test(html) && /id="communityPanelReviews"[^>]*class="community-view"/.test(html));
    check('the view is kept in the URL (?view=streaks), like the Simulation page', /url\.searchParams\.set\('view', view\)/.test(html) && /show\(new URLSearchParams\(location\.search\)\.get\('view'\)\)/.test(html));
    check('the existing reviews and leaderboard are untouched and inside their panels', /id="communityPanelReviews"[\s\S]*id="reviews"[\s\S]*id="communityPanelStreaks"[\s\S]*id="communityPanelLeaderboard"[\s\S]*id="leaderboardColumn"[\s\S]*id="boardList"/.test(html) && html.includes('js/reviews.js') && html.includes('js/community.js'));
    check('Streaks: the signed-out prompt, "How Spotting Streaks Work", safety, rankings', /Sign in to track your Cybercab spotting streaks\./.test(js) && js.includes('How Spotting Streaks Work') && /never chase or follow a Cybercab, never take photos while driving/.test(js) && js.includes('/api/streaks/leaderboard'));
    check('...no streak data invented or kept in the browser (only the session is read)', !/Math\.random/.test(js) && !/localStorage\.setItem/.test(js) && (js.match(/localStorage\./g) || []).length === 1);
    check('the migration only adds an index (no stored streaks)', /CREATE INDEX IF NOT EXISTS idx_submissions_type_status_user_time/.test(read('migrations/0039_streak_index.sql')) && !/CREATE TABLE/.test(read('migrations/0039_streak_index.sql')));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
