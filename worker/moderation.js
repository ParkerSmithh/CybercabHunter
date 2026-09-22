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
      robotaxi_vehicle_id: r.robotaxi_vehicle_id
    }))
  });
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

  return Response.json({ success: true, submission_id: submissionId, status: decision });
}

// ---- Registry vehicle visibility (Phase 3E) ----
//
// A receipt can create a registry vehicle, but receipts are not
// authenticated (forwarded email is not SPF/DKIM-verified; a pasted receipt
// has no sender at all), so new vehicles start 'private'.
//   - Making a vehicle PUBLIC is possible ONLY through the review action
//     (POST .../review, approve_public): strict approval rules, re-checked
//     inside the write, and an audit row. No other route or function can do it.
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
// action (POST .../review, action approve_public). A real change is audited.
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
//   { "action": "approve_public" | "approve_cybercab" | "return_private", "reason"?: string }
//
// The explicit moderator decision. Moderator approval means: a Cybercab
// Hunter moderator reviewed this registry record and intentionally approved
// it for public visibility. It is NOT evidence that any receipt was really
// issued by Tesla, and nothing here says so.
//
//  approve_public   STRICT. Refused with 409 not_eligible (and the factual
//                   blocking_reasons) unless the vehicle is private and meets
//                   the approval requirements: a counted, non-superseded ride
//                   and a unique plate. The check is repeated atomically inside
//                   the audited write, so a ride deleted between the check and
//                   the write cannot slip a vehicle through. Behavior and
//                   requirements are UNCHANGED by the addition of approve_cybercab
//                   below — it does not require a vin and never looks at one.
//  approve_cybercab Same guard as approve_public, PLUS the vehicle must already
//                   have a vin (saved separately beforehand via POST .../vin —
//                   see apiSetRegistryVehicleVin). This is the moderator's own
//                   assertion, made outside this app on Robotaxi Tracker, that
//                   the vehicle is a Cybercab; nothing here inspects or decodes
//                   the vin to decide that. Refused with 409 not_eligible and
//                   blocking_reasons including 'no_vin' when the vin is missing.
//                   Writes the SAME review action as approve_public
//                   ('approved_public' — see changeRobotaxiVehicleVisibility):
//                   this is still fundamentally "a moderator made this vehicle
//                   public", so no new review-table action value is needed.
//  return_private   Takes a public vehicle out of public view.
// All three write (or, for return_private, may write) an append-only history
// row (who, when, what, and the facts they were made on). 409 already_public /
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
  if (body.action !== 'approve_public' && body.action !== 'approve_cybercab' && body.action !== 'return_private') {
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

  const isCybercab = body.action === 'approve_cybercab';
  const approving = body.action === 'approve_public' || isCybercab;
  if (approving && vehicle.visibility === VEHICLE_VISIBILITY.PUBLIC) {
    return Response.json({ success: false, error: 'already_public', vehicle }, { status: 409 });
  }
  if (!approving && vehicle.visibility !== VEHICLE_VISIBILITY.PUBLIC) {
    return Response.json({ success: false, error: 'already_private', vehicle }, { status: 409 });
  }
  if (approving) {
    // evaluateVehicleApproval (vehicle.approval) is never changed for this
    // feature — approve_cybercab only ADDS 'no_vin' to the SAME blocking-reasons
    // list ordinary approve_public already computes, at the response level.
    const blockingReasons = isCybercab && !vehicle.vin
      ? [...vehicle.approval.blocking_reasons, 'no_vin']
      : vehicle.approval.blocking_reasons;
    if (blockingReasons.length > 0) {
      return Response.json({ success: false, error: 'not_eligible', blocking_reasons: blockingReasons, vehicle }, { status: 409 });
    }
  }

  const { applied } = await db.changeRobotaxiVehicleVisibility(sql, {
    vehicleId, moderatorId: auth.userId, reason: parsed.reason,
    target: approving ? VEHICLE_VISIBILITY.PUBLIC : VEHICLE_VISIBILITY.PRIVATE
  });

  const fresh = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!applied) {
    // Lost a race (another moderator, or the vehicle's rides changed) between
    // the read above and the atomic write: report the CURRENT state.
    if (!fresh) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    if (approving && fresh.visibility === VEHICLE_VISIBILITY.PUBLIC) return Response.json({ success: false, error: 'already_public', vehicle: fresh }, { status: 409 });
    if (!approving && fresh.visibility !== VEHICLE_VISIBILITY.PUBLIC) return Response.json({ success: false, error: 'already_private', vehicle: fresh }, { status: 409 });
    const freshBlocking = isCybercab && !fresh.vin
      ? [...fresh.approval.blocking_reasons, 'no_vin']
      : fresh.approval.blocking_reasons;
    return Response.json({ success: false, error: 'not_eligible', blocking_reasons: freshBlocking, vehicle: fresh }, { status: 409 });
  }

  return Response.json({ success: true, action: approving ? 'approved_public' : 'returned_private', vehicle: fresh });
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i; // standard 17-char VIN shape, excludes I/O/Q — format only, never decoded

