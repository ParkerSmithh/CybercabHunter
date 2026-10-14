// Spotter XP, levels, ranks and missions (worker/progression.js, migrations/0041):
//   - levels and ranks at their thresholds
//   - XP only on approval (moderator route), never pending / rejected
//   - one award per rider + plate + Austin day; idempotent writes; backfill twice = once
//   - missions by submission period (late approvals), once per period
//   - reversals when a contribution stops qualifying; re-grant after; ranks follow
//   - first-discovery credit (+100), system account never earns
//   - /api/xp/me: progress, pending vs verified, recent history; signed out = 401
//   - the leaderboard rows carry XP / level / rank; Top XP board; privacy kept
//   - no badges anywhere
// Run: node tests/progression.test.mjs

import fs from 'node:fs';
import worker from '../worker/index.js';
import { makeEnv, makeCheck, seedRide } from './helpers/env.mjs';
import { levelFor, rankFor, levelThresholds, reconcileAllXp, syncSubmissionXp, apiMyXp, desiredFromSightings } from '../worker/progression.js';
import { XP_REWARDS, RANKS, MISSIONS } from '../worker/progression-config.js';

const t = makeCheck();
const { check } = t;
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

async function app() {
  const ctx = await makeEnv({ users: ['ann', 'bo', 'priv', 'sys', 'mod'] });
  const { d1, env } = ctx;
  env.MUSE_CONNECTOR_USER_ID = 'sys';
  for (const u of ['ann', 'bo', 'priv', 'sys', 'mod']) await env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  d1.exec(`UPDATE users SET role = 'moderator' WHERE id = 'mod'`);
  d1.exec(`UPDATE users SET leaderboard_opt_in = 1, handle = id, display_name = upper(id)`);
  d1.exec(`UPDATE users SET leaderboard_opt_in = 0, display_name = 'Private Person', handle = 'privhandle' WHERE id = 'priv'`);
  let n = 0;
  const sub = (user, at, { status = 'pending', plate = null } = {}) => {
    const id = `s${++n}`;
    d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, evidence_type) VALUES (?, ?, 'vehicle_sighting', ?, ?, 'photo')`).bind(id, user, status, at)._exec();
    d1.prepare(`INSERT INTO vehicle_observations (id, submission_id, user_id, license_plate, service_area) VALUES (?, ?, ?, ?, 'Austin')`).bind(`o${n}`, id, user, plate)._exec();
    return id;
  };
  const call = async (method, path, { session, body } = {}) => {
    const headers = { Origin: 'https://cybercabhunter.com' };
    if (session) headers.Authorization = `Bearer session-${session}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    let json = null; try { json = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, json };
  };
  const review = (id, action) => call('PATCH', `/api/moderation/vehicle-sightings/${id}`, { session: 'mod', body: action === 'approve' ? { action } : { action, rejection_reason: 'blurry' } });
  const xp = u => (d1.query(`SELECT xp FROM user_xp WHERE user_id = '${u}'`)[0] || { xp: 0 }).xp;
  const ledger = u => d1.query(`SELECT amount, reason, tx_key FROM xp_ledger WHERE user_id = '${u}' ORDER BY id`);
  return { ...ctx, sub, call, review, xp, ledger };
}

