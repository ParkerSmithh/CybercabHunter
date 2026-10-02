// Cybercab reviews on the Community page (migrations/0023_cybercab_reviews.sql).
//
//   GET    /api/reviews?sort=recent|rating|likes&offset=&limit=   public
//     -> { summary: { average, count }, sort, offset, limit, total, reviews: [...], viewer: { signed_in, moderator } }
//   POST   /api/reviews                         signed in; multipart: vehicle_id, rating, body, photos (0–3)
//   PATCH  /api/reviews/:id                     author only; multipart: rating, body, keep_photos (ids), photos
//   DELETE /api/reviews/:id                     author or moderator
//   PUT    /api/reviews/:id/like                signed in; idempotent like      -> { liked: true,  like_count }
//   DELETE /api/reviews/:id/like                signed in; idempotent unlike    -> { liked: false, like_count }
//   GET    /api/reviews/:id/comments            public
//   POST   /api/reviews/:id/comments            signed in; JSON { body }
//   DELETE /api/review-comments/:id             author or moderator
//   GET    /api/review-photos/:id               public, by random id, while the review is shown
//
// Rules:
//   - One review per rider per vehicle (unique index); a second POST for the
//     same Cybercab is 409 already_reviewed with the existing review's id.
//   - Only reviews of PUBLICLY ELIGIBLE vehicles (publicVehicleEligibleSql)
//     are ever listed, counted, commented on, liked or have photos served — a
//     vehicle made private takes its reviews out of view with it.
//   - Every write is checked against the session's user on the server; the
//     request never names whose review or comment it is.
//   - PRIVACY: an author or commenter whose users.leaderboard_opt_in is 0 (the
//     Profile page's "Community leaderboard & public profile" switch, the
//     existing setting — nothing new) is "Anonymous": no name, handle or
//     photo ever leaves the server for them. Who liked a review is never
//     served, only the count. No user id, email or vehicle-owner data is.
//   - Photos: JPEG/PNG/WebP by their bytes, 5 MB each, at most 3 per review;
//     every metadata block (EXIF incl. GPS, XMP, comments) is stripped before
//     storing (worker/avatars.js stripMetadata), so none is ever served.
//     R2 layout: reviews/<userId>/<reviewId>/<photoId> (the rider's folder, so
//     account deletion clears it with the rest).
//   - Writes are rate limited per rider (REVIEWS_LIMITER; fails open if the
//     binding is missing or errors).

import { tesla } from './tesla.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { sniffImage, stripMetadata } from './avatars.js';
import { sha256Hex } from './account.js';

export const MAX_REVIEW_PHOTOS = 3;
export const MAX_REVIEW_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_REVIEW_CHARS = 2000;
export const MAX_COMMENT_CHARS = 500;
export const ANONYMOUS = 'Anonymous';
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const ID_RE = /^[a-f0-9]{32}$/;
const SORTS = {
  recent: 'r.created_at DESC, r.id DESC',
  rating: 'r.rating DESC, r.created_at DESC, r.id DESC',
  likes: 'like_count DESC, r.created_at DESC, r.id DESC'
};

const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });
const unauthenticated = () => Response.json({ authenticated: false }, { status: 401 });
const notFound = () => fail('not_found', 404);
const photoUrl = id => `/api/review-photos/${id}`;
const photoKey = (userId, reviewId, photoId) => `reviews/${userId}/${reviewId}/${photoId}`;
const VISIBLE = `EXISTS (SELECT 1 FROM robotaxi_vehicles v WHERE v.id = r.robotaxi_vehicle_id AND ${publicVehicleEligibleSql('v')})`;

