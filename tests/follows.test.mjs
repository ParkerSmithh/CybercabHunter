// Followers & Following (worker/follows.js, migrations/0051_follows.sql, the
// Following feed in worker/social.js). Real SQL (every migration) + the REAL
// Worker router. Isolated test databases only.
//   1. public follow / unfollow, states, counts, idempotence, self-follow
//   2. private requests: request, cancel, accept, decline, remove follower, authorization
//   3. privacy: profile, lists, counts, posts, revocation, private <-> public
//   4. the Following feed: contents, order, pagination, moderation, signed out, other filters
//   5. notifications: one per event, read state, gone with their request
//   6. rate limits, large lists, account deletion
// Run: node tests/follows.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { FOLLOW_LIMITS } from '../worker/follows.js';

const t = makeCheck();
const { check } = t;
const USERS = ['alice', 'bob', 'carol', 'dave', 'mod'];

async function app() {
  const ctx = await makeEnv({ users: USERS });
  ctx.env.ASSETS = { fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) };
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  const set = (id, name, handle, opt, extra = '') => ctx.d1.exec(`UPDATE users SET display_name = '${name}', handle = '${handle}', leaderboard_opt_in = ${opt} ${extra} WHERE id = '${id}'`);
  set('alice', 'Alice A', 'alice_a', 1);
  set('bob', 'Bob B', 'bob_b', 1);
  set('carol', 'Carol Secret', 'carol_secret', 0);   // a private account
  set('dave', 'Dave D', 'dave_d', 1);
  set('mod', 'Owner', 'owner', 1, ", role = 'moderator'");
  ctx.d1.exec(`INSERT INTO user_xp (user_id, xp) VALUES ('alice', 5400), ('carol', 900)`);
  return ctx;
}
async function call(ctx, method, path, { session, json } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, text: JSON.stringify(out), cache: r.headers.get('Cache-Control') };
}
const follow = (ctx, who, handle) => call(ctx, 'PUT', `/api/follows/${handle}`, { session: `s-${who}` });
const unfollow = (ctx, who, handle) => call(ctx, 'DELETE', `/api/follows/${handle}`, { session: `s-${who}` });
const status = (ctx, who, handle) => call(ctx, 'GET', `/api/follows/${handle}`, who ? { session: `s-${who}` } : {});
async function post(ctx, who, body, category = 'general') {
  const form = new FormData(); form.append('body', body); form.append('category', category);
  const r = await worker.fetch(new Request('https://cybercabhunter.com/api/social/posts', { method: 'POST', headers: { Authorization: `Bearer s-${who}` }, body: form }), ctx.env, { waitUntil() {} });
  return (await r.json()).post.id;
}
const feed = (ctx, who, q = '') => call(ctx, 'GET', `/api/social/feed?filter=following${q}`, who ? { session: `s-${who}` } : {});
const notices = async (ctx, who) => (await call(ctx, 'GET', '/api/social/notifications', { session: `s-${who}` })).json;
const requestId = async (ctx, who) => (await call(ctx, 'GET', '/api/follow-requests', { session: `s-${who}` })).json.requests[0].id;

