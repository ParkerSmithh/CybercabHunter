// Spotter XP, levels, ranks and missions (the Community page's Progress
// section, public/js/progress.js). Numbers: worker/progression-config.js.
// Tables: migrations/0041 (xp_awards, xp_ledger, user_xp).
//
//   GET  /api/xp/me                          signed in; never cached
//     -> { xp, level: { n, floor, next, into, span }, rank: { key, name, next },
//          ranks, missions: { day, week, daily: [...], weekly: [...] },
//          recent: [{ amount, reason, at }], rewards }
//   POST /api/moderation/xp/reconcile        moderators; the full reconcile now
//
// THE RULES (all server-side; nothing a rider sends can change XP):
//   - XP comes only from contributions a moderator approved: today, verified
//     vehicle sightings (+25) and first-discovery credit (+100, the
//     leaderboard's own rule, worker/community.js). Pending, needs-review and
//     rejected sightings earn nothing.
//   - One award per thing, ever: a sighting's key is the rider + normalized
//     plate + Austin day it was submitted (so the same Cybercab filed twice
//     that day pays once), or the submission id when there is no plate. The
//     key is unique in xp_awards and every ledger row has a unique tx_key, so
//     re-running any step never pays twice.
//   - Missions count verified contributions by the Austin day / Monday-Sunday
//     week they were SUBMITTED (a late approval counts for its own period and
//     pays when approved), and pay once per mission per period.
//   - When a contribution stops qualifying (rejected later, deleted, credit
//     moved), its award and any mission it completed are reversed with a
//     negative ledger row; totals and ranks follow automatically.
//   - Streaks (worker/streaks.js) are untouched and pay nothing by themselves.
//
// WHEN IT RUNS (D1 read budget: never on a pageview):
//   - right after a moderator approves / rejects / promotes a sighting: that
//     rider's week only (a few dozen rows);
//   - the daily cron (6 AM CT): every rider, plus discoveries (backfill and
//     reversals; ~2-3k rows once a day).
//   GET /api/xp/me reads one rider's total, this week's awards and contributions,
//   and the 10 latest ledger rows.

import { XP_REWARDS, RANKS, MISSIONS } from './progression-config.js';
import { austinDayIndex, dayKey, weekIndex, weekMonday, STREAK_TZ } from './streaks.js';
import { normalizePlate } from './plate.js';
import { discoveryCreditSql } from './community.js';
import { tesla } from './tesla.js';

const DAY = 864e5;
const RECENT = 10;
const parseUtc = s => Date.parse(String(s).replace(' ', 'T') + (/[zZ]$/.test(String(s)) ? '' : 'Z'));
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const reward = k => (XP_REWARDS[k] && XP_REWARDS[k].enabled ? XP_REWARDS[k].xp : 0);
export const ACTIVE_MISSIONS = MISSIONS.filter(m => m.enabled);

export { levelThresholds, levelFor, rankFor } from './progression-levels.js';
import { levelFor, rankFor } from './progression-levels.js';

