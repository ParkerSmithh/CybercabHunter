// Community Social (the Community page's Social section, public/js/social.js;
// migrations/0044_social.sql). Posts are the main thing; a ride review is an
// optional attachment to a post.
//
//   GET    /api/social/feed?filter=foryou|latest|photos|reviews&sort=new|popular&cursor=&limit=   public
//   GET    /api/social/posts/:id                       public (a removed post: moderators only)
//   POST   /api/social/posts                           signed in; multipart (see readPostForm)
//   PATCH  /api/social/posts/:id                       author only; multipart
//   DELETE /api/social/posts/:id                       author (deletes) or moderator (removes, audited)
//   PUT    /api/social/posts/:id/like                  signed in; idempotent
//   DELETE /api/social/posts/:id/like                  signed in; idempotent
//   GET    /api/social/posts/:id/comments?cursor=      public; top-level comments + their replies
//   POST   /api/social/posts/:id/comments              signed in; JSON { body, parent_id? }
//   PATCH  /api/social/comments/:id                    author only; JSON { body }
//   DELETE /api/social/comments/:id                    author (deletes) or moderator (removes, audited)
//   POST   /api/social/reports                         signed in; JSON { target_type, target_id, reason, details? }
//   GET    /api/social/sidebar                         public, edge-cached 2 min
//   GET    /api/social/photos/:id                      public while its post is shown
//   GET    /api/moderation/social/reports              moderators: open reports, grouped per item
//   POST   /api/moderation/social/resolve              moderators: { target_type, target_id, action: remove|dismiss, reason? }
//   PUT    /api/moderation/social/announcement         moderators: { body, link_url? }
//   DELETE /api/moderation/social/announcement         moderators
//
// RULES (all enforced here; the page only mirrors them):
//   - Every write is the session's own user; the request never names whose it is.
//   - XP: nothing in this file awards or touches XP. Posting, liking,
//     commenting and receiving likes/comments are worth 0 XP. A sighting earns
//     XP only through the existing moderated sighting workflow.
//   - PRIVACY: an author whose public-profile switch is off
//     (users.leaderboard_opt_in = 0, the existing setting) is "Anonymous":
//     no name, handle, photo, rank or level leaves the server for them. Who
//     liked a post is never served, only the count. No email or user id is.
//   - Photos: JPEG/PNG/WebP by their bytes, 5 MB each, at most 4 per post;
//     metadata (EXIF incl. GPS) stripped before storing. R2 layout:
//     social/<userId>/<postId>/<photoId> (account deletion clears the folder).
//   - Posts copied from the old Reviews (legacy_review_id) keep that
//     section's rule: shown only while the reviewed vehicle is public.
//   - Rate limits per rider (counted in D1 over indexed, capped reads):
//     posts 10/hour and 40/day, comments 30/hour, reports 20/day; likes and
//     every write also pass REVIEWS_LIMITER when bound.
//   - Removal by a moderator is a soft remove with an audit row
//     (social_mod_actions); an author's own delete removes the rows and photos.

import { tesla } from './tesla.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { sniffImage, stripMetadata } from './avatars.js';
import { sha256Hex } from './account.js';
import { publicPerson } from './reviews.js';
import { levelFor, rankFor } from './progression-levels.js';

export const MAX_POST_CHARS = 2000;
export const MAX_COMMENT_CHARS = 1000;
export const MAX_POST_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const CATEGORIES = ['general', 'sighting', 'question', 'news', 'review'];
export const REPORT_REASONS = ['spam', 'harassment', 'off_topic', 'misleading', 'privacy', 'other'];
export const LIMITS = { postsPerHour: 10, postsPerDay: 40, commentsPerHour: 30, reportsPerDay: 20 };
const FEED_DEFAULT = 10;
const FEED_MAX = 25;
const RANKED_WINDOW = 300;          // newest posts the For You / Popular rankings consider
const COMMENTS_PAGE = 10;
const SIDEBAR_CACHE_SECONDS = 120;
const ID_RE = /^[a-f0-9]{32}$/;

const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
const unauthenticated = () => Response.json({ authenticated: false }, { status: 401 });
const notFound = () => fail('not_found', 404);
const tooMany = () => Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } });
const photoUrl = id => `/api/social/photos/${id}`;
const photoKey = (userId, postId, photoId) => `social/${userId}/${postId}/${photoId}`;
const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ELIGIBLE_V = publicVehicleEligibleSql('v');
// A post is shown while visible; a copied legacy review also needs its vehicle public.
const SHOWN = `p.status = 'visible' AND (p.legacy_review_id IS NULL OR (v.id IS NOT NULL AND ${ELIGIBLE_V}))`;

async function viewer(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return null;
  const user = await env.cybercabhunter_db.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(userId).first();
  return user ? { id: user.id, moderator: user.role === 'moderator' } : null;
}

async function bindingLimited(env, userId) {
  if (!env.REVIEWS_LIMITER) return false;
  try { return (await env.REVIEWS_LIMITER.limit({ key: `social:${await sha256Hex(userId)}` })).success === false; } catch (e) { return false; }
}