console.log('1. Public accounts');
{
  const ctx = await app();
  let r = await status(ctx, null, 'alice_a');
  check('signed out: public counts, no personal state', r.status === 200 && r.json.relationship === 'signed_out' && r.json.counts.followers === 0 && r.json.can_view);
  check('every answer is private to its viewer (never shared by a cache)', /no-store/.test(r.cache));
  check('signed out can\'t follow', (await call(ctx, 'PUT', '/api/follows/alice_a')).status === 401);
  r = await status(ctx, 'bob', 'alice_a');
  check('state: Follow', r.json.relationship === 'follow');
  r = await follow(ctx, 'bob', 'alice_a');
  check('following a public account is immediate', r.status === 200 && r.json.relationship === 'following' && r.json.counts.followers === 1);
  check('Bob\'s Following count moved too', (await status(ctx, 'bob', 'bob_b')).json.counts.following === 1);
  await follow(ctx, 'bob', 'alice_a'); await follow(ctx, 'bob', 'alice_a');
  check('repeated taps: still one follow', (await status(ctx, null, 'alice_a')).json.counts.followers === 1 && ctx.d1.query(`SELECT * FROM user_follows`).length === 1);
  r = await status(ctx, 'alice', 'bob_b');
  check('state: Follow Back, for the one being followed', r.json.relationship === 'follow_back' && r.json.follows_you === true);
  await follow(ctx, 'alice', 'bob_b');
  check('following back: Following', (await status(ctx, 'alice', 'bob_b')).json.relationship === 'following');
  check('your own profile: self, no button', (await status(ctx, 'alice', 'alice_a')).json.relationship === 'self');
  const self = await follow(ctx, 'alice', 'alice_a');
  check('self-follow refused', self.status === 400 && self.json.error === 'cannot_follow_self');
  let threw = false; try { ctx.d1.exec(`INSERT INTO user_follows (id, follower_id, followed_id, status) VALUES ('x', 'dave', 'dave', 'accepted')`); } catch (e) { threw = true; }
  check('the database refuses self-follows too', threw);
  threw = false; try { ctx.d1.exec(`INSERT INTO user_follows (id, follower_id, followed_id, status) VALUES ('y', 'bob', 'alice', 'accepted')`); } catch (e) { threw = true; }
  check('...and a second row for a pair', threw);
  r = await unfollow(ctx, 'bob', 'alice_a');
  check('unfollow', r.json.relationship === 'follow_back' && r.json.counts.followers === 0);
  check('unfollow twice is safe', (await unfollow(ctx, 'bob', 'alice_a')).status === 200);
  check('unknown handle: 404', (await follow(ctx, 'bob', 'nobody_here')).status === 404);
  const list = await call(ctx, 'GET', '/api/follows/bob_b/followers', { session: 's-dave' });
  check('list: name, handle, rank and the viewer\'s own state, no ids', list.json.users.length === 1 && list.json.users[0].handle === 'alice_a' && list.json.users[0].rank.name && list.json.users[0].relationship === 'follow' && list.json.users[0].follow_id === null && !/"uid"|"id":"alice"/.test(list.text));
  check('Following list', (await call(ctx, 'GET', '/api/follows/alice_a/following')).json.users[0].handle === 'bob_b');
  check('the owner\'s followers carry what Remove names', /^[a-f0-9]{32}$/.test((await call(ctx, 'GET', '/api/follows/bob_b/followers', { session: 's-bob' })).json.users[0].follow_id));
}

