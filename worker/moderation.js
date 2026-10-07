// Server-side moderator authorization (Phase 3D-C1) plus the vehicle-
// sighting review queue and approve/reject actions built on top of it
// (Phase 3D-C2). Every export below that touches sighting data goes
// through requireModerator first — there is no route anywhere that reaches
// worker/db.js's moderation queries without it.
//
// Reuses the EXISTING session mechanism unchanged (tesla.requireUserId) —
// there is no second authentication system here. It only adds one more
// question on top of an already-resolved user_id: does users.role (never
// anything client-supplied — see migrations/0011_user_roles.sql) say
// 'moderator'? The role can only ever be changed by writing to the
// database directly; nothing in this file or elsewhere lets a caller set
// or influence their own role through any request.

import { tesla } from './tesla.js';
import { db, VEHICLE_VISIBILITY } from './db.js';
import { VEHICLE_ID_RE } from './vehicles.js';
import { normalizePlate } from './plate.js';
import { parseManualRideDate, parseManualRideDistance } from './ride-input.js';
import { readImportItems, runImport, runSummary, itemBase } from './receipt-import.js';
import { rideReviewState } from './ride-status.js';
import { sightingPhotoForModerator, deleteSightingPhoto, deleteSightingPhotoByPublicId } from './sightings-public.js';
import { placeSightingOnMap, onLiveMap } from './camera-sightings.js';
import { trafficCameraFor } from './traffic-cameras.js';

// Returns { userId } when the caller is authenticated AND holds the
// moderator role, or { error } otherwise:
//   'unauthenticated' — missing/invalid/expired session -> caller returns 401
//   'forbidden'        — a real, authenticated, ordinary user -> caller returns 403
// Kept as two distinct outcomes (rather than one boolean) so callers can
// follow this app's existing 401-vs-401/403 split instead of inventing a
// different convention for moderation routes.
export async function requireModerator(request, env) {
  const userId = await tesla.requireUserId(request, env);
  if (!userId) return { error: 'unauthenticated' };

  const user = await db.getUserById(env.cybercabhunter_db, userId);
  if (!user || user.role !== 'moderator') return { error: 'forbidden' };

  return { userId };
}

function authFailureResponse(auth) {
  return auth.error === 'unauthenticated'
    ? Response.json({ authenticated: false }, { status: 401 })
    : Response.json({ success: false, error: 'forbidden' }, { status: 403 });
}

// GET /api/moderation/access — tells the CALLER whether their own account is
// a moderator, so the site can show a "Moderation" link to moderators only.
// It reports the same server-side role check requireModerator makes for every
// moderation route and grants nothing itself: an ordinary signed-in user gets
// 200 { moderator: false } (not a 403, so it isn't an error on every page
// they open), a signed-out caller gets 401, and no other account's role is
// ever revealed. Each moderation endpoint still authorizes its own request.
export async function apiModerationAccess(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error === 'unauthenticated') return Response.json({ authenticated: false }, { status: 401 });
  return Response.json({ authenticated: true, moderator: !auth.error });
}

// Moderator-only: the reviewable vehicle-sighting queue. Deliberately does
// NOT include submitter identity (display name, handle, email) — nothing
// about the current review workflow needs it, so it's simply left out
// rather than exposed "just in case." No password/session/account material
// is anywhere near this query to begin with (see db.getPendingVehicleSightings).
export async function apiListPendingVehicleSightings(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  const rows = await db.getPendingVehicleSightings(env.cybercabhunter_db);
  return Response.json({
    success: true,
    sightings: rows.map(r => ({
      submission_id: r.submission_id,
      observation_id: r.observation_id,
      status: r.status,
      submitted_at: r.submitted_at,
      observed_at: r.observed_at,
      service_area: r.service_area,
      approx_location: r.approx_location,
      license_plate: r.license_plate,
      model: r.model,
      color: r.color,
      notes: r.notes,
      evidence_ref: r.observation_evidence_ref || r.submission_evidence_ref || null,
      robotaxi_vehicle_id: r.robotaxi_vehicle_id,
      ...cameraFields(r.camera_id)
    }))
  });
}

// A sighting's traffic camera for the moderation cards: its id and name from
// the shared camera list (null when it has none).
function cameraFields(cameraId) {
  const camera = cameraId ? trafficCameraFor(cameraId) : null;
  return { camera_id: camera ? camera.camera_id : null, camera_name: camera ? camera.name : null };
}

