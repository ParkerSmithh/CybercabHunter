// Machine endpoint for the Muse assistant to record ONE ride against an
// EXISTING, publicly eligible registry vehicle:
//
//   POST /api/integrations/muse/robotaxi-rides   { "plate", "date", "miles"? }
//
// Authenticated by ONE dedicated Worker secret (env.MUSE_RIDES_TOKEN, a
// bearer token) — deliberately NOT the sightings token (MUSE_CONNECTOR_TOKEN),
// so each credential can be rotated or revoked alone, and never a browser
// session. Server-to-server: no CORS.
//
// The write is db.logManualRide — the SAME single write path as the
// moderator's Log ride — with fixed provenance the caller cannot influence:
// owned by the system user (env.MUSE_CONNECTOR_USER_ID), reviewed_by NULL
// (no human reviewed it), evidence_type and trips.source 'muse_api'. It never
// creates a vehicle, and it only writes when the vehicle is publicly eligible
// (publicVehicleEligibleSql) at that moment, so it can't revive a hidden one.
// The D1 duplicate guard inside that write is the authority on duplicates; the
// Workers rate limiter below is only a coarse abuse brake.
//
// Order: configuration -> credential -> rate limit -> body. The body is not
// read before the credential is verified. Neither the token nor the system
// owner id is ever logged or returned.

import { db } from './db.js';
import { tokensMatch, readBearerToken } from './connector.js';
import { normalizePlate } from './plate.js';
import { parseManualRideDate, parseManualRideDistance } from './ride-input.js';

const ALLOWED_FIELDS = new Set(['plate', 'date', 'miles']);
const MAX_NORMALIZED_PLATE = 20;
// Coarse abuse-control key: one bucket for this route (the token is the only
// credential that reaches it). Not accounting — see the binding in wrangler.jsonc.
const RATE_LIMIT_KEY = 'muse-robotaxi-rides';

const fail = (status, error, headers) => Response.json({ ok: false, error }, { status, headers });

export async function apiMuseLogRide(request, env) {
  const expected = env.MUSE_RIDES_TOKEN;
  const ownerUserId = env.MUSE_CONNECTOR_USER_ID;
  if (!expected || !ownerUserId) return fail(503, 'not_configured');

  const provided = readBearerToken(request);
  if (!provided || !(await tokensMatch(provided, expected))) {
    return fail(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  // Abuse brake only: per-location, eventually consistent, permissive by design.
  // An absent binding or a limiter failure never blocks a ride — the D1 write
  // below is what enforces correctness.
  if (env.MUSE_RIDES_LIMITER) {
    let allowed = true;
    try { allowed = (await env.MUSE_RIDES_LIMITER.limit({ key: RATE_LIMIT_KEY })).success !== false; } catch (err) { /* fail open */ }
    if (!allowed) return fail(429, 'rate_limited', { 'Retry-After': '60' });
  }

  let body;
  try { body = await request.json(); } catch (err) { body = null; }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'invalid_body');
  if (Object.keys(body).some(k => !ALLOWED_FIELDS.has(k))) return fail(400, 'unknown_field');

  if (typeof body.plate !== 'string' || body.plate.length > 64) return fail(400, 'invalid_plate');
  const plate = normalizePlate(body.plate);
  if (!plate || plate.length > MAX_NORMALIZED_PLATE) return fail(400, 'invalid_plate');

  const dateCheck = parseManualRideDate(body.date);
  if (!dateCheck.ok) return fail(400, dateCheck.reason === 'future' ? 'future_date' : 'invalid_date');
  const milesCheck = parseManualRideDistance(body.miles);
  if (!milesCheck.ok) return fail(400, 'invalid_miles');

  const sql = env.cybercabhunter_db;
  try {
    const found = await db.resolveRobotaxiVehicleByPlate(sql, plate);
    if (found.status === 'ambiguous') return fail(409, 'ambiguous_plate');
    if (found.status !== 'unique') return fail(404, 'vehicle_not_found');

    const result = await db.logManualRide(sql, {
      vehicleId: found.vehicleId, reviewedBy: null, ownerUserId, source: 'muse_api', requirePublicEligible: true,
      rideDate: dateCheck.value, distance: milesCheck.value, distanceUnit: 'mi', serviceArea: null
    });
    if (result.status === 'not_found') return fail(404, 'vehicle_not_found');
    if (result.status === 'owner_missing') return fail(503, 'not_configured');
    if (result.status === 'duplicate') return fail(409, 'duplicate_ride');
    return Response.json({
      ok: true,
      vehicle: { id: found.vehicleId, license_plate: plate },
      ride: { id: result.tripId, date: dateCheck.value, miles: result.distance }
    }, { status: 201 });
  } catch (err) {
    return fail(500, 'internal_error');
  }
}
