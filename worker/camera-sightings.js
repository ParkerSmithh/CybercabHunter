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
// Authenticated by its own Worker secret (env.CAMERA_WATCH_TOKEN), the same
// bearer pattern as the Muse endpoints (worker/connector.js), never a browser
// session, so it can be rotated or revoked alone. The body is not read before
// the credential is verified. No CORS on the POST.
//
// Privacy: captures are plateless wide shots of public intersections. This
// data is never joined to robotaxi_vehicles — no plate, no VIN, no registry link.

import { tokensMatch, readBearerToken } from './connector.js';
import { serviceAreaFor, isInServiceArea } from './service-areas.js';

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

const fail = (status, error, headers) => Response.json({ ok: false, error }, { status, headers });
const imageUrl = row => (row.image_r2_key ? `/api/camera-sightings/${row.id}/image` : null);

// "YYYY-MM-DDTHH:MM:SSZ" — the one stored form (whole seconds, UTC).
export const toStoredIso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

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

export async function apiGetCameraSightingImage(request, env, id) {
  const notFound = () => new Response('Not found', { status: 404 });
  if (!DETECTION_ID_RE.test(id)) return notFound();
  const row = await env.cybercabhunter_db.prepare('SELECT image_r2_key FROM camera_detections WHERE id = ?').bind(id).first();
  if (!row || !row.image_r2_key) return notFound();
  const object = await env.EVIDENCE_BUCKET.get(row.image_r2_key);
  if (!object) return notFound();
  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/jpeg',
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