// GET /api/moderation/approved-photo-sightings — moderators only. The most
// recently approved photo sightings whose photo is still stored, for the
// Images tab's "Recently approved" list: each shows whether it is on the
// Zones map, and the ones that aren't get "Add to map".
export async function apiListApprovedPhotoSightings(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);
  const rows = await db.getRecentApprovedPhotoSightings(env.cybercabhunter_db, APPROVED_LIST_LIMIT);
  return Response.json({
    success: true,
    sightings: rows.map(r => ({
      submission_id: r.submission_id,
      reviewed_at: r.reviewed_at,
      observed_at: r.observed_at,
      service_area: r.service_area,
      approx_location: r.approx_location,
      license_plate: r.license_plate,
      ...cameraFields(r.camera_id),
      on_map: !!r.on_map,
      // On the public Zones map right now (its capture is under 24 hours old).
      visible_on_map: !!r.on_map && onLiveMap(r.map_observed_at)
    }))
  });
}
const APPROVED_LIST_LIMIT = 24;

// POST /api/moderation/vehicle-sightings/:submissionId/map  { camera_id }
// Moderators only. The manual "Add to map" for an APPROVED photo sighting
// that was approved without a camera (or whose automatic placement failed):
// records the chosen camera on the sighting and places it on the Zones map
// exactly as Approve does for a camera sighting (camera-sightings.js
// placeSightingOnMap). Already on the map -> 200 with already_on_map, no
// second row. 400 invalid_traffic_camera; 404 not_found (no such approved
// photo sighting with its photo); 409 photo_missing.
export async function apiAddSightingToMap(request, env, submissionId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);
  let body;
  try { body = await request.json(); } catch (err) { body = null; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const camera = trafficCameraFor(body.camera_id);
  if (!camera) return Response.json({ success: false, error: 'invalid_traffic_camera' }, { status: 400 });

  const sql = env.cybercabhunter_db;
  let result;
  try {
    result = await placeSightingOnMap(env, submissionId, camera.camera_id);
  } catch (err) {
    return Response.json({ success: false, error: 'map_failed' }, { status: 500 });
  }
  if (!result.placed) {
    const status = result.error === 'not_found' ? 404 : result.error === 'photo_missing' ? 409 : 400;
    return Response.json({ success: false, error: result.error }, { status });
  }
  // Record the camera on the sighting when it had none (never overwritten).
  await sql.prepare(`UPDATE vehicle_observations SET camera_id = ? WHERE submission_id = ? AND camera_id IS NULL`).bind(camera.camera_id, submissionId).run();
  return Response.json({ success: true, submission_id: submissionId, on_map: true, already_on_map: !!result.existing, visible_on_map: onLiveMap(result.observed_at) });
}

// GET /api/moderation/vehicle-sightings/:submissionId/photo — the photo of a
// sighting in the review queue, so a moderator can see what they approve.
// Moderators only; never cached (worker/sightings-public.js).
export async function apiGetVehicleSightingPhoto(request, env, submissionId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);
  return sightingPhotoForModerator(env, submissionId);
}

// DELETE /api/moderation/vehicle-sightings/:submissionId/photo (moderation
// page) and DELETE /api/moderation/sightings/:publicId/photo (the Sightings
// page's hover button): permanently deletes a sighting's photo. Moderators
// only. See worker/sightings-public.js deleteSightingPhoto.
export async function apiDeleteVehicleSightingPhoto(request, env, submissionId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);
  return deleteSightingPhoto(env, submissionId, auth.userId);
}

export async function apiDeletePublicSightingPhoto(request, env, publicId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);
  return deleteSightingPhotoByPublicId(env, publicId, auth.userId);
}

const MAX_REJECTION_REASON = 280; // matches worker/profile.js's existing MAX_BIO precedent