console.log('2. Private accounts: requests');
{
  const ctx = await app();
  let r = await follow(ctx, 'bob', 'carol_secret');
  check('a request, not a follow', r.json.relationship === 'requested' && r.json.counts === null && r.json.can_view === false);
  await follow(ctx, 'bob', 'carol_secret');
  check('a repeated request is one request', ctx.d1.query(`SELECT * FROM user_follows`).length === 1);
  const asks = await call(ctx, 'GET', '/api/follow-requests', { session: 's-carol' });
  check('the owner sees who asked', asks.json.count === 1 && asks.json.requests[0].user.handle === 'bob_b');
  const carolCounts = (await status(ctx, 'carol', 'carol_secret')).json.counts;
  check('a pending request is not a follower', carolCounts.followers === 0);
  check('nor counted as Following', (await status(ctx, 'bob', 'bob_b')).json.counts.following === 0);
  r = await unfollow(ctx, 'bob', 'carol_secret');
  check('cancel', r.json.relationship === 'follow' && (await call(ctx, 'GET', '/api/follow-requests', { session: 's-carol' })).json.count === 0);
  await follow(ctx, 'bob', 'carol_secret');
  let id = await requestId(ctx, 'carol');
  const stranger = await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-dave' });
  check('someone else can\'t accept it', stranger.status === 404 && ctx.d1.query(`SELECT status FROM user_follows`)[0].status === 'pending');
  check('nor the requester', (await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-bob' })).status === 404);
  check('nor can a stranger decline it', (await call(ctx, 'POST', `/api/follow-requests/${id}/decline`, { session: 's-dave' })).status === 200 && ctx.d1.query(`SELECT * FROM user_follows`).length === 1);
  check('decline', (await call(ctx, 'POST', `/api/follow-requests/${id}/decline`, { session: 's-carol' })).status === 200 && ctx.d1.query(`SELECT * FROM user_follows`).length === 0);
  check('Bob is back to Follow', (await status(ctx, 'bob', 'carol_secret')).json.relationship === 'follow');
  await follow(ctx, 'bob', 'carol_secret');
  id = await requestId(ctx, 'carol');
  check('accept', (await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-carol' })).status === 200);
  check('accepting twice is safe', (await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-carol' })).status === 200);
  r = await status(ctx, 'bob', 'carol_secret');
  check('Bob follows, and now sees her name and counts', r.json.relationship === 'following' && r.json.can_view && r.json.profile.name === 'Carol Secret' && r.json.counts.followers === 1);
  check('decline can\'t remove a follower', (await call(ctx, 'POST', `/api/follow-requests/${id}/decline`, { session: 's-carol' })).status === 409);
  check('someone else can\'t remove him', (await call(ctx, 'DELETE', `/api/followers/${id}`, { session: 's-dave' })).status === 200 && ctx.d1.query(`SELECT * FROM user_follows`).length === 1);
  check('the owner can', (await call(ctx, 'DELETE', `/api/followers/${id}`, { session: 's-carol' })).status === 200 && ctx.d1.query(`SELECT * FROM user_follows`).length === 0);
}

console.log('3. Privacy');
{
  const ctx = await app();
  const secret = await post(ctx, 'carol', 'A private rider\'s post about the Domain.');
  let r = await status(ctx, null, 'carol_secret');
  check('signed out, a private account looks like an unknown handle', r.status === 404 && r.text === (await status(ctx, null, 'nobody_here')).text);
  r = await status(ctx, 'bob', 'carol_secret');
  check('signed in: only the handle and Request', r.status === 200 && r.json.private && !r.json.can_view && r.json.profile === null && r.json.counts === null && !/Carol Secret|avatar|bio/.test(JSON.stringify({ ...r.json, handle: '' })) );
  check('the public rider profile stays closed', (await call(ctx, 'GET', '/api/riders/carol_secret', { session: 's-bob' })).status === 404);
  for (const list of ['followers', 'following']) {
    check(`${list}: closed to strangers`, (await call(ctx, 'GET', `/api/follows/carol_secret/${list}`, { session: 's-bob' })).status === 403);
    check(`${list}: closed when signed out`, (await call(ctx, 'GET', `/api/follows/carol_secret/${list}`)).status === 404);
  }
  await follow(ctx, 'bob', 'carol_secret');
  check('pending grants nothing', (await call(ctx, 'GET', '/api/follows/carol_secret/followers', { session: 's-bob' })).status === 403 && (await status(ctx, 'bob', 'carol_secret')).json.profile === null);
  const anon = async who => (await call(ctx, 'GET', `/api/social/posts/${secret}`, { session: `s-${who}` })).json.post.author;
  check('pending: her post is still anonymous', (await anon('bob')).anonymous === true);
  check('pending: not in the Following feed', (await feed(ctx, 'bob')).json.posts.length === 0);
  const id = await requestId(ctx, 'carol');
  await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-carol' });
  check('approved: the post carries her name', (await anon('bob')).name === 'Carol Secret');
  const f = await feed(ctx, 'bob');
  check('approved: in the Following feed, by name', f.json.posts.length === 1 && f.json.posts[0].author.name === 'Carol Secret');
  const latest = await call(ctx, 'GET', '/api/social/feed?filter=latest', { session: 's-bob' });
  check('...and by name for him elsewhere', latest.json.posts.find(p => p.id === secret).author.name === 'Carol Secret');
  const others = await call(ctx, 'GET', '/api/social/feed?filter=latest', { session: 's-dave' });
  check('but anonymous to everyone else', others.json.posts.find(p => p.id === secret).author.anonymous === true && !/Carol Secret|carol_secret/.test(others.text));
  const out = await call(ctx, 'GET', '/api/social/feed?filter=latest');
  check('and to the signed-out feed', !/Carol Secret|carol_secret/.test(out.text));
  // A private follower in someone else's list.
  await follow(ctx, 'carol', 'alice_a');
  const third = await call(ctx, 'GET', '/api/follows/alice_a/followers', { session: 's-dave' });
  check('a private follower is left out of a public list, and counted as hidden', third.json.users.length === 0 && third.json.total === 1 && third.json.hidden_count === 1 && !/Carol|carol/.test(third.text));
  const own = await call(ctx, 'GET', '/api/follows/alice_a/followers', { session: 's-alice' });
  check('the account they followed does see them', own.json.users[0].handle === 'carol_secret');
  // Removal revokes at once.
  await call(ctx, 'DELETE', `/api/followers/${id}`, { session: 's-carol' });
  check('removed: name gone from the post', (await anon('bob')).anonymous === true);
  check('removed: Following feed empty', (await feed(ctx, 'bob')).json.posts.length === 0);
  check('removed: profile closed', (await status(ctx, 'bob', 'carol_secret')).json.profile === null);
  check('removed: lists closed', (await call(ctx, 'GET', '/api/follows/carol_secret/following', { session: 's-bob' })).status === 403);
  // Public -> private keeps followers; new ones need approval.
  await follow(ctx, 'bob', 'dave_d');
  const settings = opt => ({ display_name: 'Dave D', handle: 'dave_d', bio: null, profile_visibility: 'public', leaderboard_opt_in: opt });
  await call(ctx, 'PATCH', '/api/profile', { session: 's-dave', json: settings(false) });
  check('going private keeps existing followers', (await status(ctx, 'bob', 'dave_d')).json.relationship === 'following' && (await status(ctx, 'bob', 'dave_d')).json.can_view);
  check('new followers now need approval', (await follow(ctx, 'alice', 'dave_d')).json.relationship === 'requested');
  // Private -> public accepts what was pending.
  await call(ctx, 'PATCH', '/api/profile', { session: 's-dave', json: settings(true) });
  const now = await status(ctx, 'alice', 'dave_d');
  check('going public accepts pending requests', now.json.relationship === 'following' && now.json.counts.followers === 2 && (await call(ctx, 'GET', '/api/follow-requests', { session: 's-dave' })).json.count === 0);
  check('and tells them', (await notices(ctx, 'alice')).notifications.some(n => n.type === 'follow_accepted' && n.actor.handle === 'dave_d'));
}

console.log('4. The Following feed');
{
  const ctx = await app();
  const out = await feed(ctx, null);
  check('signed out: sign in, no personal feed', out.status === 401 && out.json.error === 'sign_in_required' && !out.json.posts);
  check('follows nobody: says so', (await feed(ctx, 'dave')).json.following_count === 0 && (await feed(ctx, 'dave')).json.posts.length === 0);
  await follow(ctx, 'dave', 'alice_a');
  const quiet = await feed(ctx, 'dave');
  check('follows someone who hasn\'t posted: a different empty state', quiet.json.following_count === 1 && quiet.json.posts.length === 0);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await post(ctx, 'alice', `Alice post ${i}`, i % 2 ? 'sighting' : 'question'));
    ctx.d1.exec(`UPDATE social_posts SET created_at = datetime('now', '-${10 - i} hours') WHERE id = '${ids[i]}'`);
  }
  const bobPost = await post(ctx, 'bob', 'Bob is not followed');
  const mine = await post(ctx, 'dave', 'My own post');
  let page = await feed(ctx, 'dave', '&limit=2');
  check('only followed authors, newest first', page.json.posts.map(p => p.id).join() === [ids[4], ids[3]].join() && !page.text.includes(bobPost) && !page.text.includes(mine));
  check('it pages', !!page.json.next_cursor);
  const second = await feed(ctx, 'dave', `&limit=2&cursor=${page.json.next_cursor}`);
  check('the next page continues without repeats', second.json.posts.map(p => p.id).join() === [ids[2], ids[1]].join());
  const third = await feed(ctx, 'dave', `&limit=2&cursor=${second.json.next_cursor}`);
  check('and ends', third.json.posts.length === 1 && third.json.next_cursor === null);
  check('posts keep likes, comments and categories', page.json.posts[0].like_count === 0 && page.json.posts[0].category === 'question' && 'comment_count' in page.json.posts[0]);
  await call(ctx, 'DELETE', `/api/social/posts/${ids[4]}`, { session: 's-mod', json: { reason: 'spam' } });
  check('a moderated post is left out', !(await feed(ctx, 'dave')).text.includes(ids[4]));
  await call(ctx, 'DELETE', `/api/social/posts/${ids[3]}`, { session: 's-alice' });
  check('a deleted post is left out', !(await feed(ctx, 'dave')).text.includes(ids[3]));
  await unfollow(ctx, 'dave', 'alice_a');
  check('unfollowed: gone', (await feed(ctx, 'dave')).json.posts.length === 0);
  for (const f of ['foryou', 'latest', 'photos', 'reviews']) {
    const r = await call(ctx, 'GET', `/api/social/feed?filter=${f}`, { session: 's-dave' });
    check(`${f} still answers`, r.status === 200 && r.json.filter === f && !('following_count' in r.json));
  }
  check('Saved still needs sign-in', (await call(ctx, 'GET', '/api/social/feed?filter=saved')).status === 401);
}

console.log('5. Notifications');
{
  const ctx = await app();
  await follow(ctx, 'bob', 'alice_a');
  let n = await notices(ctx, 'alice');
  const f = n.notifications.find(x => x.type === 'follower');
  check('new follower: who, and a link to them', n.unread === 1 && f.actor.handle === 'bob_b' && f.url === '/rider/bob_b' && f.text === 'started following you' && !f.read);
  await unfollow(ctx, 'bob', 'alice_a'); await follow(ctx, 'bob', 'alice_a');
  n = await notices(ctx, 'alice');
  check('follow, unfollow, follow: still one notice', n.notifications.filter(x => x.type === 'follower').length === 1);
  check('no notice for an unfollow', !n.notifications.some(x => /unfollow/.test(x.text)));
  await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-alice', json: { ids: [f.id] } });
  check('read one', (await notices(ctx, 'alice')).unread === 0);
  await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-dave', json: { ids: [f.id] } });
  check('another rider can\'t touch it', ctx.d1.query(`SELECT read_at FROM follow_notifications WHERE id = '${f.id}'`)[0].read_at !== null);
  await follow(ctx, 'dave', 'carol_secret');
  n = await notices(ctx, 'carol');
  const ask = n.notifications.find(x => x.type === 'follow_request');
  check('request: goes to the request screen', ask.url === '/profile?section=follow-requests' && ask.actor.handle === 'dave_d');
  await unfollow(ctx, 'dave', 'carol_secret');
  check('cancelled: the notice goes', !(await notices(ctx, 'carol')).notifications.some(x => x.type === 'follow_request'));
  await follow(ctx, 'dave', 'carol_secret');
  const id = await requestId(ctx, 'carol');
  await call(ctx, 'POST', `/api/follow-requests/${id}/accept`, { session: 's-carol' });
  check('accepted: the request notice is done', !(await notices(ctx, 'carol')).notifications.some(x => x.type === 'follow_request'));
  const told = (await notices(ctx, 'dave')).notifications.find(x => x.type === 'follow_accepted');
  check('the requester is told, by the private account now visible to them', told.actor.name === 'Carol Secret' && told.url === '/rider/carol_secret');
  await follow(ctx, 'bob', 'carol_secret');
  await call(ctx, 'POST', `/api/follow-requests/${await requestId(ctx, 'carol')}/decline`, { session: 's-carol' });
  check('declined: the requester is not told', !(await notices(ctx, 'bob')).notifications.some(x => x.type === 'follow_accepted'));
  check('count_only includes them', (await call(ctx, 'GET', '/api/social/notifications?count_only=1', { session: 's-dave' })).json.unread >= 1);
  await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-dave', json: { all: true } });
  check('read all', (await notices(ctx, 'dave')).unread === 0);
  check('no private content or ids in a notice', !JSON.stringify((await notices(ctx, 'alice')).notifications).includes('"bob"'));
}

console.log('6. Limits, large lists, deletion');
{
  const ctx = await app();
  for (let i = 0; i < FOLLOW_LIMITS.perPairPerDay; i++) { await follow(ctx, 'bob', 'alice_a'); await unfollow(ctx, 'bob', 'alice_a'); }
  let r = await follow(ctx, 'bob', 'alice_a');
  check('follow/unfollow spam on one account is limited', r.status === 429 && r.json.error === 'rate_limited');
  check('unfollowing is never limited', (await unfollow(ctx, 'bob', 'alice_a')).status === 200);
  check('another account is still fine', (await follow(ctx, 'bob', 'dave_d')).status === 200);
  const many = [];
  for (let i = 0; i < FOLLOW_LIMITS.perHour; i++) many.push(`('dave', 'alice', datetime('now'))`);
  ctx.d1.exec(`INSERT INTO follow_actions (user_id, target_user_id, created_at) VALUES ${many.join(',')}`);
  check('so are follows per hour', (await follow(ctx, 'dave', 'bob_b')).status === 429);
  ctx.d1.exec(`DELETE FROM follow_actions WHERE user_id = 'dave'`);
  ctx.d1.exec(`INSERT INTO follow_actions (user_id, target_user_id, created_at) VALUES ('dave', 'alice', datetime('now', '-3 days'))`);
  await follow(ctx, 'dave', 'bob_b');
  check('old rows are pruned as riders write', ctx.d1.query(`SELECT COUNT(*) AS n FROM follow_actions WHERE user_id = 'dave'`)[0].n === 1);

  // A large list pages through everyone exactly once.
  const lots = Array.from({ length: 75 }, (_, i) => `f${i}`);
  for (const u of lots) ctx.d1.exec(`INSERT INTO users (id, display_name, handle, leaderboard_opt_in, profile_visibility) VALUES ('${u}', 'Fan ${u}', 'fan_${u}', 1, 'public'); INSERT INTO user_follows (id, follower_id, followed_id, status, updated_at) VALUES ('${u.padStart(32, '0')}', '${u}', 'alice', 'accepted', datetime('now', '-${u.slice(1)} minutes'));`);
  const seen = new Set(); let cursor = null, pages = 0;
  do {
    const p = await call(ctx, 'GET', `/api/follows/alice_a/followers?limit=30${cursor ? `&cursor=${cursor}` : ''}`);
    p.json.users.forEach(u => seen.add(u.handle)); cursor = p.json.next_cursor; pages++;
    if (pages === 1) check('the first page says the total', p.json.total === 75 && p.json.hidden_count === 0);
  } while (cursor && pages < 10);
  check('75 followers over 3 pages, each once', seen.size === 75 && pages === 3);
  check('a bad cursor is the first page, not an error', (await call(ctx, 'GET', '/api/follows/alice_a/followers?cursor=%%%')).status === 200);

  // Deleting an account removes every relationship, both ways.
  await follow(ctx, 'carol', 'alice_a'); await follow(ctx, 'alice', 'carol_secret');
  const before = (await status(ctx, null, 'alice_a')).json.counts.followers;
  const del = await call(ctx, 'DELETE', '/api/account', { session: 's-carol', json: { confirm: 'DELETE' } });
  check('account deleted', del.status === 200);
  check('no follow, notice or limit row mentions them', ctx.d1.query(`SELECT 1 FROM user_follows WHERE follower_id = 'carol' OR followed_id = 'carol'`).length === 0 && ctx.d1.query(`SELECT 1 FROM follow_notifications WHERE user_id = 'carol' OR actor_user_id = 'carol'`).length === 0 && ctx.d1.query(`SELECT 1 FROM follow_actions WHERE user_id = 'carol' OR target_user_id = 'carol'`).length === 0);
  check('counts follow', (await status(ctx, null, 'alice_a')).json.counts.followers === before - 1);
  check('a deleted account can\'t be followed', (await follow(ctx, 'bob', 'carol_secret')).status === 404);
  check('an expired session is signed out', (await call(ctx, 'PUT', '/api/follows/alice_a', { session: 's-nobody' })).status === 401);
}

console.log('7. The website: the button, the rider page, the feed and the Profile page (jsdom)');
{
  const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const page = (session) => {
    const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>', { url: 'https://cybercabhunter.com/rider/alice_a', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    if (session) w.localStorage.setItem('teslaSessionId', session);
    w.toasts = [];
    w.eval('var CCC = { toast: (m, t) => toasts.push([m, t]), renderAvatar() {} };');
    w.eval(read('public/js/follows.js'));
    return w;
  };
  const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  let w = page('s-bob');
  let calls = [], release;
  w.fetch = (url, o) => { calls.push([url, o.method]); return new Promise(r => { release = () => r(answer(200, { relationship: 'following', counts: { followers: 1, following: 0 } })); }); };
  let changed = null;
  let btn = w.CCFollow.makeButton({ handle: 'alice_a', state: 'follow', isPrivate: false, onChange: c => { changed = c; } });
  w.document.body.appendChild(btn);
  check('labels: Follow', btn.textContent === 'Follow' && /Follow @alice_a/.test(btn.getAttribute('aria-label')));
  btn.click();
  check('it changes at once', btn.textContent === 'Following' && btn.disabled);
  btn.click(); btn.click();
  check('rapid taps send one request', calls.length === 1 && calls[0][1] === 'PUT' && calls[0][0] === '/api/follows/alice_a');
  release(); await new Promise(r => setTimeout(r, 0));
  check('then settles on what the server said', btn.textContent === 'Following' && !btn.disabled && changed.relationship === 'following' && btn.getAttribute('aria-pressed') === 'true');
  // A failure goes back, with a message.
  w = page('s-bob');
  w.fetch = async () => answer(500, {});
  btn = w.CCFollow.makeButton({ handle: 'alice_a', state: 'follow_back', isPrivate: false });
  check('labels: Follow Back', btn.textContent === 'Follow Back');
  btn.click(); await new Promise(r => setTimeout(r, 0));
  check('a failed follow rolls back and says so', btn.textContent === 'Follow Back' && w.toasts.length === 1 && w.toasts[0][1] === 'error');
  w = page('s-bob');
  w.fetch = async () => answer(429, { error: 'rate_limited' });
  btn = w.CCFollow.makeButton({ handle: 'alice_a', state: 'follow', isPrivate: false });
  btn.click(); await new Promise(r => setTimeout(r, 0));
  check('a rate limit explains itself', btn.textContent === 'Follow' && /too often/.test(w.toasts[0][0]));
  w = page('s-bob');
  w.fetch = async () => { throw new Error('offline'); };
  btn = w.CCFollow.makeButton({ handle: 'alice_a', state: 'follow', isPrivate: false });
  btn.click(); await new Promise(r => setTimeout(r, 0));
  check('offline rolls back and says so', btn.textContent === 'Follow' && /offline/i.test(w.toasts[0][0]));
  // Unfollowing asks; a request is cancelled straight away.
  w = page('s-bob');
  calls = [];
  w.fetch = async (u, o) => { calls.push(o.method); return answer(200, { relationship: 'follow' }); };
  w.confirm = () => false;
  btn = w.CCFollow.makeButton({ handle: 'alice_a', state: 'following', isPrivate: true });
  btn.click(); await new Promise(r => setTimeout(r, 0));
  check('declining the confirmation changes nothing', calls.length === 0 && btn.textContent === 'Following');
  btn = w.CCFollow.makeButton({ handle: 'carol_c', state: 'requested', isPrivate: true });
  check('labels: Requested', btn.textContent === 'Requested' && /Cancel request/.test(btn.getAttribute('aria-label')));
  btn.click(); await new Promise(r => setTimeout(r, 0));
  check('cancelling a request needs no confirmation', calls[0] === 'DELETE' && btn.textContent === 'Follow');
  // Counts.
  w = page('s-bob');
  const el = w.document.createElement('div');
  w.CCFollow.renderCounts(el, { handle: 'alice_a', counts: { followers: 1, following: 2 } });
  check('counts are buttons, with singular and plural', el.querySelectorAll('button').length === 2 && /1 Follower$/.test(el.querySelector('[data-kind=followers]').textContent.trim()));
  w.CCFollow.renderCounts(el, { handle: 'carol_c', counts: null });
  check('no counts when the viewer may not see them', el.innerHTML === '' && el.classList.contains('hidden'));

  const community = read('public/community.html');
  check('the Following tab sits after For You', /data-filter="foryou"[^\n]*\n\s*<button[^>]*data-filter="following"/.test(community));
  const social = read('public/js/social.js');
  check('the Following feed\'s empty states', social.includes('Follow other Cybercab spotters to see their posts here.') && social.includes("You're not following anyone yet.") && social.includes("haven't posted yet"));
  const rider = read('public/rider.html');
  check('the rider page has the button and counts', rider.includes('id="riderFollowButton"') && rider.includes('id="riderFollowCounts"') && rider.includes('js/follows.js'));
  const profile = read('public/profile.html');
  check('the Profile page has Follow Requests', profile.includes('id="followRequests"') && profile.includes('/api/follow-requests'));
  check('every tab title stays plain', /<title>Cybercab Hunter<\/title>/.test(rider) && /<title>Cybercab Hunter<\/title>/.test(profile));
}

t.finish();