// How many rows a rider made since a time, reading at most `cap` index entries.
async function countSince(sql, table, column, userId, sinceSql, cap) {
  const row = await sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${column} = ? AND created_at >= ? LIMIT ${cap})`).bind(userId, sinceSql).first();
  return Number(row ? row.n : 0);
}

// ---- Reading posts ----

const POST_SELECT = `
  SELECT p.id, p.user_id, p.body, p.category, p.link_url, p.robotaxi_vehicle_id, p.legacy_review_id, p.status,
         p.removed_reason, p.like_count, p.comment_count, p.has_photos, p.has_review, p.created_at, p.edited_at,
         u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url, x.xp,
         v.id AS vehicle_id, v.license_plate, v.model AS vehicle_model,
         CASE WHEN v.id IS NOT NULL AND ${ELIGIBLE_V} THEN 1 ELSE 0 END AS vehicle_public,
         r.rating, r.vehicle_type, r.quoted_fare_cents, r.pickup_wait_minutes, r.ride_date,
         EXISTS (SELECT 1 FROM social_likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked_by_me
  FROM social_posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN user_xp x ON x.user_id = p.user_id
  LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
  LEFT JOIN social_post_reviews r ON r.post_id = p.id`;

async function photosFor(sql, postIds) {
  const out = new Map(postIds.map(id => [id, []]));
  if (!postIds.length) return out;
  const rows = (await sql.prepare(`SELECT id, post_id FROM social_post_photos WHERE post_id IN (${postIds.map(() => '?').join(',')}) ORDER BY post_id, position`).bind(...postIds).all()).results || [];
  for (const p of rows) out.get(p.post_id).push({ id: p.id, url: photoUrl(p.id) });
  return out;
}

export function authorJson(row) {
  const person = publicPerson(row);
  if (person.anonymous) return { ...person, rank: null, level: null };
  const xp = Number(row.xp) || 0;
  const rank = rankFor(xp);
  return { ...person, rank: { key: rank.key, name: rank.name }, level: levelFor(xp).n };
}

function postJson(row, photos, me) {
  const mine = !!me && row.user_id === me.id;
  return {
    id: row.id,
    body: row.body,
    category: row.category,
    link_url: row.link_url || null,
    created_at: row.created_at,
    edited_at: row.edited_at || null,
    author: authorJson(row),
    photos: photos || [],
    review: row.has_review && row.rating ? {
      rating: Number(row.rating),
      vehicle_type: row.vehicle_type || null,
      quoted_fare: row.quoted_fare_cents == null ? null : Number(row.quoted_fare_cents) / 100,
      pickup_wait_minutes: row.pickup_wait_minutes == null ? null : Number(row.pickup_wait_minutes),
      ride_date: row.ride_date || null
    } : null,
    // A linked registry vehicle, only while it is public (verified in the registry).
    vehicle: row.vehicle_id && Number(row.vehicle_public) === 1 ? { id: row.vehicle_id, license_plate: row.license_plate || null, model: row.vehicle_model || null, verified: true } : null,
    like_count: Number(row.like_count) || 0,
    comment_count: Number(row.comment_count) || 0,
    liked: !!me && Number(row.liked_by_me) === 1,
    mine,
    can_edit: mine && row.status === 'visible',
    can_delete: mine || (!!me && me.moderator),
    removed: row.status !== 'visible',
    legacy_review: !!row.legacy_review_id,
    url: `/community?post=${row.id}`
  };
}

async function postsByIds(sql, ids, me) {
  if (!ids.length) return [];
  const rows = (await sql.prepare(`${POST_SELECT} WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(me ? me.id : '', ...ids).all()).results || [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const photos = await photosFor(sql, rows.filter(r => Number(r.has_photos)).map(r => r.id));
  return ids.map(id => byId.get(id)).filter(Boolean).map(r => postJson(r, photos.get(r.id), me));
}

// The rank used by For You and Most Popular: real engagement, decaying with
// age so old posts can't stay on top (likes + 2 x comments + 1, over
// (age in hours + 2) ^ gravity). For You decays faster than Popular.
export function postScore({ like_count, comment_count, created_at }, nowMs, gravity) {
  const t = Date.parse(String(created_at).replace(' ', 'T') + (/[zZ]$/.test(String(created_at)) ? '' : 'Z'));
  const hours = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 3600000) : 1e6;
  return (Number(like_count || 0) + 2 * Number(comment_count || 0) + 1) / Math.pow(hours + 2, gravity);
}

const encodeCursor = obj => btoa(JSON.stringify(obj)).replace(/=+$/, '');
function decodeCursor(raw) {
  if (!raw || raw.length > 300) return null;
  try { return JSON.parse(atob(raw)); } catch (e) { return null; }
}

