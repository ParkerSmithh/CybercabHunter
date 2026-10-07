// Cybercabs spotted by the hourly traffic-camera watch, for the Zones page map.
//
//   GET  /api/camera-sightings                 public
//     -> [{ camera_id, camera_name, lat, lng, observed_at, image_url }]
//        Detections from the trailing 24 hours, ONE per camera (its latest),
//        newest first. image_url is null while a detection has no stored image.
//
//   GET  /api/camera-sightings/<id>/image      public
//     -> the stored JPEG (R2 is not public; the Worker serves it).
//
//   POST /api/camera-sightings                 the camera watch (server-to-server)
//     Authorization: Bearer <CAMERA_WATCH_TOKEN>
//     { camera_id, camera_name, lat, lng, observed_at, image_base64 }
//       camera_id    the city's camera id, e.g. "65" (letters, digits, - _; up to 32)
//       camera_name  e.g. "MARTIN LUTHER KING JR BLVD / TRINITY ST" (up to 120)
//       lat, lng     the camera's coordinates; must be inside the Austin metro box
//       observed_at  ISO 8601 with a zone ("2026-09-30T01:24:33Z"); not in the future
//       image_base64 the capture as a base64 JPEG (a data: prefix is allowed), up to 2 MB
//     -> 201 { ok: true, id, image_url }, or 200 { ok: true, duplicate: true, id, image_url }
//        when that camera already has a detection at that exact time (a retry;
//        the stored image is replaced with the new bytes).
//     The image is stored at camera-captures/<camera_id>/<YYYYMMDDTHHMMSSZ>.jpg.
//     Errors: 503 not_configured, 401 unauthorized, 400 invalid_body /
//     unknown_field / invalid_<field> / image_too_large / not_jpeg.
//
// Moderator path (no token, no re-upload): an approved photo sighting that was
// captured from one of the traffic cameras (public/data/traffic-cameras.json)
// becomes a detection too — see placeSightingOnMap below. It runs inside the
// moderator's own authenticated request (Approve, or "Add to map"), copies the
// sighting's already-stored photo, and records the sighting as the row's
// source_submission_id (one map row per sighting).
//
// Authenticated by its own Worker secret (env.CAMERA_WATCH_TOKEN), the same
// bearer pattern as the Muse endpoints (worker/connector.js), never a browser
// session, so it can be rotated or revoked alone. The body is not read before
// the credential is verified. No CORS on the POST.
//
// Privacy: captures are plateless wide shots of public intersections. This
// data is never joined to robotaxi_vehicles — no plate, no VIN, no registry link.

import { tokensMatch, readBearerToken } from './connector.js';
import { serviceAreaFor, isInServiceArea } from './service-areas.js';
import { trafficCameraFor } from './traffic-cameras.js';

const WINDOW_MS = 24 * 3600 * 1000;
// Edge cache for the public list (Cache API; works on the custom domain). The
// map refreshes every 60s; this keeps many open tabs to ~one D1 read a minute.
const LIST_CACHE_SECONDS = 60;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ALLOWED_FIELDS = new Set(['camera_id', 'camera_name', 'lat', 'lng', 'observed_at', 'image_base64']);
const CAMERA_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DETECTION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const WATCH_AREA = serviceAreaFor('austin');

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const fail = (status, error, headers) => Response.json({ ok: false, error }, { status, headers });
const imageUrl = row => (row.image_r2_key ? `/api/camera-sightings/${row.id}/image` : null);

// "YYYY-MM-DDTHH:MM:SSZ" — the one stored form (whole seconds, UTC).
export const toStoredIso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Whether a detection with this observed_at is in the public Zones feed right
// now: the same window as the list query below. The moderation page reports
// "on the Zones map" only when this is true (a capture filed over 24 hours
// before it is placed gets a row the map never shows; 2026-10-06).
export function onLiveMap(observedAt, now = Date.now()) {
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) && ms >= now - WINDOW_MS && ms <= now + MAX_FUTURE_SKEW_MS;
}

