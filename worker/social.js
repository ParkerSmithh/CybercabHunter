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
//   GET    /api/social/vehicles?q=                     public; registry search (plate, VIN, vehicle id) for the composer
//   PUT    /api/social/posts/:id/save                  signed in; private bookmark (DELETE removes it)
//   PUT    /api/social/posts/:id/pin                   moderators; at most MAX_PINS (DELETE unpins)
//   GET    /api/social/notifications?count_only=1      signed in; the rider's own notifications
//   POST   /api/social/notifications/read              signed in; JSON { ids: [...] } or { all: true }
//   GET    /api/moderation/social/reports              moderators: open reports, grouped per item
//   POST   /api/moderation/social/resolve              moderators: { target_type, target_id, action: remove|dismiss, reason? }
//   PUT    /api/moderation/social/announcement         moderators: { body, link_url?, notify? }
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
//   - Saved posts and notifications are private to their rider. Notifications:
//     never for your own actions, one row per event (dedupe_key), gone with the
//     post or comment they point at; likes, saves and notifications are 0 XP.
//   - An attached Cybercab is a registry link, never proof of a sighting.
//   - Removal by a moderator is a soft remove with an audit row
//     (social_mod_actions); an author's own delete removes the rows and photos.

import { tesla } from './tesla.js';
import { publicVehicleEligibleSql } from './ride-status.js';
import { sniffImage, stripMetadata } from './avatars.js';
import { sha256Hex } from './account.js';
import { publicPerson } from './reviews.js';
import { levelFor, rankFor } from './progression-levels.js';
import { normalizePlate, sqlNormalizedPlate } from './plate.js';

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
export const MAX_PINS = 3;           // community-wide pinned posts at once
const NOTIFICATIONS_PAGE = 30;
const MAX_MENTIONS = 5;              // @mentions notified per post or comment
const VEHICLE_SEARCH_LIMIT = 8;
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
         p.removed_reason, p.like_count, p.comment_count, p.has_photos, p.has_review, p.pinned, p.created_at, p.edited_at,
         u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url, x.xp,
         v.id AS vehicle_id, v.license_plate, v.model AS vehicle_model, v.vin AS vehicle_vin,
         v.service_area AS vehicle_area, v.approval_basis AS vehicle_basis,
         CASE WHEN v.id IS NOT NULL AND ${ELIGIBLE_V} THEN 1 ELSE 0 END AS vehicle_public,
         r.rating, r.vehicle_type, r.quoted_fare_cents, r.pickup_wait_minutes, r.ride_date,
         EXISTS (SELECT 1 FROM social_likes l WHERE l.post_id = p.id AND l.user_id = ?1) AS liked_by_me,
         EXISTS (SELECT 1 FROM social_saves sv WHERE sv.post_id = p.id AND sv.user_id = ?1) AS saved_by_me
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