export async function apiSocialFeed(request, env) {
  const sql = env.cybercabhunter_db;
  const params = new URL(request.url).searchParams;
  const filter = ['foryou', 'latest', 'photos', 'reviews'].includes(params.get('filter')) ? params.get('filter') : 'foryou';
  const sort = filter === 'foryou' ? 'ranked' : filter === 'latest' ? 'new' : (params.get('sort') === 'popular' ? 'popular' : 'new');
  const limit = Math.min(Math.max(Number(params.get('limit')) || FEED_DEFAULT, 1), FEED_MAX);
  const cursor = decodeCursor(params.get('cursor'));
  const me = await viewer(request, env);
  const extra = filter === 'photos' ? ' AND p.has_photos = 1' : filter === 'reviews' ? ' AND p.has_review = 1' : '';
  const shownFrom = `FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id WHERE ${SHOWN}${extra}`;
  let ids, next = null;
  if (sort === 'new') {
    const after = cursor && typeof cursor.t === 'string' && typeof cursor.id === 'string' ? cursor : null;
    const rows = (await sql.prepare(`SELECT p.id, p.created_at ${shownFrom}
        ${after ? 'AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))' : ''}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).bind(...(after ? [after.t, after.t, after.id] : []), limit + 1).all()).results || [];
    ids = rows.slice(0, limit).map(r => r.id);
    if (rows.length > limit) { const last = rows[limit - 1]; next = encodeCursor({ t: last.created_at, id: last.id }); }
  } else {
    // Rank the newest RANKED_WINDOW posts; the cursor keeps the moment the
    // ranking was taken, so later pages continue the same order.
    const at = cursor && Number.isFinite(cursor.at) ? cursor.at : Date.now();
    const offset = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
    const rows = (await sql.prepare(`SELECT p.id, p.created_at, p.like_count, p.comment_count ${shownFrom}
        ORDER BY p.created_at DESC, p.id DESC LIMIT ${RANKED_WINDOW}`).all()).results || [];
    const gravity = sort === 'ranked' ? 1.5 : 0.8;
    rows.sort((a, b) => postScore(b, at, gravity) - postScore(a, at, gravity) || (a.created_at < b.created_at ? 1 : -1));
    ids = rows.slice(offset, offset + limit).map(r => r.id);
    if (rows.length > offset + limit) next = encodeCursor({ at, o: offset + limit });
  }
  const posts = await postsByIds(sql, ids, me);
  return Response.json({ filter, sort, posts, next_cursor: next, viewer: { signed_in: !!me, moderator: !!(me && me.moderator) } }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// One post, or null. Moderators also see removed posts.
async function onePost(sql, id, me, { includeRemoved = false } = {}) {
  if (!ID_RE.test(id || '')) return null;
  const row = await sql.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(me ? me.id : '', id).first();
  if (!row) return null;
  const legacyHidden = row.legacy_review_id && Number(row.vehicle_public) !== 1;
  if ((row.status !== 'visible' || legacyHidden) && !(includeRemoved && me && me.moderator)) return null;
  const photos = Number(row.has_photos) ? (await photosFor(sql, [id])).get(id) : [];
  return postJson(row, photos, me);
}

export async function apiGetSocialPost(request, env, id) {
  const me = await viewer(request, env);
  const post = await onePost(env.cybercabhunter_db, id, me, { includeRemoved: true });
  if (!post) return fail('post_unavailable', 404);
  return Response.json({ post, viewer: { signed_in: !!me, moderator: !!(me && me.moderator) } }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// ---- Writing posts ----

function readText(value, max, { required = false } = {}) {
  const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!text && required) return { error: 'missing_text' };
  if (text.length > max) return { error: 'text_too_long' };
  return { text };
}

function readLink(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { url: null };
  if (s.length > 500) return { error: 'invalid_link' };
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'invalid_link' };
    return { url: u.toString() };
  } catch (e) { return { error: 'invalid_link' }; }
}

// The optional ride review fields, or { review: null } / { error }.
export function readReview(get, nowMs = Date.now()) {
  const on = ['1', 'true', 'on'].includes(String(get('review') || ''));
  if (!on) return { review: null };
  const rating = Number(get('rating'));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'invalid_rating' };
  const vt = String(get('vehicle_type') || '');
  if (vt && !['cybercab', 'model_y'].includes(vt)) return { error: 'invalid_vehicle_type' };
  const fareRaw = String(get('quoted_fare') || '').trim();
  let fare = null;
  if (fareRaw) {
    const f = Number(fareRaw);
    if (!Number.isFinite(f) || f < 1 || f > 250) return { error: 'invalid_fare' };
    fare = Math.round(f * 100);
  }
  const waitRaw = String(get('pickup_wait_minutes') || '').trim();
  let wait = null;
  if (waitRaw) {
    const w = Number(waitRaw);
    if (!Number.isInteger(w) || w < 0 || w > 120) return { error: 'invalid_wait' };
    wait = w;
  }
  const dateRaw = String(get('ride_date') || '').trim();
  let rideDate = null;
  if (dateRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) return { error: 'invalid_ride_date' };
    const t = Date.parse(dateRaw + 'T12:00:00Z');
    if (!Number.isFinite(t) || t > nowMs + 36 * 3600000 || dateRaw < '2025-06-01') return { error: 'invalid_ride_date' };
    rideDate = dateRaw;
  }
  return { review: { rating, vehicle_type: vt || null, quoted_fare_cents: fare, pickup_wait_minutes: wait, ride_date: rideDate } };
}

async function readPhotos(form) {
  const files = form.getAll('photos').filter(f => f && typeof f !== 'string' && f.size > 0);
  if (files.length > MAX_POST_PHOTOS) return { error: 'too_many_photos' };
  const out = [];
  for (const file of files) {
    if (file.size > MAX_PHOTO_BYTES) return { error: 'file_too_large', status: 413 };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) return { error: 'unsupported_file_type' };
    out.push({ bytes: stripMetadata(bytes, type), type });
  }
  return { photos: out };
}

async function readForm(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared && declared > MAX_POST_PHOTOS * MAX_PHOTO_BYTES + 256 * 1024) return { error: 'file_too_large', status: 413 };
  try { return { form: await request.formData() }; } catch (e) { return { error: 'invalid_form_data' }; }
}

// Everything a post form carries, validated (photos separately).
async function readPostForm(sql, form) {
  const get = k => form.get(k);
  const body = readText(get('body'), MAX_POST_CHARS);
  if (body.error) return { error: body.error };
  const category = String(get('category') || 'general');
  if (!CATEGORIES.includes(category)) return { error: 'invalid_category' };
  const link = readLink(get('link_url'));
  if (link.error) return { error: link.error };
  const vehicleRaw = String(get('vehicle_id') || '').trim();
  let vehicleId = null;
  if (vehicleRaw) {
    const v = await sql.prepare(`SELECT v.id FROM robotaxi_vehicles v WHERE v.id = ? AND ${ELIGIBLE_V}`).bind(vehicleRaw).first();
    if (!v) return { error: 'unknown_vehicle' };
    vehicleId = v.id;
  }
  const review = readReview(get);
  if (review.error) return { error: review.error };
  return { body: body.text, category, link_url: link.url, vehicle_id: vehicleId, review: review.review };
}

async function storePhotos(env, userId, postId, photos, firstPosition) {
  const stmts = [];
  for (let i = 0; i < photos.length; i++) {
    const id = newId();
    const key = photoKey(userId, postId, id);
    await env.EVIDENCE_BUCKET.put(key, photos[i].bytes, { httpMetadata: { contentType: photos[i].type } });
    stmts.push(env.cybercabhunter_db.prepare(`INSERT INTO social_post_photos (id, post_id, position, r2_key, content_type) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, postId, firstPosition + i, key, photos[i].type));
  }
  return stmts;
}

