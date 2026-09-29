// Local time for a sighting's area. The sighting form only asks for the
// DATE spotted; the time is the exact moment of submission, taken in the
// local time zone of the area being documented (Austin -> US Central, Miami
// -> US Eastern). See resolveObservedAt.
//
// The zone comes from, in order: the City / Service Area, the state of the
// picked Location, then the submitter's own browser time zone.

const CITY_ZONES = {
  austin: 'America/Chicago', dallas: 'America/Chicago', houston: 'America/Chicago', 'san antonio': 'America/Chicago',
  'fort worth': 'America/Chicago', 'el paso': 'America/Denver',
  miami: 'America/New_York', orlando: 'America/New_York', tampa: 'America/New_York', jacksonville: 'America/New_York',
  'san francisco': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles', phoenix: 'America/Phoenix',
  'las vegas': 'America/Los_Angeles', atlanta: 'America/New_York', nashville: 'America/Chicago', denver: 'America/Denver'
};

// Each state's main zone (a few states span two; the city list above covers
// the notable exceptions).
const STATE_ZONES = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver'
};

export function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; }
}

// "Austin" / "Austin, TX" -> city zone; a location label ending in a state
// ("..., Dallas, TX") -> state zone; otherwise the fallback (if valid) or null.
export function timeZoneFor({ serviceArea = null, location = null, fallback = null } = {}) {
  const city = String(serviceArea || '').toLowerCase().split(',')[0].trim().replace(/\s+/g, ' ');
  if (CITY_ZONES[city]) return CITY_ZONES[city];
  for (const text of [location, serviceArea]) {
    const parts = String(text || '').split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      const locCity = parts[parts.length - 2].toLowerCase();
      if (CITY_ZONES[locCity]) return CITY_ZONES[locCity];
    }
    const state = parts.length ? parts[parts.length - 1].toUpperCase() : '';
    if (STATE_ZONES[state]) return STATE_ZONES[state];
  }
  return isValidTimeZone(fallback) ? fallback : null;
}

// The wall-clock fields of instant `ms` in `zone`.
function wallClock(ms, zone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

// The UTC instant of a local wall-clock time in `zone` (DST-correct).
function localToUtc({ y, m, d, h, mi, s }, zone) {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(guess, zone);
    guess = asUtc - (Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - guess);
  }
  return guess;
}

const pad = n => String(n).padStart(2, '0');
const toSql = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// The sighting's observed_at: the chosen date (YYYY-MM-DD, or today when
// none) at the CURRENT local time in `zone`, as the schema's UTC
// 'YYYY-MM-DD HH:MM:SS'. { error } for a malformed or future date.
export function resolveObservedAt({ date = null, zone, now = Date.now() }) {
  const today = wallClock(now, zone);
  if (!date) return { observedAt: toSql(now) };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (!m) return { error: 'invalid_observed_at' };
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { error: 'invalid_observed_at' };
  if (`${y}-${pad(mo)}-${pad(d)}` > `${today.y}-${pad(today.m)}-${pad(today.d)}`) return { error: 'invalid_observed_at' };
  return { observedAt: toSql(localToUtc({ y, m: mo, d, h: today.h, mi: today.mi, s: today.s }, zone)) };
}
