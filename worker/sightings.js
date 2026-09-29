// Authenticated rider submits a sighting of a physical robotaxi. This is
// deliberately separate from worker/submissions.js's apiCreateSubmission,
// which is file-upload-only (multipart/form-data) and stays that way — a
// sighting is small structured JSON, not evidence, and this endpoint does
// not touch that file's flow at all.
//
// TRUST BOUNDARY (Phase 3D audit finding): an unreviewed crowdsourced
// sighting must never create or mutate a public robotaxi_vehicles row.
//   - If the observed plate matches an EXISTING registry vehicle (a
//     read-only lookup — db.findRobotaxiVehicleByPlate, which never
//     inserts and never touches last_seen_at), the observation is linked
//     to that vehicle's id. The vehicle's own model/color/service_area/
//     verification_status/last_seen_at are left exactly as receipt-derived
//     discovery set them.
//   - The link is made only for a UNIQUE match. If the plate matches
//     nothing, or matches two or more registry rows (an ambiguous plate),
//     the observation is still recorded — robotaxi_vehicle_id is simply
//     left NULL rather than attached to an arbitrary duplicate. The
//     registry is untouched
//     either way. Nothing here calls findOrCreateRobotaxiVehicleByPlate,
//     which is receipt-oriented and would wrongly create/touch a public
//     vehicle from an unreviewed claim.
// No moderation exists yet: every submissions row this creates is
// 'pending' and every observation is 'unverified' — this endpoint never
// sets reviewed_at/reviewed_by/rejection_reason, and nothing it writes is
// exposed through any public API today.

import { normalizePlate } from './plate.js';
import { db } from './db.js';

const MAX_PLATE_RAW = 20;
const MAX_SERVICE_AREA = 100;
const MAX_SHORT_FIELD = 60;    // model, color
const MAX_NOTES = 280;         // matches profile.js's MAX_BIO
const MAX_APPROX_LOCATION = 200;
const FUTURE_SLACK_MS = 5 * 60 * 1000; // clock-skew tolerance for observed_at
const MAX_BODY_BYTES = 8 * 1024;       // this request is always small structured JSON

// Mirrors worker/receipt-import.js's readBodyWithLimit exactly (kept as a
// separate copy rather than a shared import, to keep this change scoped to
// this one feature's files). Content-Length alone isn't a real limit — see
// that file's own comment — so this counts actual bytes off the stream.
async function readBodyWithLimit(request, maxBytes) {
  const reader = request.body && request.body.getReader ? request.body.getReader() : null;
  if (!reader) return { text: '', tooLarge: false };
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (err) { /* best effort */ }
      return { text: null, tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(buf), tooLarge: false };
}