function reviewUpsert(sql, postId, r) {
  return sql.prepare(`
    INSERT INTO social_post_reviews (post_id, rating, vehicle_type, quoted_fare_cents, pickup_wait_minutes, ride_date) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET rating = excluded.rating, vehicle_type = excluded.vehicle_type,
      quoted_fare_cents = excluded.quoted_fare_cents, pickup_wait_minutes = excluded.pickup_wait_minutes, ride_date = excluded.ride_date
  `).bind(postId, r.rating, r.vehicle_type, r.quoted_fare_cents, r.pickup_wait_minutes, r.ride_date);
}

export async function apiCreateSocialPost(request, env) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const now = Date.now();
  const [lastHour, lastDay] = await Promise.all([
    countSince(sql, 'social_posts', 'user_id', me.id, sqlNow(now - 3600000), LIMITS.postsPerHour),
    countSince(sql, 'social_posts', 'user_id', me.id, sqlNow(now - 86400000), LIMITS.postsPerDay)
  ]);
  if (lastHour >= LIMITS.postsPerHour || lastDay >= LIMITS.postsPerDay || await bindingLimited(env, me.id)) return tooMany();
  const { form, error, status } = await readForm(request);
  if (error) return fail(error, status);
  const fields = await readPostForm(sql, form);
  if (fields.error) return fail(fields.error);
  const read = await readPhotos(form);
  if (read.error) return fail(read.error, read.status);
  if (!fields.body && !read.photos.length) return fail('empty_post');
  // The same text again within a day is a duplicate (accidental re-post or spam).
  if (fields.body) {
    const dup = await sql.prepare(`SELECT id FROM social_posts WHERE user_id = ? AND body = ? AND created_at >= ? LIMIT 1`).bind(me.id, fields.body, sqlNow(now - 86400000)).first();
    if (dup) return fail('duplicate_post', 409, { post_id: dup.id });
  }
  const id = newId();
  const photoStmts = await storePhotos(env, me.id, id, read.photos, 0);
  await sql.batch([
    sql.prepare(`INSERT INTO social_posts (id, user_id, body, category, link_url, robotaxi_vehicle_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, me.id, fields.body, fields.category, fields.link_url, fields.vehicle_id),
    ...photoStmts,
    ...(fields.review ? [reviewUpsert(sql, id, fields.review)] : [])
  ]);
  return Response.json({ success: true, post: await onePost(sql, id, me) }, { status: 201 });
}

export async function apiUpdateSocialPost(request, env, postId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(postId || '')) return notFound();
  const post = await sql.prepare(`SELECT id, user_id, status FROM social_posts WHERE id = ?`).bind(postId).first();
  if (!post || post.status !== 'visible') return notFound();
  if (post.user_id !== me.id) return fail('forbidden', 403);   // only the author edits
  if (await bindingLimited(env, me.id)) return tooMany();
  const { form, error, status } = await readForm(request);
  if (error) return fail(error, status);
  const fields = await readPostForm(sql, form);
  if (fields.error) return fail(fields.error);
  const current = (await sql.prepare(`SELECT id, r2_key FROM social_post_photos WHERE post_id = ? ORDER BY position`).bind(postId).all()).results || [];
  const keepIds = new Set(form.getAll('keep_photos').map(String));
  const keep = current.filter(p => keepIds.has(p.id));
  const drop = current.filter(p => !keepIds.has(p.id));
  const read = await readPhotos(form);
  if (read.error) return fail(read.error, read.status);
  if (keep.length + read.photos.length > MAX_POST_PHOTOS) return fail('too_many_photos');
  if (!fields.body && !keep.length && !read.photos.length) return fail('empty_post');
  const removeReview = ['1', 'true'].includes(String(form.get('remove_review') || '')) && !fields.review;
  const stmts = [
    sql.prepare(`UPDATE social_posts SET body = ?, category = ?, link_url = ?, robotaxi_vehicle_id = ?, edited_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .bind(fields.body, fields.category, fields.link_url, fields.vehicle_id, postId, me.id),
    ...drop.map(p => sql.prepare(`DELETE FROM social_post_photos WHERE id = ?`).bind(p.id)),
    ...keep.map((p, i) => sql.prepare(`UPDATE social_post_photos SET position = ? WHERE id = ?`).bind(i, p.id)),
    ...await storePhotos(env, me.id, postId, read.photos, keep.length),
    ...(fields.review ? [reviewUpsert(sql, postId, fields.review)] : []),
    ...(removeReview ? [sql.prepare(`DELETE FROM social_post_reviews WHERE post_id = ?`).bind(postId)] : [])
  ];
  await sql.batch(stmts);
  if (drop.length) { try { await env.EVIDENCE_BUCKET.delete(drop.map(p => p.r2_key)); } catch (e) { /* rows are gone; best effort */ } }
  return Response.json({ success: true, post: await onePost(sql, postId, me) });
}

// Deletes a post and everything under it (and, for a post copied from the old
// Reviews, that original review too, so the copy can never come back).
export async function deletePostCompletely(env, postId) {
  const sql = env.cybercabhunter_db;
  const post = await sql.prepare(`SELECT id, legacy_review_id FROM social_posts WHERE id = ?`).bind(postId).first();
  if (!post) return;
  const keys = ((await sql.prepare(`SELECT r2_key FROM social_post_photos WHERE post_id = ?`).bind(postId).all()).results || []).map(p => p.r2_key);
  const legacy = post.legacy_review_id;
  await sql.batch([
    sql.prepare(`UPDATE social_reports SET status = 'dismissed', resolved_at = datetime('now') WHERE status = 'open' AND ((target_type = 'post' AND target_id = ?) OR (target_type = 'comment' AND target_id IN (SELECT id FROM social_comments WHERE post_id = ?)))`).bind(postId, postId),
    sql.prepare(`DELETE FROM social_comments WHERE post_id = ? AND parent_id IS NOT NULL`).bind(postId),
    sql.prepare(`DELETE FROM social_comments WHERE post_id = ?`).bind(postId),
    sql.prepare(`DELETE FROM social_likes WHERE post_id = ?`).bind(postId),
    sql.prepare(`DELETE FROM social_post_photos WHERE post_id = ?`).bind(postId),
    sql.prepare(`DELETE FROM social_post_reviews WHERE post_id = ?`).bind(postId),
    sql.prepare(`DELETE FROM social_posts WHERE id = ?`).bind(postId),
    ...(legacy ? [
      sql.prepare(`DELETE FROM cybercab_review_photos WHERE review_id = ?`).bind(legacy),
      sql.prepare(`DELETE FROM cybercab_review_likes WHERE review_id = ?`).bind(legacy),
      sql.prepare(`DELETE FROM cybercab_review_comments WHERE review_id = ?`).bind(legacy),
      sql.prepare(`DELETE FROM cybercab_reviews WHERE id = ?`).bind(legacy)
    ] : [])
  ]);
  if (keys.length) { try { await env.EVIDENCE_BUCKET.delete(keys); } catch (e) { /* best effort */ } }
}

function modAction(sql, me, action, type, id, targetUserId, reason) {
  return sql.prepare(`INSERT INTO social_mod_actions (id, moderator_user_id, action, target_type, target_id, target_user_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), me.id, action, type, id, targetUserId || null, reason || null);
}

async function removePostAsModerator(sql, me, postId, reason) {
  const post = await sql.prepare(`SELECT id, user_id, status FROM social_posts WHERE id = ?`).bind(postId).first();
  if (!post) return false;
  await sql.batch([
    sql.prepare(`UPDATE social_posts SET status = 'removed', removed_by = ?, removed_at = datetime('now'), removed_reason = ? WHERE id = ?`).bind(me.id, reason || null, postId),
    sql.prepare(`UPDATE social_reports SET status = 'actioned', resolved_by = ?, resolved_at = datetime('now') WHERE status = 'open' AND target_type = 'post' AND target_id = ?`).bind(me.id, postId),
    modAction(sql, me, 'remove_post', 'post', postId, post.user_id, reason)
  ]);
  return true;
}

export async function apiDeleteSocialPost(request, env, postId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(postId || '')) return notFound();
  const post = await sql.prepare(`SELECT id, user_id FROM social_posts WHERE id = ?`).bind(postId).first();
  if (!post) return notFound();
  if (post.user_id === me.id) {
    await deletePostCompletely(env, postId);
    return Response.json({ success: true, deleted: true });
  }
  if (!me.moderator) return fail('forbidden', 403);
  let reason = null;
  try { const b = await request.json(); reason = typeof (b && b.reason) === 'string' ? b.reason.slice(0, 200) : null; } catch (e) { reason = null; }
  await removePostAsModerator(sql, me, postId, reason);
  return Response.json({ success: true, removed: true });
}

// ---- Likes ----

async function shownPostRow(sql, id) {
  if (!ID_RE.test(id || '')) return null;
  return sql.prepare(`SELECT p.id, p.user_id FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id WHERE p.id = ? AND ${SHOWN}`).bind(id).first();
}

export async function apiSetSocialLike(request, env, postId, liked) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!await shownPostRow(sql, postId)) return notFound();
  if (await bindingLimited(env, me.id)) return tooMany();
  await sql.prepare(liked
    ? `INSERT OR IGNORE INTO social_likes (post_id, user_id) VALUES (?, ?)`
    : `DELETE FROM social_likes WHERE post_id = ? AND user_id = ?`).bind(postId, me.id).run();
  const row = await sql.prepare(`SELECT like_count FROM social_posts WHERE id = ?`).bind(postId).first();
  return Response.json({ success: true, liked, like_count: Number(row ? row.like_count : 0) });
}

// ---- Comments ----

const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.parent_id, c.user_id, c.body, c.status, c.created_at, c.edited_at,
         u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url, x.xp
  FROM social_comments c JOIN users u ON u.id = c.user_id LEFT JOIN user_xp x ON x.user_id = c.user_id`;

function commentJson(row, me) {
  const removed = row.status !== 'visible';
  const mine = !!me && row.user_id === me.id;
  return {
    id: row.id,
    parent_id: row.parent_id || null,
    body: removed ? null : row.body,
    removed,
    created_at: row.created_at,
    edited_at: row.edited_at || null,
    author: removed ? { name: 'Removed', anonymous: true, rank: null, level: null, handle: null, avatar_url: null } : authorJson(row),
    mine: mine && !removed,
    can_edit: mine && !removed,
    can_delete: !removed && (mine || (!!me && me.moderator))
  };
}

export async function apiListSocialComments(request, env, postId) {
  const sql = env.cybercabhunter_db;
  if (!await shownPostRow(sql, postId)) return notFound();
  const me = await viewer(request, env);
  const cursor = decodeCursor(new URL(request.url).searchParams.get('cursor'));
  const after = cursor && typeof cursor.t === 'string' && typeof cursor.id === 'string' ? cursor : null;
  // Top-level comments, oldest first; a removed one only while it has visible replies.
  const tops = (await sql.prepare(`${COMMENT_SELECT}
      WHERE c.post_id = ? AND c.parent_id IS NULL
        AND (c.status = 'visible' OR EXISTS (SELECT 1 FROM social_comments r WHERE r.parent_id = c.id AND r.status = 'visible'))
        ${after ? 'AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))' : ''}
      ORDER BY c.created_at ASC, c.id ASC LIMIT ?`).bind(postId, ...(after ? [after.t, after.t, after.id] : []), COMMENTS_PAGE + 1).all()).results || [];
  const page = tops.slice(0, COMMENTS_PAGE);
  const replies = page.length ? ((await sql.prepare(`${COMMENT_SELECT}
      WHERE c.parent_id IN (${page.map(() => '?').join(',')}) AND c.status = 'visible'
      ORDER BY c.created_at ASC, c.id ASC LIMIT 300`).bind(...page.map(c => c.id)).all()).results || []) : [];
  const byParent = new Map();
  for (const r of replies) { if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []); byParent.get(r.parent_id).push(commentJson(r, me)); }
  const last = page[page.length - 1];
  return Response.json({
    comments: page.map(c => ({ ...commentJson(c, me), replies: byParent.get(c.id) || [] })),
    next_cursor: tops.length > COMMENTS_PAGE ? encodeCursor({ t: last.created_at, id: last.id }) : null
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function apiCreateSocialComment(request, env, postId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!await shownPostRow(sql, postId)) return notFound();
  if (await countSince(sql, 'social_comments', 'user_id', me.id, sqlNow(Date.now() - 3600000), LIMITS.commentsPerHour) >= LIMITS.commentsPerHour || await bindingLimited(env, me.id)) return tooMany();
  let payload = null;
  try { payload = await request.json(); } catch (e) { payload = null; }
  const body = readText(payload && payload.body, MAX_COMMENT_CHARS, { required: true });
  if (body.error) return fail(body.error);
  let parentId = null;
  if (payload && payload.parent_id) {
    const parent = await sql.prepare(`SELECT id, parent_id, post_id, status FROM social_comments WHERE id = ?`).bind(String(payload.parent_id)).first();
    if (!parent || parent.post_id !== postId) return fail('invalid_parent');
    parentId = parent.parent_id || parent.id;   // one level: a reply to a reply joins the same thread
    const top = parentId === parent.id ? parent : await sql.prepare(`SELECT status FROM social_comments WHERE id = ?`).bind(parentId).first();
    if (!top || top.status !== 'visible') return fail('invalid_parent');
  }
  const id = newId();
  await sql.prepare(`INSERT INTO social_comments (id, post_id, parent_id, user_id, body) VALUES (?, ?, ?, ?, ?)`).bind(id, postId, parentId, me.id, body.text).run();
  const [row, count] = await Promise.all([
    sql.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(id).first(),
    sql.prepare(`SELECT comment_count FROM social_posts WHERE id = ?`).bind(postId).first()
  ]);
  return Response.json({ success: true, comment: { ...commentJson(row, me), replies: [] }, comment_count: Number(count.comment_count) }, { status: 201 });
}

export async function apiUpdateSocialComment(request, env, commentId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(commentId || '')) return notFound();
  const c = await sql.prepare(`SELECT id, user_id, status FROM social_comments WHERE id = ?`).bind(commentId).first();
  if (!c || c.status !== 'visible') return notFound();
  if (c.user_id !== me.id) return fail('forbidden', 403);
  let payload = null;
  try { payload = await request.json(); } catch (e) { payload = null; }
  const body = readText(payload && payload.body, MAX_COMMENT_CHARS, { required: true });
  if (body.error) return fail(body.error);
  await sql.prepare(`UPDATE social_comments SET body = ?, edited_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(body.text, commentId, me.id).run();
  return Response.json({ success: true, comment: commentJson(await sql.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(commentId).first(), me) });
}

export async function apiDeleteSocialComment(request, env, commentId) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(commentId || '')) return notFound();
  const c = await sql.prepare(`SELECT id, user_id, post_id, status FROM social_comments WHERE id = ?`).bind(commentId).first();
  if (!c || c.status !== 'visible') return notFound();
  if (c.user_id === me.id) {
    // The author's own delete: the comment and its replies go.
    await sql.batch([
      sql.prepare(`UPDATE social_reports SET status = 'dismissed', resolved_at = datetime('now') WHERE status = 'open' AND target_type = 'comment' AND target_id IN (SELECT id FROM social_comments WHERE id = ? OR parent_id = ?)`).bind(commentId, commentId),
      sql.prepare(`DELETE FROM social_comments WHERE parent_id = ?`).bind(commentId),
      sql.prepare(`DELETE FROM social_comments WHERE id = ?`).bind(commentId)
    ]);
  } else if (me.moderator) {
    await removeCommentAsModerator(sql, me, c, null);
  } else {
    return fail('forbidden', 403);
  }
  const count = await sql.prepare(`SELECT comment_count FROM social_posts WHERE id = ?`).bind(c.post_id).first();
  return Response.json({ success: true, deleted: true, comment_count: Number(count ? count.comment_count : 0) });
}

async function removeCommentAsModerator(sql, me, c, reason) {
  await sql.batch([
    sql.prepare(`UPDATE social_comments SET status = 'removed', removed_by = ?, removed_at = datetime('now') WHERE id = ?`).bind(me.id, c.id),
    sql.prepare(`UPDATE social_reports SET status = 'actioned', resolved_by = ?, resolved_at = datetime('now') WHERE status = 'open' AND target_type = 'comment' AND target_id = ?`).bind(me.id, c.id),
    modAction(sql, me, 'remove_comment', 'comment', c.id, c.user_id, reason)
  ]);
}

// ---- Reports ----

export async function apiCreateSocialReport(request, env) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  let p = null;
  try { p = await request.json(); } catch (e) { p = null; }
  if (!p || !['post', 'comment'].includes(p.target_type) || !ID_RE.test(String(p.target_id || ''))) return fail('invalid_report');
  if (!REPORT_REASONS.includes(p.reason)) return fail('invalid_reason');
  const details = readText(p.details, 500);
  if (details.error) return fail(details.error);
  const target = p.target_type === 'post'
    ? await shownPostRow(sql, p.target_id)
    : await sql.prepare(`SELECT c.id, c.user_id FROM social_comments c WHERE c.id = ? AND c.status = 'visible'`).bind(p.target_id).first();
  if (!target) return notFound();
  if (target.user_id === me.id) return fail('cannot_report_own');
  if (await countSince(sql, 'social_reports', 'reporter_user_id', me.id, sqlNow(Date.now() - 86400000), LIMITS.reportsPerDay) >= LIMITS.reportsPerDay) return tooMany();
  const res = await sql.prepare(`
    INSERT INTO social_reports (id, target_type, target_id, target_user_id, reporter_user_id, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_type, target_id, reporter_user_id) DO NOTHING
  `).bind(newId(), p.target_type, p.target_id, target.user_id, me.id, p.reason, details.text || null).run();
  if (!res || !res.meta || !res.meta.changes) return fail('already_reported', 409);
  return Response.json({ success: true, reported: true }, { status: 201 });
}

// ---- Photos ----

export async function apiGetSocialPhoto(request, env, photoId) {
  const missing = () => new Response('Not found', { status: 404 });
  if (!ID_RE.test(photoId || '')) return missing();
  const sql = env.cybercabhunter_db;
  const row = await sql.prepare(`
    SELECT ph.r2_key, ph.content_type, (${SHOWN}) AS shown
    FROM social_post_photos ph JOIN social_posts p ON p.id = ph.post_id LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
    WHERE ph.id = ?`).bind(photoId).first();
  if (!row) return missing();
  let cache = 'public, max-age=3600';
  if (Number(row.shown) !== 1) {
    // A removed post's photos: moderators only (the moderation queue), never cached.
    const me = await viewer(request, env);
    if (!me || !me.moderator) return missing();
    cache = 'private, no-store';
  }
  const object = await env.EVIDENCE_BUCKET.get(row.r2_key);
  if (!object) return missing();
  return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } });
}

// ---- Sidebar: trending, stats, announcement (the same for everyone; edge-cached) ----

export async function apiSocialSidebar(request, env, ctx) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const key = new Request('https://cybercabhunter.com/api/social/sidebar', { method: 'GET' });
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const sql = env.cybercabhunter_db;
  const week = sqlNow(Date.now() - 7 * 86400000);
  const shownFrom = `FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id WHERE ${SHOWN}`;
  const [totals, weekRow, reviewRow, trendRows, ann] = await Promise.all([
    sql.prepare(`SELECT COUNT(*) AS posts, COUNT(DISTINCT p.user_id) AS contributors ${shownFrom}`).first(),
    sql.prepare(`SELECT COUNT(*) AS n ${shownFrom} AND p.created_at >= ?`).bind(week).first(),
    sql.prepare(`SELECT COUNT(*) AS n, AVG(r.rating) AS avg FROM social_post_reviews r JOIN social_posts p ON p.id = r.post_id LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id WHERE ${SHOWN}`).first(),
    sql.prepare(`SELECT p.id, p.body, p.category, p.like_count, p.comment_count, p.created_at ${shownFrom}
        AND p.created_at >= ? AND (p.like_count + p.comment_count) > 0
        ORDER BY (p.like_count + 2 * p.comment_count) DESC, p.created_at DESC LIMIT 5`).bind(week).all(),
    sql.prepare(`SELECT body, link_url, updated_at FROM social_announcements WHERE id = 1`).first()
  ]);
  const reviewsN = Number(reviewRow && reviewRow.n) || 0;
  const response = Response.json({
    stats: {
      posts: Number(totals && totals.posts) || 0,
      contributors: Number(totals && totals.contributors) || 0,
      posts_this_week: Number(weekRow && weekRow.n) || 0,
      reviews: reviewsN,
      average_rating: reviewsN ? Math.round(Number(reviewRow.avg) * 10) / 10 : null
    },
    trending: (trendRows.results || []).map(r => ({
      id: r.id, category: r.category, excerpt: String(r.body || '').slice(0, 120),
      like_count: Number(r.like_count), comment_count: Number(r.comment_count), url: `/community?post=${r.id}`
    })),
    announcement: ann ? { body: ann.body, link_url: ann.link_url || null, updated_at: ann.updated_at } : null
  }, { headers: { 'Cache-Control': `public, max-age=${SIDEBAR_CACHE_SECONDS}` } });
  if (cache) { const put = cache.put(key, response.clone()).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(put); }
  return response;
}

// ---- Moderation ----

async function requireMod(request, env) {
  const me = await viewer(request, env);
  if (!me) return { res: unauthenticated() };
  if (!me.moderator) return { res: fail('forbidden', 403) };
  return { me };
}

// Open reports, one entry per reported item, with what was said and who it is
// about (moderators see the real handle), plus that author's history.
export async function apiModerationSocialReports(request, env) {
  const { me, res } = await requireMod(request, env);
  if (res) return res;
  const sql = env.cybercabhunter_db;
  const groups = (await sql.prepare(`
    SELECT target_type, target_id, target_user_id, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at,
           GROUP_CONCAT(reason) AS reasons
    FROM social_reports WHERE status = 'open'
    GROUP BY target_type, target_id ORDER BY first_at ASC LIMIT 50`).all()).results || [];
  const out = [];
  for (const g of groups) {
    const [details, author, history] = await Promise.all([
      sql.prepare(`SELECT reason, details, created_at FROM social_reports WHERE status = 'open' AND target_type = ? AND target_id = ? ORDER BY created_at LIMIT 10`).bind(g.target_type, g.target_id).all(),
      g.target_user_id ? sql.prepare(`SELECT display_name, handle FROM users WHERE id = ?`).bind(g.target_user_id).first() : null,
      g.target_user_id ? sql.prepare(`SELECT
          (SELECT COUNT(*) FROM social_mod_actions WHERE target_user_id = ? AND action IN ('remove_post', 'remove_comment')) AS removals,
          (SELECT COUNT(*) FROM (SELECT 1 FROM social_posts WHERE user_id = ? AND created_at >= ? LIMIT 100)) AS posts_24h`).bind(g.target_user_id, g.target_user_id, sqlNow(Date.now() - 86400000)).first() : null
    ]);
    let target = null;
    if (g.target_type === 'post') {
      const post = await onePost(sql, g.target_id, me, { includeRemoved: true });
      if (post) target = { body: post.body, photos: post.photos, link_url: post.link_url, created_at: post.created_at, review: post.review, url: post.url };
    } else {
      const c = await sql.prepare(`SELECT id, post_id, body, created_at FROM social_comments WHERE id = ?`).bind(g.target_id).first();
      if (c) target = { body: c.body, created_at: c.created_at, url: `/community?post=${c.post_id}` };
    }
    out.push({
      target_type: g.target_type, target_id: g.target_id, report_count: Number(g.n), first_at: g.first_at, last_at: g.last_at,
      reasons: [...new Set(String(g.reasons || '').split(','))],
      details: ((details.results) || []).map(d => ({ reason: d.reason, details: d.details, created_at: d.created_at })),
      author: author ? { name: author.display_name || null, handle: author.handle || null } : null,
      author_history: history ? { removals: Number(history.removals), posts_24h: Number(history.posts_24h) } : null,
      target, target_missing: !target
    });
  }
  return Response.json({ success: true, reports: out }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function apiModerationSocialResolve(request, env) {
  const { me, res } = await requireMod(request, env);
  if (res) return res;
  const sql = env.cybercabhunter_db;
  let p = null;
  try { p = await request.json(); } catch (e) { p = null; }
  if (!p || !['post', 'comment'].includes(p.target_type) || !ID_RE.test(String(p.target_id || '')) || !['remove', 'dismiss'].includes(p.action)) return fail('invalid_body');
  const reason = typeof p.reason === 'string' ? p.reason.slice(0, 200) : null;
  if (p.action === 'dismiss') {
    const target = p.target_type === 'post'
      ? await sql.prepare(`SELECT user_id FROM social_posts WHERE id = ?`).bind(p.target_id).first()
      : await sql.prepare(`SELECT user_id FROM social_comments WHERE id = ?`).bind(p.target_id).first();
    await sql.batch([
      sql.prepare(`UPDATE social_reports SET status = 'dismissed', resolved_by = ?, resolved_at = datetime('now') WHERE status = 'open' AND target_type = ? AND target_id = ?`).bind(me.id, p.target_type, p.target_id),
      modAction(sql, me, 'dismiss_report', p.target_type, p.target_id, target ? target.user_id : null, reason)
    ]);
    return Response.json({ success: true, status: 'dismissed' });
  }
  if (p.target_type === 'post') {
    if (!await removePostAsModerator(sql, me, p.target_id, reason)) return notFound();
  } else {
    const c = await sql.prepare(`SELECT id, user_id, post_id, status FROM social_comments WHERE id = ?`).bind(p.target_id).first();
    if (!c) return notFound();
    await removeCommentAsModerator(sql, me, c, reason);
  }
  return Response.json({ success: true, status: 'removed' });
}

export async function apiModerationSocialAnnouncement(request, env, ctx) {
  const { me, res } = await requireMod(request, env);
  if (res) return res;
  const sql = env.cybercabhunter_db;
  if (request.method === 'DELETE') {
    await sql.batch([sql.prepare(`DELETE FROM social_announcements WHERE id = 1`), modAction(sql, me, 'announcement', 'announcement', '1', null, 'cleared')]);
  } else {
    let p = null;
    try { p = await request.json(); } catch (e) { p = null; }
    const body = readText(p && p.body, 280, { required: true });
    if (body.error) return fail(body.error);
    const link = readLink(p && p.link_url);
    if (link.error) return fail(link.error);
    await sql.batch([
      sql.prepare(`INSERT INTO social_announcements (id, body, link_url, updated_by, updated_at) VALUES (1, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, link_url = excluded.link_url, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).bind(body.text, link.url, me.id),
      modAction(sql, me, 'announcement', 'announcement', '1', null, 'set')
    ]);
  }
  // The sidebar is edge-cached: drop this location's copy so the change shows here at once.
  try { if (typeof caches !== 'undefined' && caches.default) await caches.default.delete(new Request('https://cybercabhunter.com/api/social/sidebar')); } catch (e) { /* expires in 2 min anyway */ }
  return Response.json({ success: true });
}
