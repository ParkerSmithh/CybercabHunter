// Profile freshness and the avatar model (Phase 5.1 backend fixes):
//   - a rider's new name, photo or privacy reaches every board and profile on
//     the next request: the main leaderboard, the streak boards (stored ORDER
//     only, names/photos/privacy read live), public rider profiles, Find riders
//     and the signed-out Social feed (worker/profile-cache.js: edge copies keyed
//     by the profile epoch; browsers never keep them)
//   - edge caching still works between profile changes
//   - scores, streak numbers, XP and user ids never change because of it
//   - pictures: an upload, else the Google picture (users.google_avatar_url),
//     else initials; an upload is never replaced by a sign-in or a name change,
//     and removing it brings the Google picture back (migrations/0046)
// Isolated: real SQL over an in-memory database, fake KV/R2, a stand-in for
// the per-data-centre edge cache. No production data.
// Run: node tests/profile-sync.test.mjs

import fs from 'node:fs';
import worker from '../worker/index.js';
import { db } from '../worker/db.js';
import { makeEnv, makeCheck, seedVehicle, approveVehicle } from './helpers/env.mjs';
import { profileEpoch, bumpProfileEpoch, PROFILE_EPOCH_KEY } from '../worker/profile-cache.js';
import { getCommunitySummary } from '../worker/community-summary.js';
import { leaderboardRiderChanged } from '../worker/community.js';

const t = makeCheck();
const { check } = t;
const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600e3, DAY = 24 * HOUR;
const GOOGLE = 'https://lh3.googleusercontent.com/a/alice-google=s96-c';

// A stand-in for caches.default (one data centre): stores by URL, counts hits.
const edge = new Map();
let hits = 0;
globalThis.caches = { default: {
  async match(req) { const e = edge.get(req.url); if (!e) return undefined; hits++; return new Response(e.body, { status: e.status, headers: e.headers }); },
  async put(req, res) { edge.set(req.url, { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] }); },
  async delete(req) { return edge.delete(req.url); }
} };

const be32 = n => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const enc = s => [...Buffer.from(s, 'latin1')];
function png(w, h) {
  const chunk = (name, body) => [...be32(body.length), ...enc(name), ...body, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]), ...chunk('IDAT', [1, 2, 3, 4]), ...chunk('IEND', [])]);
}

async function app() {
  const ctx = await makeEnv({ users: ['alice', 'bob', 'carl'] });
  const { d1, env } = ctx;
  env.ASSETS = { fetch: async () => new Response('asset') };
  for (const u of ['alice', 'bob', 'carl']) await env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  d1.exec(`UPDATE users SET leaderboard_opt_in = 1, profile_visibility = 'public'`);
  d1.exec(`UPDATE users SET display_name = 'Alice A', handle = 'alice_a', avatar_url = '${GOOGLE}', google_avatar_url = '${GOOGLE}' WHERE id = 'alice'`);
  d1.exec(`UPDATE users SET display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`);
  d1.exec(`UPDATE users SET display_name = 'Carl C', handle = 'carl_c' WHERE id = 'carl'`);
  // Rides on public vehicles (the main boards) and XP.
  approveVehicle(d1, seedVehicle(d1, { id: 'a1b2c3d4-0000-4000-8000-000000000001', plate: 'XVF1001' }), { withRide: true, userId: 'alice' });
  approveVehicle(d1, seedVehicle(d1, { id: 'a1b2c3d4-0000-4000-8000-000000000002', plate: 'XVF1002' }), { withRide: true, userId: 'bob' });
  d1.exec(`INSERT INTO user_xp (user_id, xp) VALUES ('alice', 900), ('bob', 400)`);
  // Approved sightings: alice 3 days running, bob 1 (the streak boards).
  const now = Date.now();
  let n = 0;
  const sighting = (u, ms) => {
    const id = `ps-${++n}`;
    d1.prepare(`INSERT INTO submissions (id, user_id, submission_type, status, submitted_at, evidence_type) VALUES (?, ?, 'vehicle_sighting', 'approved', ?, 'photo')`).bind(id, u, sqlTime(ms))._exec();
    d1.prepare(`INSERT INTO vehicle_observations (id, submission_id, user_id, service_area) VALUES (?, ?, ?, 'Austin')`).bind(`po-${n}`, id, u)._exec();
  };
  for (let d = 0; d < 3; d++) sighting('alice', now - d * DAY - HOUR);
  sighting('bob', now - HOUR);
  sighting('carl', now - HOUR);
  edge.clear();
  return ctx;
}

