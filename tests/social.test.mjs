// Community Social (worker/social.js, public/js/social.js, migrations/0044_social.sql).
//   1. existing reviews are copied into posts (ratings, text, dates, owners,
//      photos, likes, comments), nothing is lost, and re-running adds nothing
//   2. posts: text, photos (≤ 4, metadata stripped), optional ride review,
//      categories, links, linked registry vehicles; validation server-side
//   3. likes (one per rider, toggle), comments with one level of replies
//   4. ownership: only authors edit/delete; moderators remove (audited)
//   5. reports and the moderation queue; announcements
//   6. feeds: filters, sorting, cursor pagination; shareable single posts
//   7. no XP from any social action; privacy (Anonymous, no emails/ids)
//   8. rate limits; account deletion clears social data
//   9. the page: Social is the default section, then Streaks, Leaderboard, Progress
// Real SQL (every migration) + the REAL Worker router.
// Run: node tests/social.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedVehicle, approveVehicle } from './helpers/env.mjs';
import { createTestD1, fakeKV, fakeR2, seedUser } from './helpers/d1-sqlite.mjs';
import worker from '../worker/index.js';
import { postScore, LIMITS } from '../worker/social.js';

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

const USERS = ['alice', 'bob', 'carol', 'mod'];
async function makeApp() {
  const ctx = await makeEnv({ users: USERS });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:s-${u}`, JSON.stringify({ user_id: u }));
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 0, display_name = 'Carol Secret', handle = 'carol_secret' WHERE id = 'carol'`)._exec();
  ctx.d1.prepare(`UPDATE users SET role = 'moderator', leaderboard_opt_in = 1, display_name = 'Owner' WHERE id = 'mod'`)._exec();
  ctx.d1.prepare(`INSERT INTO user_xp (user_id, xp) VALUES ('alice', 950)`)._exec();
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'veh-1', plate: 'CYB001', model: 'Cybercab' }), { withRide: true, userId: 'alice' });
  seedVehicle(ctx.d1, { id: 'veh-private', plate: 'HIDDEN1' });
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
const xpRows = ctx => ctx.d1.query('SELECT COUNT(*) AS n FROM xp_ledger')[0].n;

