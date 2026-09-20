// Lightweight service-area -> timezone knowledge. Receipts carry a local
// wall-clock time and NO timezone, so the zone is inferred from the city
// (or, failing that, the state) already extracted from the receipt's
// address. This is a small static lookup rather than a database table —
// nothing else needs it yet. It is inference, not something the receipt
// states, and callers record it as such (trips.timezone_source).

const SERVICE_AREAS = {
  austin: { state: 'TX', timezone: 'America/Chicago' },
  dallas: { state: 'TX', timezone: 'America/Chicago' },
  houston: { state: 'TX', timezone: 'America/Chicago' },
  'san antonio': { state: 'TX', timezone: 'America/Chicago' },
  'fort worth': { state: 'TX', timezone: 'America/Chicago' },
  'san francisco': { state: 'CA', timezone: 'America/Los_Angeles' },
  'san jose': { state: 'CA', timezone: 'America/Los_Angeles' },
  oakland: { state: 'CA', timezone: 'America/Los_Angeles' },
  'los angeles': { state: 'CA', timezone: 'America/Los_Angeles' },
  phoenix: { state: 'AZ', timezone: 'America/Phoenix' },
  'las vegas': { state: 'NV', timezone: 'America/Los_Angeles' },
  miami: { state: 'FL', timezone: 'America/New_York' }
};

// Coarse fallback for a city not listed above. Only states that sit in a
// single timezone are listed — a state that spans zones (e.g. TX's far
// west, FL's panhandle) is approximated by its dominant zone, which is
// why the result is always labelled as inferred.
const STATE_TIMEZONES = {
  TX: 'America/Chicago',
  CA: 'America/Los_Angeles',
  AZ: 'America/Phoenix',
  NV: 'America/Los_Angeles',
  FL: 'America/New_York',
  NY: 'America/New_York',
  GA: 'America/New_York',
  WA: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  IL: 'America/Chicago'
};

// "4301 Hanover St, Dallas, TX 75225" -> "TX". Null if the address has no
// recognizable "ST ZIP" tail.
export function parseStateFromAddress(description) {
  if (!description) return null;
  const m = String(description).match(/,\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

// Returns { timezone, source } or null when neither the city nor the state
// is known — in which case no timezone (and no UTC start time) is claimed.
export function resolveTimezone({ serviceArea, state }) {
  const area = serviceArea ? SERVICE_AREAS[String(serviceArea).trim().toLowerCase()] : null;
  if (area) return { timezone: area.timezone, source: 'inferred_from_service_area' };
  if (state && STATE_TIMEZONES[state]) return { timezone: STATE_TIMEZONES[state], source: 'inferred_from_state' };
  return null;
}