function trimmedOrNull(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

// Validates the sighting's structured fields — shared by the JSON endpoint
// below and the photo endpoint (apiCreatePhotoSighting), so both apply the
// exact same rules. Returns { error } or { fields }. `requireServiceArea`
// is false for the photo form, where City/Service Area is optional (the
// photo itself is the required part).
function parseSightingFields(body, { requireServiceArea = true } = {}) {
  // ---- license plate: absent/blank are both allowed (the column is
  // nullable); anything present that isn't a plausible plate is rejected
  // outright rather than silently stored or turned into a vehicle lookup. ----
  let licensePlate = null;
  if (body.license_plate !== undefined && body.license_plate !== null) {
    if (typeof body.license_plate !== 'string') {
      return { error: 'invalid_license_plate' };
    }
    const raw = body.license_plate.trim();
    if (raw.length > 0) {
      if (raw.length > MAX_PLATE_RAW) {
        return { error: 'invalid_license_plate' };
      }
      const normalized = normalizePlate(raw);
      if (!normalized) {
        // Non-empty input that normalizes to nothing (e.g. "----" or "!!!")
        // isn't a plate — never store arbitrary text as one, and never let
        // it reach the vehicle lookup below.
        return { error: 'invalid_license_plate' };
      }
      licensePlate = normalized;
    }
    // blank string -> licensePlate stays null, same as omitted entirely
  }

  // ---- service area: required, matching the existing sighting drawer's
  // own "Location" field, which is already a required input. No city
  // whitelist/database — any trimmed, length-capped text is accepted. ----
  const serviceArea = trimmedOrNull(body.service_area, MAX_SERVICE_AREA);
  if (!serviceArea && requireServiceArea) {
    return { error: 'invalid_service_area' };
  }

  // ---- optional fields — trimmed and length-capped, never normalized or
  // inferred. approx_location is accepted and stored (the schema and this
  // endpoint's own request shape support it) but is never returned in any
  // response — see the privacy note in the final report. ----
  const approxLocation = trimmedOrNull(body.approx_location, MAX_APPROX_LOCATION);
  const model = trimmedOrNull(body.model, MAX_SHORT_FIELD);
  const color = trimmedOrNull(body.color, MAX_SHORT_FIELD);
  const notes = trimmedOrNull(body.notes, MAX_NOTES);

  // ---- observed_at: optional; must parse to a real instant that isn't
  // absurdly in the future. Stored in the same UTC 'YYYY-MM-DD HH:MM:SS'
  // shape every other datetime('now') column in this schema already uses —
  // no timezone is invented, the value is just the UTC instant the client
  // described. Omitted entirely -> the column's own datetime('now') default
  // applies, exactly as it does everywhere else in this schema. ----
  let observedAt = null;
  if (body.observed_at !== undefined && body.observed_at !== null) {
    if (typeof body.observed_at !== 'string') {
      return { error: 'invalid_observed_at' };
    }
    const parsed = new Date(body.observed_at);
    if (isNaN(parsed.getTime()) || parsed.getTime() > Date.now() + FUTURE_SLACK_MS) {
      return { error: 'invalid_observed_at' };
    }
    observedAt = parsed.toISOString().slice(0, 19).replace('T', ' ');
  }

  return { fields: { licensePlate, serviceArea, approxLocation, model, color, notes, observedAt } };
}

export async function apiCreateVehicleSighting(request, env, userId) {
  const { text, tooLarge } = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (tooLarge) {
    return Response.json({ success: false, error: 'too_large' }, { status: 413 });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }

  const parsed = parseSightingFields(body);
  if (parsed.error) {
    return Response.json({ success: false, error: parsed.error }, { status: 400 });
  }
  const { licensePlate, serviceArea, approxLocation, model, color, notes, observedAt } = parsed.fields;

  const sql = env.cybercabhunter_db;

  // Read-only — see the trust-boundary comment at the top of this file.
  const robotaxiVehicleId = licensePlate ? await db.findRobotaxiVehicleByPlate(sql, licensePlate) : null;

  // Accidental-double-submit protection only (same user, same plate, last
  // couple of minutes) — not spam/anti-abuse, which is explicitly deferred
  // to a later phase. No plate, no dedupe check: there's no reliable
  // identity to compare two unknown-plate sightings on.
  if (licensePlate) {
    const dup = await db.findRecentDuplicateSighting(sql, userId, licensePlate);
    if (dup) {
      return Response.json({
        success: true,
        duplicate: true,
        submission_id: dup.submission_id,
        observation_id: dup.observation_id,
        robotaxi_vehicle_id: robotaxiVehicleId
      });
    }
  }

  let result;
  try {
    result = await db.createVehicleSighting(sql, {
      userId, robotaxiVehicleId, licensePlate, serviceArea, approxLocation, model, color, notes, observedAt
    });
  } catch (err) {
    return Response.json({ success: false, error: 'sighting_create_failed' }, { status: 500 });
  }

  return Response.json({
    success: true,
    duplicate: false,
    submission_id: result.submissionId,
    observation_id: result.observationId,
    robotaxi_vehicle_id: robotaxiVehicleId
  }, { status: 201 });
}

// ---- Photo sightings: POST /api/vehicle-sightings/photo (multipart) ----
// The sighting drawer's photo form. The same structured fields as above
// (City/Service Area optional here) plus a REQUIRED photo, stored in the
// existing R2 evidence bucket. The result is the same pending, private
// submissions + vehicle_observations pair as a JSON sighting — nothing is
// public until moderated, and the registry is never touched (same
// read-only plate lookup as above).

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;   // same cap as worker/submissions.js evidence

// The file type is decided from the file's own first bytes — never the
// browser-supplied MIME type or filename — and is the ONLY source of the
// stored content type and key extension.
function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return { type: 'image/png', ext: 'png' };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  return null;
}

