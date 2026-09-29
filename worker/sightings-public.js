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

// The city filter buttons. "All" (no city) covers every city, including
// future ones without a button and sightings with no city.
export const SIGHTING_CITIES = { austin: 'Austin', dallas: 'Dallas', miami: 'Miami', orlando: 'Orlando' };
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

function encodeCursor(row) {
  return btoa(`${row.observed_at}|${row.public_id}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(raw) {
  try {
    const [observedAt, publicId] = atob(raw.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(observedAt) && PUBLIC_ID_RE.test(publicId)) return { observedAt, publicId };
  } catch (e) { /* invalid */ }
  return null;
}

// GET /api/sightings?city=all|austin|dallas|miami|orlando&limit=&cursor=
// -> { seen, sightings: [...], next_cursor }. `seen` is the live count for
// the selected filter (not just this page).
export async function apiListPublicSightings(request, env) {
  const params = new URL(request.url).searchParams;
  const cityParam = (params.get('city') || 'all').toLowerCase();
  if (cityParam !== 'all' && !SIGHTING_CITIES[cityParam]) {
    return Response.json({ success: false, error: 'invalid_city' }, { status: 400 });
  }
  const city = cityParam === 'all' ? null : cityParam;
  const rawLimit = params.get('limit');
  const limit = /^\d{1,3}$/.test(rawLimit || '') ? Math.min(Math.max(Number(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  let after = null;
  if (params.get('cursor')) {
    after = decodeCursor(params.get('cursor'));
    if (!after) return Response.json({ success: false, error: 'invalid_cursor' }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const [seen, rows] = await Promise.all([
    db.countPublicPhotoSightings(sql, { city }),
    db.getPublicPhotoSightings(sql, { city, limit: limit + 1, after })
  ]);
  const page = rows.slice(0, limit);
  return Response.json({
    seen,
    sightings: page.map(r => ({
      id: r.public_id,
      image_url: `/api/sightings/${r.public_id}/photo`,
      city: displayCity(r.service_area),
      location: r.approx_location || null,
      plate: r.license_plate || null,
      spotted_at: toIso(r.observed_at)
    })),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null
  }, { headers: { 'Cache-Control': 'public, max-age=60' } });
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
  return Response.json({ success: true, deleted: true });
}

export async function deleteSightingPhotoByPublicId(env, publicId, moderatorId) {
  if (!PUBLIC_ID_RE.test(publicId)) return notFound();
  const submissionId = await db.getSubmissionIdByPublicId(env.cybercabhunter_db, publicId);
  if (!submissionId) return notFound();
  return deleteSightingPhoto(env, submissionId, moderatorId);
}