// ---- What a rider SHOULD have, from their approved sightings ----
// rows: [{ id, user_id, submitted_at, license_plate }] approved vehicle sightings.
// Returns Map(award_key -> award) for sighting XP and mission completions.
export function desiredFromSightings(rows) {
  const out = new Map();
  const units = new Map();   // user -> Map(unitKey -> { day, week, id })
  for (const r of rows) {
    const ms = parseUtc(r.submitted_at);
    if (!Number.isFinite(ms)) continue;
    const day = austinDayIndex(ms), plate = r.license_plate ? normalizePlate(r.license_plate) : null;
    const unit = plate ? `${plate}:${dayKey(day)}` : `sub:${r.id}`;
    if (!units.has(r.user_id)) units.set(r.user_id, new Map());
    const mine = units.get(r.user_id);
    const prev = mine.get(unit);
    if (!prev || r.id < prev.id) mine.set(unit, { day, week: weekIndex(day), id: r.id });   // stable: the smallest id pays
  }
  for (const [user, mine] of units) {
    const perDay = new Map(), perWeek = new Map();
    for (const [unit, u] of mine) {
      const xp = reward('verified_sighting');
      if (xp) out.set(`sighting:${user}:${unit}`, { award_key: `sighting:${user}:${unit}`, user_id: user, amount: xp, reason: XP_REWARDS.verified_sighting.label, ref_type: 'sighting', ref_id: u.id, period: dayKey(weekMonday(u.week)) });
      perDay.set(u.day, (perDay.get(u.day) || 0) + 1);
      perWeek.set(u.week, (perWeek.get(u.week) || 0) + 1);
    }
    for (const m of ACTIVE_MISSIONS) {
      if (!m.counts.includes('sighting')) continue;   // other contribution types have no workflow yet
      const xp = reward(m.reward);
      if (!xp) continue;
      const counts = m.period === 'day' ? perDay : perWeek;
      for (const [p, n] of counts) {
        if (n < m.required) continue;
        const periodKey = dayKey(m.period === 'day' ? p : weekMonday(p));
        const week = m.period === 'day' ? weekIndex(p) : p;
        const key = `mission:${m.id}:${periodKey}:${user}`;
        out.set(key, { award_key: key, user_id: user, amount: xp, reason: `Mission completed: ${m.title}`, ref_type: 'mission', ref_id: `${m.id}:${periodKey}`, period: dayKey(weekMonday(week)) });
      }
    }
  }
  return out;
}

