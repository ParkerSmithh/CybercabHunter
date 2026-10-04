// Public Cybercab Sightings gallery (public/sightings.html): approved photo
// sightings, newest first, filterable by city, with a live "Seen" count —
// plus the 30-day photo retention cleanup run by the scheduled handler.
//
// Built entirely on the existing photo-sighting records (worker/sightings.js
// creates them; moderation approves them): no second sighting system, and
// photos are served straight from the existing R2 evidence bucket — never
// copied. What counts as public lives in ONE place, db.js
// PUBLIC_PHOTO_SIGHTING_SQL (approved + photo still stored + public id +
// within 30 days), shared by the list, the counter and the photo route.
//
// Privacy: responses carry only city, approximate location, plate, date
// spotted and an image URL built from the sighting's random public_id.
// Never a user/submission/observation id, the R2 key, the submitter, the
// description, or moderation data.

import { db } from './db.js';
import { publicLocation } from './places.js';
import { timeZoneFor, usLocalParts } from './timezones.js';
import { SERVICE_AREAS, serviceAreaFor } from './service-areas.js';
import { removeSightingsFromMap } from './camera-sightings.js';

// The city filter buttons (Austin, Dallas). The API also answers city=all
// (every city, including sightings with no city), which the page no longer
// offers as a button.
// The filter cities are the service areas (worker/service-areas.js).
export const SIGHTING_CITIES = Object.fromEntries(SERVICE_AREAS.map(a => [a.key, a.name]));
const DISPLAY_CITIES = { ...SIGHTING_CITIES, houston: 'Houston', 'san antonio': 'San Antonio' };

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const PUBLIC_ID_RE = /^[0-9a-f]{32}$/;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXPIRY_BATCH = 10;   // photos deleted per scheduled run (Workers Free: 50 subrequests per invocation)

// "austin, tx" -> "Austin, TX"-style display: a known city gets its canonical
// name; anything else is shown as the submitter typed it (trimmed).
function displayCity(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const key = text.toLowerCase().split(',')[0].trim();
  return DISPLAY_CITIES[key] || text;
}

// observed_at is stored as UTC 'YYYY-MM-DD HH:MM:SS'.
const toIso = t => (t ? `${String(t).replace(' ', 'T')}Z` : null);