async function run() {
  console.log('1. Existing reviews are copied into Social posts, losslessly and once');
  {
    // A database as it was before Social (through migration 0043), with reviews.
    const d1 = createTestD1({ migrateThrough: '0043_restore_previous_sightings_counters.sql' });
    for (const u of ['alice', 'bob']) seedUser(d1, u);
    seedVehicle(d1, { id: 'veh-1', plate: 'CYB001' });
    d1.exec(`INSERT INTO cybercab_reviews (id, user_id, robotaxi_vehicle_id, rating, body, created_at, updated_at) VALUES
      ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'alice', 'veh-1', 5, 'Smooth first ride!', '2026-09-01 10:00:00', '2026-09-02 09:00:00'),
      ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', 'bob', 'veh-1', 3, 'A bit slow to pick up.', '2026-09-05 12:00:00', '2026-09-05 12:00:00')`);
    d1.exec(`INSERT INTO cybercab_review_photos (id, review_id, position, r2_key, content_type) VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 0, 'reviews/alice/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1', 'image/jpeg')`);
    d1.exec(`INSERT INTO cybercab_review_likes (review_id, user_id) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'bob'), ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2', 'alice')`);
    d1.exec(`INSERT INTO cybercab_review_comments (id, review_id, user_id, body) VALUES ('ccccccccccccccccccccccccccccccc1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'bob', 'Nice!')`);
    const migration = read('migrations/0044_social.sql');
    d1.exec(migration);
    const posts = d1.query(`SELECT * FROM social_posts ORDER BY created_at`);
    check('every review became a post with the same id, author, text and dates', posts.length === 2 && posts[0].id === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' && posts[0].user_id === 'alice' && posts[0].body === 'Smooth first ride!' && posts[0].created_at === '2026-09-01 10:00:00' && posts[0].updated_at === '2026-09-02 09:00:00' && posts[0].legacy_review_id === posts[0].id && posts[0].category === 'review');
    check('ratings are attached reviews', d1.query(`SELECT rating FROM social_post_reviews ORDER BY post_id`).map(r => r.rating).join() === '5,3');
    check('photos point at the same stored files (no copies)', d1.query(`SELECT r2_key FROM social_post_photos`)[0].r2_key === 'reviews/alice/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1' && posts[0].has_photos === 1);
    check('likes and comments came across, and the counters match', posts[0].like_count === 1 && posts[0].comment_count === 1 && posts[1].like_count === 1 && posts[1].comment_count === 0 && posts.every(p => p.has_review === 1));
    check('the original review tables are untouched', d1.query(`SELECT COUNT(*) AS n FROM cybercab_reviews`)[0].n === 2 && d1.query(`SELECT COUNT(*) AS n FROM cybercab_review_likes`)[0].n === 2);
    // Re-running the copy statements (the end of the migration) adds nothing.
    d1.exec(migration.slice(migration.indexOf('-- ---- Existing reviews -> posts')));
    check('re-running the copy is a no-op: no duplicate posts, reviews, photos, likes or comments', ['social_posts', 'social_post_reviews', 'social_post_photos', 'social_likes', 'social_comments'].map(tb => d1.query(`SELECT COUNT(*) AS n FROM ${tb}`)[0].n).join() === '2,2,1,2,1' && d1.query(`SELECT like_count FROM social_posts WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'`)[0].like_count === 1);
  }

  const ctx = await makeApp();
  console.log('2. Posting');
  {
    check('signed out: cannot post', (await post(ctx, 'nobody', { body: 'hi' })).status === 401);
    const text = await post(ctx, 'alice', { body: 'Spotted a Cybercab downtown today! First time seeing one in person.' });
    check('a text-only post works (201), default category General, no review', text.status === 201 && text.json.post.category === 'general' && text.json.post.review === null && text.json.post.photos.length === 0);
    check('the author shows with Spotter rank and level from the existing XP system', text.json.post.author.name === 'Alice A' && text.json.post.author.rank && text.json.post.author.rank.name && Number.isInteger(text.json.post.author.level));
    check('it has a shareable link', text.json.post.url === `/community?post=${text.json.post.id}`);
    const withPhotos = await post(ctx, 'bob', { body: 'Two angles', category: 'sighting', vehicle_id: 'veh-1', photos: [photo('a.jpg'), photo('b.jpg')] });
    check('photos (2) attached, category Sighting, linked registry vehicle (verified)', withPhotos.status === 201 && withPhotos.json.post.photos.length === 2 && withPhotos.json.post.category === 'sighting' && withPhotos.json.post.vehicle && withPhotos.json.post.vehicle.verified === true && withPhotos.json.post.vehicle.license_plate === 'CYB001');
    const stored = ctx.d1.query(`SELECT r2_key FROM social_post_photos WHERE post_id = ?`, withPhotos.json.post.id);
    const bytes = await ctx.env.EVIDENCE_BUCKET.get ? null : null;
    check('photos stored under the author\'s folder (account deletion clears it)', stored.every(r => r.r2_key.startsWith(`social/bob/${withPhotos.json.post.id}/`)));
    const served = await call(ctx, 'GET', withPhotos.json.post.photos[0].url);
    const buf = Buffer.from(await served.r.arrayBuffer());
    check('a served photo has its location metadata stripped', served.status === 200 && !buf.includes(Buffer.from('GPSLatitude')));
    check('more than 4 photos is refused', (await post(ctx, 'bob', { body: 'too many', photos: [1, 2, 3, 4, 5].map(i => photo(`${i}.jpg`)) })).json.error === 'too_many_photos');
    check('a non-image file is refused', (await post(ctx, 'bob', { body: 'x', photos: new File([new Uint8Array([1, 2, 3, 4])], 'x.jpg', { type: 'image/jpeg' }) })).json.error === 'unsupported_file_type');
    check('over 2,000 characters is refused (server-side)', (await post(ctx, 'bob', { body: 'x'.repeat(2001) })).json.error === 'text_too_long');
    check('an empty post is refused', (await post(ctx, 'bob', { body: '   ' })).json.error === 'empty_post');
    check('a private (not public) vehicle cannot be linked', (await post(ctx, 'bob', { body: 'hidden car', vehicle_id: 'veh-private' })).json.error === 'unknown_vehicle');
    check('only http(s) links', (await post(ctx, 'bob', { body: 'link', link_url: 'javascript:alert(1)' })).json.error === 'invalid_link');
    check('an unknown category is refused', (await post(ctx, 'bob', { body: 'cat', category: 'ads' })).json.error === 'invalid_category');
    check('the same text again within a day is a duplicate', (await post(ctx, 'alice', { body: 'Spotted a Cybercab downtown today! First time seeing one in person.' })).status === 409);

    const rev = await post(ctx, 'alice', { body: 'Just took my first Cybercab ride! Pickup was quick.', review: '1', rating: '5', vehicle_type: 'cybercab', quoted_fare: '9.40', pickup_wait_minutes: '6', ride_date: '2026-10-10' });
    check('an optional ride review attaches to the post (5 stars, fare, wait, date, type)', rev.status === 201 && rev.json.post.review.rating === 5 && rev.json.post.review.quoted_fare === 9.4 && rev.json.post.review.pickup_wait_minutes === 6 && rev.json.post.review.ride_date === '2026-10-10' && rev.json.post.review.vehicle_type === 'cybercab' && rev.json.post.category === 'general');
    check('a review needs a 1-5 rating', (await post(ctx, 'alice', { body: 'r', review: '1', rating: '7' })).json.error === 'invalid_rating');
    check('review fields are validated (fare, wait, future date)', (await post(ctx, 'alice', { body: 'r1', review: '1', rating: '4', quoted_fare: '9999' })).json.error === 'invalid_fare' && (await post(ctx, 'alice', { body: 'r2', review: '1', rating: '4', pickup_wait_minutes: '500' })).json.error === 'invalid_wait' && (await post(ctx, 'alice', { body: 'r3', review: '1', rating: '4', ride_date: '2030-01-01' })).json.error === 'invalid_ride_date');
    ctx.rev = rev.json.post; ctx.text = text.json.post; ctx.photos = withPhotos.json.post;
  }

  console.log('3. Likes and comments');
  {
    const p = ctx.text.id;
    check('signed out: cannot like', (await call(ctx, 'PUT', `/api/social/posts/${p}/like`)).status === 401);
    const l1 = await call(ctx, 'PUT', `/api/social/posts/${p}/like`, { session: 's-bob' });
    const l2 = await call(ctx, 'PUT', `/api/social/posts/${p}/like`, { session: 's-bob' });
    check('one like per rider (liking twice still counts 1)', l1.json.like_count === 1 && l2.json.like_count === 1);
    const l3 = await call(ctx, 'DELETE', `/api/social/posts/${p}/like`, { session: 's-bob' });
    check('liking again removes it', l3.json.like_count === 0 && l3.json.liked === false);
    await call(ctx, 'PUT', `/api/social/posts/${p}/like`, { session: 's-carol' });
    const c1 = await call(ctx, 'POST', `/api/social/posts/${p}/comments`, { session: 's-bob', json: { body: 'Where exactly?' } });
    const r1 = await call(ctx, 'POST', `/api/social/posts/${p}/comments`, { session: 's-alice', json: { body: 'Near 6th St.', parent_id: c1.json.comment.id } });
    const r2 = await call(ctx, 'POST', `/api/social/posts/${p}/comments`, { session: 's-carol', json: { body: 'Reply to a reply', parent_id: r1.json.comment.id } });
    check('comments and replies; a reply to a reply joins the same thread (one level)', c1.status === 201 && r1.json.comment.parent_id === c1.json.comment.id && r2.json.comment.parent_id === c1.json.comment.id && r2.json.comment_count === 3);
    const list = await call(ctx, 'GET', `/api/social/posts/${p}/comments`);
    check('the thread reads back with replies under their comment (public)', list.status === 200 && list.json.comments.length === 1 && list.json.comments[0].replies.length === 2);
    check('a private commenter is Anonymous (no name or handle)', list.json.comments[0].replies.find(r => r.body === 'Reply to a reply').author.name === 'Anonymous' && !JSON.stringify(list.json).includes('carol_secret') && !JSON.stringify(list.json).includes('Carol Secret'));
    check('only the author edits a comment', (await call(ctx, 'PATCH', `/api/social/comments/${c1.json.comment.id}`, { session: 's-alice', json: { body: 'hacked' } })).status === 403 && (await call(ctx, 'PATCH', `/api/social/comments/${c1.json.comment.id}`, { session: 's-bob', json: { body: 'Where exactly? (edited)' } })).json.comment.edited_at);
    check('another rider cannot delete it', (await call(ctx, 'DELETE', `/api/social/comments/${r1.json.comment.id}`, { session: 's-bob' })).status === 403);
    const del = await call(ctx, 'DELETE', `/api/social/comments/${r1.json.comment.id}`, { session: 's-alice' });
    check('its author deletes it; the count follows', del.status === 200 && del.json.comment_count === 2);
    for (let i = 0; i < 12; i++) await call(ctx, 'POST', `/api/social/posts/${p}/comments`, { session: 's-mod', json: { body: `comment ${i}` } });
    const page1 = await call(ctx, 'GET', `/api/social/posts/${p}/comments`);
    const page2 = await call(ctx, 'GET', `/api/social/posts/${p}/comments?cursor=${encodeURIComponent(page1.json.next_cursor)}`);
    check('comments load a page at a time ("Load more comments")', page1.json.comments.length === 10 && !!page1.json.next_cursor && page2.json.comments.length === 3 && !page2.json.next_cursor);
  }

  console.log('4. Ownership, editing, deleting, moderator removal');
  {
    const p = ctx.photos;
    check('another rider cannot edit a post', (await call(ctx, 'PATCH', `/api/social/posts/${p.id}`, { session: 's-alice', form: { body: 'mine now' } })).status === 403);
    check('another rider cannot delete a post', (await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-alice' })).status === 403);
    const edited = await call(ctx, 'PATCH', `/api/social/posts/${p.id}`, { session: 's-bob', form: { body: 'Two angles (edited)', category: 'sighting', keep_photos: [p.photos[1].id], review: '1', rating: '4' } });
    check('the author edits text, drops a photo, adds a review; marked edited', edited.status === 200 && edited.json.post.body === 'Two angles (edited)' && edited.json.post.photos.length === 1 && edited.json.post.review.rating === 4 && !!edited.json.post.edited_at);
    const unlink = await call(ctx, 'PATCH', `/api/social/posts/${p.id}`, { session: 's-bob', form: { body: 'Two angles (edited)', category: 'sighting', keep_photos: [p.photos[1].id], remove_review: '1' } });
    check('...and can remove the review again', unlink.json.post.review === null && ctx.d1.query(`SELECT has_review FROM social_posts WHERE id = ?`, p.id)[0].has_review === 0);
    const before = (await ctx.env.EVIDENCE_BUCKET.list({ prefix: `social/bob/${p.id}/` })).objects.length;
    const del = await call(ctx, 'DELETE', `/api/social/posts/${p.id}`, { session: 's-bob' });
    const after = (await ctx.env.EVIDENCE_BUCKET.list({ prefix: `social/bob/${p.id}/` })).objects.length;
    check('the author deletes the post with its photos, comments, likes and review', del.status === 200 && before === 1 && after === 0 && ['social_posts', 'social_post_photos', 'social_comments', 'social_likes', 'social_post_reviews'].every(tb => ctx.d1.query(`SELECT COUNT(*) AS n FROM ${tb} WHERE ${tb === 'social_posts' ? 'id' : 'post_id'} = ?`, p.id)[0].n === 0));
    check('a deleted post\'s link says it is unavailable', (await call(ctx, 'GET', `/api/social/posts/${p.id}`)).json.error === 'post_unavailable');
    const removed = await call(ctx, 'DELETE', `/api/social/posts/${ctx.rev.id}`, { session: 's-mod', json: { reason: 'off topic' } });
    check('a moderator removes someone else\'s post (soft, audited)', removed.json.removed === true && ctx.d1.query(`SELECT status FROM social_posts WHERE id = ?`, ctx.rev.id)[0].status === 'removed' && ctx.d1.query(`SELECT COUNT(*) AS n FROM social_mod_actions WHERE action = 'remove_post' AND target_id = ?`, ctx.rev.id)[0].n === 1);
    check('a removed post is gone for the public, still visible to moderators', (await call(ctx, 'GET', `/api/social/posts/${ctx.rev.id}`)).status === 404 && (await call(ctx, 'GET', `/api/social/posts/${ctx.rev.id}`, { session: 's-mod' })).json.post.removed === true);
  }

  console.log('5. Reports and moderation');
  {
    const p = (await post(ctx, 'carol', { body: 'Buy cheap followers at example.com' })).json.post;
    check('signed out: cannot report', (await call(ctx, 'POST', '/api/social/reports', { json: { target_type: 'post', target_id: p.id, reason: 'spam' } })).status === 401);
    check('a rider cannot report their own post', (await call(ctx, 'POST', '/api/social/reports', { session: 's-carol', json: { target_type: 'post', target_id: p.id, reason: 'spam' } })).json.error === 'cannot_report_own');
    check('report reasons are a fixed list', (await call(ctx, 'POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: p.id, reason: 'boring' } })).json.error === 'invalid_reason');
    const rep = await call(ctx, 'POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: p.id, reason: 'spam', details: 'selling followers' } });
    await call(ctx, 'POST', '/api/social/reports', { session: 's-alice', json: { target_type: 'post', target_id: p.id, reason: 'off_topic' } });
    check('reported once per rider', rep.status === 201 && (await call(ctx, 'POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: p.id, reason: 'spam' } })).status === 409);
    check('the moderation queue is moderators only', (await call(ctx, 'GET', '/api/moderation/social/reports', { session: 's-bob' })).status === 403);
    const q = await call(ctx, 'GET', '/api/moderation/social/reports', { session: 's-mod' });
    const item = q.json.reports.find(r => r.target_id === p.id);
    check('moderators see the item, its report count, reasons and details, and who wrote it', item && item.report_count === 2 && item.reasons.includes('spam') && item.reasons.includes('off_topic') && item.details.some(d => d.details === 'selling followers') && item.author.handle === 'carol_secret' && item.target.body.includes('followers'));
    check('non-moderators cannot resolve', (await call(ctx, 'POST', '/api/moderation/social/resolve', { session: 's-bob', json: { target_type: 'post', target_id: p.id, action: 'remove' } })).status === 403);
    const res = await call(ctx, 'POST', '/api/moderation/social/resolve', { session: 's-mod', json: { target_type: 'post', target_id: p.id, action: 'remove', reason: 'spam' } });
    check('removing resolves every open report on it and records the action', res.json.status === 'removed' && ctx.d1.query(`SELECT COUNT(*) AS n FROM social_reports WHERE target_id = ? AND status = 'actioned'`, p.id)[0].n === 2);
    const q2 = await call(ctx, 'GET', '/api/moderation/social/reports', { session: 's-mod' });
    check('the queue is empty again', !q2.json.reports.some(r => r.target_id === p.id));
    // Repeat offenders: the author's removal count shows on the next report.
    const p2 = (await post(ctx, 'carol', { body: 'More spam here' })).json.post;
    await call(ctx, 'POST', '/api/social/reports', { session: 's-bob', json: { target_type: 'post', target_id: p2.id, reason: 'spam' } });
    const q3 = await call(ctx, 'GET', '/api/moderation/social/reports', { session: 's-mod' });
    check('repeat offenders: the author\'s earlier removals are shown', q3.json.reports.find(r => r.target_id === p2.id).author_history.removals === 1);
    const dis = await call(ctx, 'POST', '/api/moderation/social/resolve', { session: 's-mod', json: { target_type: 'post', target_id: p2.id, action: 'dismiss' } });
    check('dismissing keeps the post', dis.json.status === 'dismissed' && ctx.d1.query(`SELECT status FROM social_posts WHERE id = ?`, p2.id)[0].status === 'visible');
    // A comment report.
    const c = (await call(ctx, 'POST', `/api/social/posts/${ctx.text.id}/comments`, { session: 's-carol', json: { body: 'rude comment' } })).json.comment;
    await call(ctx, 'POST', '/api/social/reports', { session: 's-alice', json: { target_type: 'comment', target_id: c.id, reason: 'harassment' } });
    await call(ctx, 'POST', '/api/moderation/social/resolve', { session: 's-mod', json: { target_type: 'comment', target_id: c.id, action: 'remove' } });
    check('a moderator removes a reported comment', ctx.d1.query(`SELECT status FROM social_comments WHERE id = ?`, c.id)[0].status === 'removed');
    const ann = await call(ctx, 'PUT', '/api/moderation/social/announcement', { session: 's-mod', json: { body: 'Welcome to Community Social!' } });
    check('announcements: moderators only; shown in the sidebar', ann.status === 200 && (await call(ctx, 'PUT', '/api/moderation/social/announcement', { session: 's-bob', json: { body: 'x' } })).status === 403 && (await call(ctx, 'GET', '/api/social/sidebar')).json.announcement.body === 'Welcome to Community Social!');
  }

  console.log('6. Feeds, filters, sorting and pagination');
  {
    const extra = [];
    for (let i = 0; i < 14; i++) extra.push((await post(ctx, i % 2 ? 'alice' : 'bob', { body: `feed post ${i}`, ...(i % 3 === 0 ? { photos: photo(`p${i}.jpg`) } : {}), ...(i % 4 === 0 ? { review: '1', rating: String(1 + (i % 5)) } : {}) })).json.post);
    // Spread their times so ordering is deterministic.
    extra.forEach((p, i) => ctx.d1.prepare(`UPDATE social_posts SET created_at = datetime('now', ?) WHERE id = ?`).bind(`-${14 - i} minutes`, p.id)._exec());
    const seen = []; let cursor = null; let pages = 0;
    do {
      const r = await call(ctx, 'GET', `/api/social/feed?filter=latest&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.json.posts); cursor = r.json.next_cursor; pages++;
    } while (cursor && pages < 20);
    const visible = ctx.d1.query(`SELECT COUNT(*) AS n FROM social_posts WHERE status = 'visible'`)[0].n;
    check('Latest: every visible post once, newest first, across cursor pages', seen.length === visible && new Set(seen.map(p => p.id)).size === visible && seen.every((p, i) => i === 0 || seen[i - 1].created_at >= p.created_at));
    check('removed posts never appear in a feed', !seen.some(p => p.id === ctx.rev.id));
    const photosFeed = (await call(ctx, 'GET', '/api/social/feed?filter=photos&limit=25')).json.posts;
    check('Photos: only posts with a photo', photosFeed.length > 0 && photosFeed.every(p => p.photos.length > 0));
    const reviewsFeed = (await call(ctx, 'GET', '/api/social/feed?filter=reviews&limit=25')).json.posts;
    check('Reviews: only posts with a ride review', reviewsFeed.length > 0 && reviewsFeed.every(p => p.review));
    // Popular: engagement wins over recency within the window.
    const old = extra[0];
    for (const u of ['alice', 'carol', 'mod']) await call(ctx, 'PUT', `/api/social/posts/${old.id}/like`, { session: `s-${u}` });
    await call(ctx, 'POST', `/api/social/posts/${old.id}/comments`, { session: 's-mod', json: { body: 'great' } });
    const popular = (await call(ctx, 'GET', '/api/social/feed?filter=photos&sort=popular&limit=5')).json.posts;
    check('Most Popular puts the engaged post first', popular[0].id === old.id);
    const fy1 = await call(ctx, 'GET', '/api/social/feed?filter=foryou&limit=5');
    const fy2 = await call(ctx, 'GET', `/api/social/feed?filter=foryou&limit=5&cursor=${encodeURIComponent(fy1.json.next_cursor)}`);
    check('For You pages without repeats', fy1.json.posts.length === 5 && fy2.json.posts.length > 0 && !fy2.json.posts.some(p => fy1.json.posts.some(q => q.id === p.id)));
    const now = Date.now();
    check('the ranking decays with age: an old popular post loses to a fresh one eventually', postScore({ like_count: 20, comment_count: 5, created_at: new Date(now - 30 * 864e5).toISOString() }, now, 1.5) < postScore({ like_count: 1, comment_count: 0, created_at: new Date(now - 3600e3).toISOString() }, now, 1.5));
    const signedIn = (await call(ctx, 'GET', '/api/social/feed?filter=latest&limit=25', { session: 's-alice' })).json.posts;
    check('the feed marks the viewer\'s own posts and likes', signedIn.some(p => p.mine) && signedIn.find(p => p.id === old.id).liked === true);
    const anon = JSON.stringify((await call(ctx, 'GET', '/api/social/feed?filter=latest&limit=25')).json);
    check('no emails, user ids or private names in public responses', !/@example|"user_id"|carol_secret|Carol Secret|"alice"|"bob"/.test(anon));
    const single = await call(ctx, 'GET', `/api/social/posts/${old.id}`);
    check('a single post opens by its link', single.status === 200 && single.json.post.id === old.id);
    const side = (await call(ctx, 'GET', '/api/social/sidebar')).json;
    check('sidebar statistics come from real rows', side.stats.posts === visible && side.stats.contributors >= 2 && side.stats.posts_this_week === visible && side.trending.length > 0 && side.trending.every((x, i, a) => i === 0 || (a[i - 1].like_count + 2 * a[i - 1].comment_count) >= (x.like_count + 2 * x.comment_count)) && side.trending.some(x => x.id === old.id));
  }

  console.log('7. No XP from social actions');
  {
    const before = xpRows(ctx);
    const p = (await post(ctx, 'bob', { body: 'XP check post' })).json.post;
    await call(ctx, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-alice' });
    await call(ctx, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-alice', json: { body: 'xp?' } });
    check('posting, liking, commenting and receiving likes/comments award 0 XP', xpRows(ctx) === before && ctx.d1.query(`SELECT COUNT(*) AS n FROM xp_awards`)[0].n === 0);
    check('social.js never touches the XP tables', !/xp_ledger|xp_awards|INSERT INTO user_xp|UPDATE user_xp/.test(read('worker/social.js')));
  }

  console.log('8. Rate limits and account deletion');
  {
    const d = await makeApp();
    let last = null;
    for (let i = 0; i <= LIMITS.postsPerHour; i++) last = await post(d, 'bob', { body: `rate ${i}` });
    check(`more than ${LIMITS.postsPerHour} posts an hour: 429`, last.status === 429);
    const p = (await post(d, 'alice', { body: 'to be deleted with my account', photos: photo('x.jpg') })).json.post;
    await call(d, 'POST', `/api/social/posts/${p.id}/comments`, { session: 's-bob', json: { body: 'a comment by bob' } });
    await call(d, 'PUT', `/api/social/posts/${p.id}/like`, { session: 's-bob' });
    const res = await call(d, 'DELETE', '/api/account', { session: 's-alice', json: { confirm: 'DELETE' } });
    check('account deletion removes the rider\'s posts, everything under them, and their photos', res.status === 200 && d.d1.query(`SELECT COUNT(*) AS n FROM social_posts WHERE user_id = 'alice'`)[0].n === 0 && d.d1.query(`SELECT COUNT(*) AS n FROM social_comments WHERE post_id = ?`, p.id)[0].n === 0 && (await d.env.EVIDENCE_BUCKET.list({ prefix: 'social/alice/' })).objects.length === 0);
  }

  console.log('9. The Community page');
  {
    const html = read('public/community.html');
    const tabs = [...html.matchAll(/role="tab" data-view="([a-z]+)"[^>]*>([A-Z]+)</g)].map(m => `${m[1]}:${m[2]}`);
    check('the navigation is Social | Streaks | Leaderboard | Progress', tabs.join() === 'social:SOCIAL,streaks:STREAKS,leaderboard:LEADERBOARD,progress:PROGRESS');
    check('no Reviews tab remains', !/data-view="reviews"/.test(html) && !/>REVIEWS</.test(html));
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community' });
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.includes('VIEWS')).join('\n');
    dom.window.eval(inline);
    const d = dom.window.document;
    check('Social is the default section', d.getElementById('communityTabSocial').getAttribute('aria-selected') === 'true' && !d.getElementById('communityPanelSocial').classList.contains('hidden') && d.getElementById('communityPanelStreaks').classList.contains('hidden'));
    d.getElementById('communityTabStreaks').click();
    check('Streaks still opens without a reload, and the URL remembers it', !d.getElementById('communityPanelStreaks').classList.contains('hidden') && d.getElementById('communityPanelSocial').classList.contains('hidden') && dom.window.location.search === '?view=streaks');
    const dom2 = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community?view=reviews' });
    dom2.window.eval(inline);
    check('an old ?view=reviews link opens Social', dom2.window.document.getElementById('communityTabSocial').getAttribute('aria-selected') === 'true');
    check('the composer, filters and sidebar are on the page', ['socialComposer', 'socialFeed', 'socialSidebar'].every(id => d.getElementById(id)) && /What's happening in the Cybercab world\?/.test(html) && ['foryou', 'latest', 'photos', 'reviews'].every(f => html.includes(`data-filter="${f}"`)));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
