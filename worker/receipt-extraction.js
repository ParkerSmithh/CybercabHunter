// Tesla-Robotaxi-specific field extraction, versioned so a future format
// change gets a new function (tesla_robotaxi_v2) rather than a rewrite of
// this module or the ingestion pipeline that calls it.
//
// IMPORTANT: these patterns are written against a *plausible* receipt
// layout (based on what fields a ride-hailing receipt typically contains),
// not a confirmed real Tesla Robotaxi email — none was available to test
// against. Treat this as a first version that WILL need adjustment once
// checked against an actual receipt; do not treat "it parses" as proof it
// matches Tesla's real format.

const PARSER_VERSION = 'tesla_robotaxi_v1';
const PARSER_VERSION_V2 = 'tesla_robotaxi_v2';

// Preserves block-level line breaks (so a summary line, an address line,
// and a time line stay distinguishable) instead of collapsing everything
// to one space-separated string. v1's own regexes are already \s*-based
// so real newlines don't break them; v2's pickup/dropoff parsing depends
// on these breaks existing.
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export function extractTeslaReceiptFields(message) {
  const text = message.text && message.text.trim().length > 0
    ? message.text
    : stripHtml(message.html || '');

  const fields = {};
  const fieldSources = {};

  const rideDate = firstMatch(text, [
    /\bDate\b\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/
  ]);
  if (rideDate) { fields.ride_date = rideDate; fieldSources.ride_date = 'extracted'; }

  const serviceArea = firstMatch(text, [
    /\bCity\b\s*[:\-]?\s*([A-Za-z .]{2,30}(?:,\s*[A-Z]{2})?)/i,
    /\b(Austin|Dallas|Houston)\b/i
  ]);
  if (serviceArea) { fields.service_area = serviceArea; fieldSources.service_area = 'extracted'; }

  const distanceRaw = firstMatch(text, [
    /\bDistance\b\s*[:\-]?\s*([\d.]+)\s*(?:mi|miles)?/i
  ]);
  if (distanceRaw && !Number.isNaN(parseFloat(distanceRaw))) {
    fields.distance = parseFloat(distanceRaw);
    fieldSources.distance = 'extracted';
  }

  const fareRaw = firstMatch(text, [
    /\bTotal\b\s*[:\-]?\s*\$?([\d.]+)/i,
    /\bFare\b\s*[:\-]?\s*\$?([\d.]+)/i,
    /\bAmount\s*Charged\b\s*[:\-]?\s*\$?([\d.]+)/i
  ]);
  if (fareRaw && !Number.isNaN(parseFloat(fareRaw))) {
    fields.fare_amount_cents = Math.round(parseFloat(fareRaw) * 100);
    fieldSources.fare_amount_cents = 'extracted';
  }

  const externalRideId = firstMatch(text, [
    /\bRide\s*ID\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i,
    /\bTrip\s*ID\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i,
    /\bReceipt\s*(?:#|No\.?|Number)\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i
  ]);
  if (externalRideId) { fields.external_ride_id = externalRideId; fieldSources.external_ride_id = 'extracted'; }

  const licensePlate = firstMatch(text, [
    /\bLicense\s*Plate\b\s*[:\-]?\s*([A-Z0-9\-]{4,10})/i,
    /\bPlate\b\s*[:\-]?\s*([A-Z0-9\-]{4,10})/i
  ]);
  if (licensePlate) { fields.license_plate = licensePlate.toUpperCase(); fieldSources.license_plate = 'extracted'; }

  const mentionsRobotaxi = /robotaxi/i.test(message.subject) || /robotaxi/i.test(text);

  return {
    parserVersion: PARSER_VERSION,
    fields,
    fieldSources,
    signals: {
      mentionsRobotaxi,
      hasFare: fields.fare_amount_cents !== undefined,
      hasDistance: fields.distance !== undefined,
      hasRideId: !!fields.external_ride_id
    }
  };
}

// ---- tesla_robotaxi_v2 — matches the REAL Tesla Robotaxi receipt format ----
//
// Confirmed against an actual forwarded receipt (unlike v1, which was
// written against an assumed layout and never verified). Real receipts do
// not appear to include a ride/trip ID at all — external_ride_id is
// expected to be null for most real emails, which is correct, not a
// failure. Kept alongside v1 (never replacing it) per this module's own
// versioning convention: handleIncomingEmail tries v2 first and falls
// back to v1 only if v2 recognizes nothing at all.

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12
};

