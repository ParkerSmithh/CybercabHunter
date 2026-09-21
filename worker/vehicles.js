// Public, read-only robotaxi vehicle info — the only /api/* route in this
// app that intentionally requires no bearer session. See worker/index.js
// for the route and why /api/robotaxi-vehicles/:id (not /api/vehicles/:id)
// was chosen: /api/tesla/vehicles already names something else entirely — a
// signed-in rider's OWN Tesla(s), from the private `vehicles` table — and
// robotaxi_vehicles (the public, ownerless registry) is what this endpoint
// actually reads.
//
// Thin layer only. db.getPublicRobotaxiVehicle and db.getRobotaxiVehicleHistory
// already exist and are already tested privacy-safe (no user_id, no
// pickup/dropoff text — see tests/vehicle-identity.test.mjs) — this file
// does not recompute, redefine, or add to either query.
//
// total_fare_cents from getRobotaxiVehicleHistory is deliberately left out
// of the public response. It's the sum of what riders individually PAID —
// for a vehicle with only one or two recorded rides (the common case) that
// figure is effectively one specific anonymous rider's fare, a different
// privacy category than vehicle activity/location data. It also isn't part
// of the Phase 3 vehicle-intelligence field list this endpoint exists to
// serve (plate, model, city, first/last seen, ride/mileage counts — never
// money). Everything else getRobotaxiVehicleHistory returns is forwarded
// as-is.

import { db } from './db.js';

export const VEHICLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function apiGetVehicle(request, env, vehicleId) {
  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const vehicle = await db.getPublicRobotaxiVehicle(env.cybercabhunter_db, vehicleId);
  if (!vehicle) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  const history = await db.getRobotaxiVehicleHistory(env.cybercabhunter_db, vehicleId);

  // No existing public endpoint in this app has rate limiting, caching, or
  // any KV-backed throttling to match (see worker/index.js) — introducing
  // one would be new infrastructure, out of scope for this change. A
  // Cache-Control header costs nothing (standard Fetch Response API,
  // already used everywhere) and lets a browser or any CDN layer that
  // honors origin headers avoid re-hitting D1 for the same vehicle within
  // a short window; it is not a replacement for real rate limiting.
  return Response.json({
    vehicle,
    history: {
      trip_count: history.trip_count,
      first_ride_date: history.first_ride_date,
      last_ride_date: history.last_ride_date,
      total_distance: history.total_distance,
      service_areas: history.service_areas
    }
  }, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  });
}

const SIGHTINGS_DEFAULT_LIMIT = 10;
const SIGHTINGS_MAX_LIMIT = 50;

// Public: approved community sightings for one public registry vehicle.
// Same gate as apiGetVehicle (400 bad id, 404 missing OR non-public — the
// two are indistinguishable to the caller). The response is deliberately
// only { date, service_area } per entry: no observation/submission/user
// ids, no free-text location or notes, no evidence, no moderation data, no
// exact timestamp, and no model/color (see db.getPublicVehicleSightings).
// An unusable ?limit falls back to the default rather than erroring; a
// too-large one is clamped to the maximum. There is no cursor: this is a
// short recent list, not a feed.
export async function apiGetVehicleSightings(request, env, vehicleId) {
  if (!VEHICLE_ID_RE.test(vehicleId)) {
    return Response.json({ success: false, error: 'invalid_vehicle_id' }, { status: 400 });
  }

  const sql = env.cybercabhunter_db;
  const vehicle = await db.getPublicRobotaxiVehicle(sql, vehicleId);
  if (!vehicle) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }

  const raw = new URL(request.url).searchParams.get('limit');
  let limit = SIGHTINGS_DEFAULT_LIMIT;
  if (raw !== null && /^\d+$/.test(raw)) {
    limit = Math.min(Math.max(parseInt(raw, 10), 1), SIGHTINGS_MAX_LIMIT);
  }

  const sightings = await db.getPublicVehicleSightings(sql, vehicleId, limit);
  return Response.json({ sightings }, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  });
}