const call = async (ctx, method, path, { session, json, form } = {}) => {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, cache: r.headers.get('Cache-Control') };
};
const board = async (ctx, id = 'overall') => (await call(ctx, 'GET', `/api/community/leaderboard?board=${id}`)).json;
const streaks = async (ctx, id = 'daily') => (await call(ctx, 'GET', `/api/streaks/leaderboard?board=${id}`)).json;
const rider = (ctx, handle) => call(ctx, 'GET', `/api/riders/${handle}`);
const search = async (ctx, q) => (await call(ctx, 'GET', `/api/rider-search?q=${encodeURIComponent(q)}`)).json.results;
const feed = async ctx => (await call(ctx, 'GET', '/api/social/feed?filter=latest&limit=10')).json;
const entry = (b, handle) => b.entries.find(e => e.handle === handle);
const profilePatch = (ctx, session, fields) => call(ctx, 'GET', '/api/profile', { session }).then(r => call(ctx, 'PATCH', '/api/profile', { session, json: {
  display_name: r.json.user.display_name, handle: r.json.user.handle, bio: r.json.user.bio, profile_visibility: r.json.user.profile_visibility,
  leaderboard_opt_in: r.json.user.leaderboard_opt_in, ...fields } }));
const upload = (ctx, session) => { const fd = new FormData(); fd.append('large', new File([png(512, 512)], 'a')); fd.append('thumb', new File([png(128, 128)], 'b')); return call(ctx, 'POST', '/api/profile/avatar', { session, form: fd }); };
const userRow = (ctx, id) => ctx.d1.query('SELECT id, display_name, handle, avatar_url, google_avatar_url, leaderboard_opt_in FROM users WHERE id = ?', id)[0];
const figures = b => JSON.stringify(b.entries.map(e => [e.handle, e.rank, e.score, e.rides, e.discovered, e.xp]));
const streakFigures = b => JSON.stringify(b.entries.map(e => [e.handle, e.daily_current, e.weekly_current, e.longest_daily, e.longest_weekly]));

