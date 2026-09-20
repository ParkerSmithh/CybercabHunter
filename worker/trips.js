// The authenticated rider's own ride history — every handler takes an
// already-verified userId (resolved from the bearer session in index.js),
// never a user id from the request, so a rider can only ever reach their own
// rides. What a ride exposes is whitelisted in db.getTripsPage itself, not
// here: never pickup/dropoff addresses, exact pickup/dropoff times, payment
// details, passenger name, receipt hashes or raw receipt content.

import { db } from './db.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function intParam(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function apiListTrips(request, env, userId) {
  const params = new URL(request.url).searchParams;
  const page = intParam(params.get('page'), 1, 1, 1_000_000);
  const pageSize = intParam(params.get('page_size'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  const { trips, total } = await db.getTripsPage(env.cybercabhunter_db, userId, {
    limit: pageSize, offset: (page - 1) * pageSize
  });

  return Response.json({
    trips,
    pagination: { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) }
  });
}

async function removeEvidence(env, refs) {
  // Best effort: a missing/unreachable object must not fail the deletion of
  // the rider's data. Keys are server-generated, per-user namespaced.
  for (const ref of refs) {
    try { await env.EVIDENCE_BUCKET.delete(ref); } catch (err) { /* ignore */ }
  }
}

// Deleting a ride removes only the rider's private data. The public robotaxi
// vehicle it referenced stays exactly as it was.
export async function apiDeleteTrip(request, env, userId, tripId) {
  const result = await db.deleteRideForUser(env.cybercabhunter_db, userId, tripId);
  if (!result) return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  await removeEvidence(env, result.evidenceRefs);
  return Response.json({ success: true, deleted: result.deleted });
}

// Deletes the rider's entire ride history. Requires an explicit confirmation
// token in the body so a stray request can never wipe it.
export async function apiDeleteAllTrips(request, env, userId) {
  let body = null;
  try { body = await request.json(); } catch (err) { /* handled below */ }
  if (!body || body.confirm !== 'delete-all-rides') {
    return Response.json({ success: false, error: 'confirmation_required' }, { status: 400 });
  }
  const result = await db.deleteAllRidesForUser(env.cybercabhunter_db, userId);
  await removeEvidence(env, result.evidenceRefs);
  return Response.json({ success: true, deleted: result.deleted });
}
