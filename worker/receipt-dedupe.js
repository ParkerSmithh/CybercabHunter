// Content fingerprint of a receipt, three tiers, strongest first:
//   1. Tesla's own ride/receipt ID, when the parser found one.
//   2. The real Tesla receipt format has no ride ID at all, so this is the
//      common case in practice — a hash of the structured fields that
//      identify a specific ride: date, pickup time, plate, both addresses,
//      fare and distance. Far more stable than hashing the raw body (a
//      Gmail-forwarded redelivery can carry a different footer/quoting
//      around identical ride data).
//   3. Last resort — a hash of the normalized body text, for anything that
//      didn't yield enough structured fields for tier 2.
//
// IMPORTANT: this is a CONTENT hash, not a ride identity. It answers "have
// I seen exactly this receipt before?" — nothing more. Whether two receipts
// describe the same ride (including an updated receipt with a changed fare,
// which deliberately hashes differently) is decided by the ride_key in
// worker/ride-canonical.js. The fare being part of this hash is what lets
// an updated receipt be recognized as new content rather than swallowed as
// a duplicate.

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeReceiptHash(message, extraction) {
  const {
    external_ride_id, ride_date, pickup_time, license_plate,
    pickup_description, dropoff_description, fare_amount_cents, distance
  } = extraction.fields;

  if (external_ride_id) {
    return sha256Hex(`ride:${external_ride_id}`);
  }
  if (ride_date && pickup_description && dropoff_description) {
    return sha256Hex(`trip:${ride_date}|${pickup_time ?? ''}|${license_plate ?? ''}|${pickup_description}|${dropoff_description}|${fare_amount_cents ?? ''}|${distance ?? ''}`);
  }
  return sha256Hex(`content:${(message.text || message.html || '').trim()}`);
}
