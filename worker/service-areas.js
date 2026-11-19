import cities from '../public/js/cities.js';
export const { DEFAULT_CITY, SERVICE_AREAS } = cities;

// An area by its key or name, case- and whitespace-insensitive
// ("austin", " Austin ", "AUSTIN" -> Austin); null if unsupported.
export function serviceAreaFor(value) {
  const v = String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  if (!v) return null;
  return SERVICE_AREAS.find(a => a.key === v || a.name.toLowerCase() === v) || null;
}

// Whether a point (longitude, latitude) is inside the area's box (edges included).
export function isInServiceArea(area, lon, lat) {
  if (!area || !Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  const b = area.bbox;
  return lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;
}

// Photon's bbox parameter: "minLon,minLat,maxLon,maxLat".
export function bboxParam(area) {
  const b = area.bbox;
  return `${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}`;
}

// GET /api/service-areas — the public list the pages build their City
// dropdown and filter buttons from (names only; no geometry needed there).
export function apiListServiceAreas() {
  return Response.json({
    areas: SERVICE_AREAS.map(a => ({ key: a.key, name: a.name }))
  }, { headers: { 'Cache-Control': 'public, max-age=3600' } });
}