// Moderator-only: approve or reject one vehicle-sighting submission.
// Status transitions are restricted to pending/needs_review -> approved or
// pending/needs_review -> rejected; approved <-> rejected is intentionally
// not supported here (no re-review mechanism in this phase). The actual
// race guard is db.reviewVehicleSighting's atomic, conditionally-gated
// batch — the getVehicleSightingSubmission lookup below exists only to
// return an accurate 404 vs 409, not to decide correctness.
export async function apiReviewVehicleSighting(request, env, submissionId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }

  if (body.action !== 'approve' && body.action !== 'reject') {
    return Response.json({ success: false, error: 'invalid_action' }, { status: 400 });
  }

  let rejectionReason = null;
  if (body.action === 'reject') {
    if (typeof body.rejection_reason !== 'string' || body.rejection_reason.trim() === '') {
      return Response.json({ success: false, error: 'rejection_reason_required' }, { status: 400 });
    }
    rejectionReason = body.rejection_reason.trim().slice(0, MAX_REJECTION_REASON);
  }

  const sql = env.cybercabhunter_db;
  const existing = await db.getVehicleSightingSubmission(sql, submissionId);
  if (!existing || existing.submission_type !== 'vehicle_sighting') {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if (existing.status !== 'pending' && existing.status !== 'needs_review') {
    return Response.json({ success: false, error: 'already_reviewed', status: existing.status }, { status: 409 });
  }

  const decision = body.action === 'approve' ? 'approved' : 'rejected';
  let result;
  try {
    result = await db.reviewVehicleSighting(sql, { submissionId, decision, reviewerId: auth.userId, rejectionReason });
  } catch (err) {
    return Response.json({ success: false, error: 'review_failed' }, { status: 500 });
  }
  if (!result.applied) {
    // Lost a race against another moderator (or a second click) between the
    // check above and the atomic update — never silently overwritten.
    return Response.json({ success: false, error: 'already_reviewed' }, { status: 409 });
  }

  // A photo sighting captured from a traffic camera goes on the Zones map as
  // part of the same Approve (camera-sightings.js placeSightingOnMap). The
  // approval stands either way; if placing fails, the moderator can use
  // "Add to map". A sighting without a camera responds exactly as before.
  if (decision === 'approved' && existing.camera_id) {
    let map;
    try { map = await placeSightingOnMap(env, submissionId, existing.camera_id); } catch (err) { map = { placed: false, error: 'map_failed' }; }
    return Response.json({ success: true, submission_id: submissionId, status: decision, map: { on_map: !!map.placed, visible_on_map: !!map.placed && onLiveMap(map.observed_at), ...(map.placed ? {} : { error: map.error }) } });
  }

  return Response.json({ success: true, submission_id: submissionId, status: decision });
}

