// The Tesla ride-history API adapter (source 'tesla-api', Tesla Ride Sync):
// one raw ride from GET /mobile-app/ride/history (worker/tesla-ride-provider.js)
// -> the canonical ride (worker/ride-canonical.js, which registers it).
//
// Field names are Tesla's: rideId, rideStartedAt, rideCompletedAt,
// pickup/dropoffLocationName/Latitude/Longitude/Timezone, totalDistanceMiles,
// totalDurationSeconds, totalDue, currencyCode, licensePlate, vin,
// vehicleModel, isValid. The same principles as receipts: missing stays
// missing (never 0), nothing is invented, and no private detail beyond what a
// receipt already carries is kept (billing ids, rider ids, routes, payment
// data are never read).
//
// Imports from ride-canonical.js (which imports this file back): only function
// declarations cross that cycle, and only at call time, so either module may
// load first.

import { computeRideKey, normalizePlate, nonNegativeNumber } from './ride-canonical.js';
import { parseStateFromAddress, resolveTimezone } from './city-reference.js';
import { SERVICE_AREAS, isInServiceArea } from './service-areas.js';
import { isValidTimeZone } from './timezones.js';

function parseInstant(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

// The wall-clock date (YYYY-MM-DD) and time (HH:MM) of an instant in a zone.
function localDateTime(ms, zone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function coordinate(raw, limit) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function text(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

// Dollars ("12.34", 12.34) -> cents. Null when absent or not a number.
function dollarsToCents(raw) {
  const n = nonNegativeNumber(raw);
  return n === null ? null : Math.round(n * 100);
}

function serviceAreaAt(lat, lng) {
  if (lat === null || lng === null) return null;
  const area = SERVICE_AREAS.find(a => isInServiceArea(a, lng, lat));
  return area ? area.name : null;
}

export function fromTeslaApi(raw, source) {
  const r = raw || {};
  const rideId = text(r.rideId);
  const pickupLat = coordinate(r.pickupLocationLatitude, 90);
  const pickupLng = coordinate(r.pickupLocationLongitude, 180);
  const dropoffLat = coordinate(r.dropoffLocationLatitude, 90);
  const dropoffLng = coordinate(r.dropoffLocationLongitude, 180);
  const serviceArea = serviceAreaAt(pickupLat, pickupLng) || serviceAreaAt(dropoffLat, dropoffLng);

  // Timezone: the API's own (pickup, then dropoff), else the same inference
  // receipts use (service area, then the state in an address).
  let timezone = null, timezoneSource = null;
  for (const zone of [r.pickupLocationTimezone, r.dropoffLocationTimezone]) {
    if (isValidTimeZone(zone)) { timezone = zone; timezoneSource = 'extracted'; break; }
  }
  if (!timezone) {
    const state = parseStateFromAddress(r.pickupLocationName) || parseStateFromAddress(r.dropoffLocationName);
    const zone = resolveTimezone({ serviceArea, state });
    if (zone) { timezone = zone.timezone; timezoneSource = zone.source; }
  }

  // The API gives instants; the ride's identity uses the LOCAL date and
  // pickup minute, exactly as a receipt prints them. Without a timezone there
  // is no honest local time, and the ride has no identity.
  const startedMs = parseInstant(r.rideStartedAt);
  const completedMs = parseInstant(r.rideCompletedAt);
  const start = startedMs !== null && timezone ? localDateTime(startedMs, timezone) : null;
  const end = completedMs !== null && timezone ? localDateTime(completedMs, timezone) : null;
  const rideDate = start ? start.date : null;
  const pickupTime = start ? start.time : null;

  const durationSeconds = nonNegativeNumber(r.totalDurationSeconds);
  const fareAmountCents = dollarsToCents(r.totalDue);
  const currencyCode = typeof r.currencyCode === 'string' && /^[A-Za-z]{3}$/.test(r.currencyCode) ? r.currencyCode.toUpperCase() : null;
  const licensePlate = normalizePlate(r.licensePlate);

  let identityIssue = null;
  if (!rideId) identityIssue = 'ride_id_missing';
  else if (startedMs === null) identityIssue = r.rideStartedAt ? 'ride_start_unreadable' : 'ride_start_missing';
  else if (!timezone) identityIssue = 'ride_timezone_unknown';

  return {
    source,
    provider: 'tesla',
    parserVersion: 'tesla-api-v1',
    externalRideId: rideId,
    rideDate,
    pickupTime,
    dropoffTime: end ? end.time : null,
    startedAtUtc: startedMs !== null ? new Date(startedMs).toISOString() : null,
    completedAtUtc: completedMs !== null ? new Date(completedMs).toISOString() : null,
    timezone,
    timezoneSource,
    pickupDescription: text(r.pickupLocationName),
    dropoffDescription: text(r.dropoffLocationName),
    // Coordinates are part of the canonical shape (they place the ride in a
    // service area) but are not persisted: an exact pickup point is more
    // private than the place name a receipt already shows.
    pickupLatitude: pickupLat,
    pickupLongitude: pickupLng,
    dropoffLatitude: dropoffLat,
    dropoffLongitude: dropoffLng,
    serviceArea,
    distance: nonNegativeNumber(r.totalDistanceMiles),
    distanceUnit: 'mi',
    durationSeconds: durationSeconds === null ? null : Math.round(durationSeconds),
    durationMinutes: durationSeconds === null ? null : Math.round(durationSeconds / 60),
    durationDerived: false,
    fareAmountCents,
    currency: fareAmountCents === null ? null : (currencyCode || 'USD'),
    currencySource: fareAmountCents === null ? null : (currencyCode ? 'extracted' : 'assumed'),
    licensePlate,
    // Stored as-is (only trimmed), as the vehicle's REPORTED VIN: a moderator
    // checks it later. Never decoded or trusted here, and never written to the
    // registry's moderator-entered vin (worker/tesla-rides.js).
    reportedVin: text(r.vin),
    vehicleModel: text(r.vehicleModel),
    rideKey: computeRideKey({ rideDate, pickupTime, licensePlate }),
    identityIssue,
    // The ride-history API has no "sent" time; the ordering rule
    // (worker/ride-ingest.js) then never lets it overwrite a stored value.
    receiptSentAt: null,
    // Stable per Tesla ride: the same ride synced again is a duplicate.
    receiptHash: rideId ? `${source}:${rideId}` : null,
    // Tesla's own record of a completed ride is trusted like an accepted
    // receipt — unless Tesla itself marks the ride invalid.
    review: r.isValid === false
      ? { status: 'needs_review', reason: 'tesla_marked_invalid' }
      : { status: 'accepted', reason: 'tesla_api' },
    messageId: null
  };
}