// The only avatars ever passed on: https URLs and this site's own pictures.
function safeAvatar(url) {
  if (typeof url !== 'string') return null;
  return /^https:\/\/[^\s"'<>]+$/.test(url) || /^\/api\/avatars\/[a-f0-9]{32}$/.test(url) ? url : null;
}

// Who wrote it, as the public may see it. A private account is "Anonymous".
export function publicPerson(row) {
  if (Number(row.opt_in) !== 1) return { name: ANONYMOUS, handle: null, avatar_url: null, anonymous: true };
  const handle = row.handle || null;
  return {
    name: (row.display_name && String(row.display_name).trim()) || (handle ? `@${handle}` : 'Spotter'),
    handle,
    avatar_url: safeAvatar(row.avatar_url),
    anonymous: false
  };
}

// The session's user (or null) and whether they're a moderator — the site's
// owner role, which may delete any review or comment.
async function viewer(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return null;
  const user = await env.cybercabhunter_db.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(userId).first();
  return user ? { id: user.id, moderator: user.role === 'moderator' } : null;
}

async function rateLimited(env, userId) {
  if (!env.REVIEWS_LIMITER) return false;
  try { return (await env.REVIEWS_LIMITER.limit({ key: `reviews:${await sha256Hex(userId)}` })).success === false; } catch (e) { return false; }
}
const tooMany = () => Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });

// A shown review (its vehicle is public) by id, or null.
async function shownReview(sql, id) {
  if (!ID_RE.test(id || '')) return null;
  return sql.prepare(`SELECT r.id, r.user_id, r.robotaxi_vehicle_id FROM cybercab_reviews r WHERE r.id = ? AND ${VISIBLE}`).bind(id).first();
}

// ---- Reading ----

async function photosFor(sql, reviewIds) {
  const out = new Map(reviewIds.map(id => [id, []]));
  if (!reviewIds.length) return out;
  const rows = (await sql.prepare(`SELECT id, review_id FROM cybercab_review_photos WHERE review_id IN (${reviewIds.map(() => '?').join(',')}) ORDER BY review_id, position`).bind(...reviewIds).all()).results || [];
  for (const p of rows) out.get(p.review_id).push({ id: p.id, url: photoUrl(p.id) });
  return out;
}

function reviewJson(row, photos, me) {
  return {
    id: row.id,
    rating: Number(row.rating),
    body: row.body,
    photos,
    like_count: Number(row.like_count) || 0,
    comment_count: Number(row.comment_count) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    vehicle: { id: row.vehicle_id, license_plate: row.license_plate || null },
    author: publicPerson(row),
    mine: !!me && row.user_id === me.id,
    liked: !!me && Number(row.liked_by_me) === 1,
    can_delete: !!me && (row.user_id === me.id || me.moderator)
  };
}

const REVIEW_SELECT = `
  SELECT r.id, r.user_id, r.rating, r.body, r.created_at, r.updated_at,
         v.id AS vehicle_id, v.license_plate,
         u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url,
         (SELECT COUNT(*) FROM cybercab_review_likes l WHERE l.review_id = r.id) AS like_count,
         (SELECT COUNT(*) FROM cybercab_review_comments c WHERE c.review_id = r.id) AS comment_count,
         (SELECT COUNT(*) FROM cybercab_review_likes l WHERE l.review_id = r.id AND l.user_id = ?) AS liked_by_me
  FROM cybercab_reviews r
  JOIN robotaxi_vehicles v ON v.id = r.robotaxi_vehicle_id
  JOIN users u ON u.id = r.user_id
  WHERE ${publicVehicleEligibleSql('v')}`;

