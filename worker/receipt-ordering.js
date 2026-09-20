// When was this receipt SENT? The one ordering signal a receipt can carry.
//
// What the platform actually provides: Cloudflare Email Routing hands the
// worker the raw message, and the only time metadata in it is the sender's
// own Date header (postal-mime normalizes a valid one to UTC ISO-8601 and
// leaves an invalid one as raw text). There is no trustworthy "received at"
// stamp, and nothing at all for pasted text.
//
// A Date header is only Tesla's send time when the message really is
// Tesla's: an auto-forwarded message keeps the original From and Date. A
// MANUALLY forwarded message carries the forwarder's own Date (the moment
// they pressed Forward), which says nothing about when Tesla sent the
// receipt — treating it as one would let an old receipt forwarded late look
// "newer" than a corrected one. So the stamp is only taken from a message
// whose own From is Tesla; everything else is null, meaning "cannot be
// ordered". Nothing is guessed.

import { isTeslaAddress } from './receipt-forwarding.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// Returns a normalized UTC ISO string, or null when the message cannot be
// ordered. `now` is injectable for tests.
export function receiptSentAt(message, now = Date.now()) {
  if (!message || !message.from || !isTeslaAddress(message.from)) return null;
  const raw = message.date;
  if (typeof raw !== 'string' || !ISO_UTC.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < EARLIEST_PLAUSIBLE_MS || ms > now + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

// True only when the incoming receipt is CONFIDENTLY newer than what the
// ride currently holds: both sides have a timestamp and the incoming one is
// strictly later. Equal, older, or unknown all mean "keep what is stored".
export function isConfidentlyNewer(incomingSentAt, storedSentAt) {
  return !!incomingSentAt && !!storedSentAt && incomingSentAt > storedSentAt;
}
