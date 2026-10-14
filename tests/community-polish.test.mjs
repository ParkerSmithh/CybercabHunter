// Community polish (worker/community-summary.js, migrations/0040, the page):
//   - the summary is computed once and then READ, not re-aggregated, on every
//     request (D1 read budget); recomputed by the daily cron or when >36 h old
//   - its numbers match direct SQL; the system account never counts
//   - privacy: an opted-out rider is counted but never named or ranked in any
//     new surface (streak boards, crown, summary); public fields only
//   - the four bug fixes are in the page and scripts
// Run: node tests/community-polish.test.mjs

import fs from 'node:fs';
import worker from '../worker/index.js';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { computeCommunitySummary, getCommunitySummary, recomputeCommunitySummary, apiCommunitySummary, apiStreakLeaderboard } from '../worker/community-summary.js';

const t = makeCheck();
const { check } = t;
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-14T18:00:00Z');

async function setup() {
  const ctx = await makeEnv({ users: ['ann', 'priv', 'sys'] });
  const { d1, env } = ctx;
  env.MUSE_CONNECTOR_USER_ID = 'sys';
  d1.exec(`UPDATE users SET leaderboard_opt_in = 1, handle = id, display_name = upper(id)`);
  d1.exec(`UPDATE users SET leaderboard_opt_in = 0, handle = 'privhandle', display_name = 'Private Person' WHERE id = 'priv'`);
  let n = 0;
  const sub = (user, at, status = 'approved', evidence = 'photo', area = 'Austin, TX') => {
    const id = `s${++n}`;
    d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, evidence_type) VALUES (?, ?, 'vehicle_sighting', ?, ?, ?)`).bind(id, user, status, at, evidence)._exec();
    d1.prepare(`INSERT INTO vehicle_observations (id, submission_id, user_id, service_area) VALUES (?, ?, ?, ?)`).bind(`o${n}`, id, user, area)._exec();
  };
  for (const d of [12, 13, 14]) sub('ann', `2026-10-${d} 16:00:00`);
  sub('ann', '2026-10-14 17:00:00', 'approved', 'plate', 'dallas');
  sub('ann', '2026-10-01 16:00:00', 'rejected');                                    // a rejected photo: submitted, not verified
  for (let d = 1; d <= 14; d++) sub('priv', `2026-10-${String(d).padStart(2, '0')} 16:00:00`, 'approved', 'photo', 'San Diego');
  for (let d = 1; d <= 14; d++) sub('sys', `2026-10-${String(d).padStart(2, '0')} 16:00:00`, 'approved', 'photo', 'Houston');
  return ctx;
}

// Counts every D1 statement the summary code prepares.
function countQueries(env) {
  const db = env.cybercabhunter_db, real = db.prepare.bind(db);
  const log = [];
  db.prepare = sql => { log.push(sql); return real(sql); };
  return log;
}

async function run() {
  console.log('1. The precomputed summary');
  {
    const { env, d1 } = await setup();
    const s = await computeCommunitySummary(env, NOW);
    const direct = d1.query(`SELECT
      (SELECT COUNT(*) FROM submissions WHERE submission_type = 'vehicle_sighting' AND status = 'approved' AND user_id <> 'sys') AS verified,
      (SELECT COUNT(*) FROM submissions WHERE submission_type = 'vehicle_sighting' AND evidence_type = 'photo' AND user_id <> 'sys') AS photos`)[0];
    check('verified sightings and photos submitted match direct SQL (system account excluded)', s.sightings.verified === direct.verified && s.sightings.verified === 18 && s.sightings.photos_submitted === direct.photos && s.sightings.photos_submitted === 18);
    check('cities covered: distinct cities of verified sightings, "Austin, TX" = "austin" (Austin, Dallas, San Diego; never Houston from the system account)', s.sightings.cities === 3);
    check('the 14-day series and the site start (first sighting submitted)', s.sightings.last_14_days.length === 14 && s.sightings.last_14_days.at(-1).date === '2026-10-14' && s.sightings.last_14_days.at(-1).n === 3 && s.sightings.site_start === '2026-10-01');
    check('streak counts over every spotter, the opted-out one too (named nowhere)', s.streaks.active_daily === 2 && s.streaks.record_daily === 14);
    const names = JSON.stringify(s.boards);
    check('the opted-out rider is never named or ranked in any streak board (no name, no handle)', !/Private Person|privhandle|"priv"/.test(names) && s.boards.daily.length === 1 && s.boards.daily[0].handle === 'ann');
    check('...and ranks are counted among the listed riders only (ann is #1, no gap)', s.boards.daily[0].rank === 1 && s.boards.longest[0].rank === 1);
    check('no ids, emails or sighting details in the summary', !/"uid"|user_id|email|"s\d+"|submitted_at/.test(JSON.stringify(s)));

    const log = countQueries(env);
    const first = await getCommunitySummary(env, NOW);
    const writes = log.length;
    log.length = 0;
    const again = await getCommunitySummary(env, NOW + 3600e3);
    check('first use computes and stores it; later requests read ONE row (no aggregate over sightings)', writes >= 4 && log.length === 1 && /SELECT value, computed_at FROM community_summary WHERE key = \?/.test(log[0]) && again.computed_at === first.computed_at);
    log.length = 0;
    await getCommunitySummary(env, NOW + 37 * 3600e3);
    check('a summary older than 36 h (a missed cron) is recomputed once', log.some(q => /GROUP BY s\.user_id, hr/.test(q)));
    log.length = 0;
    const lb = await apiStreakLeaderboard(new Request('https://x/api/streaks/leaderboard?board=weekly'), env, null, { now: NOW + 37 * 3600e3 + 60e3 });
    const sm = await apiCommunitySummary(new Request('https://x/api/community/summary'), env, null, { now: NOW + 37 * 3600e3 + 60e3 });
    check('/api/streaks/leaderboard and /api/community/summary read the stored row only, and are edge-cacheable 5 min', log.length === 2 && log.every(q => /FROM community_summary/.test(q)) && /max-age=300/.test(lb.headers.get('cache-control')) && /max-age=300/.test(sm.headers.get('cache-control')));
    const smj = await sm.json();
    check('the public summary carries totals only (no boards, no names)', !('boards' in smj) && !/ANN|Private/.test(JSON.stringify(smj)));
    d1.exec(`DELETE FROM community_summary`);
    await recomputeCommunitySummary(env, NOW);
    check('the daily recompute writes the row', d1.query(`SELECT COUNT(*) AS n FROM community_summary`)[0].n === 1);
    check('the daily cron (FLEET_STATS_CRON, 6 AM CT) runs it; there is no new cron', /recomputeCommunitySummary\(env\)/.test(read('worker/index.js')) && read('wrangler.jsonc').match(/"crons": \[[^\]]*\]/)[0] === '"crons": ["*/10 * * * *", "0 11 * * *", "30 11 * * *", "5-59/10 * * * *"]');
    check('migration 0040 is one small table, no new database', /CREATE TABLE IF NOT EXISTS community_summary/.test(read('migrations/0040_community_summary.sql')) && (read('wrangler.jsonc').match(/"database_id"/g) || []).length === 1);
    const route = await worker.fetch(new Request('https://x/api/community/summary'), env, { waitUntil() {} });
    check('GET /api/community/summary is routed', route.status === 200);
  }

  console.log('2. The page');
  {
    const html = read('public/community.html'), cjs = read('public/js/community.js'), sjs = read('public/js/streaks.js'), css = read('public/css/community.css');
    check('bug 1: the privacy note is one complete sentence inside the panel, and phones clear the tab bar', /<p class="board-privacy">Spotters are listed by name and photo\. Prefer not to be listed\? Turn off <span[^>]*>Community leaderboard &amp; public profile<\/span> on your <a[^>]*>Profile<\/a> page, and you will be left off every Community board\.<\/p>/.test(html) && /\.community-page\{padding-bottom:calc\(72px/.test(css));
    check('bug 2: a rank is shown once ("Rank" is screen-reader text, no aria-label repeating it)', /<span class="sr-only">Rank <\/span>\$\{e\.rank\}/.test(cjs) && !/aria-label="Rank/.test(cjs) && /<span class="sr-only">Rank <\/span>\$\{e\.rank\}/.test(sjs));
    check('bug 3: Spotters is "Credited spotters", and the line under every board says ranked vs. credited', /Credited spotters/.test(html) && /riders'\} ranked on this board · \$\{t\.spotters/.test(cjs) && /'boardCount'\)\.textContent = n >= 10 \? 'Top 10' : `\$\{n\} ranked`/.test(cjs));
    check('bug 4: Find riders lives in the Leaderboard section only', /id="communityPanelLeaderboard"[\s\S]*id="riderSearch"/.test(html) && !/id="communityPanelReviews"[\s\S]*id="riderSearch"[\s\S]*id="communityPanelStreaks"/.test(html) && html.indexOf('id="riderSearch"') > html.indexOf('id="communityPanelLeaderboard"'));
    check('empty states: "None yet" for the rating, How reviews work, an invitation under a short board, the crown', /'None yet'/.test(read('public/js/reviews.js')) && /class="review-steps"/.test(html) && /Room for \$\{10 - n\} more/.test(cjs) && /holds the crown/.test(sjs));
    check('mobile: the three tabs and the board tabs are single scrolling rows (scroll-snap, no wrap)', /#communityTabs\{flex-wrap:nowrap;overflow-x:auto;scroll-snap-type:x mandatory/.test(css) && /\.community-page #boardTabs\{scroll-snap-type:x mandatory/.test(css));
    check('every new number comes from an API (no hard-coded stats in the page or scripts)', /<span id="statSightings" class="stat-value">—<\/span>/.test(html) && !/statSightings[^\n]*\d{2,}/.test(html) && !/Math\.random/.test(read('public/js/community-stats.js')));
    check('reduced motion: no entrances, shimmer or pulsing', /@media \(prefers-reduced-motion: reduce\)\{\s*\.community-hero-art img/.test(css));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
