// A stand-in for the Photon place-search service (worker/places.js), so no
// test ever calls the real one. Installed over the global fetch that the
// Worker code uses; every other URL passes through unchanged.
//
// Like Photon, it honours the `bbox` parameter: only places inside the box
// come back (set photon.ignoreBbox to simulate a provider that returns
// out-of-box results anyway — the server must still reject them).
//
// Any query returns one "echo" place named exactly as the query, with an id
// derived from the text (so placeIdFor(label) is the id a visitor would have
// picked for that label), located at the centre of the searched box. A query
// containing a fixture's keyword also returns that fixed real-looking place.

const realFetch = globalThis.fetch;

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 1000000000;
}

export const placeIdFor = label => `W:${hash(label)}`;

function fixture(id, keyword, props, lon, lat, label, publicLabel) {
  const [osm_type, osm_id] = id.split(':');
  return { id, keyword, label, publicLabel, lon, lat, properties: { osm_type, osm_id: Number(osm_id), countrycode: 'US', ...props } };
}

// University Park (Dallas metro), inside the Dallas box.
export const HANOVER = fixture('N:4016001', 'hanover', { housenumber: '4016', street: 'Hanover Street', city: 'Dallas', state: 'Texas' }, -96.7925, 32.8497,
  '4016 Hanover Street, Dallas, TX', 'Hanover Street, Dallas');
// Levittown, New York — the real mismatch found in production.
export const LEVITTOWN = fixture('W:807791782', 'hahn', { housenumber: '4016', street: 'Hahn Avenue', city: 'Levittown', state: 'New York' }, -73.4919, 40.7289,
  '4016 Hahn Avenue, Levittown, NY');
// Downtown Austin.
export const CONGRESS = fixture('W:15405268', 'congress', { name: 'Congress Avenue', city: 'Austin', state: 'Texas' }, -97.7446, 30.2632,
  'Congress Avenue, Austin, TX', 'Congress Avenue, Austin');
// Another segment of the same Austin street, found only by the words the
// visitor typed ("cong ave") — a search for its label returns CONGRESS instead,
// like real multi-segment streets in OpenStreetMap.
export const SEGMENT = fixture('W:204974733', 'congave', { name: 'Congress Avenue', city: 'Austin', state: 'Texas' }, -97.7412, 30.2725,
  'Congress Avenue, Austin, TX', 'Congress Avenue, Austin');
// Just inside / just outside each metro box's corner or edge (all in Texas).
export const EDGE_IN_AUSTIN = fixture('N:9000001', 'edgeinaustin', { name: 'Edge In Austin', city: 'Austin', state: 'Texas' }, -98.0499, 30.0501, 'Edge In Austin, Austin, TX');
export const EDGE_OUT_AUSTIN = fixture('N:9000002', 'edgeoutaustin', { name: 'Edge Out Austin', city: 'Dripping Springs', state: 'Texas' }, -98.0501, 30.3000, 'Edge Out Austin, Dripping Springs, TX');
export const EDGE_IN_DALLAS = fixture('N:9000003', 'edgeindallas', { name: 'Edge In Dallas', city: 'McKinney', state: 'Texas' }, -96.4501, 33.1499, 'Edge In Dallas, McKinney, TX');
export const EDGE_OUT_DALLAS = fixture('N:9000004', 'edgeoutdallas', { name: 'Edge Out Dallas', city: 'Terrell', state: 'Texas' }, -96.4499, 32.8000, 'Edge Out Dallas, Terrell, TX');
const FIXTURES = [HANOVER, LEVITTOWN, CONGRESS, SEGMENT, EDGE_IN_AUSTIN, EDGE_OUT_AUSTIN, EDGE_IN_DALLAS, EDGE_OUT_DALLAS];

export const photon = { calls: [], failing: false, ignoreBbox: false, noFallback: false };   // noFallback: only the fixtures

const feature = (properties, lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });

export function installPhotonStub() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'photon.komoot.io') return realFetch(input, init);
    photon.calls.push(url);
    if (photon.failing) return new Response('unavailable', { status: 503 });
    const q = url.searchParams.get('q') || '';
    const [minLon, minLat, maxLon, maxLat] = (url.searchParams.get('bbox') || '-180,-90,180,90').split(',').map(Number);
    const inBox = (lon, lat) => photon.ignoreBbox || (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat);
    const features = [];
    for (const f of FIXTURES) {
      if (q.toLowerCase().replace(/\s+/g, '').includes(f.keyword) && inBox(f.lon, f.lat)) features.push(feature(f.properties, f.lon, f.lat));
    }
    if (!photon.noFallback) features.push(feature({ osm_type: 'W', osm_id: hash(q), name: q }, (minLon + maxLon) / 2, (minLat + maxLat) / 2));
    return Response.json({ type: 'FeatureCollection', features });
  };
}
