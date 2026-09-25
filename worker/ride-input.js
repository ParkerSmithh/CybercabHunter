// Validation shared by every endpoint that records ONE manual ride
// (the moderator's Log ride and the Muse machine endpoint), so the two can never
// disagree about what a valid date or distance is. Each returns
// { ok: true, value } or { ok: false, reason }; the caller maps the reason to
// its own error code.

import { normalizeRideDate } from './ride-canonical.js';

export const todayUtc = () => new Date().toISOString().slice(0, 10);

// A REAL calendar date in exactly YYYY-MM-DD, not after today (UTC).
export function parseManualRideDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || normalizeRideDate(raw) !== raw) {
    return { ok: false, reason: 'invalid' };
  }
  if (raw > todayUtc()) return { ok: false, reason: 'future' };
  return { ok: true, value: raw };
}

// Optional: absent/null means "no distance" (never defaulted or guessed);
// present means a JSON number that is finite and strictly positive.
export function parseManualRideDistance(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { ok: false, reason: 'invalid' };
  return { ok: true, value: raw };
}