// The cursor carries the sort order it was made for, so a "most recent" page
// cursor can never be reused for "least recent" (it would skip or repeat).
function encodeCursor(row, order) {
  return btoa(`${row.observed_at}|${row.public_id}|${order}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(raw, order) {
  try {
    const [observedAt, publicId, cursorOrder = 'desc'] = atob(raw.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(observedAt) && PUBLIC_ID_RE.test(publicId) && cursorOrder === order) return { observedAt, publicId };
  } catch (e) { /* invalid */ }
  return null;
}

const STATS_DEFAULT_ZONE = 'America/Chicago';   // Austin and Dallas; also used for "all"
const PEAK_HOUR_MIN_SIGHTINGS = 2;
const pad2 = n => String(n).padStart(2, '0');

// The Sightings page's stat cards, from sighting timestamps (observed_at) in
// the city's local time: counts per UTC hour (db) are mapped to local
// date/hour with the US daylight-saving rule (timezones.js usLocalParts) —
// cheap enough for the Workers Free plan however long the history grows.
//   last_7_days  — exact trailing 7×24 h (counted in SQL)
//   today        — local calendar day
//   this_month   — local calendar month
//   peak_hour    — busiest local hour of day over all history {hour 0-23, count},
//                  ONLY when the data shows a clear one: that hour has at least
//                  PEAK_HOUR_MIN_SIGHTINGS sightings and more than any other
//                  hour. Otherwise null ("Not enough data yet") — never a
//                  tie-break guess.
//   best_day     — local date with the most sightings {date YYYY-MM-DD, count}
//   first_day    — local date of the earliest sighting (YYYY-MM-DD), so the
//                  page can say what "all history" covers
// Best-day ties: the more recent day.
export function buildSightingStats(buckets, zone, nowMs = Date.now()) {
  const now = usLocalParts(nowMs, zone);
  const today = `${now.y}-${pad2(now.m)}-${pad2(now.d)}`;
  const month = `${now.y}-${pad2(now.m)}`;
  const hours = new Array(24).fill(0);
  const days = new Map();
  let total = 0, last7 = 0;
  for (const b of buckets) {
    const n = Number(b.n) || 0;
    const ms = Date.parse(`${String(b.utc_hour).replace(' ', 'T')}:00:00Z`);
    if (!n || Number.isNaN(ms)) continue;
    const local = usLocalParts(ms, zone);
    const date = `${local.y}-${pad2(local.m)}-${pad2(local.d)}`;
    total += n;
    last7 += Number(b.last_7_days) || 0;
    hours[local.h] += n;
    days.set(date, (days.get(date) || 0) + n);
  }
  let peak = null;
  hours.forEach((count, hour) => { if (count > 0 && (!peak || count > peak.count)) peak = { hour, count }; });
  // A peak only when the data clearly shows one: enough sightings in that
  // hour and no other hour tied with it.
  if (peak && (peak.count < PEAK_HOUR_MIN_SIGHTINGS || hours.filter(c => c === peak.count).length > 1)) peak = null;
  let best = null;
  for (const [date, count] of days) if (!best || count > best.count || (count === best.count && date > best.date)) best = { date, count };
  let first = null;
  for (const date of days.keys()) if (!first || date < first) first = date;
  let thisMonth = 0;
  for (const [date, count] of days) if (date.startsWith(month)) thisMonth += count;
  return {
    time_zone: zone,
    total,
    last_7_days: last7,
    today: days.get(today) || 0,
    this_month: thisMonth,
    peak_hour: peak,
    best_day: best,
    first_day: first
  };
}

// GET /api/sightings?city=all|austin|dallas&order=desc|asc&limit=&cursor=&stats=1
// -> { seen, order, stats?, sightings: [...], next_cursor }. `stats` (with
// stats=1): see buildSightingStats. `seen` is the live count for
// the selected filter (not just this page).
// Responses are cached at the edge for LIST_CACHE_SECONDS (Cache API; works on
// the custom domain, where the Sightings page calls it). This protects D1's
// daily rows-read allowance from many open tabs polling once a minute — each
// poll's stats query scans the sighting history. It does NOT reduce Worker
// request counts: a request answered from the cache is still a request.
const LIST_CACHE_SECONDS = 30;

export async function apiListPublicSightings(request, env, ctx) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const params = new URL(request.url).searchParams;
  const cityParam = (params.get('city') || 'all').toLowerCase();
  if (cityParam !== 'all' && !SIGHTING_CITIES[cityParam]) {
    return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  }
  // Matched against the stored City, which is always the area's canonical name.
  const city = cityParam === 'all' ? null : SIGHTING_CITIES[cityParam].toLowerCase();
  const rawLimit = params.get('limit');
  const limit = /^\d{1,3}$/.test(rawLimit || '') ? Math.min(Math.max(Number(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  // Order: most recent first (default) or least recent first.
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';
  let after = null;
  if (params.get('cursor')) {
    after = decodeCursor(params.get('cursor'), order);
    if (!after) return Response.json({ success: false, error: 'invalid_cursor' }, { status: 400 });
  }
  const wantStats = params.get('stats') === '1';

  const sql = env.cybercabhunter_db;
  const [seen, rows, buckets] = await Promise.all([
    db.countPublicPhotoSightings(sql, { city }),
    db.getPublicPhotoSightings(sql, { city, limit: limit + 1, after, order }),
    wantStats ? db.getApprovedPhotoSightingHourBuckets(sql, { city }) : null
  ]);
  const page = rows.slice(0, limit);
  const area = cityParam === 'all' ? null : serviceAreaFor(cityParam);
  const statsZone = area && usLocalParts(0, area.timeZone) ? area.timeZone : STATS_DEFAULT_ZONE;
  const response = Response.json({
    seen,
    order,
    ...(wantStats ? { stats: buildSightingStats(buckets, statsZone) } : {}),
    sightings: page.map(r => ({
      id: r.public_id,
      image_url: `/api/sightings/${r.public_id}/photo`,
      city: displayCity(r.service_area),
      location: publicLocation(r.approx_location),   // street/place + city, never a house number
      plate: r.public_plate || null,                   // only a publicly eligible registry vehicle's plate
      cybercab: !!r.public_cybercab,                   // that vehicle is VIN verified (the registry's Cybercab label)
      spotted_at: toIso(r.observed_at),
      // The area's local time zone, so the time is shown as it was there
      // (e.g. Austin in US Central); null when the area is unknown.
      time_zone: timeZoneFor({ serviceArea: r.service_area, location: r.approx_location })
    })),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1], order) : null
  }, { headers: { 'Cache-Control': `public, max-age=${LIST_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}

const notFound = () => Response.json({ success: false, error: 'not_found' }, { status: 404 });

// Streams one R2 object as an image, trusting only the type recorded at
// upload (worker/sightings.js sniffs it from the file's bytes).
function imageResponse(object, cacheControl) {
  const type = (object.customMetadata && object.customMetadata.verifiedContentType)
    || (object.httpMetadata && object.httpMetadata.contentType);
  return new Response(object.body, {
    headers: {
      'Content-Type': PHOTO_TYPES.has(type) ? type : 'application/octet-stream',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline'
    }
  });
}

// GET /api/sightings/:publicId/photo — the photo of ONE currently public
// sighting. Anything else (unknown, pending, rejected, expired, malformed id)
// is the same 404: the R2 bucket is never addressable directly, only
// through a key looked up from an approved record. A photo that has gone
// missing from R2 is recorded as gone, so it immediately stops counting
// toward "Seen".
export async function apiGetPublicSightingPhoto(request, env, publicId) {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const sql = env.cybercabhunter_db;
  const row = await db.getPublicSightingPhoto(sql, publicId);
  if (!row) return notFound();
  const object = await env.EVIDENCE_BUCKET.get(row.evidence_ref);
  if (!object) {
    try { await db.clearSightingPhotos(sql, [row.submission_id]); } catch (e) { /* retried on the next request */ }
    return notFound();
  }
  return imageResponse(object, 'public, max-age=3600');
}

// Moderation queue: a sighting's photo for a signed-in moderator (the caller,
// worker/moderation.js, checks the role first). Never cached publicly.
export async function sightingPhotoForModerator(env, submissionId) {
  const ref = await db.getSightingPhotoRef(env.cybercabhunter_db, submissionId);
  if (!ref) return notFound();
  const object = await env.EVIDENCE_BUCKET.get(ref);
  if (!object) return notFound();
  return imageResponse(object, 'private, no-store');
}

// Scheduled: deletes sighting photos 30 days after submission (any status),
// a bounded batch per run, oldest first. The D1 sighting stays; only its
// storage key is cleared once the object is deleted. A failed delete leaves
// the key in place, so it is simply retried on a later run.
export async function expireSightingPhotos(env, { limit = EXPIRY_BATCH } = {}) {
  const sql = env.cybercabhunter_db;
  const due = await db.listExpiredSightingPhotos(sql, limit);
  const deleted = [];
  for (const row of due) {
    try {
      await env.EVIDENCE_BUCKET.delete(row.evidence_ref);
      deleted.push(row.submission_id);
    } catch (e) { /* retried next run */ }
  }
  await db.clearSightingPhotos(sql, deleted);
  // A traffic-camera sighting's copy on the Zones map expires with it.
  try { await removeSightingsFromMap(env, deleted); } catch (e) { /* best effort */ }
  return { due: due.length, deleted: deleted.length };
}

// Moderator "delete photo" (the caller, worker/moderation.js, checks the role
// first): deletes the R2 object, then records it (db.deleteSightingPhotoRecord).
// A failed R2 delete changes nothing, so it can simply be retried.
export async function deleteSightingPhoto(env, submissionId, moderatorId) {
  const sql = env.cybercabhunter_db;
  const ref = await db.getSightingPhotoRef(sql, submissionId);
  if (!ref) return notFound();
  try {
    await env.EVIDENCE_BUCKET.delete(ref);
  } catch (e) {
    return Response.json({ success: false, error: 'delete_failed' }, { status: 502 });
  }
  try {
    await db.deleteSightingPhotoRecord(sql, { submissionId, moderatorId });
  } catch (e) {
    // The object is gone; the public photo route also clears a missing photo.
    return Response.json({ success: false, error: 'record_update_failed' }, { status: 500 });
  }
  // A deleted photo leaves the Zones map too (its copy there, if any).
  try { await removeSightingsFromMap(env, [submissionId]); } catch (e) { /* best effort */ }
  return Response.json({ success: true, deleted: true });
}

export async function deleteSightingPhotoByPublicId(env, publicId, moderatorId) {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const submissionId = await db.getSubmissionIdByPublicId(env.cybercabhunter_db, publicId);
  if (!submissionId) return notFound();
  return deleteSightingPhoto(env, submissionId, moderatorId);
}