// The public facts of a registry vehicle (the same fields /api/robotaxi-vehicles
// serves). `cybercab`: approved as a Cybercab (migrations/0025); the image is
// the site's generic Cybercab picture, never a photo of this car.
export function vehicleJson(v) {
  const cybercab = v.approval_basis === 'vin-verified' || v.approval_basis === 'manual';
  return {
    id: v.id,
    short_id: String(v.id).slice(0, 8),
    license_plate: v.license_plate || null,
    vin: v.vin || null,
    service_area: v.service_area || null,
    cybercab,
    image: cybercab ? '/images/dmv-cybercab.webp' : null,
    verified: true,                    // a public registry vehicle (not a verified sighting)
    url: `/vehicle/${v.id}`
  };
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
    // A linked registry vehicle, only while it is public (the registry's own
    // rule). A link, not a verified sighting. Removed or made private: no card.
    vehicle: row.vehicle_id && Number(row.vehicle_public) === 1 ? vehicleJson({
      id: row.vehicle_id, license_plate: row.license_plate, vin: row.vehicle_vin, service_area: row.vehicle_area, approval_basis: row.vehicle_basis
    }) : null,
    like_count: Number(row.like_count) || 0,
    comment_count: Number(row.comment_count) || 0,
    liked: !!me && Number(row.liked_by_me) === 1,
    saved: !!me && Number(row.saved_by_me) === 1,
    pinned: Number(row.pinned) === 1 && row.status === 'visible',
    can_pin: !!me && me.moderator && row.status === 'visible',
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
  const filter = ['foryou', 'latest', 'photos', 'reviews', 'saved'].includes(params.get('filter')) ? params.get('filter') : 'foryou';
  // For You has its own ranking and Latest is newest-first by definition;
  // Photos, Reviews and Saved take ?sort=new|popular.
  const sort = filter === 'foryou' ? 'ranked' : filter === 'latest' ? 'new' : (params.get('sort') === 'popular' ? 'popular' : 'new');
  const limit = Math.min(Math.max(Number(params.get('limit')) || FEED_DEFAULT, 1), FEED_MAX);
  const cursor = decodeCursor(params.get('cursor'));
  const me = await viewer(request, env);
  const viewerJson = { signed_in: !!me, moderator: !!(me && me.moderator) };
  if (filter === 'saved' && !me) return Response.json({ authenticated: false, error: 'sign_in_required', viewer: viewerJson }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  // Community pins sit above For You and Latest (first page only) and are left
  // out of those lists below them, so a pinned post never shows twice.
  const withPins = filter === 'foryou' || filter === 'latest';
  const extra = filter === 'photos' ? ' AND p.has_photos = 1' : filter === 'reviews' ? ' AND p.has_review = 1' : withPins ? ' AND p.pinned = 0' : '';
  const shownFrom = `FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id WHERE ${SHOWN}${extra}`;
  let ids, next = null;
  if (filter === 'saved' && sort === 'popular') {
    // The rider's bookmarks ranked like Most popular (the newest RANKED_WINDOW saves).
    const at = cursor && Number.isFinite(cursor.at) ? cursor.at : Date.now();
    const offset = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
    const rows = (await sql.prepare(`SELECT p.id, p.created_at, p.like_count, p.comment_count
        FROM social_saves s JOIN social_posts p ON p.id = s.post_id LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
        WHERE s.user_id = ? AND ${SHOWN} ORDER BY s.created_at DESC, s.post_id DESC LIMIT ${RANKED_WINDOW}`).bind(me.id).all()).results || [];
    rows.sort((a, b) => postScore(b, at, 0.8) - postScore(a, at, 0.8) || (a.created_at < b.created_at ? 1 : -1));
    ids = rows.slice(offset, offset + limit).map(r => r.id);
    if (rows.length > offset + limit) next = encodeCursor({ at, o: offset + limit });
  } else if (filter === 'saved') {
    // The rider's own bookmarks, most recently saved first; a post that is no
    // longer shown drops out (its save row stays until the post is deleted).
    const after = cursor && typeof cursor.t === 'string' && typeof cursor.id === 'string' ? cursor : null;
    const rows = (await sql.prepare(`SELECT s.post_id AS id, s.created_at AS saved_at
        FROM social_saves s JOIN social_posts p ON p.id = s.post_id LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
        WHERE s.user_id = ? AND ${SHOWN}
        ${after ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.post_id < ?))' : ''}
        ORDER BY s.created_at DESC, s.post_id DESC LIMIT ?`).bind(me.id, ...(after ? [after.t, after.t, after.id] : []), limit + 1).all()).results || [];
    ids = rows.slice(0, limit).map(r => r.id);
    if (rows.length > limit) { const last = rows[limit - 1]; next = encodeCursor({ t: last.saved_at, id: last.id }); }
  } else if (sort === 'new') {
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
  let pinnedIds = [];
  if (withPins && !cursor) {
    pinnedIds = ((await sql.prepare(`SELECT p.id FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
        WHERE p.pinned = 1 AND ${SHOWN} ORDER BY p.pinned_at DESC, p.id DESC LIMIT ${MAX_PINS}`).all()).results || []).map(r => r.id);
  }
  const posts = await postsByIds(sql, [...pinnedIds, ...ids], me);
  return Response.json({ filter, sort, posts, next_cursor: next, viewer: viewerJson }, { headers: { 'Cache-Control': 'private, no-store' } });
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
  await notify(sql, await mentionNotices(sql, fields.body, { actorId: me.id, postId: id }));
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
  await notify(sql, await mentionNotices(sql, fields.body, { actorId: me.id, postId }));
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
    sql.prepare(`DELETE FROM social_notifications WHERE post_id = ?`).bind(postId),
    sql.prepare(`DELETE FROM social_saves WHERE post_id = ?`).bind(postId),
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
    sql.prepare(`UPDATE social_posts SET status = 'removed', removed_by = ?, removed_at = datetime('now'), removed_reason = ?, pinned = 0, pinned_at = NULL WHERE id = ?`).bind(me.id, reason || null, postId),
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

// ---- Notifications (written by the actions below; read by the rider only) ----

// "@handle" in text: handles are [a-z0-9_]{3,20} (worker/profile.js), matched
// case-insensitively and only when the @ starts a word (not an email address).
export function mentionedHandles(text) {
  const out = new Set();
  const re = /(^|[^A-Za-z0-9_@.])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g;
  let m;
  while ((m = re.exec(String(text || ''))) && out.size < MAX_MENTIONS) out.add(m[2].toLowerCase());
  return [...out];
}

// One notification per event (dedupe_key is UNIQUE), never for yourself.
function notifyStmt(sql, { userId, type, actorId, postId, commentId = null, key }) {
  if (!userId || userId === actorId) return null;
  return sql.prepare(`INSERT OR IGNORE INTO social_notifications (id, user_id, type, actor_user_id, post_id, comment_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), userId, type, actorId, postId, commentId, key);
}
async function notify(sql, list) {
  const stmts = list.map(n => notifyStmt(sql, n)).filter(Boolean);
  if (!stmts.length) return;
  try { await sql.batch(stmts); } catch (e) { /* a notification never fails the action itself */ }
}
// Mentions in a post or comment: matched to real accounts by handle.
async function mentionNotices(sql, text, { actorId, postId, commentId = null, skip = [] }) {
  const handles = mentionedHandles(text);
  if (!handles.length) return [];
  const rows = (await sql.prepare(`SELECT id FROM users WHERE handle IN (${handles.map(() => '?').join(',')})`).bind(...handles).all()).results || [];
  return rows.filter(u => !skip.includes(u.id)).map(u => ({ userId: u.id, type: 'mention', actorId, postId, commentId, key: `mention:${commentId || postId}:${u.id}` }));
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
  const post = await shownPostRow(sql, postId);
  if (!post) return notFound();
  if (await bindingLimited(env, me.id)) return tooMany();
  await sql.prepare(liked
    ? `INSERT OR IGNORE INTO social_likes (post_id, user_id) VALUES (?, ?)`
    : `DELETE FROM social_likes WHERE post_id = ? AND user_id = ?`).bind(postId, me.id).run();
  const key = `like:${postId}:${me.id}`;
  if (liked) await notify(sql, [{ userId: post.user_id, type: 'like', actorId: me.id, postId, key }]);
  else await sql.prepare(`DELETE FROM social_notifications WHERE dedupe_key = ? AND read_at IS NULL`).bind(key).run();
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
  const post = await shownPostRow(sql, postId);
  if (!post) return notFound();
  if (await countSince(sql, 'social_comments', 'user_id', me.id, sqlNow(Date.now() - 3600000), LIMITS.commentsPerHour) >= LIMITS.commentsPerHour || await bindingLimited(env, me.id)) return tooMany();
  let payload = null;
  try { payload = await request.json(); } catch (e) { payload = null; }
  const body = readText(payload && payload.body, MAX_COMMENT_CHARS, { required: true });
  if (body.error) return fail(body.error);
  let parentId = null, repliedTo = null;
  if (payload && payload.parent_id) {
    const parent = await sql.prepare(`SELECT id, parent_id, post_id, status, user_id FROM social_comments WHERE id = ?`).bind(String(payload.parent_id)).first();
    if (!parent || parent.post_id !== postId) return fail('invalid_parent');
    parentId = parent.parent_id || parent.id;   // one level: a reply to a reply joins the same thread
    const top = parentId === parent.id ? parent : await sql.prepare(`SELECT status FROM social_comments WHERE id = ?`).bind(parentId).first();
    if (!top || top.status !== 'visible') return fail('invalid_parent');
    repliedTo = parent.status === 'visible' ? parent.user_id : null;   // whoever was actually replied to
  }
  const id = newId();
  await sql.prepare(`INSERT INTO social_comments (id, post_id, parent_id, user_id, body) VALUES (?, ?, ?, ?, ?)`).bind(id, postId, parentId, me.id, body.text).run();
  const notices = [];
  if (repliedTo) notices.push({ userId: repliedTo, type: 'reply', actorId: me.id, postId, commentId: id, key: `reply:${id}` });
  if (post.user_id !== repliedTo) notices.push({ userId: post.user_id, type: 'comment', actorId: me.id, postId, commentId: id, key: `comment:${id}` });
  notices.push(...await mentionNotices(sql, body.text, { actorId: me.id, postId, commentId: id, skip: [repliedTo, post.user_id] }));
  await notify(sql, notices);
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
  const c = await sql.prepare(`SELECT id, user_id, post_id, status FROM social_comments WHERE id = ?`).bind(commentId).first();
  if (!c || c.status !== 'visible') return notFound();
  if (c.user_id !== me.id) return fail('forbidden', 403);
  let payload = null;
  try { payload = await request.json(); } catch (e) { payload = null; }
  const body = readText(payload && payload.body, MAX_COMMENT_CHARS, { required: true });
  if (body.error) return fail(body.error);
  await sql.prepare(`UPDATE social_comments SET body = ?, edited_at = datetime('now') WHERE id = ? AND user_id = ?`).bind(body.text, commentId, me.id).run();
  await notify(sql, await mentionNotices(sql, body.text, { actorId: me.id, postId: c.post_id, commentId }));
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
      sql.prepare(`DELETE FROM social_notifications WHERE comment_id IN (SELECT id FROM social_comments WHERE id = ? OR parent_id = ?)`).bind(commentId, commentId),
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

// ---- Saved posts (private bookmarks; no notification, no XP) ----

export async function apiSetSocialSave(request, env, postId, saved) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  if (!ID_RE.test(postId || '')) return notFound();
  if (saved && !await shownPostRow(sql, postId)) return notFound();
  await sql.prepare(saved
    ? `INSERT OR IGNORE INTO social_saves (user_id, post_id) VALUES (?, ?)`
    : `DELETE FROM social_saves WHERE user_id = ? AND post_id = ?`).bind(me.id, postId).run();
  return Response.json({ success: true, saved });
}

// ---- Community pins (moderators; at most MAX_PINS shown at once) ----

export async function apiSetSocialPin(request, env, postId, pinned) {
  const { me, res } = await requireMod(request, env);
  if (res) return res;
  const sql = env.cybercabhunter_db;
  const post = await shownPostRow(sql, postId);
  if (!post) return notFound();
  if (pinned) {
    const row = await sql.prepare(`SELECT COUNT(*) AS n FROM social_posts p LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
        WHERE p.pinned = 1 AND p.id <> ? AND ${SHOWN}`).bind(postId).first();
    if (Number(row && row.n) >= MAX_PINS) return fail('too_many_pins', 409, { max: MAX_PINS });
  }
  await sql.batch([
    pinned
      ? sql.prepare(`UPDATE social_posts SET pinned = 1, pinned_at = COALESCE(CASE WHEN pinned = 1 THEN pinned_at END, datetime('now')), pinned_by = ? WHERE id = ?`).bind(me.id, postId)
      : sql.prepare(`UPDATE social_posts SET pinned = 0, pinned_at = NULL, pinned_by = NULL WHERE id = ?`).bind(postId),
    modAction(sql, me, pinned ? 'pin_post' : 'unpin_post', 'post', postId, post.user_id, null)
  ]);
  return Response.json({ success: true, pinned });
}

// ---- Notifications (the rider's own; nothing here is public) ----

const NOTIFICATION_TEXT = {
  comment: 'commented on your post',
  reply: 'replied to your comment',
  like: 'liked your post',
  mention: 'mentioned you'
};

// The optional announcement notice: one row for everyone (no fan-out); it is
// unread for a rider until they mark notifications read after it was posted.
async function announcementNotice(sql, me) {
  const ann = await sql.prepare(`SELECT a.body, a.link_url, a.updated_at, a.notify, st.announcement_read_at
      FROM social_announcements a LEFT JOIN social_notification_state st ON st.user_id = ? WHERE a.id = 1`).bind(me.id).first();
  if (!ann || Number(ann.notify) !== 1) return null;
  return {
    id: 'announcement',
    type: 'announcement',
    actor: { name: 'Cybercab Hunter', handle: null, avatar_url: null, anonymous: false, official: true },
    text: 'posted an announcement',
    excerpt: String(ann.body).slice(0, 140),
    url: ann.link_url || '/community',
    created_at: ann.updated_at,
    read: !!ann.announcement_read_at && ann.announcement_read_at >= ann.updated_at
  };
}

// Only notifications whose post (and comment) is still shown to the public.
const NOTIFICATION_FROM = `
  FROM social_notifications n
  JOIN social_posts p ON p.id = n.post_id
  LEFT JOIN robotaxi_vehicles v ON v.id = p.robotaxi_vehicle_id
  LEFT JOIN social_comments c ON c.id = n.comment_id
  WHERE n.user_id = ? AND ${SHOWN} AND (n.comment_id IS NULL OR c.status = 'visible')`;

export async function apiListSocialNotifications(request, env) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  const countOnly = new URL(request.url).searchParams.get('count_only') === '1';
  const [unreadRow, ann] = await Promise.all([
    sql.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${NOTIFICATION_FROM} AND n.read_at IS NULL LIMIT 100)`).bind(me.id).first(),
    announcementNotice(sql, me)
  ]);
  const unread = Number(unreadRow ? unreadRow.n : 0) + (ann && !ann.read ? 1 : 0);
  const headers = { 'Cache-Control': 'private, no-store' };
  if (countOnly) return Response.json({ unread }, { headers });
  const rows = (await sql.prepare(`SELECT n.id, n.type, n.post_id, n.comment_id, n.read_at, n.created_at,
        COALESCE(c.body, p.body) AS excerpt,
        u.leaderboard_opt_in AS opt_in, u.display_name, u.handle, u.avatar_url
      ${NOTIFICATION_FROM.replace('WHERE n.user_id', 'JOIN users u ON u.id = n.actor_user_id WHERE n.user_id')}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${NOTIFICATIONS_PAGE}`).bind(me.id).all()).results || [];
  const items = rows.map(r => ({
    id: r.id,
    type: r.type,
    actor: publicPerson(r),
    text: NOTIFICATION_TEXT[r.type],
    excerpt: String(r.excerpt || '').slice(0, 140),
    url: `/community?post=${r.post_id}${r.comment_id ? `&comment=${r.comment_id}` : ''}`,
    created_at: r.created_at,
    read: !!r.read_at
  }));
  if (ann) items.push(ann);
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return Response.json({ unread, notifications: items.slice(0, NOTIFICATIONS_PAGE) }, { headers });
}

export async function apiReadSocialNotifications(request, env) {
  const me = await viewer(request, env);
  if (!me) return unauthenticated();
  const sql = env.cybercabhunter_db;
  let p = null;
  try { p = await request.json(); } catch (e) { p = null; }
  const ids = p && Array.isArray(p.ids) ? p.ids.map(String).slice(0, 100) : [];
  const stmts = [];
  if (p && p.all === true) {
    stmts.push(sql.prepare(`UPDATE social_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).bind(me.id));
  } else {
    const real = ids.filter(id => ID_RE.test(id));
    // Only the rider's own rows can change (user_id = me): someone else's id does nothing.
    if (real.length) stmts.push(sql.prepare(`UPDATE social_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${real.map(() => '?').join(',')})`).bind(me.id, ...real));
  }
  if ((p && p.all === true) || ids.includes('announcement')) {
    stmts.push(sql.prepare(`INSERT INTO social_notification_state (user_id, announcement_read_at) VALUES (?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET announcement_read_at = excluded.announcement_read_at`).bind(me.id));
  }
  if (!stmts.length) return fail('invalid_body');
  await sql.batch(stmts);
  return Response.json({ success: true });
}

// ---- Registry search for the composer's Cybercab picker ----
// Public vehicles only (the registry's own rule), by license plate, VIN or the
// vehicle's id (the one in its /vehicle/<id> link); partial and
// case-insensitive. Only the public registry fields come back. With no query:
// the most recently seen. Cheap: no per-vehicle ride statistics.
export async function apiSearchSocialVehicles(request, env) {
  const raw = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 40);
  const compact = normalizePlate(raw) || '';   // A-Z0-9 only, the registry's own rule (worker/plate.js)
  const idLike = /^[0-9a-f-]{3,36}$/i.test(raw) ? raw.toLowerCase() : null;
  const norm = sqlNormalizedPlate('v.license_plate');
  let where = '', binds = [], order = 'COALESCE(v.last_seen_at, v.created_at) DESC';
  if (raw) {
    if (!compact) return Response.json({ q: raw, vehicles: [] }, { headers: { 'Cache-Control': 'public, max-age=60' } });
    where = ` AND (${norm} LIKE ? OR UPPER(COALESCE(v.vin, '')) LIKE ?${idLike ? ' OR v.id LIKE ?' : ''})`;
    binds = [`%${compact}%`, `%${compact}%`, ...(idLike ? [`${idLike}%`] : [])];
    // Exact and prefix matches first, then the most recently seen.
    order = `(${norm} = ?) DESC, (UPPER(COALESCE(v.vin, '')) = ?) DESC, (${norm} LIKE ?) DESC, ${order}`;
    binds.push(compact, compact, `${compact}%`);
  }
  const rows = (await env.cybercabhunter_db.prepare(`
    SELECT v.id, v.license_plate, v.vin, v.service_area, v.approval_basis
    FROM robotaxi_vehicles v
    WHERE ${ELIGIBLE_V}${where}
    ORDER BY ${order}, v.id
    LIMIT ${VEHICLE_SEARCH_LIMIT}`).bind(...binds).all()).results || [];
  return Response.json({ q: raw, vehicles: rows.map(vehicleJson) }, { headers: { 'Cache-Control': 'public, max-age=60' } });
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
      sql.prepare(`INSERT INTO social_announcements (id, body, link_url, updated_by, updated_at, notify) VALUES (1, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, link_url = excluded.link_url, updated_by = excluded.updated_by, updated_at = excluded.updated_at, notify = excluded.notify`).bind(body.text, link.url, me.id, p && p.notify === true ? 1 : 0),
      modAction(sql, me, 'announcement', 'announcement', '1', null, 'set')
    ]);
  }
  // The sidebar is edge-cached: drop this location's copy so the change shows here at once.
  try { if (typeof caches !== 'undefined' && caches.default) await caches.default.delete(new Request('https://cybercabhunter.com/api/social/sidebar')); } catch (e) { /* expires in 2 min anyway */ }
  return Response.json({ success: true });
}

// ---- Link previews for shared posts (/community?post=<id>) ----
// The Community page is static; for a post link the Worker fills in its
// Open Graph tags from the post (public posts only — a removed,
// hidden or unknown post gets the page's own tags). Text only; quotes and
// angle brackets are dropped so nothing can break out of an attribute.
const META_SITE = 'https://cybercabhunter.com';
const metaText = (v, max) => {
  const t = String(v || '').replace(/["<>]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};
export function socialMetaFor(post) {
  const who = post.author && !post.author.anonymous ? post.author.name : 'a Cybercab Hunter';
  const title = metaText(post.review ? `Ride review by ${who}` : `Post by ${who}`, 80) + ' | Cybercab Hunter Community';
  const description = metaText(post.body || (post.review ? `${post.review.rating} out of 5 stars` : 'A photo from the Cybercab Hunter community.'), 200);
  const image = post.photos && post.photos[0] ? META_SITE + post.photos[0].url : `${META_SITE}/images/CybercabAnimation-poster.jpg`;
  return { title, description, image, url: META_SITE + post.url };
}

export async function socialPostMeta(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const postId = new URL(request.url).searchParams.get('post');
  if (!postId || !ID_RE.test(postId) || !asset.ok || typeof HTMLRewriter === 'undefined') return asset;
  let post = null;
  try { post = await onePost(env.cybercabhunter_db, postId, null); } catch (e) { post = null; }
  if (!post) return asset;
  const m = socialMetaFor(post);
  const set = (value) => ({ element(el) { el.setAttribute('content', value); } });
  return new HTMLRewriter()
    .on('meta[name="description"]', set(m.description))
    .on('meta[property="og:title"]', set(m.title))
    .on('meta[property="og:description"]', set(m.description))
    .on('meta[property="og:image"]', set(m.image))
    .on('meta[property="og:url"]', set(m.url))
    .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', m.url); } })
    .on('meta[name="twitter:title"]', set(m.title))
    .on('meta[name="twitter:description"]', set(m.description))
    .on('meta[name="twitter:image"]', set(m.image))
    .on('meta[name="twitter:card"]', set(post.photos && post.photos.length ? 'summary_large_image' : 'summary'))
    .transform(asset);
}