const bad = (error, status = 400) => Response.json({ success: false, error }, { status });

export async function apiCreatePhotoSighting(request, env, userId) {
  // Cheap early rejection before parsing an obviously huge body.
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength && declaredLength > MAX_PHOTO_BYTES + 64 * 1024) return bad('file_too_large', 413);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return bad('invalid_form_data');
  }

  const photo = form.get('photo');
  if (!photo || typeof photo === 'string' || photo.size === 0) return bad('missing_photo');
  if (photo.size > MAX_PHOTO_BYTES) return bad('file_too_large', 413);

  const bytes = new Uint8Array(await photo.arrayBuffer());
  const image = sniffImageType(bytes);
  if (!image) return bad('unsupported_file_type');

  // Text fields only (a second file under a field name is ignored).
  const body = {};
  for (const key of ['license_plate', 'service_area', 'approx_location', 'notes', 'observed_at']) {
    const value = form.get(key);
    if (typeof value === 'string' && value.trim()) body[key] = value;
  }
  const parsed = parseSightingFields(body, { requireServiceArea: false });
  if (parsed.error) return bad(parsed.error);
  const { licensePlate, serviceArea, approxLocation, notes, observedAt } = parsed.fields;

  const sql = env.cybercabhunter_db;
  const robotaxiVehicleId = licensePlate ? await db.findRobotaxiVehicleByPlate(sql, licensePlate) : null;

  // Same accidental-double-submit guard as the JSON endpoint — checked
  // BEFORE storing anything, so a duplicate never leaves an orphaned photo.
  if (licensePlate) {
    const dup = await db.findRecentDuplicateSighting(sql, userId, licensePlate);
    if (dup) {
      return Response.json({ success: true, duplicate: true, submission_id: dup.submission_id, observation_id: dup.observation_id, status: 'pending' });
    }
  }

  // Server-generated, unguessable key, namespaced by user — the same
  // evidence/<user>/<uuid>.<ext> scheme as worker/submissions.js. Nothing
  // from the request (filename, path) ever reaches it.
  const objectKey = `evidence/${userId}/${crypto.randomUUID()}.${image.ext}`;
  try {
    await env.EVIDENCE_BUCKET.put(objectKey, bytes, {
      httpMetadata: { contentType: image.type },
      customMetadata: { verifiedContentType: image.type }
    });
  } catch (err) {
    return bad('upload_failed', 502);
  }

  let result;
  try {
    result = await db.createVehicleSighting(sql, {
      userId, robotaxiVehicleId, licensePlate, serviceArea, approxLocation, notes, observedAt, evidenceRef: objectKey
    });
  } catch (err) {
    // The photo is stored but the record isn't: remove it rather than leave
    // an orphan, and don't claim success.
    try { await env.EVIDENCE_BUCKET.delete(objectKey); } catch (cleanupErr) { /* best effort */ }
    return bad('sighting_create_failed', 500);
  }

  return Response.json({
    success: true,
    duplicate: false,
    submission_id: result.submissionId,
    observation_id: result.observationId,
    status: 'pending'
  }, { status: 201 });
}