export async function apiListCameraSightings(request, env, ctx, { now = Date.now() } = {}) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const { results } = await env.cybercabhunter_db.prepare(
    `SELECT id, camera_id, camera_name, lat, lng, observed_at, image_r2_key FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY camera_id ORDER BY observed_at DESC, created_at DESC, id DESC) AS rn
       FROM camera_detections
       WHERE observed_at >= ? AND observed_at <= ?
     ) WHERE rn = 1
     ORDER BY observed_at DESC, camera_id`
  ).bind(toStoredIso(now - WINDOW_MS), toStoredIso(now + MAX_FUTURE_SKEW_MS)).all();
  const response = Response.json((results || []).map(r => ({
    camera_id: r.camera_id,
    camera_name: r.camera_name,
    lat: r.lat,
    lng: r.lng,
    observed_at: r.observed_at,
    image_url: imageUrl(r)
  })), { headers: { 'Cache-Control': `public, max-age=${LIST_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}

// GET /api/camera-sightings/history?from=<ISO>&to=<ISO>[&cursor=..][&limit=..]
// Public. EVERY detection in the window (not just each camera's latest — that
// is the Zones map feed above, unchanged), oldest first, for the /replay page:
//   -> { from, to, detections: [{ t, lat, lng, camera_id, camera_name, source }], next_cursor }
//   source: 'watch' (the hourly camera watch) | 'spotter' (an approved photo
//   sighting filed with a traffic camera — placeSightingOnMap below).
// The window is at most HISTORY_MAX_DAYS and may not end in the future; pages
// are keyset-paginated by (observed_at, id). Only public data: no image, no
// detection or submission id, and a spotter detection only while its sighting
// is still approved with its photo stored (deleting the photo removes the row
// anyway — this is a second guard). Edge-cached like the list.
const HISTORY_MAX_DAYS = 31;
const HISTORY_DEFAULT_LIMIT = 500;
const HISTORY_MAX_LIMIT = 1000;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export async function apiCameraSightingsHistory(request, env, ctx, { now = Date.now() } = {}) {
  const params = new URL(request.url).searchParams;
  const fromRaw = params.get('from'), toRaw = params.get('to');
  if (!ISO_Z_RE.test(fromRaw || '') || !ISO_Z_RE.test(toRaw || '')) return fail(400, 'invalid_range');
  const fromMs = Date.parse(fromRaw), toMs = Date.parse(toRaw);
  if (!(toMs > fromMs) || toMs - fromMs > HISTORY_MAX_DAYS * 86400000 || toMs > now + MAX_FUTURE_SKEW_MS) return fail(400, 'invalid_range');
  const rawLimit = params.get('limit');
  const limit = /^\d{1,4}$/.test(rawLimit || '') ? Math.min(Math.max(Number(rawLimit), 1), HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
  let after = null;
  if (params.get('cursor')) {
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\|([A-Za-z0-9-]{1,64})$/.exec(params.get('cursor'));
    if (!m) return fail(400, 'invalid_cursor');
    after = { t: m[1], id: m[2] };
  }

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  const from = toStoredIso(fromMs), to = toStoredIso(toMs);
  const { results } = await env.cybercabhunter_db.prepare(`
    SELECT d.id, d.camera_id, d.camera_name, d.lat, d.lng, d.observed_at, d.source_submission_id
    FROM camera_detections d
    WHERE d.observed_at >= ? AND d.observed_at < ?
      ${after ? 'AND (d.observed_at > ? OR (d.observed_at = ? AND d.id > ?))' : ''}
      AND (d.source_submission_id IS NULL OR EXISTS (
        SELECT 1 FROM submissions s WHERE s.id = d.source_submission_id
          AND s.submission_type = 'vehicle_sighting' AND s.status = 'approved' AND s.evidence_ref IS NOT NULL))
    ORDER BY d.observed_at ASC, d.id ASC
    LIMIT ?
  `).bind(...[from, to, ...(after ? [after.t, after.t, after.id] : []), limit + 1]).all();
  const rows = results || [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const response = Response.json({
    from, to,
    detections: page.map(r => ({
      t: r.observed_at, lat: r.lat, lng: r.lng, camera_id: r.camera_id, camera_name: r.camera_name,
      source: r.source_submission_id ? 'spotter' : 'watch'
    })),
    next_cursor: rows.length > limit ? `${last.observed_at}|${last.id}` : null
  }, { headers: { 'Cache-Control': `public, max-age=${LIST_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
}

export async function apiGetCameraSightingImage(request, env, id) {
  const notFound = () => new Response('Not found', { status: 404 });
  if (!DETECTION_ID_RE.test(id)) return notFound();
  const row = await env.cybercabhunter_db.prepare('SELECT image_r2_key FROM camera_detections WHERE id = ?').bind(id).first();
  if (!row || !row.image_r2_key) return notFound();
  const object = await env.EVIDENCE_BUCKET.get(row.image_r2_key);
  if (!object) return notFound();
  // Watch uploads are JPEG; a sighting's photo keeps its own (verified) type.
  const type = object.httpMetadata && object.httpMetadata.contentType;
  return new Response(object.body, {
    headers: {
      'Content-Type': IMAGE_EXT[type] ? type : 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline'
    }
  });
}

function decodeJpegBase64(value) {
  if (typeof value !== 'string' || !value) return { error: 'invalid_image_base64' };
  const b64 = value.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) return { error: 'invalid_image_base64' };
  if (b64.length * 3 / 4 > MAX_IMAGE_BYTES + 3) return { error: 'image_too_large' };
  let binary;
  try { binary = atob(b64); } catch (e) { return { error: 'invalid_image_base64' }; }
  if (binary.length > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8 || bytes[2] !== 0xFF) return { error: 'not_jpeg' };
  return { bytes };
}

export async function apiCreateCameraSighting(request, env, { now = Date.now() } = {}) {
  const expected = env.CAMERA_WATCH_TOKEN;
  if (!expected) return fail(503, 'not_configured');
  const provided = readBearerToken(request);
  if (!provided || !(await tokensMatch(provided, expected))) {
    return fail(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  let body;
  try { body = await request.json(); } catch (err) { body = null; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_body');
  if (Object.keys(body).some(k => !ALLOWED_FIELDS.has(k))) return fail(400, 'unknown_field');

  const cameraId = typeof body.camera_id === 'number' && Number.isInteger(body.camera_id) ? String(body.camera_id) : body.camera_id;
  if (typeof cameraId !== 'string' || !CAMERA_ID_RE.test(cameraId)) return fail(400, 'invalid_camera_id');
  const cameraName = typeof body.camera_name === 'string' ? body.camera_name.trim().replace(/\s+/g, ' ') : '';
  if (!cameraName || cameraName.length > 120) return fail(400, 'invalid_camera_name');
  const { lat, lng } = body;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isInServiceArea(WATCH_AREA, lng, lat)) return fail(400, 'invalid_location');
  // A zone is required so the instant is unambiguous.
  const observedMs = typeof body.observed_at === 'string' && /(Z|[+-]\d{2}:?\d{2})$/i.test(body.observed_at.trim())
    ? Date.parse(body.observed_at.trim()) : NaN;
  if (!Number.isFinite(observedMs) || observedMs > now + MAX_FUTURE_SKEW_MS) return fail(400, 'invalid_observed_at');
  const observedAt = toStoredIso(observedMs);
  const image = decodeJpegBase64(body.image_base64);
  if (image.error) return fail(400, image.error);

  const key = `camera-captures/${cameraId}/${observedAt.replace(/[-:]/g, '')}.jpg`;
  await env.EVIDENCE_BUCKET.put(key, image.bytes, { httpMetadata: { contentType: 'image/jpeg' } });

  const sql = env.cybercabhunter_db;
  const id = crypto.randomUUID();
  const inserted = await sql.prepare(
    `INSERT OR IGNORE INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, cameraId, cameraName, lat, lng, observedAt, key).run();
  if (inserted.meta && inserted.meta.changes === 0) {
    // A retry of an existing detection: the image above replaced the old
    // bytes at the same key; make sure the row points at it.
    const existing = await sql.prepare('SELECT id FROM camera_detections WHERE camera_id = ? AND observed_at = ?').bind(cameraId, observedAt).first();
    await sql.prepare('UPDATE camera_detections SET image_r2_key = ? WHERE id = ?').bind(key, existing.id).run();
    return Response.json({ ok: true, duplicate: true, id: existing.id, image_url: imageUrl({ id: existing.id, image_r2_key: key }) });
  }
  return Response.json({ ok: true, id, image_url: imageUrl({ id, image_r2_key: key }) }, { status: 201 });
}

// ---- Approved photo sightings from a traffic camera -> the Zones map ----
// Called only by worker/moderation.js, after its requireModerator check, for
// an APPROVED photo sighting whose photo is still stored. The camera's name
// and position come from the shared camera list, never from the request;
// observed_at is the sighting's own observed time. The sighting's photo is
// COPIED to camera-captures/<camera_id>/<timestamp>.<ext> (not referenced),
// so the map image outlives the sighting photo's own lifecycle rules and a
// map row never points at another record's storage key. Nothing about the
// sighting beyond its time and photo is used: no plate, no VIN, no registry link.
// Returns { placed: true, id, existing? } or { placed: false, error }:
//   invalid_traffic_camera — not one of the cameras
//   not_found              — no such approved photo sighting with a stored photo
//   photo_missing          — the photo is gone from storage
export async function placeSightingOnMap(env, submissionId, cameraId) {
  const camera = trafficCameraFor(cameraId);
  if (!camera) return { placed: false, error: 'invalid_traffic_camera' };
  const sql = env.cybercabhunter_db;
  const sighting = await sql.prepare(`
    SELECT s.id AS submission_id, s.evidence_ref, o.observed_at
    FROM submissions s JOIN vehicle_observations o ON o.submission_id = s.id
    WHERE s.id = ? AND s.submission_type = 'vehicle_sighting' AND s.status = 'approved'
      AND s.evidence_type = 'photo' AND s.evidence_ref IS NOT NULL
  `).bind(submissionId).first();
  if (!sighting) return { placed: false, error: 'not_found' };

  // One map row per sighting: re-approving or retrying changes nothing.
  const already = await sql.prepare('SELECT id, observed_at FROM camera_detections WHERE source_submission_id = ?').bind(submissionId).first();
  if (already) return { placed: true, id: already.id, existing: true, observed_at: already.observed_at };
  const observedMs = Date.parse(String(sighting.observed_at).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(observedMs)) return { placed: false, error: 'not_found' };
  const observedAt = toStoredIso(observedMs);
  // ...and one per camera per moment: a watch upload at that exact time stays as it is.
  const sameMoment = await sql.prepare('SELECT id FROM camera_detections WHERE camera_id = ? AND observed_at = ?').bind(camera.camera_id, observedAt).first();
  if (sameMoment) return { placed: true, id: sameMoment.id, existing: true, observed_at: observedAt };

  const object = await env.EVIDENCE_BUCKET.get(sighting.evidence_ref);
  if (!object) return { placed: false, error: 'photo_missing' };
  const type = (object.customMetadata && object.customMetadata.verifiedContentType)
    || (object.httpMetadata && object.httpMetadata.contentType);
  const ext = IMAGE_EXT[type] || 'jpg';
  const key = `camera-captures/${camera.camera_id}/${observedAt.replace(/[-:]/g, '')}.${ext}`;
  await env.EVIDENCE_BUCKET.put(key, await new Response(object.body).arrayBuffer(), {
    httpMetadata: { contentType: IMAGE_EXT[type] ? type : 'image/jpeg' }
  });

  const id = crypto.randomUUID();
  const inserted = await sql.prepare(`
    INSERT OR IGNORE INTO camera_detections (id, camera_id, camera_name, lat, lng, observed_at, image_r2_key, source_submission_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, camera.camera_id, camera.name, camera.lat, camera.lng, observedAt, key, submissionId).run();
  if (inserted.meta && inserted.meta.changes === 0) {
    // A concurrent approval/Add to map won the insert; use its row.
    const winner = await sql.prepare('SELECT id FROM camera_detections WHERE source_submission_id = ? OR (camera_id = ? AND observed_at = ?)')
      .bind(submissionId, camera.camera_id, observedAt).first();
    return { placed: true, id: winner ? winner.id : null, existing: true, observed_at: observedAt };
  }
  return { placed: true, id, observed_at: observedAt };
}

// Removes the map detections made from these sightings (their copied images
// and rows) — when a sighting's photo is deleted by a moderator or expires,
// its map copy goes with it. Best effort: a failure leaves that one map row
// (it drops off the public map 24 hours after observed_at regardless).
export async function removeSightingsFromMap(env, submissionIds) {
  if (!submissionIds.length) return;
  const sql = env.cybercabhunter_db;
  const marks = submissionIds.map(() => '?').join(', ');
  const { results } = await sql.prepare(`SELECT id, image_r2_key FROM camera_detections WHERE source_submission_id IN (${marks})`).bind(...submissionIds).all();
  for (const row of results || []) {
    try {
      if (row.image_r2_key) await env.EVIDENCE_BUCKET.delete(row.image_r2_key);
      await sql.prepare('DELETE FROM camera_detections WHERE id = ?').bind(row.id).run();
    } catch (e) { /* best effort, see above */ }
  }
}
