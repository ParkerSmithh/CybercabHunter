// A stand-in for the Photon place-search service (worker/places.js), so no
// test ever calls the real one. Installed over the global fetch that the
// Worker code uses; every other URL passes through unchanged.
//
// Any query returns one place named exactly as the query, whose id is
// derived from the text — so placeIdFor(label) is the id a visitor would
// have picked for that label. A query mentioning "hanover" also returns a
// real-looking street address (house number, street, city, state).

const realFetch = globalThis.fetch;

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 1000000000;
}

export const placeIdFor = label => `W:${hash(label)}`;

export const HANOVER = {
  id: 'N:4016001',
  label: '4016 Hanover Street, Dallas, TX',
  publicLabel: 'Hanover Street, Dallas',
  properties: { osm_type: 'N', osm_id: 4016001, housenumber: '4016', street: 'Hanover Street', city: 'Dallas', state: 'Texas', countrycode: 'US' }
};

export const photon = { calls: [], failing: false };

export function installPhotonStub() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'photon.komoot.io') return realFetch(input, init);
    photon.calls.push(url);
    if (photon.failing) return new Response('unavailable', { status: 503 });
    const q = url.searchParams.get('q') || '';
    const features = [];
    if (/hanover/i.test(q)) features.push({ type: 'Feature', properties: HANOVER.properties });
    features.push({ type: 'Feature', properties: { osm_type: 'W', osm_id: hash(q), name: q } });
    return Response.json({ type: 'FeatureCollection', features });
  };
}
