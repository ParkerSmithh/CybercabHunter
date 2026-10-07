// Zones map place search: GET /api/places/map (public, Austin only, with
// coordinates) and the search box on the Zones map (public/js/map-search.js),
// which suggests Austin places as you type and flies the map to the one you
// pick. Photon is stubbed (tests/helpers/places.mjs); the map is a fake that
// records what the search asks of it.
// Run: node tests/map-search.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeEnv, makeCheck } from './helpers/env.mjs';
import { installPhotonStub, photon, CONGRESS, LEVITTOWN, HANOVER, EDGE_OUT_AUSTIN } from './helpers/places.mjs';
import worker from '../worker/index.js';

installPhotonStub();

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');

const get = async (ctx, path, headers = {}) => {
  const res = await worker.fetch(new Request(`https://x${path}`, { headers }), ctx.env, {});
  return { status: res.status, headers: res.headers, json: await res.json() };
};
const search = (ctx, q, extra = '') => get(ctx, `/api/places/map?q=${encodeURIComponent(q)}${extra}`);

// The search box in a page shaped like the Zones map, against the real Worker.
function openSearch(ctx) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="mapSearch"><input id="mapSearchInput"><button id="mapSearchClear" class="hidden"></button><ul id="mapSearchList" class="hidden"></ul><p id="mapSearchStatus"></p></div>
  </body>`, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/infrastructure', pretendToBeVisual: true });
  const w = dom.window;
  const requests = [];
  w.fetch = async (url, init = {}) => {
    requests.push(String(url));
    return worker.fetch(new Request(`https://x${url}`, init), ctx.env, {});
  };
  const map = { flights: [], flyTo(o) { this.flights.push(o); } };
  const markers = [];
  w.maplibregl = { Marker: class { constructor(o) { this.o = o; this.removed = false; markers.push(this); } setLngLat(ll) { this.ll = ll; return this; } addTo() { return this; } remove() { this.removed = true; } } };
  w.eval(read('public/js/map-search.js'));
  w.CCCMapSearch.attach(map);
  const $ = id => w.document.getElementById(id);
  const type = async text => {
    $('mapSearchInput').value = text;
    $('mapSearchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 450));    // past the debounce and the response
  };
  const key = k => $('mapSearchInput').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const options = () => [...w.document.querySelectorAll('#mapSearchList [role="option"]')];
  return { w, $, map, markers, requests, type, key, options };
}

