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
import { sha256Hex } from './account.js';

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

// bias: optional { lat, lon } — Photon ranks places near it higher (the map
// search biases to the city center, so a half-typed word finds the city's
// places before the suburbs').
async function photonSearch(query, limit, bbox = US_BBOX, bias = null) {
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'en', bbox });
  if (bias) {
    params.set('lat', String(bias.lat));
    params.set('lon', String(bias.lon));
    params.set('zoom', '12');
    params.set('location_bias_scale', '0.5');
  }
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

// GET /api/places/map?q=  — the Zones map's search box (public/js/map-search.js).
// Public (the Zones map is), for a city with a Zones map (Austin, Dallas;
// ?area=, default austin), and the
// one place search that returns coordinates: the map needs them to fly to a
// place. That is safe here because these are searched public places, never a
// sighting's location (/api/places above still never returns coordinates).
// Same Photon search and the same in-area re-check as /api/places. Rate
// limited per visitor (SEARCH_LIMITER, keyed by a hash of the IP; fails open)
// and cached publicly, since the answer is the same for everyone.
//   -> { places: [{ id, label, lat, lng }] }
const MAP_SEARCH_CACHE_SECONDS = 86400;
const MAP_SEARCH_AREAS = ['austin', 'dallas'];   // the cities with a Zones map
const MAP_SEARCH_CANDIDATES = 20;                 // fetched, then narrowed to the city
// The city the map shows: Photon is biased to its center, and a suggestion
// must be in the city itself (Photon's city) or inside the service zone's box
// (the enclaves in it, e.g. Highland Park, West Lake Hills). The metro box
// alone let half-typed words fill the list with suburbs (Allen, Rockwall).
const MAP_SEARCH_CITY = {
  austin: { name: 'Austin', center: { lat: 30.27, lon: -97.74 }, zone: { minLon: -97.87, minLat: 30.14, maxLon: -97.55, maxLat: 30.46 } },
  dallas: { name: 'Dallas', center: { lat: 32.80, lon: -96.80 }, zone: { minLon: -96.93, minLat: 32.73, maxLon: -96.72, maxLat: 32.88 } }
};
export function placeInMapCity(place, cityKey) {
  const c = MAP_SEARCH_CITY[cityKey];
  if (!c || !place) return false;
  const z = c.zone;
  return place.city === c.name || (place.lon >= z.minLon && place.lon <= z.maxLon && place.lat >= z.minLat && place.lat <= z.maxLat);
}
export async function apiSearchMapPlaces(request, env, ctx) {
  const params = new URL(request.url).searchParams;
  const area = serviceAreaFor(params.get('area') || 'austin');
  if (!area || !MAP_SEARCH_AREAS.includes(area.key)) return Response.json({ success: false, error: 'invalid_service_area' }, { status: 400 });
  const q = (params.get('q') || '').trim().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY) return Response.json({ places: [] });
  if (q.length > MAX_QUERY) return Response.json({ success: false, error: 'query_too_long' }, { status: 400 });

  // One cache entry per normalized query, shared by every visitor.
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  // v2: city-biased results (older entries, some empty from a Photon outage, are skipped).
  const cacheKey = new Request(`https://cybercabhunter.com/api/places/map?v=2&area=${area.key}&q=${encodeURIComponent(q.toLowerCase())}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  if (env.SEARCH_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';   // one limit across both cities
    let allowed = true;
    try { allowed = (await env.SEARCH_LIMITER.limit({ key: `map-search:${await sha256Hex(ip)}` })).success !== false; } catch (e) { /* fail open */ }
    if (!allowed) return Response.json({ success: false, error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  }
  let places;
  try {
    places = (await photonSearch(q, MAP_SEARCH_CANDIDATES, bboxParam(area), MAP_SEARCH_CITY[area.key].center))
      .filter(p => placeInArea(p, area) && placeInMapCity(p, area.key))
      // One suggestion per label: OpenStreetMap splits long streets into
      // same-named segments ("East 6th Street, Austin, TX" twice); the first
      // (Photon's best match) stands for the street.
      .filter((p, i, all) => all.findIndex(x => x.label === p.label) === i)
      .slice(0, MAX_RESULTS)
      .map(({ id, label, lon, lat }) => ({ id, label, lat, lng: lon }));
  } catch (e) {
    return Response.json({ success: false, error: 'places_unavailable' }, { status: 502 });
  }
  // An empty answer is never cached: it may be a passing Photon hiccup.
  if (!places.length) return Response.json({ places }, { headers: { 'Cache-Control': 'no-store' } });
  const response = Response.json({ places }, { headers: { 'Cache-Control': `public, max-age=${MAP_SEARCH_CACHE_SECONDS}` } });
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(stored);
  }
  return response;
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