async function run() {
  console.log('1. Edge caching still works, and browsers never keep these responses');
  {
    const ctx = await app();
    const r1 = await call(ctx, 'GET', '/api/community/leaderboard?board=overall');
    const h0 = hits;
    const r2 = await call(ctx, 'GET', '/api/community/leaderboard?board=overall');
    check('the second leaderboard request is an edge hit', hits === h0 + 1 && JSON.stringify(r1.json) === JSON.stringify(r2.json));
    check('the browser is told not to store it (miss and hit alike)', r1.cache === 'private, no-store' && r2.cache === 'private, no-store');
    const stored = [...edge.values()][0];
    check('the edge copy is kept 5 minutes', new Headers(stored.headers).get('Cache-Control') === 'public, max-age=300');
    const s1 = await call(ctx, 'GET', '/api/streaks/leaderboard?board=daily');
    const h1 = hits;
    await call(ctx, 'GET', '/api/streaks/leaderboard?board=daily');
    const p1 = await rider(ctx, 'alice_a');
    await rider(ctx, 'alice_a');
    check('streak boards and rider profiles are edge-cached too', hits === h1 + 2 && s1.cache === 'private, no-store' && p1.cache === 'private, no-store');
    await call(ctx, 'GET', '/api/community/leaderboard?board=overall&junk=1');
    check('an unknown query parameter cannot bypass the edge copy', hits === h1 + 3);
    check('the epoch starts at 0 and is in every key', (await profileEpoch(ctx.env)) === '0' && [...edge.keys()].every(k => k.includes('pe=0')));
  }

  console.log('2. A new display name shows everywhere on the next request');
  {
    const ctx = await app();
    const before = { overall: await board(ctx), xp: await board(ctx, 'xp'), daily: await streaks(ctx), longest: await streaks(ctx, 'longest') };
    check('setup: the boards show "Alice A" (now cached at the edge)', entry(before.overall, 'alice_a').name === 'Alice A' && entry(before.daily, 'alice_a').name === 'Alice A' && (await rider(ctx, 'alice_a')).json.rider.name === 'Alice A');
    await feed(ctx);
    const idsBefore = ctx.d1.query('SELECT id FROM users ORDER BY id').map(r => r.id).join();
    const xpBefore = JSON.stringify(ctx.d1.query('SELECT user_id, xp FROM user_xp ORDER BY user_id'));
    const r = await profilePatch(ctx, 's-alice', { display_name: 'Alice Renamed' });
    check('PATCH /api/profile: 200', r.status === 200 && r.json.user.display_name === 'Alice Renamed');
    check('the profile epoch moved', (await profileEpoch(ctx.env)) !== '0');
    const after = { overall: await board(ctx), xp: await board(ctx, 'xp'), daily: await streaks(ctx), longest: await streaks(ctx, 'longest') };
    check('main leaderboard: the new name', entry(after.overall, 'alice_a').name === 'Alice Renamed' && entry(after.xp, 'alice_a').name === 'Alice Renamed');
    check('streak boards: the new name (same day, no recompute)', entry(after.daily, 'alice_a').name === 'Alice Renamed' && entry(after.longest, 'alice_a').name === 'Alice Renamed' && after.daily.computed_at === before.daily.computed_at);
    check('public rider profile: the new name', (await rider(ctx, 'alice_a')).json.rider.name === 'Alice Renamed');
    check('Find riders: the new name', (await search(ctx, 'Alice'))[0].name === 'Alice Renamed');
    check('the old name is nowhere in these responses', !/Alice A"/.test(JSON.stringify([after, await search(ctx, 'Ali')])));
    check('scores, ranks, rides, discoveries and XP unchanged', figures(after.overall) === figures(before.overall) && figures(after.xp) === figures(before.xp));
    check('streak numbers and order unchanged', streakFigures(after.daily) === streakFigures(before.daily) && streakFigures(after.longest) === streakFigures(before.longest));
    check('user ids and XP rows unchanged', ctx.d1.query('SELECT id FROM users ORDER BY id').map(r => r.id).join() === idsBefore && JSON.stringify(ctx.d1.query('SELECT user_id, xp FROM user_xp ORDER BY user_id')) === xpBefore);
  }

  console.log('3. The signed-out Social feed and live surfaces use the current name');
  {
    const ctx = await app();
    const posted = await call(ctx, 'POST', '/api/social/posts', { session: 's-alice', form: (() => { const f = new FormData(); f.append('body', 'Spotted one at the Domain.'); f.append('category', 'general'); return f; })() });
    check('setup: a post by Alice', posted.status === 201);
    const f1 = await feed(ctx);
    check('signed-out feed (edge-cached 60 s) shows "Alice A"', JSON.stringify(f1).includes('Alice A'));
    await profilePatch(ctx, 's-alice', { display_name: 'Alice Feed' });
    const f2 = await feed(ctx);
    check('...and "Alice Feed" right after the rename (a new edge copy)', JSON.stringify(f2).includes('Alice Feed') && !JSON.stringify(f2).includes('Alice A"'));
    const signedIn = (await call(ctx, 'GET', '/api/social/feed?filter=latest&limit=10', { session: 's-bob' })).json;
    check('the signed-in feed (never cached) shows the current name', JSON.stringify(signedIn).includes('Alice Feed'));
  }

  console.log('4. A new photo shows everywhere; an upload never replaces the Google picture on record');
  {
    const ctx = await app();
    await board(ctx); await streaks(ctx); await rider(ctx, 'alice_a');
    const up = await upload(ctx, 's-alice');
    const custom = up.json.avatar_url;
    check('upload: 200, a custom picture', up.status === 200 && /^\/api\/avatars\/[a-f0-9]{32}$/.test(custom) && up.json.avatar_source === 'custom');
    check('...the Google picture is kept on record', userRow(ctx, 'alice').google_avatar_url === GOOGLE && userRow(ctx, 'alice').avatar_url === custom);
    check('main leaderboard, streak board and profile show the upload', entry(await board(ctx), 'alice_a').avatar_url === custom && entry(await streaks(ctx), 'alice_a').avatar_url === custom && (await rider(ctx, 'alice_a')).json.rider.avatar_url === custom);
    await profilePatch(ctx, 's-alice', { display_name: 'Alice Photo', bio: 'New bio' });
    check('a name and bio change keeps both pictures', userRow(ctx, 'alice').avatar_url === custom && userRow(ctx, 'alice').google_avatar_url === GOOGLE);
    const del = await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-alice' });
    check('Remove photo: the Google picture comes back (response and database)', del.status === 200 && del.json.avatar_url === GOOGLE && del.json.avatar_source === 'google' && userRow(ctx, 'alice').avatar_url === GOOGLE);
    check('...and every board and the profile show it at once', entry(await board(ctx), 'alice_a').avatar_url === GOOGLE && entry(await streaks(ctx), 'alice_a').avatar_url === GOOGLE && (await rider(ctx, 'alice_a')).json.rider.avatar_url === GOOGLE);
    const again = await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-alice' });
    check('Remove again (a Google picture shown): nothing changes', again.status === 200 && userRow(ctx, 'alice').avatar_url === GOOGLE);
    // No Google picture: removing an upload goes to initials.
    await upload(ctx, 's-bob');
    const bobDel = await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-bob' });
    check('a rider without a Google picture: Remove -> initials (null)', bobDel.json.avatar_url === null && bobDel.json.avatar_source === null && userRow(ctx, 'bob').avatar_url === null);
  }

  console.log('5. Privacy: off hides at once everywhere, on shows again');
  {
    const ctx = await app();
    const before = { overall: await board(ctx), daily: await streaks(ctx) };
    await rider(ctx, 'alice_a');
    await profilePatch(ctx, 's-alice', { leaderboard_opt_in: false });
    const off = { overall: await board(ctx), daily: await streaks(ctx), longest: await streaks(ctx, 'longest') };
    const leak = JSON.stringify(off);
    check('main and streak boards: no row, no name, no handle, no photo', !entry(off.overall, 'alice_a') && !entry(off.daily, 'alice_a') && !/Alice|alice_a|googleusercontent/.test(leak));
    check('...and ranks close up (no gap)', off.daily.entries.every((e, i) => e.rank <= i + 1) && off.daily.entries[0].rank === 1);
    check('public profile: 404, and not kept by the browser', (await rider(ctx, 'alice_a')).status === 404 && (await rider(ctx, 'alice_a')).cache === 'private, no-store');
    check('Find riders: not listed', !(await search(ctx, 'Alice')).length);
    await profilePatch(ctx, 's-alice', { leaderboard_opt_in: true });
    const on = await streaks(ctx);
    check('switch back on: the streak board shows her again at once, same numbers', streakFigures(on) === streakFigures(before.daily));
    check('...and the profile is back', (await rider(ctx, 'alice_a')).status === 200);
    check('bob and carl\'s figures never changed', JSON.stringify(entry(off.overall, 'bob_b')) === JSON.stringify(entry(before.overall, 'bob_b')));
    const back = await board(ctx);
    check('switch back on: the main leaderboard lists her again at once, same figures', figures(back) === figures(before.overall));
    const log = [], real = ctx.env.cybercabhunter_db.prepare.bind(ctx.env.cybercabhunter_db);
    ctx.env.cybercabhunter_db.prepare = q => { log.push(q); return real(q); };
    await profilePatch(ctx, 's-alice', { display_name: 'Alice Again' });
    await board(ctx);
    ctx.env.cybercabhunter_db.prepare = real;
    check('an ordinary edit (switch stays on) never recomputes the leaderboard figures', !log.some(q => /WITH\s+ride_first|discovery|ride_first AS/.test(q)));
  }

  console.log('6. Deleted accounts and old stored rows');
  {
    const ctx = await app();
    await streaks(ctx);
    const r = await call(ctx, 'DELETE', '/api/account', { session: 's-carl', json: { confirm: 'DELETE' } });
    check('setup: carl deletes his account', r.status === 200);
    check('the streak board drops a deleted account at once', !entry(await streaks(ctx), 'carl_c'));
    // A row stored by the previous code (boards with names, no board_order) is recomputed once.
    const s = await getCommunitySummary(ctx.env);
    const { board_order, ...old } = s;
    ctx.d1.prepare(`UPDATE community_summary SET value = ? WHERE key = 'community'`).bind(JSON.stringify({ ...old, boards: { daily: [{ name: 'Stale Name' }] } }))._exec();
    const fresh = await getCommunitySummary(ctx.env);
    check('an older stored row (names, no order) is recomputed once; no stale names are served', !!fresh.board_order && !JSON.stringify(fresh).includes('Stale Name'));
    await leaderboardRiderChanged(ctx.env, 'nobody', {});
    check('the change hook works with no stored leaderboard row', (await profileEpoch(ctx.env)) !== '0');
  }

  console.log('7. Google sign-in and the picture fallback');
  {
    const ctx = await app();
    const sql = ctx.env.cybercabhunter_db;
    const changed = [];
    const onAvatarChange = (id, url) => { changed.push([id, url]); };
    const id = await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-new', email: 'n@example.com', name: 'New Rider', avatarUrl: 'https://lh3.googleusercontent.com/a/new=s96-c' }, { onAvatarChange });
    check('a new Google account: shown picture = Google picture = recorded', userRow(ctx, id).avatar_url === 'https://lh3.googleusercontent.com/a/new=s96-c' && userRow(ctx, id).google_avatar_url === 'https://lh3.googleusercontent.com/a/new=s96-c');
    await ctx.env.TESLA_SESSIONS.put('session:s-new', JSON.stringify({ user_id: id }));
    const up = await upload(ctx, 's-new');
    await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-new', name: 'New Rider', avatarUrl: 'https://lh3.googleusercontent.com/a/new2=s96-c' }, { onAvatarChange });
    check('signing in again never replaces an upload; the Google picture on record follows Google', userRow(ctx, id).avatar_url === up.json.avatar_url && userRow(ctx, id).google_avatar_url === 'https://lh3.googleusercontent.com/a/new2=s96-c' && changed.length === 0);
    await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-new' });
    check('...and removing the upload shows the latest Google picture', userRow(ctx, id).avatar_url === 'https://lh3.googleusercontent.com/a/new2=s96-c');
    await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-new', name: 'New Rider', avatarUrl: 'https://lh3.googleusercontent.com/a/new3=s96-c' }, { onAvatarChange });
    check('no upload: a new Google picture is shown at sign-in, and the boards are told', userRow(ctx, id).avatar_url === 'https://lh3.googleusercontent.com/a/new3=s96-c' && changed.length === 1 && changed[0][1] === 'https://lh3.googleusercontent.com/a/new3=s96-c');
    await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-new', name: 'New Rider', avatarUrl: 'http://insecure.example/p.png' }, { onAvatarChange });
    check('a non-https picture from Google is ignored (nothing changes)', userRow(ctx, id).avatar_url === 'https://lh3.googleusercontent.com/a/new3=s96-c');
    const noPic = await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-nopic', name: 'No Pic' }, {});
    check('a Google account without a picture: initials (both empty)', userRow(ctx, noPic).avatar_url === null && userRow(ctx, noPic).google_avatar_url === null);
    // An account from before this change: shown picture null, nothing on record (e.g. an upload removed earlier).
    ctx.d1.exec(`UPDATE users SET avatar_url = NULL, google_avatar_url = NULL WHERE id = '${id}'`);
    await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-new', name: 'New Rider', avatarUrl: 'https://lh3.googleusercontent.com/a/back=s96-c' }, { onAvatarChange });
    check('an older account with no picture gets its Google picture back at its next sign-in', userRow(ctx, id).avatar_url === 'https://lh3.googleusercontent.com/a/back=s96-c' && userRow(ctx, id).google_avatar_url === 'https://lh3.googleusercontent.com/a/back=s96-c');
  }

  console.log('8. Migration 0046 backfill and the profile API contract');
  {
    const ctx = await app();
    ctx.d1.exec(`UPDATE users SET avatar_url = 'https://lh3.googleusercontent.com/a/old=s96-c', google_avatar_url = NULL WHERE id = 'bob'`);
    ctx.d1.exec(`UPDATE users SET avatar_url = '/api/avatars/0123456789abcdef0123456789abcdef', google_avatar_url = NULL WHERE id = 'carl'`);
    const sqlText = fs.readFileSync(new URL('../migrations/0046_google_avatar.sql', import.meta.url), 'utf8');
    const backfill = sqlText.slice(sqlText.indexOf('UPDATE users'));
    ctx.d1.exec(backfill);
    check('backfill: a shown Google picture is recorded; the shown picture is untouched', userRow(ctx, 'bob').google_avatar_url === 'https://lh3.googleusercontent.com/a/old=s96-c' && userRow(ctx, 'bob').avatar_url === 'https://lh3.googleusercontent.com/a/old=s96-c');
    check('backfill: a custom upload is untouched and not recorded as Google', userRow(ctx, 'carl').avatar_url === '/api/avatars/0123456789abcdef0123456789abcdef' && userRow(ctx, 'carl').google_avatar_url === null);
    ctx.d1.exec(backfill);
    check('backfill is safe to run twice', userRow(ctx, 'bob').google_avatar_url === 'https://lh3.googleusercontent.com/a/old=s96-c');
    const p = (await call(ctx, 'GET', '/api/profile', { session: 's-alice' })).json.user;
    check('GET /api/profile: every existing field, plus avatar_source and has_google_avatar', ['display_name', 'handle', 'bio', 'profile_visibility', 'leaderboard_opt_in', 'avatar_url', 'joined_at'].every(k => k in p) && p.avatar_source === 'google' && p.has_google_avatar === true);
    const me = (await call(ctx, 'GET', '/api/me', { session: 's-carl' })).json.user;
    check('GET /api/me: the same fields as before, plus avatar_source', me.id === 'carl' && me.avatar_url === '/api/avatars/0123456789abcdef0123456789abcdef' && me.avatar_source === 'custom' && 'display_name' in me);
    check('GET /api/me never exposes the stored Google URL field', !('google_avatar_url' in me) && !('google_avatar_url' in p));
    check('GET /api/profile says whether the account is signed in with Google', typeof p.google_linked === 'boolean');

    // An upload from before the Google picture was kept (carl: nothing on record), on a Google account.
    ctx.d1.exec(`INSERT INTO google_connections (id, user_id, google_sub, email) VALUES ('gc-carl', 'carl', 'g-carl', NULL)`);
    const removed = await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-carl' });
    const after = (await call(ctx, 'GET', '/api/profile', { session: 's-carl' })).json.user;
    check('removing it: initials for now, and the clients are told a Google sign-in brings the Google picture back', removed.status === 200 && after.avatar_url === null && after.has_google_avatar === false && after.google_linked === true);
    await db.findOrCreateUserByGoogleIdentity(ctx.env.cybercabhunter_db, { googleSub: 'g-carl', name: 'Carl', avatarUrl: 'https://lh3.googleusercontent.com/a/carl=s96-c' }, {});
    const restored = (await call(ctx, 'GET', '/api/profile', { session: 's-carl' })).json.user;
    check('…and that Google sign-in shows the Google picture', restored.avatar_url === 'https://lh3.googleusercontent.com/a/carl=s96-c' && restored.avatar_source === 'google' && restored.has_google_avatar === true);
  }

  console.log('9. The epoch reaches every profile-bearing cache key');
  {
    const ctx = await app();
    await board(ctx); await streaks(ctx); await rider(ctx, 'alice_a'); await feed(ctx);
    const old = [...edge.keys()];
    await ctx.env.TESLA_SESSIONS.put(PROFILE_EPOCH_KEY, 'zz1');
    await board(ctx); await streaks(ctx); await rider(ctx, 'alice_a'); await feed(ctx);
    const fresh = [...edge.keys()].filter(k => !old.includes(k));
    check('leaderboard, streaks, rider profile and signed-out feed all re-keyed', fresh.length === 4 && fresh.every(k => k.includes('pe=zz1')) && old.every(k => k.includes('pe=0')));
  }

  console.log('10. KV unavailable, concurrent changes');
  {
    const ctx = await app();
    await board(ctx); await rider(ctx, 'alice_a');
    const kv = ctx.env.TESLA_SESSIONS, realGet = kv.get.bind(kv), realPut = kv.put.bind(kv);
    // Privacy off while KV reads fail for public requests (sessions still read; the edit itself needs KV).
    await profilePatch(ctx, 's-alice', { leaderboard_opt_in: false });
    kv.get = async key => { if (key === PROFILE_EPOCH_KEY) throw new Error('KV unavailable'); return realGet(key); };
    const size = edge.size;
    const r = await rider(ctx, 'alice_a');
    const b = await board(ctx);
    const f = await call(ctx, 'GET', '/api/social/feed?filter=latest&limit=10');
    check('KV unreadable: answers come fresh from the database (the hidden profile is a 404, not an old copy)', r.status === 404 && !entry(b, 'alice_a') && f.status === 200);
    check('...and nothing is stored at the edge meanwhile, and browsers keep nothing', edge.size === size && r.cache === 'private, no-store' && b && f.cache === 'private, no-store');
    check('profileEpoch reports the failure as null (not "0")', (await profileEpoch(ctx.env)) === null);
    kv.get = realGet;
    // Writes refused once (KV allows one write per second per key): retried.
    let refused = 0;
    kv.put = async (key, value, o) => { if (key === PROFILE_EPOCH_KEY && refused++ === 0) throw new Error('429 too many writes'); return realPut(key, value, o); };
    const e0 = await profileEpoch(ctx.env);
    check('a refused epoch write is retried once and succeeds', (await bumpProfileEpoch(ctx.env, { retryMs: 5 })) === true && (await profileEpoch(ctx.env)) !== e0 && refused === 2);
    kv.put = async key => { if (key === PROFILE_EPOCH_KEY) throw new Error('KV down'); };
    const errors = [], realError = console.error; console.error = m => errors.push(m);
    const ok = await bumpProfileEpoch(ctx.env, { retryMs: 5 });
    console.error = realError;
    check('both writes refused: reported and logged, no exception (copies then expire on their own TTL)', ok === false && errors.some(m => /profile_epoch_bump_failed/.test(m)));
    kv.put = realPut;
    const saved = await profilePatch(ctx, 's-alice', { leaderboard_opt_in: true });
    check('switching privacy back on afterwards works normally', saved.status === 200);
    // Concurrent bumps: every value is new, none repeats an old one.
    const seen = new Set();
    for (let i = 0; i < 40; i++) { await bumpProfileEpoch(ctx.env, { retryMs: 0 }); seen.add(await profileEpoch(ctx.env)); }
    const both = await Promise.all([bumpProfileEpoch(ctx.env), bumpProfileEpoch(ctx.env)]);
    check('epoch values never repeat (40 bumps, 40 distinct values); concurrent bumps both land', seen.size === 40 && both.every(Boolean) && !seen.has(await profileEpoch(ctx.env)));
  }

  console.log('11. The whole picture sequence (website and app read the same fields)');
  {
    const ctx = await app();
    const sql = ctx.env.cybercabhunter_db;
    const PIC = 'https://lh3.googleusercontent.com/a/seq=s96-c';
    const signIn = async () => {
      const id = await db.findOrCreateUserByGoogleIdentity(sql, { googleSub: 'g-seq', email: 'seq@example.com', name: 'Sam Sequence', avatarUrl: PIC }, { onAvatarChange: (uid, url) => leaderboardRiderChanged(ctx.env, uid, { avatar_url: url }) });
      await ctx.env.TESLA_SESSIONS.put('session:s-seq', JSON.stringify({ user_id: id }));
      return id;
    };
    const view = async () => {
      const me = (await call(ctx, 'GET', '/api/me', { session: 's-seq' })).json.user;
      const p = (await call(ctx, 'GET', '/api/profile', { session: 's-seq' })).json.user;
      return { me: [me.avatar_url, me.avatar_source], profile: [p.avatar_url, p.avatar_source, p.has_google_avatar] };
    };
    const id = await signIn();
    let v = await view();
    check('1-2. signs in with Google: the Google picture shows (app: /api/me; website: /api/profile)', v.me[0] === PIC && v.me[1] === 'google' && v.profile[1] === 'google');
    const up = await upload(ctx, 's-seq');
    v = await view();
    check('3-4. uploads a picture: it replaces the Google one everywhere', v.me[0] === up.json.avatar_url && v.me[1] === 'custom' && v.profile[1] === 'custom');
    await profilePatch(ctx, 's-seq', { display_name: 'Sam Renamed' });
    check('5-6. renames: both picture records intact', userRow(ctx, id).avatar_url === up.json.avatar_url && userRow(ctx, id).google_avatar_url === PIC && userRow(ctx, id).display_name === 'Sam Renamed');
    await call(ctx, 'DELETE', '/api/profile/avatar', { session: 's-seq' });
    v = await view();
    check('7-8. removes the upload: the Google picture returns by itself', v.me[0] === PIC && v.me[1] === 'google' && v.profile[2] === true);
    await ctx.env.TESLA_SESSIONS.delete('session:s-seq');
    check('9. signed out: /api/me is a 401', (await call(ctx, 'GET', '/api/me', { session: 's-seq' })).status === 401);
    await signIn();
    v = await view();
    check('9-10. signs back in: still the Google picture, name kept', v.me[0] === PIC && userRow(ctx, id).display_name === 'Sam Renamed');
    await upload(ctx, 's-seq');
    const custom = userRow(ctx, id).avatar_url;
    await ctx.env.TESLA_SESSIONS.delete('session:s-seq');
    await signIn();
    check('...and with an upload, signing out and in keeps the upload', userRow(ctx, id).avatar_url === custom && (await view()).me[1] === 'custom');
  }

  console.log('12. Rollback safety: the stored streak row keeps the previous version\'s shape');
  {
    const ctx = await app();
    const s = await getCommunitySummary(ctx.env);
    const legacy = s.boards;
    check('boards (named, as the previous Worker serves them) is still stored next to board_order', legacy && Array.isArray(legacy.daily) && legacy.daily.length > 0 && legacy.daily[0].name && !('uid' in legacy.daily[0]));
    ctx.d1.exec(`UPDATE users SET leaderboard_opt_in = 0 WHERE id = 'bob'`);
    const s2 = await getCommunitySummary(ctx.env, Date.now() + 37 * 3600e3);
    check('...it lists opted-in riders only (as before), never with an id', !JSON.stringify(s2.boards).includes('bob_b') && !/"uid"/.test(JSON.stringify(s2.boards)));
    const pub = await streaks(ctx);
    check('the current Worker never serves the stored names (it reads users live)', pub.entries.every(e => e.name !== undefined) && !('board_order' in pub));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
