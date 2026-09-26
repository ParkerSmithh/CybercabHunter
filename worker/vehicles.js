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

// Public: two aggregate numbers for the homepage (see db.getPublicRegistryStats).
// GET only, no session, an explicit two-field whitelist. A database failure is a
// generic 503 that is never cached — the page then shows a dash, because "could
// not load" is not the same as zero.
export async function apiGetRegistryStats(request, env) {
  try {
    const stats = await db.getPublicRegistryStats(env.cybercabhunter_db);
    return Response.json({
      public_vehicles: stats.public_vehicles,
      recorded_rides: stats.recorded_rides
    }, {
      headers: { 'Cache-Control': 'public, max-age=60' }
    });
  } catch (err) {
    return Response.json({ success: false, error: 'stats_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;
const LIST_MAX_QUERY = 64;

// Public: the registry list behind /vehicles. Same gate as apiGetVehicle (only
// vehicles that are public AND have a counted ride) — see
// db.getPublicRobotaxiVehicles — so a private, hidden, ineligible or
// nonexistent vehicle can never appear here, and nothing is returned that the
// per-vehicle endpoint would not also return. A missing or unusable
// ?limit / ?offset falls back to the default; a too-large limit is clamped.
export async function apiListVehicles(request, env) {
  const params = new URL(request.url).searchParams;
  const asInt = (raw, fallback) => (/^\d{1,6}$/.test(raw || '') ? Number(raw) : fallback);
  const limit = Math.min(Math.max(asInt(params.get('limit'), LIST_DEFAULT_LIMIT), 1), LIST_MAX_LIMIT);
  const offset = asInt(params.get('offset'), 0);
  // Free-text search (plate, VIN, model, color, city); capped so a pasted
  // essay can't become an expensive scan pattern.
  const q = (params.get('q') || '').trim().slice(0, LIST_MAX_QUERY);

  const { vehicles, total } = await db.getPublicRobotaxiVehicles(env.cybercabhunter_db, { limit, offset, q });
  return Response.json({
    vehicles: vehicles.map(v => ({
      id: v.id,
      provider: v.provider,
      license_plate: v.license_plate,
      model: v.model,
      color: v.color,
      service_area: v.service_area,
      first_seen_at: v.first_seen_at,
      last_seen_at: v.last_seen_at,
      verification_status: v.verification_status,
      // A moderator-entered fact (never inferred/decoded — see migrations/0013),
      // present only once a moderator has confirmed and approved the vehicle as
      // a Cybercab. Never vin_set_by_user_id/vin_set_at — those are moderation
      // provenance, not public vehicle data.
      vin: v.vin,
      trip_count: v.trip_count,
      first_ride_date: v.first_ride_date,
      last_ride_date: v.last_ride_date,
      // Sum of the counted rides' recorded miles (same rule as the detail page's
      // total_distance); null when none of them recorded a distance.
      total_distance: v.total_distance,
      service_areas: v.service_areas
    })),
    total, limit, offset, q
  }, {
    headers: { 'Cache-Control': 'public, max-age=60' }
  });
}

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
