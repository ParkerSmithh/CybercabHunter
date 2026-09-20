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

const VEHICLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
