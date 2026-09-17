// Content-fingerprint for deduplication. Prefers Tesla's own ride/receipt
// ID when the parser found one (strongest signal); falls back to a hash of
// the normalized body text so a receipt lacking an extractable ID still
// gets a stable fingerprint across repeated/retried deliveries.

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeReceiptHash(message, extraction) {
  const basis = extraction.fields.external_ride_id
    ? `ride:${extraction.fields.external_ride_id}`
    : `content:${(message.text || message.html || '').trim()}`;
  return sha256Hex(basis);
}
