// Real-place search for the sighting form's Location field, backed by Photon
// (https://photon.komoot.io — OpenStreetMap data, the same data the site's
// maps use; free, no API key, built for search-as-you-type).
//
//   GET /api/places?q=...&area=austin   (signed in) -> { places: [{ id, label, city }] }
//
// Searches are limited to ONE service area (worker/service-areas.js): the
// area's metro box is passed to Photon, and every result is re-checked here
// (coordinates inside the box, same state) — so "Austin" only ever offers
// Austin-area places. The browser never talks to Photon directly: this proxy
// keeps visitors' IP addresses away from the provider and lets the server
// decide what a place looks like. A submitted location is then VERIFIED here
// too (verifyPlace): the form sends the chosen place's OpenStreetMap id, the
// server looks it up again within the chosen area, and stores Photon's own
// label — never text the visitor typed. So the Location can only ever be a
// real place inside the chosen City's area. Coordinates are used only for
// that check; they are never stored or returned.
//
// Privacy: the full label (it may include a house number) is kept for
// moderators; the public gallery shows publicLocation() — street/place and
// city only, never the house number.

import { serviceAreaFor, isInServiceArea, bboxParam } from './service-areas.js';

const PHOTON_URL = 'https://photon.komoot.io/api/';
const US_BBOX = '-125.0,24.0,-66.5,49.5';            // contiguous United States
const USER_AGENT = 'CybercabHunter/1.0 (+https://cybercabhunter.com)';
const TIMEOUT_MS = 4000;
const MIN_QUERY = 3;
const MAX_QUERY = 120;
const MAX_RESULTS = 6;
export const PLACE_ID_RE = /^[NWR]:\d{1,15}$/;

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC'
};

// One Photon feature -> { id, label, city, lon, lat, state }, or null if it
// has no usable id. lon/lat/state are for the area check only.
function toPlace(feature) {
  const p = (feature && feature.properties) || {};
  if (!['N', 'W', 'R'].includes(p.osm_type) || !Number.isFinite(Number(p.osm_id))) return null;
  const streetAddress = [p.housenumber, p.street].filter(Boolean).join(' ');
  // Some places carry several names joined by ';' — the first is the main one.
  const name = p.name ? String(p.name).split(';')[0].trim() : '';
  const first = name || streetAddress || p.street || null;
  const city = p.city || p.town || p.village || p.district || p.county || null;
  const state = p.state ? (STATES[String(p.state).toLowerCase()] || p.state) : null;
  const parts = [];
  for (const part of [first, city, state]) {
    const text = part && String(part).trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (!parts.length) return null;
  const coords = feature.geometry && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
  return {
    id: `${p.osm_type}:${p.osm_id}`, label: parts.join(', ').slice(0, 200), city: city || null,
    lon: Number(coords[0]), lat: Number(coords[1]), state
  };
}

// A place belongs to an area when its coordinates are inside the area's box
// and (when the place names one) it is in the area's state.
export function placeInArea(place, area) {
  return !!place && isInServiceArea(area, place.lon, place.lat) && (!place.state || place.state === area.state);
}

async function photonSearch(query, limit, bbox = US_BBOX) {
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'en', bbox });
  const resp = await fetch(`${PHOTON_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error(`photon_${resp.status}`);
  const body = await resp.json();
  const places = [];
  for (const f of (body && body.features) || []) {
    const place = toPlace(f);
    if (place && !places.some(x => x.id === place.id)) places.push(place);
  }
  return places;
}

// GET /api/places?q=&area=  — suggestions for the Location field, only from
// inside the chosen service area (the caller has already checked the visitor
// is signed in). Only { id, label, city } leave the server.
export async function apiSearchPlaces(request, env) {
  const params = new URL(request.url).searchParams;
  const area = serviceAreaFor(params.get('area'));
  if (!area) return Response.json({ success: false, error: 'invalid_service_area' }, { status: 400 });
  const q = (params.get('q') || '').trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY) return Response.json({ places: [] });
  if (q.length > MAX_QUERY) return Response.json({ success: false, error: 'query_too_long' }, { status: 400 });
  try {
    const places = (await photonSearch(q, MAX_RESULTS, bboxParam(area)))
      .filter(p => placeInArea(p, area))
      .map(({ id, label, city }) => ({ id, label, city }));
    return Response.json({ places }, { headers: { 'Cache-Control': 'private, max-age=300' } });
  } catch (e) {
    return Response.json({ success: false, error: 'places_unavailable' }, { status: 502 });
  }
}

// Confirms that `id` is a real place INSIDE `area`: re-runs a Photon search
// within the area and finds that same id, then checks its coordinates/state
// against the area here — never trusting Photon's own box filter alone.
// `queries` are tried in order: first the exact search text the page used to
// offer the place (the same search returns the same places — a street split
// into many same-named segments may not come back for a search by its label),
// then the picked label (older pages send only that). Returns { place } (with
// Photon's own label), or { error: 'invalid_location' } (not a real/known
// place) or { error: 'location_outside_area' } (real, but not in this area).
// Throws if Photon can't be reached.
export async function verifyPlace(id, queries, area) {
  if (!area || !PLACE_ID_RE.test(String(id || ''))) return { error: 'invalid_location' };
  const qs = [...new Set((Array.isArray(queries) ? queries : [queries])
    .map(q => String(q || '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY))
    .filter(q => q.length >= MIN_QUERY))];
  if (!qs.length) return { error: 'invalid_location' };
  for (const q of qs) {
    const inArea = (await photonSearch(q, 10, bboxParam(area))).find(p => p.id === id);
    if (inArea) return placeInArea(inArea, area) ? { place: inArea } : { error: 'location_outside_area' };
  }
  // Not found inside the area: tell "real but elsewhere" from "not a place"
  // (the label, which names the place's city and state, finds it best).
  for (const q of [...qs].reverse()) {
    if ((await photonSearch(q, 10)).some(p => p.id === id)) return { error: 'location_outside_area' };
  }
  return { error: 'invalid_location' };
}

// The public version of a stored location: the street or place and the city,
// without a house number ("4016 Hanover Street, Dallas, TX" ->
// "Hanover Street, Dallas").
export function publicLocation(label) {
  const parts = String(label || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  parts[0] = parts[0].replace(/^\d+[A-Za-z]?(-\d+)?\s+/, '').trim();
  const shown = parts.slice(0, 2).filter(Boolean);
  return shown.length ? shown.join(', ') : null;
}