// POST /api/moderation/vehicle-sightings/:id/promote   (no body)
//
// The moderator's explicit "Add to registry": turns a reviewable sighting
// with a plate into a PRIVATE registry vehicle (origin 'sighting') and
// approves the sighting in the same atomic write (db.promoteSightingToRegistryVehicle).
// No ride is invented. The new vehicle still needs the normal path to go
// public — a VIN entered by a moderator, then Approve Cybercab — and nothing
// here makes anything public. 400 plate_required (no usable plate);
// 409 vehicle_exists (a registry row already holds that plate — approve the
// sighting normally instead) / already_reviewed; 404 not_found.
export async function apiPromoteVehicleSighting(request, env, submissionId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  const sql = env.cybercabhunter_db;
  const existing = await db.getVehicleSightingSubmission(sql, submissionId);
  if (!existing || existing.submission_type !== 'vehicle_sighting') {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if (existing.status !== 'pending' && existing.status !== 'needs_review') {
    return Response.json({ success: false, error: 'already_reviewed', status: existing.status }, { status: 409 });
  }
  if (!existing.license_plate || !normalizePlate(existing.license_plate)) {
    return Response.json({ success: false, error: 'plate_required' }, { status: 400 });
  }
  const match = await db.resolveRobotaxiVehicleByPlate(sql, existing.license_plate);
  if (match.status !== 'none') {
    return Response.json({ success: false, error: 'vehicle_exists', robotaxi_vehicle_id: match.vehicleId }, { status: 409 });
  }

  let result;
  try {
    result = await db.promoteSightingToRegistryVehicle(sql, { submissionId, reviewerId: auth.userId });
  } catch (err) {
    return Response.json({ success: false, error: 'promote_failed' }, { status: 500 });
  }
  if (!result.applied) {
    // Lost a race (another moderator, a second click, or a receipt that just
    // created the same plate) between the checks above and the atomic write.
    const fresh = await db.getVehicleSightingSubmission(sql, submissionId);
    const stillPending = fresh && (fresh.status === 'pending' || fresh.status === 'needs_review');
    return Response.json({ success: false, error: stillPending ? 'vehicle_exists' : 'already_reviewed' }, { status: 409 });
  }

  const vehicle = await db.getRegistryVehicleForModeration(sql, result.vehicleId);
  // This approves the sighting too, so a traffic-camera photo goes on the
  // Zones map here just as with Approve (the map row never has the plate).
  if (existing.camera_id) {
    let map;
    try { map = await placeSightingOnMap(env, submissionId, existing.camera_id); } catch (err) { map = { placed: false, error: 'map_failed' }; }
    return Response.json({ success: true, submission_id: submissionId, status: 'approved', vehicle, map: { on_map: !!map.placed, visible_on_map: !!map.placed && onLiveMap(map.observed_at), ...(map.placed ? {} : { error: map.error }) } }, { status: 201 });
  }
  return Response.json({ success: true, submission_id: submissionId, status: 'approved', vehicle }, { status: 201 });
}

// ---- Registry vehicle visibility (Phase 3E) ----
//
// A receipt can create a registry vehicle, but receipts are not
// authenticated (forwarded email is not SPF/DKIM-verified; a pasted receipt
// has no sender at all), so new vehicles start 'private'.
//   - Making a vehicle PUBLIC is possible ONLY through the review action
//     (POST .../review, approve_cybercab or approve_manual): strict approval
//     rules (approve_cybercab also requires a vin on file; approve_manual does
//     not), re-checked inside the write, and an audit row. No other route,
//     action, or function can do it.
//   - Making a vehicle PRIVATE is the administrative takedown: the review
//     action's return_private, or PATCH { visibility: "private" }. Both are audited.
//   - Public visibility alone is still not enough: the public endpoints also
//     require a counted ride (db.getPublicRobotaxiVehicle), which is why every
//     row here reports publicly_eligible and an approval state separately.
// Responses carry registry facts and counts only — no rider, receipt,
// address or evidence data.

const MODERATION_VEHICLE_LIMIT = 50;

// GET /api/moderation/robotaxi-vehicles[?scope=awaiting|public][&plate=…]
export async function apiListRegistryVehicles(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  const params = new URL(request.url).searchParams;
  const rawScope = params.get('scope');
  const scope = rawScope === 'public' || rawScope === 'private' ? rawScope : 'awaiting';
  const rawPlate = params.get('plate');
  const plate = rawPlate && rawPlate.trim() ? rawPlate.trim().slice(0, 40) : null;

  const vehicles = await db.getRegistryVehiclesForModeration(env.cybercabhunter_db, { plate, scope, limit: MODERATION_VEHICLE_LIMIT });
  return Response.json({ success: true, vehicles });
}

const MAX_REVIEW_REASON = 280;   // same cap as a sighting rejection reason

// Optional moderator note. Absent/empty -> null; anything but a string, or one
// over the cap, is refused rather than silently truncated.
function parseReason(body) {
  if (body.reason === undefined || body.reason === null) return { reason: null };
  if (typeof body.reason !== 'string') return { error: 'invalid_reason' };
  const trimmed = body.reason.trim();
  if (trimmed.length > MAX_REVIEW_REASON) return { error: 'invalid_reason' };
  return { reason: trimmed === '' ? null : trimmed };
}

async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return null;
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

// PATCH /api/moderation/robotaxi-vehicles/:id   { "visibility": "private", "reason"?: string }
//
// ADMINISTRATIVE TAKEDOWN ONLY. This endpoint can take a vehicle out of public
// view and nothing else. Granting public visibility is not possible here:
// { "visibility": "public" } is refused with 409 review_required, because the
// one and only way to make a vehicle public is the strict, audited review
// action (POST .../review, action approve_cybercab). A real change is audited.
export async function apiSetVehicleVisibility(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  if (body.visibility !== VEHICLE_VISIBILITY.PUBLIC && body.visibility !== VEHICLE_VISIBILITY.PRIVATE) {
    return Response.json({ success: false, error: 'invalid_visibility' }, { status: 400 });
  }
  const parsed = parseReason(body);
  if (parsed.error) {
    return Response.json({ success: false, error: parsed.error }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const existing = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!existing) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  if (body.visibility === VEHICLE_VISIBILITY.PUBLIC) {
    // Never a direct write: not even a no-op on an already-public vehicle.
    return Response.json({ success: false, error: 'review_required' }, { status: 409 });
  }

  if (existing.visibility === VEHICLE_VISIBILITY.PRIVATE) {
    // Already private: nothing changes, so there is nothing to audit (and the
    // request stays idempotent, as before).
    await db.setRobotaxiVehicleVisibility(sql, vehicleId, VEHICLE_VISIBILITY.PRIVATE);
  } else {
    const { applied } = await db.changeRobotaxiVehicleVisibility(sql, {
      vehicleId, moderatorId: auth.userId, target: body.visibility, reason: parsed.reason
    });
    if (!applied) {
      return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    }
  }

  const vehicle = await db.getRegistryVehicleForModeration(sql, vehicleId);
  return Response.json({ success: true, vehicle });
}

// POST /api/moderation/robotaxi-vehicles/:id/review
//   { "action": "approve_cybercab" | "approve_manual" | "verify_vin" | "return_private", "reason"?: string }
//
// The explicit moderator decision. Moderator approval means: a Cybercab
// Hunter moderator reviewed this registry record and intentionally approved
// it for public visibility. It is NOT evidence that any receipt was really
// issued by Tesla, and nothing here says so.
//
// approve_manual: the same approval with NO VIN requirement — a moderator can
// approve a pending vehicle that has no VIN on file. Still an explicit
// moderator action with the same rules otherwise (private, a counted ride or
// sighting origin, a unique plate), checked atomically and audited the same
// way. The vehicle's approval_basis records the difference (migrations/0025):
// 'vin-verified' if a VIN was on file when approved, otherwise 'manual'.
//
// verify_vin: upgrades a public 'manual' vehicle to 'vin-verified' once a VIN
// is on file — the moderator's assertion that it is the Tracker-confirmed VIN
// of this Cybercab (the same standard as approve_cybercab). Changes nothing
// else; 409 not_public / no_vin / already_vin_verified otherwise.
//
// approve_cybercab is unchanged (the daily pipeline relies on it): refused with 409
// not_eligible (and the factual blocking_reasons) unless the vehicle is
// private, has a counted non-superseded ride, has a unique plate, AND
// already has a vin (saved separately beforehand via POST .../vin — see
// apiSetRegistryVehicleVin; 'no_vin' is added to blocking_reasons when
// missing). The vin is the moderator's own assertion, made outside this app
// on Robotaxi Tracker, that the vehicle is a Cybercab — nothing here
// inspects or decodes it to decide that. The full guard is repeated
// atomically inside the audited write, so a ride deleted between the check
// and the write cannot slip a vehicle through. Writes the review action
// 'approved_public' (see changeRobotaxiVehicleVisibility) — this is still
// fundamentally "a moderator made this vehicle public", so no separate
// review-table action value exists for it.
//
// return_private takes a public vehicle out of public view; both actions
// write (or, for return_private, may write) an append-only history row
// (who, when, what, and the facts they were made on). 409 already_public /
// already_private if there is nothing to do.
export async function apiReviewRegistryVehicle(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  if (!['approve_cybercab', 'approve_manual', 'verify_vin', 'return_private'].includes(body.action)) {
    return Response.json({ success: false, error: 'invalid_action' }, { status: 400 });
  }
  const parsed = parseReason(body);
  if (parsed.error) {
    return Response.json({ success: false, error: parsed.error }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const vehicle = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!vehicle) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  if (body.action === 'verify_vin') {
    if (vehicle.visibility !== VEHICLE_VISIBILITY.PUBLIC) return Response.json({ success: false, error: 'not_public', vehicle }, { status: 409 });
    if (!vehicle.vin) return Response.json({ success: false, error: 'no_vin', vehicle }, { status: 409 });
    if (vehicle.approval_basis === 'vin-verified') return Response.json({ success: false, error: 'already_vin_verified', vehicle }, { status: 409 });
    const upgraded = await db.verifyRegistryVehicleVin(sql, vehicleId, auth.userId);
    const after = await db.getRegistryVehicleForModeration(sql, vehicleId);
    if (!after) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    if (!upgraded) {
      // Lost a race (returned to private, VIN cleared, or verified by someone else).
      const error = after.visibility !== VEHICLE_VISIBILITY.PUBLIC ? 'not_public'
        : !after.vin ? 'no_vin' : 'already_vin_verified';
      return Response.json({ success: false, error, vehicle: after }, { status: 409 });
    }
    return Response.json({ success: true, action: 'vin_verified', vehicle: after });
  }

  const approving = body.action === 'approve_cybercab' || body.action === 'approve_manual';
  const requireVin = body.action === 'approve_cybercab';
  if (approving && vehicle.visibility === VEHICLE_VISIBILITY.PUBLIC) {
    return Response.json({ success: false, error: 'already_public', vehicle }, { status: 409 });
  }
  if (!approving && vehicle.visibility !== VEHICLE_VISIBILITY.PUBLIC) {
    return Response.json({ success: false, error: 'already_private', vehicle }, { status: 409 });
  }
  if (approving) {
    // evaluateVehicleApproval (vehicle.approval) never involves the VIN —
    // approve_cybercab only ADDS 'no_vin' to the SAME blocking-reasons list
    // the ordinary guard already computes, at the response level.
    const blockingReasons = vehicle.vin || !requireVin
      ? vehicle.approval.blocking_reasons
      : [...vehicle.approval.blocking_reasons, 'no_vin'];
    if (blockingReasons.length > 0) {
      return Response.json({ success: false, error: 'not_eligible', blocking_reasons: blockingReasons, vehicle }, { status: 409 });
    }
  }

  const { applied } = await db.changeRobotaxiVehicleVisibility(sql, {
    vehicleId, moderatorId: auth.userId, reason: parsed.reason,
    target: approving ? VEHICLE_VISIBILITY.PUBLIC : VEHICLE_VISIBILITY.PRIVATE,
    cybercabApproval: approving, requireVin
  });

  const fresh = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!applied) {
    // Lost a race (another moderator, or the vehicle's rides changed) between
    // the read above and the atomic write: report the CURRENT state.
    if (!fresh) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    if (approving && fresh.visibility === VEHICLE_VISIBILITY.PUBLIC) return Response.json({ success: false, error: 'already_public', vehicle: fresh }, { status: 409 });
    if (!approving && fresh.visibility !== VEHICLE_VISIBILITY.PUBLIC) return Response.json({ success: false, error: 'already_private', vehicle: fresh }, { status: 409 });
    const freshBlocking = fresh.vin || !requireVin
      ? fresh.approval.blocking_reasons
      : [...fresh.approval.blocking_reasons, 'no_vin'];
    return Response.json({ success: false, error: 'not_eligible', blocking_reasons: freshBlocking, vehicle: fresh }, { status: 409 });
  }

  return Response.json({ success: true, action: approving ? 'approved_public' : 'returned_private', vehicle: fresh });
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // standard 17-char VIN shape, excludes I/O/Q — format only, never decoded

// POST /api/moderation/robotaxi-vehicles/:id/vin   { "vin": string | null }
//
// Records, edits, or clears the VIN a moderator read directly off Robotaxi
// Tracker (an external site this app never queries programmatically — see
// the workflow comment above apiReviewRegistryVehicle) after manually
// confirming for themselves that the vehicle is a Cybercab. This is the ONLY
// way a vin is ever written: nothing in this app derives, decodes, guesses,
// or looks one up. The VIN is optional: an empty string or null clears it
// (unknown), which is always valid. Allowed before or after approval.
//
// Writes vin/vin_set_by_user_id/vin_set_at (db.setRegistryVehicleVin) —
// never visibility, never a robotaxi_vehicle_reviews row, never any
// ride/trip data. Saving a VIN never approves or upgrades anything by
// itself; approval and the manual -> vin-verified upgrade (verify_vin) are
// always separate requests. Changing or clearing the VIN of a 'vin-verified'
// vehicle drops it to 'manual', since that verification was of the old VIN.
export async function apiSetRegistryVehicleVin(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const body = await readJsonObject(request);
  if (!body || (typeof body.vin !== 'string' && body.vin !== null)) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const vin = body.vin === null ? null : (body.vin.trim().toUpperCase() || null);
  if (vin !== null && !VIN_RE.test(vin)) {
    return Response.json({ success: false, error: 'invalid_vin' }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const existing = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!existing) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if ((existing.vin || null) === vin) {
    // Nothing changes (same VIN, or clearing one that isn't there).
    return Response.json({ success: true, vehicle: existing });
  }

  const applied = await db.setRegistryVehicleVin(sql, vehicleId, auth.userId, vin);
  const fresh = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!applied || !fresh) {
    // Deleted between the read above and the write.
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  return Response.json({ success: true, vehicle: fresh });
}

// POST /api/moderation/robotaxi-vehicles/:id/rides
//   { "ride_date": "YYYY-MM-DD", "distance"?: number, "distance_unit"?: "mi" | "km", "service_area"?: string }
//
// A moderator records one ride against an EXISTING registry vehicle (see
// db.logModeratorRide for the write sequence, ownership, units and the
// duplicate rule). The ride is OWNED by the dedicated system user
// (env.MUSE_CONNECTOR_USER_ID — the established non-login owner of registry-
// level records) and reviewed_by is the calling moderator; with no system
// owner configured it is refused (503) and never falls back to the moderator. It adds ride history only: it never changes a vehicle's
// visibility, approval, VIN, model, color or service area, and it can never
// make anything public. service_area here is ride-level data (trips.service_area).
// Unknown body fields are ignored, like every other endpoint here.
//   400 invalid_vehicle_id | invalid_body | invalid_ride_date | future_ride_date |
//       invalid_distance | invalid_distance_unit | invalid_service_area
//   404 not_found   409 duplicate_ride   503 system_owner_not_configured   201 { success, ride, vehicle }
const MAX_RIDE_SERVICE_AREA = 100;
const DISTANCE_UNITS = ['mi', 'km'];
export async function apiLogVehicleRide(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const bad = error => Response.json({ success: false, error }, { status: 400 });

  // ride_date: required, a REAL calendar date in exactly YYYY-MM-DD, not after today (UTC).
  const dateCheck = parseManualRideDate(body.ride_date);
  if (!dateCheck.ok) return bad(dateCheck.reason === 'future' ? 'future_ride_date' : 'invalid_ride_date');

  // distance: optional; a JSON number that is finite and strictly positive. Never defaulted or guessed.
  const distanceCheck = parseManualRideDistance(body.distance);
  if (!distanceCheck.ok) return bad('invalid_distance');
  const distance = distanceCheck.value;
  let distanceUnit = 'mi';
  if (body.distance_unit !== undefined && body.distance_unit !== null) {
    if (!DISTANCE_UNITS.includes(body.distance_unit)) return bad('invalid_distance_unit');
    distanceUnit = body.distance_unit;
  }
  let serviceArea = null;
  if (body.service_area !== undefined && body.service_area !== null) {
    if (typeof body.service_area !== 'string') return bad('invalid_service_area');
    const trimmed = body.service_area.trim();
    if (trimmed.length > MAX_RIDE_SERVICE_AREA) return bad('invalid_service_area');
    serviceArea = trimmed || null;
  }

  const ownerUserId = env.MUSE_CONNECTOR_USER_ID;
  if (!ownerUserId) {
    return Response.json({ success: false, error: 'system_owner_not_configured' }, { status: 503 });
  }
  const sql = env.cybercabhunter_db;
  let result;
  try {
    result = await db.logModeratorRide(sql, {
      vehicleId, moderatorId: auth.userId, ownerUserId, rideDate: body.ride_date, distance, distanceUnit, serviceArea
    });
  } catch (err) {
    return Response.json({ success: false, error: 'log_ride_failed' }, { status: 500 });
  }
  if (result.status === 'not_found') {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if (result.status === 'owner_missing') {
    return Response.json({ success: false, error: 'system_owner_not_configured' }, { status: 503 });
  }
  const vehicle = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (result.status === 'duplicate') {
    return Response.json({ success: false, error: 'duplicate_ride', vehicle }, { status: 409 });
  }
  return Response.json({
    success: true,
    ride: {
      id: result.tripId, submission_id: result.submissionId, ride_date: body.ride_date,
      distance: result.distance, distance_unit: 'mi', service_area: serviceArea,
      ...(distance !== null && distanceUnit === 'km' ? { converted_from: 'km' } : {})
    },
    vehicle
  }, { status: 201 });
}

// DELETE /api/moderation/robotaxi-vehicles/:id
//
// Removes a registry vehicle row entirely (e.g. resolving a duplicate plate,
// or a row created in error). Unlike the takedown PATCH, this can remove a
// vehicle regardless of its current visibility.
//
// Also deletes every trip logged against this vehicle (any rider's), and the
// submissions/receipt_ingestions/evidence behind them — db.deleteRegistryVehicle
// always purges. Deleting only the vehicle row would leave the ingestion
// dedupe permanently blocking that receipt (it keys off the trip surviving,
// not the vehicle link), so a moderator deleting a vehicle here is deleting
// everything that made it exist. Any receipt evidence freed by that is also
// removed from R2.
//
// Not audited in robotaxi_vehicle_reviews: that table records approve/return
// decisions on a vehicle that still exists, not its removal.
export async function apiDeleteRegistryVehicle(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const { deleted, evidenceRefs } = await db.deleteRegistryVehicle(sql, vehicleId);
  if (!deleted) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  for (const ref of evidenceRefs) {
    try { await env.EVIDENCE_BUCKET.delete(ref); } catch (err) { /* best effort, mirrors worker/trips.js */ }
  }

  return Response.json({ success: true, id: vehicleId });
}

// GET /api/moderation/robotaxi-vehicles/:id/reviews — the vehicle's
// append-only review history, newest first. Moderator-only.
export async function apiListRegistryVehicleReviews(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }
  const sql = env.cybercabhunter_db;
  if (!(await db.getRegistryVehicleForModeration(sql, vehicleId))) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  const reviews = await db.getRobotaxiVehicleReviews(sql, vehicleId);
  return Response.json({ success: true, reviews });
}

// GET /api/moderation/riders?display_name=<text>
//
// Moderator-only: riders whose display name contains the text, for choosing
// whose Rider Data an imported receipt goes to. Returns id, display_name,
// handle and created_at only (see db.searchUsersByDisplayName). At most 10.
const MAX_RIDER_QUERY = 100;
export async function apiModerationSearchRiders(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  const q = (new URL(request.url).searchParams.get('display_name') || '').trim().slice(0, MAX_RIDER_QUERY);
  const riders = q ? await db.searchUsersByDisplayName(env.cybercabhunter_db, q, 10) : [];
  return Response.json({
    success: true,
    riders: riders.map(r => ({ id: r.id, display_name: r.display_name, handle: r.handle, created_at: r.created_at }))
  });
}

// POST /api/moderation/receipt-import
//   { rider_user_id: string, items: [{ kind: 'eml' | 'text', content }] }
//
// The moderator receipt-import page (moderation/import-receipt.html). Same
// items, same limits and EXACTLY the same pipeline as POST /api/rides/import
// (worker/receipt-import.js's readImportItems/runImport) — source
// 'receipt_import', the same parsing, dedupe, review status and
// vehicle find-or-create (a new plate becomes a PRIVATE registry vehicle; no
// VIN, model or visibility is ever set here). The differences: the caller
// must be a moderator (requireModerator: 401/403 otherwise); the ride is
// imported AS the rider the moderator chose (rider_user_id, required — the
// rider must exist and have a display name, which is how the page picks
// them), so it lands in THAT rider's Rider Data and dedupes against their
// rides; and each result reads back the stored ride and its vehicle's
// current registry state. Nothing is published by this endpoint.
//   400 missing_rider | rider_has_no_display_name   404 rider_not_found
export async function apiModerationImportReceipts(request, env) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  const read = await readImportItems(request);
  if (read.response) return read.response;

  const sql = env.cybercabhunter_db;
  const riderId = read.body.rider_user_id;
  if (typeof riderId !== 'string' || !riderId.trim() || riderId.length > 200) {
    return Response.json({ success: false, error: 'missing_rider' }, { status: 400 });
  }
  const rider = await db.getUserById(sql, riderId);
  if (!rider) {
    return Response.json({ success: false, error: 'rider_not_found' }, { status: 404 });
  }
  if (!rider.display_name || !String(rider.display_name).trim()) {
    return Response.json({ success: false, error: 'rider_has_no_display_name' }, { status: 400 });
  }

  const { counts, results } = await runImport(env, rider.id, read.items);
  const detailed = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const item = { ...itemBase(result, index), ride: null, vehicle: null };
    const row = result.tripId ? await db.getImportedRideSummary(sql, rider.id, result.tripId) : null;
    if (row) {
      item.ride = {
        ride_date: row.ride_date, pickup_time: row.pickup_time,
        distance: row.distance, distance_unit: row.distance_unit,
        fare_amount_cents: row.fare_amount_cents, currency: row.currency,
        service_area: row.service_area, source: row.source,
        review_state: rideReviewState(row.submission_status)
      };
      if (row.vehicle_id) {
        item.vehicle = {
          id: row.vehicle_id, license_plate: row.vehicle_plate,
          // Only a call that actually inserted the row reports created; a
          // duplicate receipt never created anything.
          created: !!result.vehicleCreated,
          visibility: row.vehicle_visibility,
          has_vin: !!row.vehicle_has_vin,
          publicly_eligible: !!row.vehicle_public_eligible
        };
      }
    }
    detailed.push(item);
  }

  return Response.json({
    success: true,
    rider: { id: rider.id, display_name: rider.display_name, handle: rider.handle },
    run: runSummary(counts),
    results: detailed
  });
}
