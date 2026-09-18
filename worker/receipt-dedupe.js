// Content-fingerprint for deduplication, three tiers, strongest first:
//   1. Tesla's own ride/receipt ID, when the parser found one.
//   2. The real Tesla receipt format has no ride ID at all, so this is the
//      common case in practice — a hash of the structured fields that
//      identify a specific ride (date, pickup, dropoff, fare, distance).
//      Far more stable than hashing the raw body: a Gmail-forwarded
//      redelivery can have a different footer/quoting/whitespace around
//      identical ride data, which would otherwise produce a different hash
//      and fail to be recognized as the same ride.
//   3. Last resort — a hash of the normalized body text, for anything that
//      didn't yield enough structured fields for tier 2 either.
//
// Note: this only changes how NEW hashes are computed; it never touches an
// already-stored trips.receipt_hash value.

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeReceiptHash(message, extraction) {
  const { external_ride_id, ride_date, pickup_description, dropoff_description, fare_amount_cents, distance } = extraction.fields;

  if (external_ride_id) {
    return sha256Hex(`ride:${external_ride_id}`);
  }
  if (ride_date && pickup_description && dropoff_description) {
    return sha256Hex(`trip:${ride_date}|${pickup_description}|${dropoff_description}|${fare_amount_cents ?? ''}|${distance ?? ''}`);
  }
  return sha256Hex(`content:${(message.text || message.html || '').trim()}`);
}
