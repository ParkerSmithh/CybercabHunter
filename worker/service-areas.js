// The service areas Cybercab Hunter supports — the ONE definition behind:
//   - the Submit form's City dropdown and the Sightings page's city filter
//     buttons (both built from GET /api/service-areas),
//   - the Location search (worker/places.js searches only inside the
//     chosen area's box),
//   - server-side validation of a submitted Location (it must fall inside the
//     chosen area) and of the City itself (worker/sightings.js),
//   - the public Sightings city filters (worker/sightings-public.js).
//
// Each area is a practical METRO bounding box — where Cybercabs may be seen,
// deliberately a little wider than Tesla's service-zone polygon.
// To add a city (e.g. Miami, Orlando), add one entry here.

export const SERVICE_AREAS = [
  {
    key: 'austin', name: 'Austin', state: 'TX', timeZone: 'America/Chicago',
    bbox: { minLon: -98.05, minLat: 30.05, maxLon: -97.45, maxLat: 30.60 }
  },
  {
    key: 'dallas', name: 'Dallas', state: 'TX', timeZone: 'America/Chicago',
    bbox: { minLon: -97.20, minLat: 32.55, maxLon: -96.45, maxLat: 33.15 }
  }
];

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