// POST /api/moderation/robotaxi-vehicles/:id/vin   { "vin": string }
//
// Records the VIN a moderator read directly off Robotaxi Tracker (an
// external site this app never queries programmatically — see the workflow
// comment above apiReviewRegistryVehicle) after manually confirming for
// themselves that the vehicle is a Cybercab. This is the ONLY way a vin is
// ever written: nothing in this app derives, decodes, or looks one up.
//
// Writes vin/vin_set_by_user_id/vin_set_at ONLY (db.setRegistryVehicleVin) —
// never visibility, never a robotaxi_vehicle_reviews row, never any
// ride/trip/eligibility data. Saving a VIN never approves anything by
// itself; Approve Cybercab (apiReviewRegistryVehicle, action approve_cybercab)
// is always a separate follow-up request. Refuses to overwrite an existing
// vin (409 vin_already_set) rather than silently replacing it.
export async function apiSetRegistryVehicleVin(request, env, vehicleId) {
  const auth = await requireModerator(request, env);
  if (auth.error) return authFailureResponse(auth);

  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const body = await readJsonObject(request);
  if (!body || typeof body.vin !== 'string') {
    return Response.json({ success: false, error: 'invalid_body' }, { status: 400 });
  }
  const vin = body.vin.trim().toUpperCase();
  if (!VIN_RE.test(vin)) {
    return Response.json({ success: false, error: 'invalid_vin' }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const existing = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!existing) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  if (existing.vin) {
    return Response.json({ success: false, error: 'vin_already_set', vehicle: existing }, { status: 409 });
  }
  // A vin may be saved only while the vehicle is still private. Approve
  // Cybercab is the ONLY path that is meant to combine "vin present" with
  // public visibility (see apiReviewRegistryVehicle); without this guard a
  // vehicle already public through the ordinary approve_public path (no vin
  // ever required) could have a vin attached afterward and start showing
  // publicly — vin and Cybercab2.png — without Approve Cybercab ever having
  // run. Refusing here keeps that combination reachable only through the
  // gated action.
  if (existing.visibility === VEHICLE_VISIBILITY.PUBLIC) {
    return Response.json({ success: false, error: 'already_public', vehicle: existing }, { status: 409 });
  }

  const applied = await db.setRegistryVehicleVin(sql, vehicleId, auth.userId, vin);
  const fresh = await db.getRegistryVehicleForModeration(sql, vehicleId);
  if (!applied) {
    // Lost a race (another moderator saved one first, or the vehicle was
    // deleted) between the read above and the atomic write.
    if (!fresh) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
    return Response.json({ success: false, error: 'vin_already_set', vehicle: fresh }, { status: 409 });
  }

  return Response.json({ success: true, vehicle: fresh });
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