// ---- Grant / reverse (idempotent D1 statements) ----
export function grantStatements(sql, a) {
  return [
    sql.prepare(`UPDATE xp_awards SET active = 1, seq = seq + 1, amount = ?, reason = ?, ref_id = ?, updated_at = datetime('now') WHERE award_key = ? AND active = 0`).bind(a.amount, a.reason, a.ref_id, a.award_key),
    sql.prepare(`INSERT OR IGNORE INTO xp_awards (award_key, user_id, amount, reason, ref_type, ref_id, period) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(a.award_key, a.user_id, a.amount, a.reason, a.ref_type, a.ref_id, a.period),
    sql.prepare(`INSERT OR IGNORE INTO xp_ledger (tx_key, award_key, user_id, amount, reason, ref_type, ref_id)
      SELECT award_key || ':' || seq || ':award', award_key, user_id, amount, reason, ref_type, ref_id FROM xp_awards WHERE award_key = ? AND active = 1`).bind(a.award_key)
  ];
}
export function reverseStatements(sql, key) {
  return [
    sql.prepare(`UPDATE xp_awards SET active = 0, updated_at = datetime('now') WHERE award_key = ? AND active = 1`).bind(key),
    sql.prepare(`INSERT OR IGNORE INTO xp_ledger (tx_key, award_key, user_id, amount, reason, ref_type, ref_id)
      SELECT award_key || ':' || seq || ':reverse', award_key, user_id, -amount, 'Reversed: ' || reason, ref_type, ref_id FROM xp_awards WHERE award_key = ? AND active = 0`).bind(key)
  ];
}
async function runBatches(sql, statements) {
  for (let i = 0; i < statements.length; i += 90) await sql.batch(statements.slice(i, i + 90));
}
// Diff what should be active against what is, for the given scope.
async function applyDiff(sql, desired, active) {
  const statements = [];
  let granted = 0, reversed = 0;
  for (const [key, a] of desired) if (!active.has(key)) { statements.push(...grantStatements(sql, a)); granted++; }
  for (const key of active.keys()) if (!desired.has(key)) { statements.push(...reverseStatements(sql, key)); reversed++; }
  await runBatches(sql, statements);
  return { granted, reversed };
}

const SIGHTINGS_SELECT = `SELECT s.id, s.user_id, s.submitted_at, o.license_plate
  FROM submissions s LEFT JOIN vehicle_observations o ON o.submission_id = s.id
  WHERE s.submission_type = 'vehicle_sighting' AND s.status = 'approved'`;

// After a moderator decision: one rider, the week of that submission.
export async function syncSubmissionXp(env, submissionId) {
  const sql = env.cybercabhunter_db;
  const sub = await sql.prepare(`SELECT user_id, submitted_at FROM submissions WHERE id = ?`).bind(submissionId).first();
  if (!sub || sub.user_id === (env.MUSE_CONNECTOR_USER_ID || '\u0000')) return { granted: 0, reversed: 0 };
  const ms = parseUtc(sub.submitted_at);
  if (!Number.isFinite(ms)) return { granted: 0, reversed: 0 };
  return syncUserWeek(env, sub.user_id, weekIndex(austinDayIndex(ms)));
}
export async function syncUserWeek(env, userId, week) {
  const sql = env.cybercabhunter_db;
  const monday = weekMonday(week), period = dayKey(monday);
  // Austin's week, with a day of slack each side in UTC (filtered exactly below).
  const from = sqlTime((monday - 1) * DAY), to = sqlTime((monday + 8) * DAY);
  const [rows, awards] = await Promise.all([
    sql.prepare(`${SIGHTINGS_SELECT} AND s.user_id = ? AND s.submitted_at >= ? AND s.submitted_at < ?`).bind(userId, from, to).all(),
    sql.prepare(`SELECT award_key FROM xp_awards WHERE user_id = ? AND period = ? AND active = 1 AND ref_type IN ('sighting', 'mission')`).bind(userId, period).all()
  ]);
  const inWeek = (rows.results || []).filter(r => weekIndex(austinDayIndex(parseUtc(r.submitted_at))) === week);
  const desired = new Map([...desiredFromSightings(inWeek)].filter(([, a]) => a.period === period));
  return applyDiff(sql, desired, new Map((awards.results || []).map(r => [r.award_key, true])));
}

// The daily full reconcile: every rider's sightings and missions, and
// discovery credit. Also the one-time backfill (it only ever adds what is
// missing, so running it again changes nothing).
export async function reconcileAllXp(env) {
  const sql = env.cybercabhunter_db;
  const sys = env.MUSE_CONNECTOR_USER_ID || '\u0000';
  const [rows, active, credit] = await Promise.all([
    sql.prepare(`${SIGHTINGS_SELECT} AND s.user_id <> ?`).bind(sys).all(),
    sql.prepare(`SELECT award_key, ref_type FROM xp_awards WHERE active = 1`).all(),
    sql.prepare(`WITH ${discoveryCreditSql()} SELECT vid, uid FROM credit WHERE rn = 1`).bind(sys, sys).all()
  ]);
  const desired = desiredFromSightings(rows.results || []);
  const disc = reward('first_discovery');
  if (disc) for (const c of credit.results || []) {
    const key = `discovery:${c.vid}:${c.uid}`;
    desired.set(key, { award_key: key, user_id: c.uid, amount: disc, reason: XP_REWARDS.first_discovery.label, ref_type: 'discovery', ref_id: c.vid, period: 'discovery' });
  }
  const result = await applyDiff(sql, desired, new Map((active.results || []).map(r => [r.award_key, r.ref_type])));
  // Totals re-checked against the ledger (the trigger keeps them equal; this
  // repairs any drift). One small aggregate a day.
  await sql.prepare(`UPDATE user_xp SET xp = (SELECT COALESCE(SUM(amount), 0) FROM xp_ledger l WHERE l.user_id = user_xp.user_id), updated_at = datetime('now')
    WHERE xp <> (SELECT COALESCE(SUM(amount), 0) FROM xp_ledger l WHERE l.user_id = user_xp.user_id)`).run();
  return result;
}

// ---- The rider's own progress ----
export async function apiMyXp(request, env, { now = Date.now() } = {}) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return Response.json({ authenticated: false }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  const sql = env.cybercabhunter_db;
  const today = austinDayIndex(now), week = weekIndex(today), monday = weekMonday(week), period = dayKey(monday);
  const from = sqlTime((monday - 1) * DAY), to = sqlTime((monday + 8) * DAY);
  const [total, recent, awards, subs] = await Promise.all([
    sql.prepare(`SELECT xp FROM user_xp WHERE user_id = ?`).bind(userId).first(),
    sql.prepare(`SELECT amount, reason, created_at FROM xp_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`).bind(userId, RECENT).all(),
    sql.prepare(`SELECT award_key, active FROM xp_awards WHERE user_id = ? AND period = ? AND ref_type = 'mission'`).bind(userId, period).all(),
    sql.prepare(`SELECT s.id, s.status, s.submitted_at, o.license_plate FROM submissions s LEFT JOIN vehicle_observations o ON o.submission_id = s.id
      WHERE s.submission_type = 'vehicle_sighting' AND s.status IN ('approved', 'pending', 'needs_review') AND s.user_id = ? AND s.submitted_at >= ? AND s.submitted_at < ?`).bind(userId, from, to).all()
  ]);
  const xp = Math.max(0, Number(total && total.xp) || 0);
  // This week's contributions, by status and period (the same unit rule as XP).
  const units = { verified: new Map(), pending: new Map() };
  for (const r of subs.results || []) {
    const day = austinDayIndex(parseUtc(r.submitted_at));
    if (weekIndex(day) !== week) continue;
    const plate = r.license_plate ? normalizePlate(r.license_plate) : null;
    const unit = plate ? `${plate}:${dayKey(day)}` : `sub:${r.id}`;
    const bucket = r.status === 'approved' ? units.verified : units.pending;
    if (!bucket.has(unit)) bucket.set(unit, day);
  }
  for (const u of units.verified.keys()) units.pending.delete(u);
  const count = (bucket, period) => [...bucket.values()].filter(d => (period === 'day' ? d === today : true)).length;
  const paid = new Set((awards.results || []).filter(a => a.active === 1).map(a => a.award_key));
  const mission = m => {
    const periodKey = m.period === 'day' ? dayKey(today) : period;
    const done = paid.has(`mission:${m.id}:${periodKey}:${userId}`);
    const progress = Math.min(m.required, count(units.verified, m.period));
    const pending = count(units.pending, m.period);
    const state = done ? 'completed' : progress >= m.required ? 'completing' : progress > 0 ? 'in_progress' : pending > 0 ? 'awaiting_verification' : 'not_started';
    return { id: m.id, title: m.title, description: m.description, reward: reward(m.reward), required: m.required, progress, pending, state, period: periodKey };
  };
  return Response.json({
    timezone: STREAK_TZ,
    xp,
    level: levelFor(xp),
    rank: rankFor(xp),
    ranks: RANKS.map(r => ({ key: r.key, name: r.name, xp: r.xp })),
    missions: { day: dayKey(today), week: period, daily: ACTIVE_MISSIONS.filter(m => m.period === 'day').map(mission), weekly: ACTIVE_MISSIONS.filter(m => m.period === 'week').map(mission) },
    recent: (recent.results || []).map(r => ({ amount: r.amount, reason: r.reason, at: r.created_at })),
    rewards: Object.entries(XP_REWARDS).filter(([, v]) => v.enabled).map(([k, v]) => ({ id: k, xp: v.xp, label: v.label }))
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// The public rules (for signed-out visitors): rewards, ranks, missions.
export function publicRules() {
  return {
    rewards: Object.entries(XP_REWARDS).filter(([, v]) => v.enabled).map(([k, v]) => ({ id: k, xp: v.xp, label: v.label })),
    ranks: RANKS.map(r => ({ key: r.key, name: r.name, xp: r.xp })),
    missions: ACTIVE_MISSIONS.map(m => ({ id: m.id, period: m.period, title: m.title, description: m.description, required: m.required, reward: reward(m.reward) }))
  };
}
export async function apiXpRules() {
  return Response.json(publicRules(), { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