// "Trip Summary for June 9, 2026" — anchored specifically to this label so
// a Gmail-forwarded copy's own "Date: ..." header (a completely different
// line) can never be mistaken for the ride's actual date.
function parseTripSummaryDate(text) {
  const m = text.match(/Trip\s+Summary\s+for\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTH_NAMES[m[1].toLowerCase()];
  if (!month) return null;
  const day = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${m[3]}-${String(month).padStart(2, '0')}-${day}`;
}

// "2.8 mi · 14 min · XJR2195" — tolerant of whatever separates the three
// tokens (·, |, dash, plain whitespace) since only proximity is required,
// not an exact separator character. Plate length is not assumed.
function parseSummaryLine(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*mi(?:les)?\b[^\n]{0,25}?(\d+)\s*min(?:ute)?s?\b[^\n]{0,25}?([A-Za-z0-9]{3,10})\b/i);
  if (!m) return null;
  return {
    distance: parseFloat(m[1]),
    duration_minutes: parseInt(m[2], 10),
    license_plate: m[3].toUpperCase()
  };
}

// "1:04 pm" / "1:18 PM" -> "13:04" / "13:18". 12 AM -> 00, 12 PM stays 12.
function to24HourTime(raw) {
  const m = raw.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  const isPM = m[3].toLowerCase() === 'p';
  if (hour === 12) hour = isPM ? 12 : 0;
  else if (isPM) hour += 12;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

function deriveDurationMinutes(pickupTime, dropoffTime) {
  const [ph, pm] = pickupTime.split(':').map(Number);
  const [dh, dm] = dropoffTime.split(':').map(Number);
  let diff = (dh * 60 + dm) - (ph * 60 + pm);
  if (diff < 0) diff += 24 * 60; // crossed midnight
  return diff;
}

function splitLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

// Gmail's plain-text rendering of Tesla's HTML receipt turns each address
// into a Google Maps hyperlink and precedes some lines with image
// alt-text — neither is real location data, so both are stripped from any
// line before it's kept. A line that's ONLY an artifact (e.g. a standalone
// "[image: x]" line) disappears entirely rather than leaving an empty
// fragment in the joined description.
function stripLocationArtifacts(str) {
  return str
    .replace(/\[image[^\]]*\]/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s*,\s*,/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Walks the lines after "Pick up", collecting a name/address block until it
// hits a time line (that's this stop's time) or a payment-section keyword
// (a guard against runaway consumption if a dropoff time is ever missing).
// The same walk repeats immediately after for the dropoff stop. A single
// collected line is used as-is (the real pickup has no name, just an
// address); two collected lines are joined "Name, Address" (the real
// dropoff has both) — this one rule produces the correct shape for either
// case without hardcoding which stop gets a name.
function parsePickupDropoff(lines) {
  const pickupIdx = lines.findIndex(l => /^pick\s*up$/i.test(l));
  if (pickupIdx === -1) return {};

  const timeRe = /^\d{1,2}:\d{2}\s*[ap]\.?m\.?$/i;
  const stopRe = /^(payment|trip fare|total)\b/i;

  function collectStop(startIdx) {
    const block = [];
    let i = startIdx;
    while (i < lines.length && !timeRe.test(lines[i]) && !stopRe.test(lines[i])) {
      const cleaned = stripLocationArtifacts(lines[i]);
      if (cleaned) block.push(cleaned);
      i++;
    }
    const time = i < lines.length && timeRe.test(lines[i]) ? to24HourTime(lines[i]) : null;
    const description = block.length ? stripLocationArtifacts(block.join(', ')) : null;
    return { description: description || null, time, nextIdx: i + 1 };
  }

  const pickup = collectStop(pickupIdx + 1);
  const dropoff = pickup.time !== null ? collectStop(pickup.nextIdx) : {};

  return {
    pickup_description: pickup.description || null,
    pickup_time: pickup.time || null,
    dropoff_description: dropoff.description || null,
    dropoff_time: dropoff.time || null
  };
}

// Prefers an explicit "City: ..." label (rare in the real format so far);
// otherwise reads the city straight out of a "Street, City, ST ZIP"
// address that was already extracted for pickup/dropoff. Never hardcodes
// a specific city — any US "City, ST ZIP" shape works.
function deriveServiceArea(text, pickupDescription, dropoffDescription) {
  const explicit = firstMatch(text, [
    /\bCity\b\s*[:\-]?\s*([A-Za-z .]{2,30}(?:,\s*[A-Z]{2})?)/i
  ]);
  if (explicit) return explicit;

  const addressCityRe = /,\s*([A-Za-z .]+?),\s*[A-Z]{2}\s*\d{5}/;
  for (const desc of [pickupDescription, dropoffDescription]) {
    if (!desc) continue;
    const m = desc.match(addressCityRe);
    if (m) return m[1].trim();
  }
  return null;
}

// "$6.92\n\nTotal" and "Trip Fare $6.92" are the same charge shown twice —
// extracts once, not twice. If both are present and disagree, that's
// flagged via `mismatch` rather than silently picked, so classifyReceipt
// can route it to human review instead of trusting either number blindly.
function parseFare(text) {
  const totalRaw = firstMatch(text, [
    /\$\s*([\d.]+)\s+Total\b/i,
    /\bTotal\b\s*[:\-]?\s*\$?([\d.]+)/i
  ]);
  const tripFareRaw = firstMatch(text, [
    /\bTrip\s*Fare\b\s*[:\-]?\s*\$?([\d.]+)/i
  ]);

  let cents = null;
  let mismatch = false;
  if (tripFareRaw) cents = Math.round(parseFloat(tripFareRaw) * 100);
  if (totalRaw) {
    const totalCents = Math.round(parseFloat(totalRaw) * 100);
    if (cents === null) cents = totalCents;
    else if (cents !== totalCents) mismatch = true;
  }
  return { cents, mismatch };
}

export function extractTeslaReceiptFieldsV2(message) {
  const text = message.text && message.text.trim().length > 0
    ? message.text
    : stripHtml(message.html || '');

  const fields = {};
  const fieldSources = {};

  const rideDate = parseTripSummaryDate(text);
  if (rideDate) { fields.ride_date = rideDate; fieldSources.ride_date = 'extracted'; }

  const summary = parseSummaryLine(text);
  if (summary) {
    fields.distance = summary.distance;
    fieldSources.distance = 'extracted';
    fields.duration_minutes = summary.duration_minutes;
    fieldSources.duration_minutes = 'extracted';
    fields.license_plate = summary.license_plate;
    fieldSources.license_plate = 'extracted';
  }

  const fare = parseFare(text);
  let fareMismatch = false;
  if (fare.cents !== null) {
    fields.fare_amount_cents = fare.cents;
    fieldSources.fare_amount_cents = fare.mismatch ? 'ambiguous' : 'extracted';
    fareMismatch = fare.mismatch;
  }

  const stops = parsePickupDropoff(splitLines(text));
  if (stops.pickup_description) { fields.pickup_description = stops.pickup_description; fieldSources.pickup_description = 'extracted'; }
  if (stops.pickup_time) { fields.pickup_time = stops.pickup_time; fieldSources.pickup_time = 'extracted'; }
  if (stops.dropoff_description) { fields.dropoff_description = stops.dropoff_description; fieldSources.dropoff_description = 'extracted'; }
  if (stops.dropoff_time) { fields.dropoff_time = stops.dropoff_time; fieldSources.dropoff_time = 'extracted'; }

  // Only derive duration from timestamps when the receipt didn't state one
  // explicitly, and mark it as derived rather than extracted so callers
  // (and duration_minutes_derived in D1) can tell the difference.
  if (fields.duration_minutes === undefined && fields.pickup_time && fields.dropoff_time) {
    const derived = deriveDurationMinutes(fields.pickup_time, fields.dropoff_time);
    if (derived !== null) {
      fields.duration_minutes = derived;
      fieldSources.duration_minutes = 'derived';
    }
  }

  const serviceArea = deriveServiceArea(text, fields.pickup_description, fields.dropoff_description);
  if (serviceArea) { fields.service_area = serviceArea; fieldSources.service_area = 'extracted'; }

  // Kept for any future Tesla receipt that does include one. Absent here —
  // and the vehicle plate above must never be used to fill this in.
  const externalRideId = firstMatch(text, [
    /\bRide\s*ID\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i,
    /\bTrip\s*ID\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i,
    /\bReceipt\s*(?:#|No\.?|Number)\b\s*[:\-]?\s*([A-Za-z0-9\-]{4,40})/i
  ]);
  if (externalRideId) { fields.external_ride_id = externalRideId; fieldSources.external_ride_id = 'extracted'; }

  const mentionsRobotaxi = /robotaxi/i.test(message.subject) || /robotaxi/i.test(text);

  return {
    parserVersion: PARSER_VERSION_V2,
    fields,
    fieldSources,
    signals: {
      mentionsRobotaxi,
      hasFare: fields.fare_amount_cents !== undefined,
      hasDistance: fields.distance !== undefined,
      hasRideId: !!fields.external_ride_id,
      hasPickupDropoff: !!(fields.pickup_description && fields.dropoff_description),
      hasTripDate: !!fields.ride_date,
      fareMismatch
    }
  };
}