async function run() {
  console.log('1. GET /api/places/map — public, Austin only, with coordinates');
  {
    const ctx = await makeEnv();
    const r = await search(ctx, 'congress');
    const hit = r.json.places && r.json.places.find(p => p.label === CONGRESS.label);
    check('no sign-in needed: 200 with places', r.status === 200 && Array.isArray(r.json.places));
    check('Congress Avenue is offered with its coordinates', !!hit && hit.lat === CONGRESS.lat && hit.lng === CONGRESS.lon);
    check('each place carries only id, label, lat and lng', r.json.places.every(p => Object.keys(p).sort().join() === 'id,label,lat,lng'));
    check('the search sent Photon the Austin metro box', photon.calls.at(-1).searchParams.get('bbox') === '-98.05,30.05,-97.45,30.6');
    check('a New York or Dallas address is not offered', !(await search(ctx, '4016 hahn')).json.places.some(p => p.id === LEVITTOWN.id) && !(await search(ctx, '4016 hanover')).json.places.some(p => p.id === HANOVER.id));
    photon.ignoreBbox = true;
    const leaky = await search(ctx, 'hahn edgeoutaustin congress');
    photon.ignoreBbox = false;
    check('even if the provider ignores the box, out-of-Austin results are dropped', !leaky.json.places.some(p => [LEVITTOWN.id, EDGE_OUT_AUSTIN.id].includes(p.id)) && leaky.json.places.some(p => p.id === CONGRESS.id));
    const segs = await search(ctx, 'congress congave');
    check('a street split into same-named segments is offered once (one "Congress Avenue, Austin, TX")', segs.json.places.filter(p => p.label === CONGRESS.label).length === 1);
    photon.calls.length = 0;
    check('under 3 characters: empty, and Photon is not called', (await search(ctx, 'ab')).json.places.length === 0 && photon.calls.length === 0);
    check('over 120 characters: 400', (await search(ctx, 'x'.repeat(121))).status === 400);
    const dal = await search(ctx, 'hanover', '&area=dallas');
    check('Dallas (Dallas launch): searches inside the Dallas box', dal.status === 200 && dal.json.places.some(p => p.id === HANOVER.id) && photon.calls.at(-1).searchParams.get('bbox') === '-97.2,32.55,-96.45,33.15');
    check('an Austin place is not offered for Dallas', !(await search(ctx, 'congress', '&area=dallas')).json.places.some(p => p.id === CONGRESS.id));
    check('a city without a Zones map is refused (400)', (await search(ctx, 'congress', '&area=houston')).status === 400);
    check('cacheable publicly (it is public map data)', /public/.test(r.headers.get('Cache-Control')));
    photon.failing = true;
    const down = await search(ctx, 'congress');
    photon.failing = false;
    check('the place search being down: 502 places_unavailable', down.status === 502 && down.json.error === 'places_unavailable');
  }

  console.log('2. Rate limited per visitor (SEARCH_LIMITER)');
  {
    const ctx = await makeEnv();
    const keys = [];
    ctx.env.SEARCH_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: keys.length <= 2 }; } };
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    const a = await get(ctx, '/api/places/map?q=congress', ip), b = await get(ctx, '/api/places/map?q=congress%20ave', ip), c = await get(ctx, '/api/places/map?q=congress%20avenue', ip);
    check('under the limit: 200; over it: 429 rate_limited', a.status === 200 && b.status === 200 && c.status === 429 && c.json.error === 'rate_limited');
    check('the limiter key is per visitor and never the raw IP', keys.every(k => k.startsWith('map-search:') && !k.includes('203.0.113.9')));
    ctx.env.SEARCH_LIMITER = { limit: async () => { throw new Error('down'); } };
    check('a limiter failure does not break search (fails open)', (await get(ctx, '/api/places/map?q=congress', ip)).status === 200);
  }

  console.log('3. The search box on the Zones map');
  {
    const ctx = await makeEnv();
    const s = openSearch(ctx);
    await s.type('ab');
    check('fewer than 3 letters: no request, no list', s.requests.length === 0 && s.$('mapSearchList').classList.contains('hidden'));
    await s.type('congress');
    check('typing suggests Austin places', s.options().some(o => o.textContent.includes('Congress Avenue')) && !s.$('mapSearchList').classList.contains('hidden'));
    check('it is an accessible combobox', s.$('mapSearchInput').getAttribute('role') === 'combobox' && s.$('mapSearchInput').getAttribute('aria-expanded') === 'true' && s.$('mapSearchList').getAttribute('role') === 'listbox');
    s.key('ArrowDown');
    check('arrow keys highlight a suggestion', s.options()[0].getAttribute('aria-selected') === 'true' && s.$('mapSearchInput').getAttribute('aria-activedescendant') === s.options()[0].id);
    const idx = s.options().findIndex(o => o.textContent.includes('Congress Avenue'));
    s.options()[idx].dispatchEvent(new s.w.MouseEvent('mousedown', { bubbles: true }));
    s.options()[idx] && s.options()[idx].dispatchEvent(new s.w.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
    const f = s.map.flights.at(-1);
    check('picking a place flies the map to it, zoomed in', f && f.center[0] === CONGRESS.lon && f.center[1] === CONGRESS.lat && f.zoom >= 15);
    check('...drops one pin there', s.markers.length === 1 && s.markers[0].ll[0] === CONGRESS.lon && s.markers[0].ll[1] === CONGRESS.lat && !s.markers[0].removed);
    check('...fills the box with the place and closes the list', s.$('mapSearchInput').value === CONGRESS.label && s.$('mapSearchList').classList.contains('hidden') && s.$('mapSearchInput').getAttribute('aria-expanded') === 'false');

    await s.type('congress ave');
    s.key('Enter');
    await new Promise(r => setTimeout(r, 20));
    check('Enter picks the first suggestion; the old pin is replaced, never stacked', s.map.flights.length === 2 && s.markers.length === 2 && s.markers[0].removed && !s.markers[1].removed);

    await s.type('congress');
    s.key('Escape');
    check('Escape closes the list', s.$('mapSearchList').classList.contains('hidden'));
    s.$('mapSearchClear').dispatchEvent(new s.w.MouseEvent('click', { bubbles: true }));
    check('the clear button empties the box and removes the pin', s.$('mapSearchInput').value === '' && s.markers.every(m => m.removed));

    photon.failing = true;
    await s.type('congress');
    photon.failing = false;
    check('search unavailable: says so, no list', /couldn't search/i.test(s.$('mapSearchStatus').textContent) && s.$('mapSearchList').classList.contains('hidden'));
    s.w.close();
  }

  console.log('4. The Zones page wires it up');
  {
    const html = read('public/infrastructure.html');
    check('the page has the search box inside the map card', /<div id="austinMapWrap"[\s\S]*id="mapSearchInput"[\s\S]*id="infraMap"/.test(html));
    check('the page loads js/map-search.js and attaches it to the Zones map', /<script src="js\/map-search\.js[^"]*"><\/script>/.test(html) && /CCCMapSearch\.attach\(map[,)]/.test(html));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
