// Local wall-clock date + time in a named IANA timezone -> UTC ISO string.
// Uses Intl (available in both the Workers runtime and Node) so daylight
// saving is handled by the platform's tz database, not hand-rolled offsets.

function offsetMinutesAt(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const get = type => Number(parts.find(p => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

// dateStr 'YYYY-MM-DD', timeStr 'HH:MM' (24h). Returns 'YYYY-MM-DDTHH:MM:00Z'
// or null when any input is missing/invalid or the zone is unknown.
export function localToUtcIso(dateStr, timeStr, timeZone) {
  if (!dateStr || !timeStr || !timeZone) return null;
  const d = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = timeStr.match(/^(\d{2}):(\d{2})$/);
  if (!d || !t) return null;

  const wallAsUtc = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0);
  try {
    // Two passes: the offset must be evaluated at the true instant, which
    // itself depends on the offset (matters only within a DST transition).
    let guess = wallAsUtc - offsetMinutesAt(wallAsUtc, timeZone) * 60000;
    guess = wallAsUtc - offsetMinutesAt(guess, timeZone) * 60000;
    return new Date(guess).toISOString().replace('.000Z', 'Z');
  } catch (err) {
    return null; // unknown timezone identifier
  }
}
