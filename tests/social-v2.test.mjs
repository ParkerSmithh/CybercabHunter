// Community Social, part 2 (worker/social.js, public/js/social.js,
// migrations/0045_social_saves_notifications_pins.sql).
//   1. the composer's Cybercab search: plate, VIN, vehicle id; partial and
//      case-insensitive; public registry vehicles only; attach / change / remove
//   2. saved posts: private, no duplicates, the Saved feed, gone with the post
//   3. notifications: comment, reply, like, @mention, announcement; never your
//      own; one per event; private; read one / read all; gone with the content
//   4. community pins: moderators only, at most 3, on top of For You / Latest,
//      never twice, unpinned when removed
//   5. feeds: Photos / Reviews / Latest / Most popular with pagination
//   6. editing keeps photos, vehicle and review; deleting leaves nothing behind
//   7. link previews for shared posts; no XP from any of it
//   8. the page (jsdom): picker, share, save, bell, pins, ranks
// Real SQL (every migration) + the REAL Worker router. Isolated test databases only.
// Run: node tests/social-v2.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedVehicle, approveVehicle } from './helpers/env.mjs';
import worker from '../worker/index.js';
import { mentionedHandles, socialMetaFor, MAX_PINS } from '../worker/social.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const enc = s => [...Buffer.from(s, 'latin1')];
const be16 = n => [(n >> 8) & 255, n & 255];
function jpeg() {
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  return Uint8Array.from([0xff, 0xd8, ...seg(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...seg(0xe1, enc('Exif\0\0MM\0*GPSLatitude 30.2672 GPSLongitude -97.7431')),
    ...seg(0xc0, [8, ...be16(64), ...be16(64), 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0xff, 0xd9]);
}

const V1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const V2 = 'b2c3d4e5-0000-4000-8000-000000000002';
const V3 = 'c3d4e5f6-0000-4000-8000-000000000003';
const VPRIV = 'd4e5f6a7-0000-4000-8000-000000000004';
const USERS = ['alice', 'bob', 'carol', 'mod'];
async function makeApp() {
  const ctx = await makeEnv({ users: USERS });
  ctx.env.ASSETS = { fetch: async () => new Response('<html><head><title>Cybercab Hunter</title></head></html>', { headers: { 'Content-Type': 'text/html' } }) };
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 0, display_name = 'Carol Secret', handle = 'carol_secret' WHERE id = 'carol'`)._exec();
  ctx.d1.prepare(`UPDATE users SET role = 'moderator', leaderboard_opt_in = 1, display_name = 'Owner', handle = 'owner' WHERE id = 'mod'`)._exec();
  ctx.d1.prepare(`INSERT INTO user_xp (user_id, xp) VALUES ('alice', 5400), ('bob', 820)`)._exec();
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: V1, plate: 'XVF-3582', model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: V2, plate: 'XVF3210', model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: V3, plate: null, model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  seedVehicle(ctx.d1, { id: VPRIV, plate: 'HIDDEN1' });
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '7SAYGDEF5TA000123', service_area = 'Austin', approval_basis = 'vin-verified' WHERE id = '${V1}'`);
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET approval_basis = 'manual', service_area = 'Austin' WHERE id = '${V2}'`);
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '7SAYGDEF9TA000999' WHERE id = '${V3}'`);
  ctx.d1.exec(`UPDATE robotaxi_vehicles SET vin = '7SAYGDEF0TA000555' WHERE id = '${VPRIV}'`);
  return ctx;
}
async function call(ctx, method, path, { session, json, form } = {}) {
  const headers = {};
  if (session) headers.Authorization = `Bearer ${session}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) for (const one of [].concat(v)) body.append(k, one);
  }
  const r = await worker.fetch(new Request(`https://cybercabhunter.com${path}`, { method, headers, body }), ctx.env, { waitUntil() {} });
  let out = null; try { out = await r.clone().json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json: out, r };
}
const post = (ctx, who, form) => call(ctx, 'POST', '/api/social/posts', { session: `s-${who}`, form });
const photo = name => new File([jpeg()], name, { type: 'image/jpeg' });
const count = (ctx, sql, ...a) => ctx.d1.query(sql, ...a)[0].n;
const search = async (ctx, q) => (await call(ctx, 'GET', `/api/social/vehicles?q=${encodeURIComponent(q)}`)).json.vehicles;
const feed = async (ctx, qs, who) => (await call(ctx, 'GET', `/api/social/feed?${qs}`, { session: who ? `s-${who}` : undefined })).json;
const notes = async (ctx, who) => (await call(ctx, 'GET', '/api/social/notifications', { session: `s-${who}` })).json;
const xpRows = ctx => ctx.d1.query('SELECT COUNT(*) AS n FROM xp_ledger')[0].n;

async function run() {
  console.log('1. Cybercab search and attachments');
  {
    const ctx = await makeApp();
    check('by license plate: partial, case-insensitive, dashes and spaces ignored', (await search(ctx, 'xvf35')).map(v => v.id).join() === V1 && (await search(ctx, 'XVF 3582'))[0].id === V1);
    check('by plate prefix: both XVF cars, best match first', (await search(ctx, 'xvf3')).length === 2 && (await search(ctx, 'xvf3210'))[0].id === V2);
    check('by VIN (partial, any case)', (await search(ctx, '7saygdef5ta')).map(v => v.id).join() === V1);
    check('by the vehicle id (its /vehicle/<id> link)', (await search(ctx, 'c3d4e5f6')).map(v => v.id).join() === V3);
    check('a vehicle without a plate is found by its VIN', (await search(ctx, '000999'))[0].id === V3 && (await search(ctx, '000999'))[0].license_plate === null);
    const priv = await search(ctx, 'HIDDEN1');
    check('a private / unlisted vehicle never appears, even by exact VIN', priv.length === 0 && (await search(ctx, '7SAYGDEF0TA000555')).length === 0);
    check('no match: an empty list (the page shows its empty state)', (await search(ctx, 'ZZZ999')).length === 0 && (await search(ctx, '%%%')).length === 0);
    const all = await search(ctx, '');
    const v1 = all.find(v => v.id === V1);
    check('no query: the public vehicles, at most 8', all.length === 3 && all.length <= 8);
    check('only public registry fields: id, plate, VIN, city, Cybercab image, page link', v1.license_plate === 'XVF-3582' && v1.vin === '7SAYGDEF5TA000123' && v1.service_area === 'Austin' && v1.cybercab === true && v1.image === '/images/dmv-cybercab.webp' && v1.url === `/vehicle/${V1}` && v1.short_id === 'a1b2c3d4' && Object.keys(v1).sort().join() === 'cybercab,id,image,license_plate,service_area,short_id,url,verified,vin');
    check('a vehicle that is not an approved Cybercab gets no Cybercab image', all.find(v => v.id === V3).image === null);

    const subsBefore = count(ctx, `SELECT COUNT(*) AS n FROM submissions`);
    const p = await post(ctx, 'alice', { body: 'Spotted it on Congress', vehicle_id: V1 });
    check('attaching a Cybercab: the post carries its card (plate, VIN, city, link)', p.status === 201 && p.json.post.vehicle.id === V1 && p.json.post.vehicle.vin === '7SAYGDEF5TA000123' && p.json.post.vehicle.url === `/vehicle/${V1}`);
    check('the card links to the existing vehicle page, which opens', (await call(ctx, 'GET', `/api/robotaxi-vehicles/${V1}`)).status === 200);
    check('a private vehicle cannot be attached (server-side)', (await post(ctx, 'alice', { body: 'x', vehicle_id: VPRIV })).json.error === 'unknown_vehicle');
    check('attaching is optional: a plain post, a photo post and a review post need no vehicle',
      (await post(ctx, 'alice', { body: 'Just text' })).status === 201 && (await post(ctx, 'alice', { photos: photo('a.jpg') })).status === 201 && (await post(ctx, 'alice', { body: 'Rode one', review: '1', rating: '4' })).status === 201);
    const changed = await call(ctx, 'PATCH', `/api/social/posts/${p.json.post.id}`, { session: 's-alice', form: { body: 'Spotted it on Congress', vehicle_id: V2 } });
    check('changing the attached Cybercab', changed.json.post.vehicle.id === V2);
    const removed = await call(ctx, 'PATCH', `/api/social/posts/${p.json.post.id}`, { session: 's-alice', form: { body: 'Spotted it on Congress' } });
    check('removing it', removed.status === 200 && removed.json.post.vehicle === null);
    await call(ctx, 'PATCH', `/api/social/posts/${p.json.post.id}`, { session: 's-alice', form: { body: 'Spotted it on Congress', vehicle_id: V1 } });
    ctx.d1.exec(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = '${V1}'`);
    const after = (await call(ctx, 'GET', `/api/social/posts/${p.json.post.id}`)).json.post;
    check('a vehicle made private: the post stays, its card simply goes', !!after && after.vehicle === null && after.body === 'Spotted it on Congress');
    check('attaching is not a sighting: no submission or XP was created', count(ctx, `SELECT COUNT(*) AS n FROM submissions`) === subsBefore && xpRows(ctx) === 0);
  }

  console.log('2. Saved posts');
  {
    const ctx = await makeApp();
    const a = (await post(ctx, 'alice', { body: 'First' })).json.post;
    const b = (await post(ctx, 'bob', { body: 'Second' })).json.post;
    check('saving needs a session', (await call(ctx, 'PUT', `/api/social/posts/${a.id}/save`)).status === 401);
    const s1 = await call(ctx, 'PUT', `/api/social/posts/${a.id}/save`, { session: 's-bob' });
    const s2 = await call(ctx, 'PUT', `/api/social/posts/${a.id}/save`, { session: 's-bob' });
    check('save: idempotent, one row', s1.status === 200 && s2.status === 200 && count(ctx, `SELECT COUNT(*) AS n FROM social_saves WHERE user_id = 'bob'`) === 1);
    await call(ctx, 'PUT', `/api/social/posts/${b.id}/save`, { session: 's-bob' });
    const saved = await feed(ctx, 'filter=saved', 'bob');
    check('the Saved feed: the rider\'s bookmarks, most recently saved first, marked saved', saved.posts.length === 2 && saved.posts.every(p => p.saved));
    check('the feed shows whether a post is saved, for that rider only', (await feed(ctx, 'filter=latest', 'bob')).posts.every(p => p.saved) && (await feed(ctx, 'filter=latest', 'alice')).posts.every(p => !p.saved));
    check('Saved is private: another rider sees their own (empty) list, signed out is 401', (await feed(ctx, 'filter=saved', 'alice')).posts.length === 0 && (await call(ctx, 'GET', '/api/social/feed?filter=saved')).status === 401);
    check('saving notifies nobody and earns no XP', count(ctx, `SELECT COUNT(*) AS n FROM social_notifications`) === 0 && xpRows(ctx) === 0);
    await call(ctx, 'DELETE', `/api/social/posts/${b.id}/save`, { session: 's-bob' });
    check('unsave', (await feed(ctx, 'filter=saved', 'bob')).posts.map(p => p.id).join() === a.id);
    await call(ctx, 'PUT', `/api/social/posts/${b.id}/save`, { session: 's-bob' });
    await call(ctx, 'DELETE', `/api/social/posts/${b.id}`, { session: 's-mod', json: { reason: 'spam' } });
    check('a removed post drops out of Saved', (await feed(ctx, 'filter=saved', 'bob')).posts.map(p => p.id).join() === a.id);
    await call(ctx, 'DELETE', `/api/social/posts/${a.id}`, { session: 's-alice' });
    check('a deleted post: its saves are gone too', count(ctx, `SELECT COUNT(*) AS n FROM social_saves WHERE post_id = ?`, a.id) === 0 && (await feed(ctx, 'filter=saved', 'bob')).posts.length === 0);
    for (let i = 0; i < 4; i++) { const p = (await post(ctx, 'alice', { body: `Post ${i}` })).json.post; await call(ctx, 'PUT', `/api/social/posts/${p.id}/save`, { session: 's-carol' }); }
    const pg1 = await feed(ctx, 'filter=saved&limit=3', 'carol');
    const pg2 = await feed(ctx, `filter=saved&limit=3&cursor=${pg1.next_cursor}`, 'carol');
    check('Saved pages with a cursor, nothing twice', pg1.posts.length === 3 && pg2.posts.length === 1 && !pg1.posts.some(p => p.id === pg2.posts[0].id));
    const carolSaved = pg1.posts.concat(pg2.posts);
    for (const who of ['alice', 'bob', 'mod']) await call(ctx, 'PUT', `/api/social/posts/${carolSaved[3].id}/like`, { session: `s-${who}` });
    const popular = await feed(ctx, 'filter=saved&sort=popular&limit=3', 'carol');
    const popular2 = await feed(ctx, `filter=saved&sort=popular&limit=3&cursor=${popular.next_cursor}`, 'carol');
    check('Saved · Most popular: the most-liked saved post first, paged without repeats', popular.posts[0].id === carolSaved[3].id && popular.posts.length + popular2.posts.length === 4 && new Set(popular.posts.concat(popular2.posts).map(p => p.id)).size === 4);
    check('Latest ignores ?sort (it is newest-first by definition)', (await feed(ctx, 'filter=latest&sort=popular')).sort === 'new');
  }

  console.log('3. Notifications');
  {
    const ctx = await makeApp();
    const p = (await post(ctx, 'alice', { body: 'Saw two today' })).json.post;
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-alice' });   // her own
    const c1 = (await call(ctx, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-bob', json: { body: 'Where?' } })).json.comment;
    await call(ctx, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-alice', json: { body: 'Riverside', parent_id: c1.id } });
    let n = await notes(ctx, 'alice');
    check('the author hears about a like and a comment (not her own like or reply)', n.notifications.map(x => x.type).sort().join() === 'comment,like' && n.unread === 2);
    const like = n.notifications.find(x => x.type === 'like');
    check('each says who, what, when, and links to the post', like.actor.name === 'Bob B' && like.text === 'liked your post' && like.url === `/community?post=${p.id}` && !like.read && !!like.created_at);
    const com = n.notifications.find(x => x.type === 'comment');
    check('a comment notice links to the comment and quotes it', com.url === `/community?post=${p.id}&comment=${c1.id}` && com.excerpt === 'Where?');
    const bobN = await notes(ctx, 'bob');
    check('a reply notifies the person replied to', bobN.notifications.length === 1 && bobN.notifications[0].type === 'reply' && bobN.notifications[0].text === 'replied to your comment' && bobN.notifications[0].actor.name === 'Alice A');
    // Liking, unliking and liking again: still one notice.
    await call(ctx, 'DELETE', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    check('unliking takes back the unread like notice', !(await notes(ctx, 'alice')).notifications.some(x => x.type === 'like'));
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    await call(ctx, 'DELETE', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    check('no duplicates: one like notice however often it is toggled', count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE type = 'like'`) === 1);
    // Mentions.
    check('mention parsing: real @handles only, not emails, at most 5', mentionedHandles('hi @Bob_B and @alice_a, mail x@y.com @ab @bob_b').join() === 'bob_b,alice_a');
    const m = (await post(ctx, 'carol', { body: 'Thanks @bob_b and @nobody_here and @carol_secret' })).json.post;
    const bm = (await notes(ctx, 'bob')).notifications.find(x => x.type === 'mention');
    check('a mention notifies a real account; unknown handles and yourself are ignored', !!bm && bm.url === `/community?post=${m.id}` && count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE type = 'mention'`) === 1);
    check('a private author shows as Anonymous in the notice', bm.actor.anonymous === true && bm.actor.name === 'Anonymous' && !bm.actor.handle && !JSON.stringify(bm.actor).includes('Carol'));
    await call(ctx, 'PATCH', `/api/social/posts/${m.id}`, { session: 's-carol', form: { body: 'Thanks @bob_b again' } });
    check('editing does not repeat a mention notice', count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE type = 'mention'`) === 1);
    // Privacy and reading.
    check('notifications need a session and are only the rider\'s own', (await call(ctx, 'GET', '/api/social/notifications')).status === 401 && (await notes(ctx, 'mod')).notifications.length === 0);
    check('the unread count alone (for the bell)', (await call(ctx, 'GET', '/api/social/notifications?count_only=1', { session: 's-alice' })).json.unread === 2);
    const aliceIds = (await notes(ctx, 'alice')).notifications.map(x => x.id);
    await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-bob', json: { ids: aliceIds } });
    check('someone else cannot mark your notifications read', (await notes(ctx, 'alice')).unread === 2);
    await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-alice', json: { ids: [aliceIds[0]] } });
    n = await notes(ctx, 'alice');
    check('mark one read', n.unread === 1 && n.notifications.find(x => x.id === aliceIds[0]).read === true);
    await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-alice', json: { all: true } });
    check('mark all read', (await notes(ctx, 'alice')).unread === 0);
    // Gone with the content.
    await call(ctx, 'DELETE', `/api/social/comments/${c1.id}`, { session: 's-bob' });
    check('a deleted comment takes its notices (and its replies\') with it', !(await notes(ctx, 'alice')).notifications.some(x => x.type === 'comment') && !(await notes(ctx, 'bob')).notifications.some(x => x.type === 'reply'));
    await call(ctx, 'DELETE', `/api/social/posts/${m.id}`, { session: 's-mod', json: {} });
    check('a removed post\'s notices are no longer shown', !(await notes(ctx, 'bob')).notifications.some(x => x.type === 'mention'));
    await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-alice' });
    check('a deleted post leaves no notification rows', count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE post_id = ?`, p.id) === 0);
    // The announcement notice.
    ctx.d1.exec(`UPDATE social_notification_state SET announcement_read_at = '2026-01-01 00:00:00'`);   // an earlier "mark all read"
    const rowsBefore = count(ctx, `SELECT COUNT(*) AS n FROM social_notifications`);
    await call(ctx, 'PUT', '/api/moderation/social/announcement', { session: 's-mod', json: { body: 'Austin meetup Saturday', notify: true } });
    const ann = (await notes(ctx, 'bob')).notifications.find(x => x.type === 'announcement');
    check('an announcement with "notify" reaches everyone (no row per rider)', !!ann && !ann.read && ann.excerpt === 'Austin meetup Saturday' && count(ctx, `SELECT COUNT(*) AS n FROM social_notifications`) === rowsBefore);
    await call(ctx, 'POST', '/api/social/notifications/read', { session: 's-bob', json: { ids: ['announcement'] } });
    check('...read per rider', (await notes(ctx, 'bob')).notifications.find(x => x.type === 'announcement').read === true && (await notes(ctx, 'alice')).notifications.find(x => x.type === 'announcement').read === false);
    await call(ctx, 'PUT', '/api/moderation/social/announcement', { session: 's-mod', json: { body: 'Quiet update' } });
    check('an announcement without "notify" is not a notification', !(await notes(ctx, 'alice')).notifications.some(x => x.type === 'announcement'));
    check('notifications never award XP', xpRows(ctx) === 0);
  }

  console.log('4. Community pins');
  {
    const ctx = await makeApp();
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push((await post(ctx, i % 2 ? 'bob' : 'alice', { body: `Post ${i}` })).json.post);
    ps.forEach((p, i) => ctx.d1.exec(`UPDATE social_posts SET created_at = '2026-10-0${i + 1} 10:00:00' WHERE id = '${p.id}'`));
    check('only moderators pin', (await call(ctx, 'PUT', `/api/social/posts/${ps[0].id}/pin`, { session: 's-alice' })).status === 403 && (await call(ctx, 'PUT', `/api/social/posts/${ps[0].id}/pin`)).status === 401);
    for (const p of ps.slice(0, MAX_PINS)) await call(ctx, 'PUT', `/api/social/posts/${p.id}/pin`, { session: 's-mod' });
    const fourth = await call(ctx, 'PUT', `/api/social/posts/${ps[3].id}/pin`, { session: 's-mod' });
    check(`at most ${MAX_PINS} pins: a 4th is refused (409)`, fourth.status === 409 && fourth.json.error === 'too_many_pins');
    check('pinning is audited', count(ctx, `SELECT COUNT(*) AS n FROM social_mod_actions WHERE action = 'pin_post'`) === MAX_PINS);
    const latest = await feed(ctx, 'filter=latest&limit=10');
    check('pinned posts lead Latest, marked pinned', latest.posts.slice(0, 3).every(p => p.pinned) && latest.posts.slice(0, 3).map(p => p.id).sort().join() === ps.slice(0, 3).map(p => p.id).sort().join());
    check('...and are not repeated below', new Set(latest.posts.map(p => p.id)).size === latest.posts.length && latest.posts.length === 5);
    const pg1 = await feed(ctx, 'filter=latest&limit=1');
    const pg2 = await feed(ctx, `filter=latest&limit=1&cursor=${pg1.next_cursor}`);
    check('pins only on the first page; the regular order continues beneath them', pg1.posts.length === 4 && pg2.posts.length === 1 && !pg2.posts[0].pinned && pg2.posts[0].id === ps[3].id && pg1.posts[3].id === ps[4].id);
    check('For You also starts with the pins', (await feed(ctx, 'filter=foryou')).posts.slice(0, 3).every(p => p.pinned));
    check('Photos / Reviews / Saved are filters, not pinned lists', (await feed(ctx, 'filter=photos')).posts.length === 0);
    await call(ctx, 'DELETE', `/api/social/posts/${ps[0].id}/pin`, { session: 's-mod' });
    check('unpin', !(await feed(ctx, 'filter=latest')).posts.find(p => p.id === ps[0].id).pinned);
    await call(ctx, 'DELETE', `/api/social/posts/${ps[1].id}`, { session: 's-mod', json: { reason: 'spam' } });
    check('a removed post is unpinned and out of the feed', count(ctx, `SELECT pinned AS n FROM social_posts WHERE id = ?`, ps[1].id) === 0 && !(await feed(ctx, 'filter=latest')).posts.some(p => p.id === ps[1].id));
    check('moderators see can_pin; riders do not', (await feed(ctx, 'filter=latest', 'mod')).posts.every(p => p.can_pin) && (await feed(ctx, 'filter=latest', 'alice')).posts.every(p => !p.can_pin));
  }

  console.log('5. Filters and sorting');
  {
    const ctx = await makeApp();
    const plain = (await post(ctx, 'alice', { body: 'Plain' })).json.post;
    const pic = (await post(ctx, 'bob', { body: 'Pic', photos: photo('p.jpg') })).json.post;
    const rev = (await post(ctx, 'alice', { body: 'Review', review: '1', rating: '5' })).json.post;
    ctx.d1.exec(`UPDATE social_posts SET created_at = '2026-10-01 10:00:00' WHERE id = '${plain.id}'`);
    ctx.d1.exec(`UPDATE social_posts SET created_at = '2026-10-02 10:00:00' WHERE id = '${pic.id}'`);
    ctx.d1.exec(`UPDATE social_posts SET created_at = '2026-10-03 10:00:00' WHERE id = '${rev.id}'`);
    check('Latest: newest first', (await feed(ctx, 'filter=latest')).posts.map(p => p.id).join() === [rev.id, pic.id, plain.id].join());
    check('Photos: only posts with photos', (await feed(ctx, 'filter=photos')).posts.map(p => p.id).join() === pic.id);
    check('Reviews: only posts with a ride review', (await feed(ctx, 'filter=reviews')).posts.map(p => p.id).join() === rev.id);
    for (const who of ['bob', 'carol', 'mod']) await call(ctx, 'PUT', `/api/social/posts/${plain.id}/like`, { session: `s-${who}` });
    await call(ctx, 'POST', `/api/social/posts/${plain.id}/comments`, { session: 's-bob', json: { body: 'Nice' } });
    const pop = await post(ctx, 'bob', { body: 'Popular pic', photos: photo('q.jpg') });
    ctx.d1.exec(`UPDATE social_posts SET created_at = '2026-10-01 09:00:00' WHERE id = '${pop.json.post.id}'`);
    for (const who of ['alice', 'carol', 'mod']) await call(ctx, 'PUT', `/api/social/posts/${pop.json.post.id}/like`, { session: `s-${who}` });
    check('Photos · Newest vs Most popular: engagement outranks recency', (await feed(ctx, 'filter=photos&sort=new')).posts[0].id === pic.id && (await feed(ctx, 'filter=photos&sort=popular')).posts[0].id === pop.json.post.id);
    check('For You ranks real engagement (the liked, commented post first)', (await feed(ctx, 'filter=foryou')).posts[0].id === plain.id);
    const p1 = await feed(ctx, 'filter=foryou&limit=2');
    const p2 = await feed(ctx, `filter=foryou&limit=2&cursor=${p1.next_cursor}`);
    check('ranked pages continue without repeats', p1.posts.length === 2 && p2.posts.length === 2 && !p2.posts.some(x => p1.posts.some(y => y.id === x.id)));
  }

  console.log('6. Editing keeps attachments; deleting leaves nothing behind');
  {
    const ctx = await makeApp();
    const p = (await post(ctx, 'alice', { body: 'With everything', vehicle_id: V2, review: '1', rating: '4', photos: [photo('a.jpg'), photo('b.jpg')] })).json.post;
    const edited = await call(ctx, 'PATCH', `/api/social/posts/${p.id}`, { session: 's-alice', form: { body: 'Edited text', vehicle_id: V2, review: '1', rating: '4', keep_photos: p.photos.map(x => x.id) } });
    check('editing the text keeps the photos, vehicle and review the page sends back', edited.json.post.body === 'Edited text' && edited.json.post.photos.length === 2 && edited.json.post.vehicle.id === V2 && edited.json.post.review.rating === 4 && !!edited.json.post.edited_at);
    check('someone else cannot edit or delete it', (await call(ctx, 'PATCH', `/api/social/posts/${p.id}`, { session: 's-bob', form: { body: 'x' } })).status === 403 && (await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-bob' })).status === 403);
    const c = (await call(ctx, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-bob', json: { body: 'Cool @alice_a' } })).json.comment;
    await call(ctx, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-carol', json: { body: 'Agreed', parent_id: c.id } });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/save`, { session: 's-bob' });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/pin`, { session: 's-mod' });
    check('someone else cannot edit or delete a comment', (await call(ctx, 'PATCH', `/api/social/comments/${c.id}`, { session: 's-alice', json: { body: 'x' } })).status === 403 && (await call(ctx, 'DELETE', `/api/social/comments/${c.id}`, { session: 's-alice' })).status === 403);
    const del = await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-alice' });
    const left = ['social_comments', 'social_likes', 'social_saves', 'social_notifications', 'social_post_photos', 'social_post_reviews'].map(tb => count(ctx, `SELECT COUNT(*) AS n FROM ${tb} WHERE post_id = ?`, p.id));
    check('the author\'s delete removes comments, likes, saves, notifications, photos (and files) and the review', del.status === 200 && left.every(x => x === 0) && ![...ctx.env.EVIDENCE_BUCKET._objects.keys()].some(k => k.includes(p.id)));
    check('...the vehicle record itself is untouched; the audit log is kept', count(ctx, `SELECT COUNT(*) AS n FROM robotaxi_vehicles WHERE id = ?`, V2) === 1 && count(ctx, `SELECT COUNT(*) AS n FROM social_mod_actions WHERE target_id = ?`, p.id) === 1);
    const gone = await call(ctx, 'GET', `/api/social/posts/${p.id}`);
    check('its shared link now answers 404 post_unavailable (the page says so)', gone.status === 404 && gone.json.error === 'post_unavailable');
  }

  console.log('7. Link previews; account deletion; no XP');
  {
    const ctx = await makeApp();
    const p = (await post(ctx, 'alice', { body: 'Gold Cybercab at the "Domain" <b>today</b>', photos: photo('a.jpg') })).json.post;
    const m = socialMetaFor(p);
    check('a shared post\'s preview: who, the text (no quotes or tags), its photo, its link', m.title === 'Post by Alice A | Cybercab Hunter Community' && m.description === 'Gold Cybercab at the Domain btoday/b' && m.image === `https://cybercabhunter.com${p.photos[0].url}` && m.url === `https://cybercabhunter.com/community?post=${p.id}`);
    const anon = socialMetaFor({ ...p, author: { anonymous: true, name: 'Anonymous' }, photos: [], review: { rating: 5 } });
    check('an anonymous author is never named; no photo → the site image', anon.title === 'Ride review by a Cybercab Hunter | Cybercab Hunter Community' && /CybercabAnimation-poster/.test(anon.image));
    const page = await call(ctx, 'GET', `/community?post=${p.id}`);
    check('/community is served through the Worker (the page itself when no rewriter is available)', page.status === 200 && /<title>/.test(await page.r.text()));
    check('wrangler runs the Worker first for /community only', /"run_worker_first": \["\/community"\]/.test(read('wrangler.jsonc')));
    check('the page has default Open Graph tags for the rewriter to fill', ['og:title', 'og:description', 'og:image', 'og:url'].every(k => read('public/community.html').includes(`property="${k}"`)));
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/save`, { session: 's-bob' });
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    const bp = (await post(ctx, 'bob', { body: 'Bob post' })).json.post;
    await call(ctx, 'PUT', `/api/social/posts/${bp.id}/save`, { session: 's-alice' });
    await call(ctx, 'POST', `/api/social/posts/${bp.id}/comments`, { session: 's-alice', json: { body: 'hi @bob_b' } });
    const gone = await call(ctx, 'DELETE', '/api/account', { session: 's-bob', json: { confirm: 'DELETE' } });
    check('deleting an account clears their saves, their notifications and notices they caused, and saves of their posts',
      gone.status === 200 && count(ctx, `SELECT COUNT(*) AS n FROM social_saves WHERE user_id = 'bob' OR post_id = ?`, bp.id) === 0 && count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE user_id = 'bob' OR actor_user_id = 'bob'`) === 0);
    check('no XP from saves, likes, comments, pins or notifications', xpRows(ctx) === 0);
  }

  console.log('8. The page (jsdom)');
  {
    const ctx = await makeApp();
    const html = read('public/community.html');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(x => x.includes('VIEWS')).join('\n');
    async function open(session, url = 'https://cybercabhunter.com/community') {
      const dom = new JSDOM(html.replace(/<script src="https?:[^"]*"><\/script>/g, ''), { runScripts: 'outside-only', url, pretendToBeVisual: true });
      const w = dom.window;
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      if (!w.CSS) w.CSS = {};
      if (!w.CSS.escape) w.CSS.escape = v => String(v).replace(/["\\]/g, '\\$&');
      if (session) w.localStorage.setItem('teslaSessionId', session);
      const sent = [];
      w.fetch = async (u, opts = {}) => {
        const path = String(u).replace(/^https:\/\/[^/]+/, '');
        if (path.startsWith('/api/')) { sent.push({ path, opts }); return worker.fetch(new Request(`https://cybercabhunter.com${path}`, opts), ctx.env, {}); }
        return new Response('{}', { status: 404 });
      };
      w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/community.js')}\n${read('public/js/peek-rating.js')}\n${read('public/js/social.js')}\n${inline}`);
      await new Promise(r => setTimeout(r, 300));
      return { w, d: w.document, sent };
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const a = (await post(ctx, 'alice', { body: 'Pinned welcome post' })).json.post;
    await call(ctx, 'PUT', `/api/social/posts/${a.id}/pin`, { session: 's-mod' });
    const b = (await post(ctx, 'bob', { body: 'Hello @alice_a' })).json.post;
    const c = (await call(ctx, 'POST', `/api/social/posts/${a.id}/comments`, { session: 's-bob', json: { body: 'Welcome!' } })).json.comment;

    const anon = await open(null);
    check('signed out: no bell; Saved asks to sign in', anon.d.getElementById('socialBellWrap').classList.contains('hidden') && (anon.d.querySelector('[data-filter="saved"]').click(), await wait(100), !anon.d.getElementById('socialEmptySignIn').classList.contains('hidden')));
    anon.w.close();

    const p = await open('s-alice');
    const d = p.d;
    check('the filters are For You | Latest | Photos | Reviews | Saved', [...d.querySelectorAll('.social-filter[data-filter]')].map(x => x.textContent).join('|') === 'For You|Latest|Photos|Reviews|Saved');
    check('the pinned post leads the feed with a Pinned label', d.querySelector('#socialFeed .social-post').dataset.post === a.id && /Pinned/.test(d.querySelector('#socialFeed .social-post .social-pinned').textContent));
    check('post headers show the Spotter rank and level', /Gold Spotter/.test(d.querySelector(`[data-post="${a.id}"] .social-rank`).textContent) && /Lv \d+/.test(d.querySelector(`[data-post="${a.id}"] .social-level`).textContent));
    check('the bell shows the unread count (a comment and a mention)', !d.getElementById('socialBellWrap').classList.contains('hidden') && d.getElementById('socialBellCount').textContent === '2');
    d.getElementById('socialBell').click();
    await wait(150);
    const items = [...d.querySelectorAll('#socialNotifList [data-note]')];
    check('the panel lists who did what, unread first-class', items.length === 2 && items.some(x => /Bob B commented on your post/.test(x.textContent)) && items.some(x => /Bob B mentioned you/.test(x.textContent)) && items.every(x => x.classList.contains('is-unread')));
    const toComment = items.find(x => /commented/.test(x.textContent));
    toComment.click();
    await wait(250);
    check('opening a notification shows the post with that comment highlighted, and marks it read', new p.w.URL(p.w.location.href).searchParams.get('comment') === c.id && !!d.querySelector(`#socialSinglePost [data-comment="${c.id}"].is-highlight`) && count(ctx, `SELECT COUNT(*) AS n FROM social_notifications WHERE user_id = 'alice' AND read_at IS NOT NULL`) === 1);
    d.getElementById('socialBack').click();
    await wait(200);
    // Save from the card.
    d.querySelector(`#socialFeed [data-post="${b.id}"] [data-save]`).click();
    await wait(150);
    check('the bookmark saves the post (and shows it)', d.querySelector(`#socialFeed [data-post="${b.id}"] [data-save]`).getAttribute('aria-pressed') === 'true' && count(ctx, `SELECT COUNT(*) AS n FROM social_saves WHERE user_id = 'alice' AND post_id = ?`, b.id) === 1);
    d.querySelector('[data-filter="saved"]').click();
    await wait(150);
    check('the Saved filter lists it', [...d.querySelectorAll('#socialFeed [data-post]')].map(x => x.dataset.post).join() === b.id);
    d.querySelector(`#socialFeed [data-post="${b.id}"] [data-save]`).click();
    await wait(150);
    check('unsaving takes it off Saved, with the empty message', !d.querySelector('#socialFeed [data-post]') && /You haven't saved any posts yet\./.test(d.getElementById('socialEmptyText').textContent));
    d.querySelector('[data-filter="latest"]').click();
    await wait(150);
    // The Cybercab picker.
    d.querySelector('[data-attach="vehicle"]').click();
    const input = d.getElementById('socialVehicleSearch');
    input.value = '7sayGDEF5';
    input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    await wait(400);
    const opts = [...d.querySelectorAll('#socialVehicleResults [data-vi]')];
    check('typing a VIN finds the Cybercab (debounced search), showing plate, VIN and city', opts.length === 1 && /XVF-3582/.test(opts[0].textContent) && /7SAYGDEF5TA000123/.test(opts[0].textContent) && /Austin/.test(opts[0].textContent));
    input.value = 'nothing99';
    input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    await wait(400);
    check('no match: a helpful empty state', /No public Cybercab matches/.test(d.getElementById('socialVehicleResults').textContent));
    input.value = 'xvf-3582';
    input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
    await wait(400);
    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    check('Enter picks it: a preview card with Change and Remove', /XVF-3582/.test(d.getElementById('socialVehiclePreview').textContent) && !!d.querySelector('#socialVehiclePreview [data-vchange]') && d.getElementById('socialVehiclePicker').classList.contains('hidden'));
    d.getElementById('socialBody').value = 'At the Domain';
    d.getElementById('socialBody').dispatchEvent(new p.w.Event('input', { bubbles: true }));
    d.getElementById('socialComposer').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(300);
    const card = d.querySelector('#socialFeed .social-post:not(.is-pinned) .social-vcard');
    check('the published post shows the Cybercab card, linking to its vehicle page', !!card && card.getAttribute('href') === `/vehicle/${V1}` && /XVF-3582/.test(card.textContent));
    p.w.close();

    const shared = await open(null, `https://cybercabhunter.com/community?post=${a.id}`);
    check('a shared link opens Social on that post, with its comments, for anyone', shared.d.getElementById('communityTabSocial').getAttribute('aria-selected') === 'true' && !!shared.d.querySelector(`#socialSinglePost [data-post="${a.id}"]`) && /Welcome!/.test(shared.d.getElementById('socialSinglePost').textContent));
    shared.w.close();
    const deleted = await open(null, 'https://cybercabhunter.com/community?post=ffffffffffffffffffffffffffffffff');
    check('a deleted or unknown post says it is not available', /This post isn't available/.test(deleted.d.getElementById('socialSinglePost').textContent));
    deleted.w.close();
    check('Share uses the native share sheet where supported, copy link otherwise', /navigator\.share/.test(read('public/js/social.js')) && /clipboard\.writeText/.test(read('public/js/social.js')));
    check('the navigation is still Social | Streaks | Leaderboard | Progress, and there is no /social page', [...html.matchAll(/role="tab" data-view="([a-z]+)"/g)].map(m => m[1]).join('|') === 'social|streaks|leaderboard|progress' && !fs.existsSync(`${ROOT}public/social.html`));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