async function run() {
  console.log('1. Levels and ranks');
  {
    const tl = levelThresholds();
    check('levels start at the owner\'s anchors: 1=0, 2=100, 3=250, 4=450, 5=700, 10=2500, 20=7500, 30=15000, 40=25000, 50=40000', [[1, 0], [2, 100], [3, 250], [4, 450], [5, 700], [10, 2500], [20, 7500], [30, 15000], [40, 25000], [50, 40000]].every(([l, x]) => tl[l - 1] === x));
    check('...every step costs at least as much as the one before (gets harder), up to level 100', tl.length === 100 && tl.every((x, i) => i < 2 || x - tl[i - 1] >= tl[i - 1] - tl[i - 2]));
    check('levelFor: 99 = level 1, 100 = level 2, 3,450 = level 11 (3,000-3,500)', levelFor(99).n === 1 && levelFor(100).n === 2 && JSON.stringify(levelFor(3450)) === JSON.stringify({ n: 11, floor: 3000, next: 3500, into: 450, span: 500 }));
    check('ranks: Bronze 0, Silver 1,000, Gold 3,000, Platinum 8,000, Diamond 20,000', RANKS.map(r => `${r.name}:${r.xp}`).join() === 'Bronze Spotter:0,Silver Spotter:1000,Gold Spotter:3000,Platinum Spotter:8000,Diamond Spotter:20000');
    check('rankFor at the edges, with XP to the next rank', rankFor(999).key === 'bronze' && rankFor(1000).key === 'silver' && rankFor(2999).next.needed === 1 && rankFor(20000).key === 'diamond' && rankFor(20000).next === null);
    check('rewards as configured; evidence / VIN / correction off until a workflow exists', XP_REWARDS.verified_sighting.xp === 25 && XP_REWARDS.first_discovery.xp === 100 && XP_REWARDS.daily_mission.xp === 30 && XP_REWARDS.weekly_mission.xp === 100 && !XP_REWARDS.vehicle_evidence.enabled && !XP_REWARDS.vin_identified.enabled && !XP_REWARDS.record_correction.enabled);
    check('only completable missions are active (no evidence / correction / VIN missions)', MISSIONS.filter(m => m.enabled).map(m => m.id).join() === 'daily_contribution,weekly_spotter,weekly_contributor');
  }

  console.log('2. Awards on approval');
  {
    const a = await app();
    // Mon Oct 12, Tue Oct 13 and Thu Oct 15 (CDT, afternoon).
    const s1 = a.sub('ann', '2026-10-12 17:00:00', { plate: 'ABC123' });
    check('pending: no XP', a.xp('ann') === 0 && a.ledger('ann').length === 0);
    const r1 = await a.review(s1, 'approve');
    check('approved by a moderator: +25 sighting and +30 Daily Contribution, at once', r1.status === 200 && a.xp('ann') === 55 && a.ledger('ann').map(l => l.amount).sort().join() === '25,30');
    const dup = a.sub('ann', '2026-10-12 20:00:00', { plate: 'abc 123' });
    await a.review(dup, 'approve');
    check('the same Cybercab (same plate) the same Austin day: no second award', a.xp('ann') === 55);
    const s2 = a.sub('ann', '2026-10-13 17:00:00', { plate: 'ABC123' });
    const rej = a.sub('ann', '2026-10-13 18:00:00', { plate: 'ZZZ999' });
    await a.review(rej, 'reject');
    check('rejected: nothing', a.xp('ann') === 55);
    await a.review(s2, 'approve');
    check('same plate on another day counts: +25 and that day\'s mission +30', a.xp('ann') === 110);
    // Late approval: submitted Thursday, approved "now" (later): counts for Thursday's day and the week.
    const s3 = a.sub('ann', '2026-10-15 17:00:00', { plate: 'NOPLATE1' });
    const before = a.xp('ann');
    await a.review(s3, 'approve');
    const third = a.ledger('ann').map(l => l.tx_key);
    check('3 verified units this week: Weekly Spotter +100 (and the sighting +25, Thursday\'s daily +30)', a.xp('ann') === before + 25 + 30 + 100 && third.some(k => /^mission:weekly_spotter:2026-10-12:ann:1:award$/.test(k)) && third.some(k => /^mission:daily_contribution:2026-10-15:ann/.test(k)));
    const ledgerCount = a.ledger('ann').length;
    await syncSubmissionXp(a.env, s3); await syncSubmissionXp(a.env, s1);
    await reconcileAllXp(a.env); await reconcileAllXp(a.env);
    check('re-running the sync and the full reconcile (twice) adds nothing: exactly once', a.ledger('ann').length === ledgerCount && a.xp('ann') === before + 155);
    check('the system account never earns', (() => { a.sub('sys', '2026-10-12 17:00:00', { status: 'approved', plate: 'SYS1' }); return true; })() && (await reconcileAllXp(a.env), a.xp('sys') === 0));
    check('a user cannot write XP: no route accepts it (only GET /api/xp/me; the reconcile is moderators-only)', (a.env.ASSETS = { fetch: async () => new Response('not found', { status: 404 }) }, (await a.call('POST', '/api/xp/me', { session: 'ann', body: { xp: 9999 } })).status === 404) && a.xp('ann') === before + 155 && (await a.call('POST', '/api/moderation/xp/reconcile', { session: 'ann' })).status === 403 && (await a.call('POST', '/api/moderation/xp/reconcile', { session: 'mod' })).status === 200);

    console.log('3. Reversals');
    a.d1.exec(`UPDATE submissions SET status = 'rejected' WHERE id = '${s3}'`);
    await reconcileAllXp(a.env);
    const rev = a.ledger('ann').filter(l => l.amount < 0);
    check('an approved sighting later invalidated: its +25, Thursday\'s +30 and the weekly +100 (now 2 of 3) are reversed', rev.map(l => l.amount).sort((x, y) => x - y).join() === '-100,-30,-25' && rev.every(l => /^Reversed: /.test(l.reason)) && a.xp('ann') === 110);
    a.d1.exec(`UPDATE submissions SET status = 'approved' WHERE id = '${s3}'`);
    await syncSubmissionXp(a.env, s3);
    check('re-approved: granted again (a new :2:award transaction), never doubled', a.xp('ann') === 265 && a.ledger('ann').some(l => /^mission:weekly_spotter:2026-10-12:ann:2:award$/.test(l.tx_key)));
    a.d1.exec(`DELETE FROM submissions WHERE id = '${s2}'`);
    await reconcileAllXp(a.env);
    check('a deleted sighting is reversed too (and its day\'s mission)', a.xp('ann') === 265 - 25 - 30 - 100);
    const total = a.d1.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM xp_ledger WHERE user_id = 'ann'`)[0].s;
    check('the total always equals the ledger sum', total === a.xp('ann'));
    a.d1.exec(`UPDATE user_xp SET xp = 99999 WHERE user_id = 'ann'`);
    await reconcileAllXp(a.env);
    check('...and drift is repaired by the daily reconcile', a.xp('ann') === total);

    console.log('4. Backfill and discoveries');
    const b = await app();
    for (const d of ['05', '06', '07']) b.sub('bo', `2026-10-${d} 17:00:00`, { status: 'approved', plate: `B${d}` });
    b.sub('bo', '2026-10-07 18:00:00', { status: 'pending', plate: 'PEND' });
    const v = 'v1';
    b.d1.prepare(`INSERT INTO robotaxi_vehicles (id, license_plate, visibility, origin, vin, model, color, service_area) VALUES (?, 'DISC1', 'public', 'receipt', NULL, 'Cybercab', 'Gold', 'Austin')`).bind(v)._exec();
    seedRide(b.d1, { id: 'r1', userId: 'bo', vehicleId: v, status: 'approved', rideKey: 'rk1', createdAt: '2026-10-05 10:00:00' });
    const res1 = await reconcileAllXp(b.env);
    check('backfill of history: 3 sightings (75) + 3 dailies (90) + Weekly Spotter (100) + first discovery (100)', b.xp('bo') === 75 + 90 + 100 + 100 && res1.granted === 8);
    const res2 = await reconcileAllXp(b.env);
    check('running the backfill again duplicates nothing', res2.granted === 0 && res2.reversed === 0 && b.xp('bo') === 365);
    b.d1.exec(`DELETE FROM robotaxi_vehicles WHERE id = '${v}'`);
    await reconcileAllXp(b.env);
    check('discovery credit gone: the +100 is reversed', b.xp('bo') === 265);

    console.log('5. /api/xp/me');
    const me = async (who, now) => { const r = await apiMyXp(new Request('https://x/api/xp/me', { headers: who ? { Authorization: `Bearer session-${who}` } : {} }), b.env, { now }); return { status: r.status, json: await r.json() }; };
    const m = await me('bo', Date.parse('2026-10-07T20:00:00Z'));
    check('total, level and rank from the database', m.json.xp === 265 && m.json.level.n === 3 && m.json.level.next === 450 && m.json.rank.name === 'Bronze Spotter' && m.json.rank.next.needed === 735);
    const w = m.json.missions.weekly.find(x => x.id === 'weekly_spotter'), wc = m.json.missions.weekly.find(x => x.id === 'weekly_contributor'), dly = m.json.missions.daily[0];
    check('Weekly Spotter: 3 / 3, completed', w.progress === 3 && w.required === 3 && w.state === 'completed' && w.reward === 100);
    check('Community Contributor: 3 / 5 verified, 1 awaiting verification (pending shown apart)', wc.progress === 3 && wc.pending === 1 && wc.state === 'in_progress');
    check('today\'s Daily Contribution: completed (+30)', dly.state === 'completed' && dly.reward === 30);
    const fresh = await me('bo', Date.parse('2026-10-08T20:00:00Z'));
    check('a new day: the daily mission resets (not started), the week keeps its progress; XP is kept', fresh.json.missions.daily[0].state === 'not_started' && fresh.json.missions.weekly.find(x => x.id === 'weekly_spotter').state === 'completed' && fresh.json.xp === 265);
    const nextWeek = await me('bo', Date.parse('2026-10-12T20:00:00Z'));
    check('Monday: weekly missions reset to not started', nextWeek.json.missions.weekly.every(x => x.state === 'not_started' && x.progress === 0));
    check('recent XP activity: the ledger, newest first, with reversals', m.json.recent.length > 0 && m.json.recent[0].reason.startsWith('Reversed') && typeof m.json.recent[0].amount === 'number');
    check('signed out: 401; never cached', (await me(null, Date.now())).status === 401 && /no-store/.test((await apiMyXp(new Request('https://x/api/xp/me', { headers: { Authorization: 'Bearer session-bo' } }), b.env)).headers.get('cache-control')));
    const rules = await b.call('GET', '/api/xp/rules');
    check('the public rules (for signed-out visitors): rewards, ranks, active missions only', rules.status === 200 && rules.json.ranks.length === 5 && rules.json.missions.length === 3 && rules.json.rewards.every(r => r.xp > 0));

    console.log('6. Leaderboard');
    a.d1.exec(`UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'ann'`);
    a.sub('priv', '2026-10-12 17:00:00', { status: 'approved', plate: 'PRIV1' });
    await reconcileAllXp(a.env);
    const lb = await a.call('GET', '/api/community/leaderboard?board=xp');
    check('a Top XP board: riders ranked by XP, each with level and spotter rank (text)', lb.status === 200 && lb.json.label === 'Top XP' && lb.json.entries[0].handle === 'ann' && lb.json.entries[0].xp === a.xp('ann') && lb.json.entries[0].level === levelFor(a.xp('ann')).n && lb.json.entries[0].spotter_rank === 'Bronze Spotter');
    check('...an opted-out rider earns XP but is never listed', a.xp('priv') > 0 && !JSON.stringify(lb.json).match(/Private Person|privhandle/));
    const ov = await a.call('GET', '/api/community/leaderboard');
    check('Top Overall keeps its own rule (no rows added for XP alone)', ov.json.board === 'overall' && !ov.json.entries.some(e => e.handle === 'ann'));
  }

  console.log('8. The page');
  {
    const html = read('public/community.html'), js = read('public/js/progress.js');
    const tabs = [...html.matchAll(/id="communityTab(\w+)" type="button" role="tab" data-view="(\w+)"[^>]*class="city-filter/g)].map(m => m[2]);
    check('Community navigation: Reviews | Streaks | Leaderboard | Progress, same button style', tabs.join('|') === 'reviews|streaks|leaderboard|progress');
    check('the Progress panel, hidden until chosen, kept in the URL like the others', /id="communityPanelProgress" role="tabpanel"[^>]*class="community-view hidden"/.test(html) && /const VIEWS = \['reviews', 'streaks', 'leaderboard', 'progress'\]/.test(html));
    check('its own at-a-glance stats from the daily summary (XP earned, spotters, missions, top rank)', /data-stats-view="progress"/.test(html) && /statXpTotal/.test(html) && /x\.missions_this_week/.test(read('public/js/community-stats.js')));
    check('signed out: the rules, the rank ladder and a sign-in prompt; signed in: /api/xp/me with the session', /Sign in to track your Spotter XP and missions\./.test(js) && /\/api\/xp\/rules/.test(js) && /fetch\('\/api\/xp\/me', \{ headers: \{ Authorization: 'Bearer ' \+ s \} \}\)/.test(js));
    check('mission states incl. awaiting verification, and "COMPLETED — +N XP EARNED"', /awaiting_verification: 'Awaiting verification'/.test(js) && /COMPLETED — \+\$\{n\(m\.reward\)\} XP EARNED/.test(js));
    check('nothing stored in the browser except reading the session', !/localStorage\.setItem/.test(js));
  }

  console.log('7. No badges');
  {
    const all = ['worker/progression.js', 'worker/progression-config.js', 'public/js/progress.js'].filter(f => fs.existsSync(new URL('../' + f, import.meta.url))).map(read).join('\n');
    // Lines that only SAY there are no badges (comments, the rules copy) aside.
    const code = all.split('\n').filter(l => !/no badges|never badges|never a badge|not badges/i.test(l)).join('\n');
    check('XP is the only reward: no badge, trophy or collectible in the progression code', !/badge|trophy|collectible|achievement/i.test(code));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