export async function apiListReviews(request, env) {
  const sql = env.cybercabhunter_db;
  const params = new URL(request.url).searchParams;
  const asInt = (raw, fallback) => (/^\d{1,6}$/.test(raw || '') ? Number(raw) : fallback);
  const limit = Math.min(Math.max(asInt(params.get('limit'), LIST_DEFAULT), 1), LIST_MAX);
  const offset = asInt(params.get('offset'), 0);
  const sort = SORTS[params.get('sort')] ? params.get('sort') : 'recent';
  const me = await viewer(request, env);

  // The aggregate, live, over exactly the reviews that are shown.
  const summary = await sql.prepare(`SELECT COUNT(*) AS n, AVG(r.rating) AS avg FROM cybercab_reviews r WHERE ${VISIBLE}`).first();
  const count = Number(summary && summary.n) || 0;
  const rows = (await sql.prepare(`${REVIEW_SELECT} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`).bind(me ? me.id : '', limit, offset).all()).results || [];
  const photos = await photosFor(sql, rows.map(r => r.id));
  return Response.json({
    summary: { average: count ? Math.round(Number(summary.avg) * 10) / 10 : null, count },
    sort, offset, limit, total: count,
    reviews: rows.map(r => reviewJson(r, photos.get(r.id), me)),
    viewer: { signed_in: !!me, moderator: !!(me && me.moderator) }
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function oneReview(sql, id, me) {
  const row = await sql.prepare(`${REVIEW_SELECT} AND r.id = ?`).bind(me ? me.id : '', id).first();
  if (!row) return null;
  return reviewJson(row, (await photosFor(sql, [id])).get(id), me);
}

// ---- Writing a review ----

function readText(value, max) {
  if (typeof value !== 'string') return { error: 'missing_text' };
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return { error: 'missing_text' };
  if (text.length > max) return { error: 'text_too_long' };
  return { text };
}

// Validated, metadata-stripped photos from the form, or { error }.
async function readPhotos(form) {
  const files = form.getAll('photos').filter(f => f && typeof f !== 'string' && f.size > 0);
  const out = [];
  for (const file of files) {
    if (file.size > MAX_REVIEW_PHOTO_BYTES) return { error: 'file_too_large', status: 413 };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return { error: 'unsupported_file_type' };
    out.push({ bytes: stripMetadata(bytes, type), type });
  }
  return { photos: out };
}

async function storePhotos(env, userId, reviewId, photos, firstPosition) {
  const stmts = [];
  for (let i = 0; i < photos.length; i++) {
    const id = newId();
    const key = photoKey(userId, reviewId, id);
    await env.EVIDENCE_BUCKET.put(key, photos[i].bytes, { httpMetadata: { contentType: photos[i].type } });
    stmts.push(env.cybercabhunter_db.prepare(`INSERT INTO cybercab_review_photos (id, review_id, position, r2_key, content_type) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, reviewId, firstPosition + i, key, photos[i].type));
  }
  return stmts;
}

async function readForm(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared && declared > MAX_REVIEW_PHOTOS * MAX_REVIEW_PHOTO_BYTES + 256 * 1024) return { error: 'file_too_large', status: 413 };
  try { return { form: await request.formData() }; } catch (e) { return { error: 'invalid_form_data' }; }
}

function readRating(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

export async function apiCreateReview(request, env) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  if (await rateLimited(env, me.id)) return tooMany();
  const { form, error, status } = await readForm(request);
  if (error) return fail(error, status);

  const sql = env.cybercabhunter_db;
  const vehicleId = String(form.get('vehicle_id') || '');
  const vehicle = vehicleId && await sql.prepare(`SELECT v.id FROM robotaxi_vehicles v WHERE v.id = ? AND ${publicVehicleEligibleSql('v')}`).bind(vehicleId).first();
  if (!vehicle) return fail('unknown_vehicle');
  const rating = readRating(form.get('rating'));
  if (!rating) return fail('invalid_rating');
  const body = readText(form.get('body'), MAX_REVIEW_CHARS);
  if (body.error) return fail(body.error);
  const existing = await sql.prepare(`SELECT id FROM cybercab_reviews WHERE user_id = ? AND robotaxi_vehicle_id = ?`).bind(me.id, vehicleId).first();
  if (existing) return fail('already_reviewed', 409, { review_id: existing.id });
  const read = await readPhotos(form);
  if (read.error) return fail(read.error, read.status);
  if (read.photos.length > MAX_REVIEW_PHOTOS) return fail('too_many_photos');

  const id = newId();
  try {
    await sql.prepare(`INSERT INTO cybercab_reviews (id, user_id, robotaxi_vehicle_id, rating, body) VALUES (?, ?, ?, ?, ?)`).bind(id, me.id, vehicleId, rating, body.text).run();
  } catch (e) {
    // The unique index: a simultaneous second review of the same Cybercab.
    const again = await sql.prepare(`SELECT id FROM cybercab_reviews WHERE user_id = ? AND robotaxi_vehicle_id = ?`).bind(me.id, vehicleId).first();
    if (again) return fail('already_reviewed', 409, { review_id: again.id });
    throw e;
  }
  const stmts = await storePhotos(env, me.id, id, read.photos, 0);
  if (stmts.length) await sql.batch(stmts);
  return Response.json({ success: true, review: await oneReview(sql, id, me) }, { status: 201 });
}

export async function apiUpdateReview(request, env, reviewId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const review = await shownReview(sql, reviewId);
  if (!review) return notFound();
  if (review.user_id !== me.id) return fail('forbidden', 403);   // only its author edits a review
  if (await rateLimited(env, me.id)) return tooMany();
  const { form, error, status } = await readForm(request);
  if (error) return fail(error, status);

  const rating = readRating(form.get('rating'));
  if (!rating) return fail('invalid_rating');
  const body = readText(form.get('body'), MAX_REVIEW_CHARS);
  if (body.error) return fail(body.error);
  const current = (await sql.prepare(`SELECT id, r2_key FROM cybercab_review_photos WHERE review_id = ? ORDER BY position`).bind(reviewId).all()).results || [];
  const keepIds = new Set(form.getAll('keep_photos').map(String));
  const keep = current.filter(p => keepIds.has(p.id));
  const drop = current.filter(p => !keepIds.has(p.id));
  const read = await readPhotos(form);
  if (read.error) return fail(read.error, read.status);
  if (keep.length + read.photos.length > MAX_REVIEW_PHOTOS) return fail('too_many_photos');

  const stmts = [
    sql.prepare(`UPDATE cybercab_reviews SET rating = ?, body = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(rating, body.text, reviewId, me.id),
    ...drop.map(p => sql.prepare(`DELETE FROM cybercab_review_photos WHERE id = ?`).bind(p.id)),
    ...keep.map((p, i) => sql.prepare(`UPDATE cybercab_review_photos SET position = ? WHERE id = ?`).bind(i, p.id)),
    ...await storePhotos(env, me.id, reviewId, read.photos, keep.length)
  ];
  await sql.batch(stmts);
  if (drop.length) { try { await env.EVIDENCE_BUCKET.delete(drop.map(p => p.r2_key)); } catch (e) { /* the rows are gone; best effort */ } }
  return Response.json({ success: true, review: await oneReview(sql, reviewId, me) });
}

export async function apiDeleteReview(request, env, reviewId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(reviewId || '')) return notFound();
  const review = await sql.prepare(`SELECT id, user_id FROM cybercab_reviews WHERE id = ?`).bind(reviewId).first();
  if (!review) return notFound();
  if (review.user_id !== me.id && !me.moderator) return fail('forbidden', 403);
  const keys = ((await sql.prepare(`SELECT r2_key FROM cybercab_review_photos WHERE review_id = ?`).bind(reviewId).all()).results || []).map(p => p.r2_key);
  await sql.batch([
    sql.prepare(`DELETE FROM cybercab_review_photos WHERE review_id = ?`).bind(reviewId),
    sql.prepare(`DELETE FROM cybercab_review_likes WHERE review_id = ?`).bind(reviewId),
    sql.prepare(`DELETE FROM cybercab_review_comments WHERE review_id = ?`).bind(reviewId),
    sql.prepare(`DELETE FROM cybercab_reviews WHERE id = ?`).bind(reviewId)
  ]);
  if (keys.length) { try { await env.EVIDENCE_BUCKET.delete(keys); } catch (e) { /* best effort */ } }
  return Response.json({ success: true, deleted: true });
}

// ---- Likes ----

export async function apiSetReviewLike(request, env, reviewId, liked) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!await shownReview(sql, reviewId)) return notFound();
  if (await rateLimited(env, me.id)) return tooMany();
  await sql.prepare(liked
    ? `INSERT OR IGNORE INTO cybercab_review_likes (review_id, user_id) VALUES (?, ?)`
    : `DELETE FROM cybercab_review_likes WHERE review_id = ? AND user_id = ?`).bind(reviewId, me.id).run();
  const n = await sql.prepare(`SELECT COUNT(*) AS n FROM cybercab_review_likes WHERE review_id = ?`).bind(reviewId).first();
  return Response.json({ success: true, liked, like_count: Number(n.n) });
}

// ---- Comments ----

function commentJson(row, me) {
  return {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    author: publicPerson(row),
    mine: !!me && row.user_id === me.id,
    can_delete: !!me && (row.user_id === me.id || me.moderator)
  };
}
const COMMENT_SELECT = `
  SELECT c.id, c.user_id, c.body, c.created_at, u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url
  FROM cybercab_review_comments c JOIN users u ON u.id = c.user_id`;

export async function apiListReviewComments(request, env, reviewId) {
  const sql = env.cybercabhunter_db;
  if (!await shownReview(sql, reviewId)) return notFound();
  const me = await viewer(request, env);
  const rows = (await sql.prepare(`${COMMENT_SELECT} WHERE c.review_id = ? ORDER BY c.created_at ASC, c.rowid ASC LIMIT 500`).bind(reviewId).all()).results || [];
  return Response.json({ comments: rows.map(r => commentJson(r, me)), comment_count: rows.length }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function apiCreateReviewComment(request, env, reviewId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!await shownReview(sql, reviewId)) return notFound();
  if (await rateLimited(env, me.id)) return tooMany();
  let payload = null;
  try { payload = await request.json(); } catch (e) { payload = null; }
  const body = readText(payload && payload.body, MAX_COMMENT_CHARS);
  if (body.error) return fail(body.error);
  const id = newId();
  await sql.prepare(`INSERT INTO cybercab_review_comments (id, review_id, user_id, body) VALUES (?, ?, ?, ?)`).bind(id, reviewId, me.id, body.text).run();
  const row = await sql.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(id).first();
  const n = await sql.prepare(`SELECT COUNT(*) AS n FROM cybercab_review_comments WHERE review_id = ?`).bind(reviewId).first();
  return Response.json({ success: true, comment: commentJson(row, me), comment_count: Number(n.n) }, { status: 201 });
}

export async function apiDeleteReviewComment(request, env, commentId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(commentId || '')) return notFound();
  const comment = await sql.prepare(`SELECT id, user_id, review_id FROM cybercab_review_comments WHERE id = ?`).bind(commentId).first();
  if (!comment) return notFound();
  if (comment.user_id !== me.id && !me.moderator) return fail('forbidden', 403);
  await sql.prepare(`DELETE FROM cybercab_review_comments WHERE id = ?`).bind(commentId).run();
  const n = await sql.prepare(`SELECT COUNT(*) AS n FROM cybercab_review_comments WHERE review_id = ?`).bind(comment.review_id).first();
  return Response.json({ success: true, deleted: true, comment_count: Number(n.n) });
}

// ---- Photos ----

export async function apiGetReviewPhoto(request, env, photoId) {
  const missing = () => new Response('Not found', { status: 404 });
  if (!ID_RE.test(photoId || '')) return missing();
  const row = await env.cybercabhunter_db.prepare(`
    SELECT p.r2_key, p.content_type FROM cybercab_review_photos p JOIN cybercab_reviews r ON r.id = p.review_id
    WHERE p.id = ? AND ${VISIBLE}`).bind(photoId).first();
  if (!row) return missing();
  const object = await env.EVIDENCE_BUCKET.get(row.r2_key);
  if (!object) return missing();
  return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}
