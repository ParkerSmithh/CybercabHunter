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

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
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
