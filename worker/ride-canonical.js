// The canonical ride: the single shape every ride source must produce
// before anything touches the database. A source adapter turns whatever a
// source hands us into this shape (normalizeRide); ingestRide
// (worker/ride-ingest.js) is the only thing that persists it. Today the
// only sources are forwarded/imported Tesla receipts; a future source adds
// an adapter here and reuses the rest unchanged.
//
// Principles enforced in this layer:
//  - Missing stays missing. An absent distance or fare is null — never 0.
//    (A fare of exactly 0 is a real, distinct value: a free ride.)
//  - Nothing is invented. Currency, timezone and UTC start time carry a
//    provenance field saying whether they were extracted or inferred.
//  - Private receipt details (payment last-four, passenger name) are never
//    read into this shape.

import { parseStateFromAddress, resolveTimezone } from './city-reference.js';
import { localToUtcIso } from './ride-time.js';

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};

const pad2 = n => String(n).padStart(2, '0');

function validIsoDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// Accepts an ISO date, "June 9, 2026" / "Jun 9 2026", or "6/9/2026" /
// "6/9/26". Anything else becomes null rather than a guessed value — the
// older (v1) receipt parser hands back raw date text, which must not be
// stored as-is because month grouping depends on it being ISO.
export function normalizeRideDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validIsoDate(+m[1], +m[2], +m[3]);

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    return month ? validIsoDate(+m[3], month, +m[2]) : null;
  }

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validIsoDate(year, +m[1], +m[2]);
  }
  return null;
}

export function normalizePlate(raw) {
  if (!raw) return null;
  const plate = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return plate.length >= 2 && plate.length <= 10 ? plate : null;
}

function normalizeTime(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${pad2(+m[1])}:${m[2]}`;
}

function nonNegativeNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nonNegativeInt(raw) {
  const n = nonNegativeNumber(raw);
  return n === null ? null : Math.round(n);
}

function normalizeServiceArea(raw) {
  if (!raw) return null;
  const city = String(raw).replace(/,\s*[A-Z]{2}$/, '').trim();
  return city || null;
}

// A ride's identity: user + date + pickup time + plate (when known). The
// user is a separate column, so it isn't repeated in the key. Requires a
// date and pickup time — without both there is not enough to say two
// receipts are the same ride, and the key is null. A receipt whose key is
// null is NEVER stored as a ride (see identityIssue below and ingestRide).
export function computeRideKey({ rideDate, pickupTime, licensePlate }) {
  if (!rideDate || !pickupTime) return null;
  return `v1|${rideDate}|${pickupTime}|${licensePlate || ''}`;
}

export function parseRideKey(key) {
  if (!key) return null;
  const parts = String(key).split('|');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  return { rideDate: parts[1], pickupTime: parts[2], licensePlate: parts[3] || null };
}

// Two keys name the same ride when date and pickup time match and the
// plates agree — or either side simply didn't have a plate (an updated
// receipt may include one the first lacked, or vice versa).
export function rideKeysCompatible(a, b) {
  const ka = parseRideKey(a), kb = parseRideKey(b);
  if (!ka || !kb) return false;
  if (ka.rideDate !== kb.rideDate || ka.pickupTime !== kb.pickupTime) return false;
  return !ka.licensePlate || !kb.licensePlate || ka.licensePlate === kb.licensePlate;
}

// Why a receipt has no usable ride identity, or null when it has one. The
// plate is optional (an updated receipt may add it); date and pickup time
// are not. "unreadable" means the receipt HAD the field but its text could
// not be normalized — it is never repaired or guessed.
function identityIssueFor(f, rideDate, pickupTime) {
  if (!rideDate) return f.ride_date ? 'ride_date_unreadable' : 'ride_date_missing';
  if (!pickupTime) return f.pickup_time ? 'pickup_time_unreadable' : 'pickup_time_missing';
  return null;
}

// ---- Source adapters ----

// Receipt sources (forwarded email, pasted text, .eml upload) all arrive as
// a parsed extraction plus the trust decision made about it. `raw` is:
//   { extraction, receiptHash, review, messageId, sentAt }
// sentAt is the receipt's trustworthy send time (worker/receipt-ordering.js)
// or null when it cannot be ordered.
function fromReceipt(raw, source) {
  const { extraction, receiptHash, review, messageId, sentAt } = raw;
  const f = extraction.fields;

  const rideDate = normalizeRideDate(f.ride_date);
  const pickupTime = normalizeTime(f.pickup_time);
  const dropoffTime = normalizeTime(f.dropoff_time);
  const licensePlate = normalizePlate(f.license_plate);
  const serviceArea = normalizeServiceArea(f.service_area);
  const state = parseStateFromAddress(f.pickup_description) || parseStateFromAddress(f.dropoff_description);

  const fareAmountCents = nonNegativeInt(f.fare_amount_cents);
  let currency = null, currencySource = null;
  if (fareAmountCents !== null) {
    if (typeof f.currency === 'string' && /^[A-Za-z]{3}$/.test(f.currency) && extraction.fieldSources.currency === 'extracted') {
      currency = f.currency.toUpperCase();
      currencySource = 'extracted';
    } else {
      // Tesla receipts show a bare "$". USD is the natural reading but the
      // receipt does not state it, so it is recorded as an assumption.
      currency = 'USD';
      currencySource = 'assumed';
    }
  }

  const zone = resolveTimezone({ serviceArea, state });
  const timezone = zone ? zone.timezone : null;
  const startedAtUtc = zone ? localToUtcIso(rideDate, pickupTime, zone.timezone) : null;

  return {
    source,
    provider: 'tesla',
    parserVersion: extraction.parserVersion,
    externalRideId: f.external_ride_id || null,
    rideDate,
    pickupTime,
    dropoffTime,
    startedAtUtc,
    timezone,
    timezoneSource: zone ? zone.source : null,
    pickupDescription: f.pickup_description || null,
    dropoffDescription: f.dropoff_description || null,
    serviceArea,
    distance: nonNegativeNumber(f.distance),
    distanceUnit: 'mi',
    durationMinutes: nonNegativeInt(f.duration_minutes),
    durationDerived: extraction.fieldSources.duration_minutes === 'derived',
    fareAmountCents,
    currency,
    currencySource,
    licensePlate,
    rideKey: computeRideKey({ rideDate, pickupTime, licensePlate }),
    identityIssue: identityIssueFor(f, rideDate, pickupTime),
    receiptSentAt: sentAt || null,
    receiptHash,
    review: review || { status: 'needs_review', reason: 'unclassified' },
    messageId: messageId || null
  };
}

export const RIDE_SOURCES = {
  receipt_email: fromReceipt,
  receipt_import: fromReceipt
};

export function normalizeRide(raw, source) {
  const adapter = RIDE_SOURCES[source];
  if (!adapter) throw new Error(`Unknown ride source: ${source}`);
  return adapter(raw, source);
}
