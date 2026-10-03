// Cybercab reviews on the Community page (worker/reviews.js, js/reviews.js,
// migrations/0023_cybercab_reviews.sql).
//   - one review per rider per vehicle; edit, not stack
//   - 1–5 stars, text ≤ 2000, photos ≤ 3 (a 4th is rejected), JPEG/PNG/WebP, 5 MB
//   - photos: EXIF/GPS stripped before storing, so never served; R2 layout
//   - a private account (Profile switch off) is "Anonymous" everywhere
//   - likes: one per rider, idempotent, toggleable; who liked is never served
//   - comments ≤ 500, counts match, own or moderator delete
//   - the aggregate is live and right; only public vehicles' reviews count
//   - ownership on every write; rate limiting; account deletion clears it all
//   - the page renders it (jsdom)
// Real SQL (every migration) + the REAL Worker router.
// Run: node tests/reviews.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck, seedVehicle, approveVehicle } from './helpers/env.mjs';
import worker from '../worker/index.js';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const enc = s => [...Buffer.from(s, 'latin1')];
const be16 = n => [(n >> 8) & 255, n & 255];
const le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const le24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, 'latin1'));

// Small valid images with GPS metadata to strip.
function jpeg() {
  const seg = (m, body) => [0xff, m, ...be16(body.length + 2), ...body];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, enc('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...seg(0xe1, enc('Exif\0\0MM\0*GPSLatitude 30.2672 GPSLongitude -97.7431')),
    ...seg(0xfe, enc('taken at home')),
    ...seg(0xc0, [8, ...be16(64), ...be16(64), 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34, 0x56, 0xff, 0xd9
  ]);
}
function webp() {
  const chunk = (name, body) => [...enc(name), ...le32(body.length), ...body, ...(body.length % 2 ? [0] : [])];
  const chunks = [...chunk('VP8X', [0x08, 0, 0, 0, ...le24(63), ...le24(63)]), ...chunk('VP8 ', [1, 2, 3, 4, 5, 6]), ...chunk('EXIF', enc('MM\0*GPSLatitude 30.2672'))];
  return Uint8Array.from([...enc('RIFF'), ...le32(4 + chunks.length), ...enc('WEBP'), ...chunks]);
}

const USERS = ['alice', 'bob', 'carol', 'mod'];
async function makeApp() {
  const ctx = await makeEnv({ users: USERS });
  ctx.env.ASSETS = { fetch: async () => new Response('asset') };
  for (const u of USERS) await ctx.env.TESLA_SESSIONS.put(`session:session-${u}`, JSON.stringify({ user_id: u }));
  // alice and bob are public; carol has turned the Profile switch off (private).
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Alice A', handle = 'alice_a' WHERE id = 'alice'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1, display_name = 'Bob B', handle = 'bob_b' WHERE id = 'bob'`)._exec();
  ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 0, display_name = 'Carol Secret', handle = 'carol_secret', avatar_url = '/api/avatars/0123456789abcdef0123456789abcdef' WHERE id = 'carol'`)._exec();
  ctx.d1.prepare(`UPDATE users SET role = 'moderator', leaderboard_opt_in = 1, display_name = 'Owner' WHERE id = 'mod'`)._exec();
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'veh-1', plate: 'CYB001' }), { withRide: true, userId: 'alice' });
  approveVehicle(ctx.d1, seedVehicle(ctx.d1, { id: 'veh-2', plate: 'CYB002' }), { withRide: true, userId: 'alice' });
  seedVehicle(ctx.d1, { id: 'veh-private', plate: 'HIDDEN1' });   // not public
  return ctx;
}
const auth = u => (u ? { Authorization: `Bearer session-${u}` } : {});
async function call(ctx, method, path, { user, body, json } = {}) {
  const headers = { ...auth(user), ...(json ? { 'Content-Type': 'application/json' } : {}) };
  const r = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: json ? JSON.stringify(json) : body }), ctx.env, {});
  let data = null; try { data = await r.clone().json(); } catch (e) { /* not json */ }
  return { status: r.status, data, r };
}
function form({ vehicle = 'veh-1', rating = 5, text = 'Smooth, quiet ride.', photos = [], keep = [] } = {}) {
  const fd = new FormData();
  if (vehicle != null) fd.append('vehicle_id', vehicle);
  if (rating != null) fd.append('rating', String(rating));
  if (text != null) fd.append('body', text);
  photos.forEach((p, i) => fd.append('photos', new File([p], `p${i}`)));
  keep.forEach(id => fd.append('keep_photos', id));
  return fd;
}
const post = (ctx, user, o) => call(ctx, 'POST', '/api/reviews', { user, body: form(o) });
const list = async (ctx, user, qs = '') => (await call(ctx, 'GET', `/api/reviews${qs}`, { user })).data;
const count = (ctx, sql, ...a) => ctx.d1.query(sql, ...a)[0].n;

async function run() {
  console.log('1. Leaving a review: one per rider per vehicle');
  {
    const ctx = await makeApp();
    check('signed out: 401', (await post(ctx, null, {})).status === 401);
    const first = await post(ctx, 'alice', { rating: 5 });
    check('a review is created and visible at once (201)', first.status === 201 && first.data.review.rating === 5 && first.data.review.mine === true);
    const again = await post(ctx, 'alice', { rating: 1, text: 'second try' });
    check('a second review of the same Cybercab: 409 already_reviewed, pointing at the first', again.status === 409 && again.data.error === 'already_reviewed' && again.data.review_id === first.data.review.id);
    let dbRejects = false;
    try { ctx.d1.prepare(`INSERT INTO cybercab_reviews (id, user_id, robotaxi_vehicle_id, rating, body) VALUES ('x', 'alice', 'veh-1', 3, 'dup')`)._exec(); } catch (e) { dbRejects = true; }
    check('...and the database itself refuses a duplicate (unique index)', dbRejects && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_reviews WHERE user_id = 'alice'`) === 1);
    check('the same rider can review a DIFFERENT Cybercab', (await post(ctx, 'alice', { vehicle: 'veh-2', rating: 3 })).status === 201);
    check('another rider can review the same Cybercab', (await post(ctx, 'bob', { rating: 4 })).status === 201);

    check('rating 0 / 6 / missing: 400 invalid_rating', (await post(ctx, 'carol', { rating: 0 })).data.error === 'invalid_rating' && (await post(ctx, 'carol', { rating: 6 })).data.error === 'invalid_rating' && (await post(ctx, 'carol', { rating: null })).data.error === 'invalid_rating');
    check('empty text: 400 missing_text', (await post(ctx, 'carol', { text: '   ' })).data.error === 'missing_text');
    check('2000 characters is fine; 2001 is 400 text_too_long', (await post(ctx, 'carol', { vehicle: 'veh-2', text: 'x'.repeat(2000) })).status === 201 && (await post(ctx, 'carol', { text: 'x'.repeat(2001) })).data.error === 'text_too_long');
    check('a vehicle that is not public (or unknown): 400 unknown_vehicle', (await post(ctx, 'carol', { vehicle: 'veh-private' })).data.error === 'unknown_vehicle' && (await post(ctx, 'carol', { vehicle: 'nope' })).data.error === 'unknown_vehicle');
  }

  console.log('2. Photos: at most 3, image types only, metadata stripped');
  {
    const ctx = await makeApp();
    const four = await post(ctx, 'alice', { photos: [jpeg(), jpeg(), webp(), jpeg()] });
    check('a 4th photo is rejected (400 too_many_photos) and nothing is created', four.status === 400 && four.data.error === 'too_many_photos' && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_reviews`) === 0);
    check('a non-image is rejected', (await post(ctx, 'alice', { photos: [Uint8Array.from(enc('<svg>hi</svg>'))] })).data.error === 'unsupported_file_type');
    const big = new Uint8Array(5 * 1024 * 1024 + 1); big.set(jpeg());
    check('a photo over 5 MB: 413 file_too_large', (await post(ctx, 'alice', { photos: [big] })).status === 413);
    const three = await post(ctx, 'alice', { photos: [jpeg(), webp(), jpeg()] });
    const review = three.data.review;
    check('3 photos are fine', three.status === 201 && review.photos.length === 3);
    const keys = [...ctx.env.EVIDENCE_BUCKET._objects.keys()].filter(k => k.startsWith('reviews/'));
    check('R2 layout: reviews/<rider>/<review>/<photo>, one object per photo', keys.length === 3 && keys.every(k => new RegExp(`^reviews/alice/${review.id}/[a-f0-9]{32}$`).test(k)));
    const stored = keys.map(k => ctx.env.EVIDENCE_BUCKET._objects.get(k));
    check('EXIF / GPS / comments are stripped before storing', stored.every(b => !has(b, 'Exif') && !has(b, 'GPS') && !has(b, 'taken at home') && !has(b, 'EXIF')));
    const served = await call(ctx, 'GET', review.photos[0].url);
    const servedBytes = new Uint8Array(await served.r.arrayBuffer());
    check('a served photo has no metadata and the right type', served.status === 200 && served.r.headers.get('Content-Type') === 'image/jpeg' && !has(servedBytes, 'GPS') && servedBytes[0] === 0xff);
    check('photo URLs carry a random id, never the rider or the R2 key', review.photos.every(p => /^\/api\/review-photos\/[a-f0-9]{32}$/.test(p.url)));

    // Edit: keep 2, add 1 is fine; keep 3 + add 1 is not.
    const keepIds = review.photos.slice(0, 2).map(p => p.id);
    const patch = fd => call(ctx, 'PATCH', `/api/reviews/${review.id}`, { user: 'alice', body: fd });
    check('editing: keep 3 + add 1 → too_many_photos', (await patch(form({ vehicle: null, keep: review.photos.map(p => p.id), photos: [jpeg()] }))).data.error === 'too_many_photos');
    const edited = await patch(form({ vehicle: null, rating: 4, text: 'Updated.', keep: keepIds, photos: [webp()] }));
    const left = [...ctx.env.EVIDENCE_BUCKET._objects.keys()].filter(k => k.startsWith('reviews/'));
    check('editing: keep 2 + add 1 → 3 photos, the dropped one deleted from R2', edited.status === 200 && edited.data.review.photos.length === 3 && edited.data.review.rating === 4 && edited.data.review.body === 'Updated.' && left.length === 3 && edited.data.review.photos.slice(0, 2).map(p => p.id).join() === keepIds.join());

    ctx.d1.prepare(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = 'veh-1'`)._exec();
    check('a photo is not served once its vehicle is no longer public', (await call(ctx, 'GET', review.photos[0].url)).status === 404);
  }

  console.log('3. Privacy: a private account is "Anonymous" everywhere');
  {
    const ctx = await makeApp();
    const carol = (await post(ctx, 'carol', { rating: 2, text: 'Bumpy.' })).data.review;
    const alice = (await post(ctx, 'alice', { rating: 5 })).data.review;
    await call(ctx, 'POST', `/api/reviews/${alice.id}/comments`, { user: 'carol', json: { body: 'Agreed!' } });
    await call(ctx, 'PUT', `/api/reviews/${alice.id}/like`, { user: 'carol' });
    const pub = await list(ctx, null);
    const theirs = pub.reviews.find(r => r.id === carol.id);
    check('their review: "Anonymous", no handle, no photo', theirs.author.name === 'Anonymous' && theirs.author.handle === null && theirs.author.avatar_url === null && theirs.author.anonymous === true);
    check('a public author is shown by name, handle and link', pub.reviews.find(r => r.id === alice.id).author.name === 'Alice A' && pub.reviews.find(r => r.id === alice.id).author.handle === 'alice_a');
    const comments = (await call(ctx, 'GET', `/api/reviews/${alice.id}/comments`)).data;
    check('their comment: "Anonymous" too', comments.comments[0].author.name === 'Anonymous' && comments.comments[0].author.handle === null);
    const everything = JSON.stringify([pub, comments, await list(ctx, 'alice'), await list(ctx, 'bob', '?sort=likes')]);
    check('nothing identifying leaks: no name, handle, avatar or user id of the private rider, in any response', !/Carol Secret|carol_secret|0123456789abcdef0123456789abcdef|"carol"/.test(everything));
    check('no user id of anyone is ever sent, and who liked is never listed', !/"user_id"|"alice"|"bob"|likers|liked_by"/.test(everything));
    const herOwn = (await list(ctx, 'carol')).reviews.find(r => r.id === carol.id);
    check('the private rider still sees the review as theirs (mine), still Anonymous', herOwn.mine === true && herOwn.author.name === 'Anonymous');
    ctx.d1.prepare(`UPDATE users SET leaderboard_opt_in = 1 WHERE id = 'carol'`)._exec();
    check('turning the switch back on shows them again (the existing setting, read live)', (await list(ctx, null)).reviews.find(r => r.id === carol.id).author.name === 'Carol Secret');
  }

  console.log('4. Likes: one per rider, idempotent, toggleable');
  {
    const ctx = await makeApp();
    const r = (await post(ctx, 'alice', {})).data.review;
    const like = u => call(ctx, 'PUT', `/api/reviews/${r.id}/like`, { user: u });
    const unlike = u => call(ctx, 'DELETE', `/api/reviews/${r.id}/like`, { user: u });
    check('signed out: 401', (await like(null)).status === 401);
    const a = await like('bob'); const b = await like('bob');
    check('liking twice is still one like', a.data.like_count === 1 && b.data.like_count === 1 && b.data.liked === true && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_likes`) === 1);
    await like('carol');
    check('the card shows the live count, and "liked" for the viewer only', (await list(ctx, 'bob')).reviews[0].like_count === 2 && (await list(ctx, 'bob')).reviews[0].liked === true && (await list(ctx, 'alice')).reviews[0].liked === false && (await list(ctx, null)).reviews[0].liked === false);
    const u1 = await unlike('bob'); const u2 = await unlike('bob');
    check('unliking twice is fine and leaves the other like', u1.data.like_count === 1 && u2.data.like_count === 1 && u2.data.liked === false);
    check('liking an unknown review: 404', (await call(ctx, 'PUT', '/api/reviews/ffffffffffffffffffffffffffffffff/like', { user: 'bob' })).status === 404);
  }

  console.log('5. Comments: counts match; own or moderator delete');
  {
    const ctx = await makeApp();
    const r = (await post(ctx, 'alice', {})).data.review;
    const add = (u, body) => call(ctx, 'POST', `/api/reviews/${r.id}/comments`, { user: u, json: { body } });
    check('signed out: 401', (await add(null, 'hi')).status === 401);
    check('empty: 400; 501 chars: 400; 500 chars: fine', (await add('bob', ' ')).status === 400 && (await add('bob', 'x'.repeat(501))).data.error === 'text_too_long' && (await add('bob', 'x'.repeat(500))).status === 201);
    const c2 = (await add('carol', 'Nice')).data;
    const c3 = (await add('bob', 'Same here')).data;
    const shown = (await list(ctx, null)).reviews[0].comment_count;
    const thread = (await call(ctx, 'GET', `/api/reviews/${r.id}/comments`)).data;
    check('the card count matches the thread (3), oldest first', shown === 3 && thread.comment_count === 3 && thread.comments.length === 3 && thread.comments[1].body === 'Nice' && c3.comment_count === 3);
    check('deleting someone else\'s comment: 403', (await call(ctx, 'DELETE', `/api/review-comments/${c2.comment.id}`, { user: 'bob' })).status === 403);
    check('the review\'s author can\'t delete others\' comments either', (await call(ctx, 'DELETE', `/api/review-comments/${c2.comment.id}`, { user: 'alice' })).status === 403);
    const own = await call(ctx, 'DELETE', `/api/review-comments/${c3.comment.id}`, { user: 'bob' });
    const mod = await call(ctx, 'DELETE', `/api/review-comments/${c2.comment.id}`, { user: 'mod' });
    check('own delete and moderator (owner) delete both work; the count follows', own.status === 200 && mod.status === 200 && mod.data.comment_count === 1 && (await list(ctx, null)).reviews[0].comment_count === 1);
    const forBob = (await call(ctx, 'GET', `/api/reviews/${r.id}/comments`, { user: 'bob' })).data.comments[0];
    check('can_delete is offered only to the author or a moderator', forBob.can_delete === true && (await call(ctx, 'GET', `/api/reviews/${r.id}/comments`, { user: 'carol' })).data.comments[0].can_delete === false && (await call(ctx, 'GET', `/api/reviews/${r.id}/comments`, { user: 'mod' })).data.comments[0].can_delete === true);
  }

  console.log('6. The aggregate and the sort orders');
  {
    const ctx = await makeApp();
    check('no reviews: count 0, average null (never a made-up number)', (await list(ctx, null)).summary.count === 0 && (await list(ctx, null)).summary.average === null);
    const a = (await post(ctx, 'alice', { rating: 5 })).data.review;
    const b = (await post(ctx, 'bob', { rating: 4 })).data.review;
    const c = (await post(ctx, 'carol', { rating: 2 })).data.review;
    const s = (await list(ctx, null)).summary;
    check('5, 4, 2 → average 3.7 over 3 reviews', s.count === 3 && s.average === 3.7);
    check('...and the breakdown: one 5★, one 4★, one 2★, none else', JSON.stringify(s.distribution) === JSON.stringify({ 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 }));
    await call(ctx, 'PUT', `/api/reviews/${c.id}/like`, { user: 'alice' });
    await call(ctx, 'PUT', `/api/reviews/${c.id}/like`, { user: 'bob' });
    await call(ctx, 'PUT', `/api/reviews/${b.id}/like`, { user: 'alice' });
    const order = async sort => (await list(ctx, null, `?sort=${sort}`)).reviews.map(r => r.id).join();
    ctx.d1.prepare(`UPDATE cybercab_reviews SET created_at = '2026-09-01 10:00:00' WHERE id = ?`).bind(a.id)._exec();
    ctx.d1.prepare(`UPDATE cybercab_reviews SET created_at = '2026-09-02 10:00:00' WHERE id = ?`).bind(b.id)._exec();
    ctx.d1.prepare(`UPDATE cybercab_reviews SET created_at = '2026-09-03 10:00:00' WHERE id = ?`).bind(c.id)._exec();
    check('Most recent', await order('recent') === [c.id, b.id, a.id].join());
    check('Highest rated', await order('rating') === [a.id, b.id, c.id].join());
    check('Most liked', await order('likes') === [c.id, b.id, a.id].join());
    ctx.d1.prepare(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = 'veh-1'`)._exec();
    approveVehicle(ctx.d1, 'veh-1');
    await post(ctx, 'alice', { vehicle: 'veh-2', rating: 1 });
    ctx.d1.prepare(`UPDATE robotaxi_vehicles SET visibility = 'private' WHERE id = 'veh-2'`)._exec();
    const after = (await list(ctx, null)).summary;
    check('a review of a vehicle that is no longer public drops out of the list AND the aggregate', after.count === 3 && after.average === 3.7 && (await list(ctx, null)).reviews.length === 3);
  }

  console.log('7. Ownership on every write');
  {
    const ctx = await makeApp();
    const r = (await post(ctx, 'alice', { photos: [jpeg()] })).data.review;
    const patch = u => call(ctx, 'PATCH', `/api/reviews/${r.id}`, { user: u, body: form({ vehicle: null, rating: 1, text: 'hijacked' }) });
    check('editing someone else\'s review: 403 (even a moderator — authors edit their own)', (await patch('bob')).status === 403 && (await patch('mod')).status === 403 && (await list(ctx, null)).reviews[0].body !== 'hijacked');
    check('editing signed out: 401', (await patch(null)).status === 401);
    check('deleting someone else\'s review: 403', (await call(ctx, 'DELETE', `/api/reviews/${r.id}`, { user: 'bob' })).status === 403);
    check('can_delete / mine as each viewer sees it', (await list(ctx, 'alice')).reviews[0].can_delete === true && (await list(ctx, 'bob')).reviews[0].can_delete === false && (await list(ctx, 'mod')).reviews[0].can_delete === true && (await list(ctx, 'mod')).reviews[0].mine === false);
    await call(ctx, 'PUT', `/api/reviews/${r.id}/like`, { user: 'bob' });
    await call(ctx, 'POST', `/api/reviews/${r.id}/comments`, { user: 'bob', json: { body: 'x' } });
    const del = await call(ctx, 'DELETE', `/api/reviews/${r.id}`, { user: 'mod' });
    check('the owner (moderator) can delete any review: it, its photos, likes and comments are gone', del.status === 200 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_reviews`) === 0 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_likes`) === 0 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_comments`) === 0 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_photos`) === 0 && ![...ctx.env.EVIDENCE_BUCKET._objects.keys()].some(k => k.startsWith('reviews/')));
    const mine = (await post(ctx, 'bob', {})).data.review;
    check('an author can delete their own review', (await call(ctx, 'DELETE', `/api/reviews/${mine.id}`, { user: 'bob' })).status === 200);
  }

  console.log('8. Rate limiting and account deletion');
  {
    const ctx = await makeApp();
    let calls = 0;
    ctx.env.REVIEWS_LIMITER = { limit: async ({ key }) => { calls += 1; return { success: calls <= 2 && /^reviews:[a-f0-9]{64}$/.test(key) }; } };
    const r = (await post(ctx, 'alice', {})).data.review;
    await call(ctx, 'PUT', `/api/reviews/${r.id}/like`, { user: 'bob' });
    const third = await call(ctx, 'POST', `/api/reviews/${r.id}/comments`, { user: 'bob', json: { body: 'spam' } });
    check('writes past the limit: 429 rate_limited (keyed by a hash, not the user id)', third.status === 429 && third.data.error === 'rate_limited' && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_comments`) === 0);
    ctx.env.REVIEWS_LIMITER = { limit: async () => { throw new Error('down'); } };
    check('a limiter outage fails open', (await call(ctx, 'POST', `/api/reviews/${r.id}/comments`, { user: 'bob', json: { body: 'ok' } })).status === 201);
    delete ctx.env.REVIEWS_LIMITER;

    const withPhoto = (await post(ctx, 'carol', { photos: [webp()] })).data.review;
    await call(ctx, 'PUT', `/api/reviews/${withPhoto.id}/like`, { user: 'alice' });
    await call(ctx, 'POST', `/api/reviews/${withPhoto.id}/comments`, { user: 'alice', json: { body: 'nice' } });
    await call(ctx, 'PUT', `/api/reviews/${r.id}/like`, { user: 'carol' });
    await call(ctx, 'POST', `/api/reviews/${r.id}/comments`, { user: 'carol', json: { body: 'mine' } });
    const gone = await call(ctx, 'DELETE', '/api/account', { user: 'carol', json: { confirm: 'DELETE' } });
    check('deleting an account removes their reviews (with others\' likes/comments on them), their likes and comments, and their review photos',
      gone.status === 200 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_reviews WHERE user_id = 'carol'`) === 0
      && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_likes WHERE user_id = 'carol' OR review_id = ?`, withPhoto.id) === 0
      && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_comments WHERE user_id = 'carol' OR review_id = ?`, withPhoto.id) === 0
      && ![...ctx.env.EVIDENCE_BUCKET._objects.keys()].some(k => k.startsWith('reviews/carol/')));
    check('...and leaves everyone else\'s alone', count(ctx, `SELECT COUNT(*) AS n FROM cybercab_reviews WHERE user_id = 'alice'`) === 1 && count(ctx, `SELECT COUNT(*) AS n FROM cybercab_review_comments WHERE user_id = 'bob'`) === 1);
  }

  console.log('9. The page (jsdom)');
  {
    const ctx = await makeApp();
    const a = (await post(ctx, 'alice', { rating: 5, text: 'Great <b>ride</b>', photos: [jpeg()] })).data.review;
    const c = (await post(ctx, 'carol', { rating: 3, text: 'Fine.' })).data.review;
    await call(ctx, 'PUT', `/api/reviews/${a.id}/like`, { user: 'bob' });
    ctx.d1.prepare(`UPDATE cybercab_reviews SET created_at = '2026-09-01 10:00:00', updated_at = '2026-09-01 10:00:00' WHERE id = ?`).bind(a.id)._exec();
    ctx.d1.prepare(`UPDATE cybercab_reviews SET created_at = '2026-09-02 10:00:00', updated_at = '2026-09-02 10:00:00' WHERE id = ?`).bind(c.id)._exec();
    async function open(session) {
      const html = read('public/community.html').replace(/<script src="https?:[^"]*"><\/script>/g, '');
      const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/community', pretendToBeVisual: true });
      const w = dom.window;
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      if (session) w.localStorage.setItem('teslaSessionId', session);
      w.fetch = async (url, opts = {}) => {
        const u = String(url).replace(/^https:\/\/[^/]+/, '');   // main.js calls the Worker by its full URL
        if (u.startsWith('/api/')) return worker.fetch(new Request(`https://x${u}`, opts), ctx.env, {});
        return new Response('{}', { status: 404 });
      };
      w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\nCCC.init();\n${read('public/js/community.js')}\n${read('public/js/reviews.js')}`);
      await new Promise(r => setTimeout(r, 200));
      return { w, d: w.document, text: id => w.document.getElementById(id).textContent.replace(/\s+/g, ' ').trim() };
    }
    const p = await open(null);
    const cards = [...p.d.querySelectorAll('#reviewList [data-review]')];
    check('the aggregate is the server\'s: 4.0 over 2 reviews', p.text('reviewAverage') === '4.0' && p.text('reviewCount') === '2 reviews');
    check('both reviews render, newest first, with stars, like and comment counts', cards.length === 2 && cards[1].querySelector('[role="img"]').getAttribute('aria-label') === '5 out of 5 stars' && cards[1].querySelector('[data-like-count]').textContent === '1' && cards[1].querySelector('[data-comment-count]').textContent === '0');
    check('the private rider\'s card says Anonymous with the default avatar', /Anonymous/.test(cards[0].textContent) && !cards[0].querySelector('[data-avatar-name]'));
    const bar = n => p.d.querySelector(`#reviewBreakdown [data-stars="${n}"]`);
    check('the breakdown: 5★ and 3★ at 50% each, counts beside them, the rest empty', bar(5).querySelector('[data-bar]').style.width === '50%' && bar(3).querySelector('[data-bar]').style.width === '50%' && bar(5).querySelector('[data-n]').textContent === '1' && bar(4).querySelector('[data-bar]').style.width === '0%' && bar(1).querySelector('[data-n]').textContent === '0');
    check('the at-a-glance tiles: 2 reviews, 4.0 average, 1 spotter, 2 public Cybercabs', p.text('statReviews') === '2' && p.text('statRating') === '4.0' && p.text('statSpotters') === '1' && p.text('statVehicles') === '2');
    check('the leaderboard footer totals every credited spotter', p.text('boardTotals') === '1 spotter credited · 2 vehicles discovered in all' && !p.d.getElementById('boardTotals').classList.contains('hidden'));
    check('a public author gets the shared avatar (initials when there is no photo)', cards[1].querySelector('[data-avatar-name]').textContent.trim() === 'AA');
    check('review text is shown as text, never as HTML', cards[1].querySelector('[data-body]').textContent === 'Great <b>ride</b>' && !cards[1].querySelector('[data-body] b'));
    check('photos are a thumbnail grid that opens the viewer', cards[1].querySelectorAll('[data-photo] img').length === 1 && (cards[1].querySelector('[data-photo]').click(), !p.d.getElementById('sightingViewer').classList.contains('hidden')));
    check('signed out: a sign-in note, no edit/delete buttons', !p.d.getElementById('reviewSignInNote').classList.contains('hidden') && !p.d.querySelector('[data-edit], [data-delete]'));
    check('the leaderboard is still on the page', !!p.d.getElementById('boardList'));
    check('with reviews, the summary and sort are shown; with none, the page starts with both hidden so the empty state says it once', !p.d.getElementById('reviewSummary').classList.contains('hidden') && !p.d.getElementById('reviewSort').classList.contains('hidden') && (() => { const s = new JSDOM(read('public/community.html')).window.document; return s.getElementById('reviewSummary').classList.contains('hidden') && s.getElementById('reviewSort').classList.contains('hidden'); })());
    p.w.close();

    const signed = await open('session-alice');
    const mine = signed.d.querySelector(`[data-review="${a.id}"]`);
    check('signed in as the author: Edit and Delete on their own card only', mine.querySelector('[data-edit]') && mine.querySelector('[data-delete]') && signed.d.querySelectorAll('[data-edit]').length === 1);
    mine.querySelector('[data-like]').click();
    await new Promise(r => setTimeout(r, 120));
    check('liking from the card updates the live count', mine.querySelector('[data-like-count]').textContent === '2' && mine.querySelector('[data-like]').getAttribute('aria-pressed') === 'true');
    mine.querySelector('[data-comments]').click();
    await new Promise(r => setTimeout(r, 120));
    mine.querySelector('[data-comment-form] input').value = 'Thanks all';
    mine.querySelector('[data-comment-form]').dispatchEvent(new signed.w.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    check('commenting from the card: the thread and count update', mine.querySelector('[data-comment-count]').textContent === '1' && /Thanks all/.test(mine.querySelector('[data-comment-list]').textContent));
    signed.d.querySelector('#reviewSort [data-sort="rating"]').click();
    await new Promise(r => setTimeout(r, 150));
    check('sorting by Highest rated re-orders the list', signed.d.querySelector('#reviewList [data-review]').dataset.review === a.id && signed.d.querySelector('#reviewSort [data-sort="rating"]').getAttribute('aria-pressed') === 'true');
    signed.w.close();
  }

  console.log('10. Wiring');
  {
    const wr = read('wrangler.jsonc');
    check('a REVIEWS_LIMITER rate-limit binding is configured', /"name": "REVIEWS_LIMITER"/.test(wr));
    const page = new JSDOM(read('public/community.html')).window.document;
    const grid = page.getElementById('reviews').parentElement;
    check('the box is headed "Reviews"', page.querySelector('#reviews h2').textContent === 'Reviews' && !/CYBERCAB REVIEWS/.test(read('public/community.html')));
    check('reviews and the leaderboard sit side by side on lg+ (one grid, two columns), stacked below that', /\blg:grid-cols-\[/.test(grid.className) && /\bgrid\b/.test(grid.className) && grid.children.length === 2 && grid.children[1].id === 'leaderboardColumn' && !!grid.children[1].querySelector('#boardList'));
    check('the privacy page explains reviews and the Anonymous rule', /Cybercab reviews:[^<]*Anonymous/.test(read('public/privacy.html')));
    check('no new privacy setting was invented: reviews read users.leaderboard_opt_in', /leaderboard_opt_in AS opt_in/.test(read('worker/reviews.js')) && !/ALTER TABLE users/.test(read('migrations/0023_cybercab_reviews.sql')));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
