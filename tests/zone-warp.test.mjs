// Zone Warp (public/js/zone-warp.js), the Zones page's city-to-city camera move:
//   - trip tiers by distance (local glide / near flight / far flight + trace),
//     shorter on phones
//   - the route trace gradient is valid MapLibre (ascending stops) at every step
//   - lands on exactly the camera cameraForBounds gives (the instant framing)
//   - every effect is off at the end, on a new selection, and on the rider's drag
//   - Reduce Motion: a jump, no effect layers; no ready map: instant fitBounds
//   - wired into infrastructure.html, with no requests or timers of its own
//   - phones: a new city closes the Zone details drawer (js/main.js
//     initMapDrawer) so the move shows; the panel updates at once; the drawer
//     reopens as usual; desktop and a re-tap of the current city are unchanged
// Run: node tests/zone-warp.test.mjs

import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SRC = read('public/js/zone-warp.js');

function load({ reduced = false, compact = false } = {}) {
  let now = 0, frames = [];
  const sandbox = {
    window: {},
    performance: { now: () => now },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    Math, Object, Array, Number, JSON,
  };
  sandbox.window.matchMedia = q => ({ matches: q.includes('reduce') ? reduced : compact });
  vm.runInNewContext(SRC, sandbox);
  const W = sandbox.window.CCCZoneWarp;
  // Advance the clock, running the frames requested so far (one loop at a time).
  const advance = ms => { const end = now + ms; while (now < end) { now = Math.min(end, now + 16); const f = frames; frames = []; f.forEach(fn => fn(now)); } };
  return { W, advance, pending: () => frames.length };
}

const AUSTIN = { lng: -97.74, lat: 30.27 }, DALLAS = { lng: -96.87, lat: 32.81 };
function fakeMap({ style = true, camera = true } = {}) {
  const layers = {}, sources = { 'service-zone': {}, 'service-zone-dallas': {} }, handlers = {}, calls = [];
  let center = AUSTIN;
  const map = {
    calls, layers, sources,
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    fire: (ev, e) => (handlers[ev] || []).forEach(fn => fn(e)),
    isStyleLoaded: () => style,
    getCenter: () => center,
    fitBounds: (b, o) => calls.push(['fitBounds', o]),
    jumpTo: c => { calls.push(['jumpTo', c]); center = c.center; },
    easeTo: o => { calls.push(['easeTo', o]); center = o.center; },
    flyTo: o => { calls.push(['flyTo', o]); center = o.center; },
    getSource: id => sources[id] ? { setData: d => { sources[id].data = d; } } : undefined,
    addSource: (id, s) => { sources[id] = { ...s }; },
    getLayer: id => layers[id],
    addLayer: l => { layers[l.id] = { ...l, paint: { ...l.paint } }; },
    setPaintProperty: (id, p, v) => { layers[id].paint[p] = v; },
  };
  if (camera) map.cameraForBounds = b => ({ center: b.center, zoom: b.zoom, bearing: 0 });
  return map;
}
const OPTS = { sources: { austin: 'service-zone', dallas: 'service-zone-dallas' }, padding: () => 40 };
const dallasBounds = { center: DALLAS, zoom: 11.5 }, austinBounds = { center: AUSTIN, zoom: 10.2 };
const effectsOff = m => ['warp-edge-austin', 'warp-edge-dallas'].every(id => m.layers[id].paint['line-opacity'] === 0)
  && m.layers['warp-ring'].paint['circle-stroke-opacity'] === 0
  && JSON.stringify(m.sources['warp-trace'].data) === JSON.stringify({ type: 'FeatureCollection', features: [] });

console.log('Trip tiers');
{
  const { W } = load();
  check('Austin to Dallas is ~290 km', Math.abs(W.distanceKm(AUSTIN, DALLAS) - 290) < 15);
  const local = W.plan(5, false), near = W.plan(80, false), far = W.plan(290, false);
  check('same city: a short glide, no trace', local.kind === 'local' && local.duration >= 500 && local.duration <= 850 && !local.trace);
  check('nearby: a flight of ~0.85–1.3 s, no trace', near.kind === 'near' && near.duration >= 850 && near.duration <= 1300 && !near.trace);
  check('distant: a flight of ~1.5–2.2 s with the trace', far.kind === 'far' && far.duration >= 1500 && far.duration <= 2200 && far.trace);
  check('phones: shorter at every tier', ['5', '80', '290'].every(k => W.plan(+k, true).duration < W.plan(+k, false).duration));
}

console.log('Route trace gradient');
{
  const { W } = load();
  let ok = true;
  for (let h = 0; h <= 1.0001; h += 0.01) for (const a of [0, 0.4, 1]) {
    const g = W.traceGradient(h, a), stops = g.slice(3).filter((_, i) => i % 2 === 0);
    if (g[0] !== 'interpolate' || stops[0] !== 0 || stops[stops.length - 1] !== 1 || stops.some((s, i) => i && s <= stops[i - 1])) ok = false;
  }
  check('stops strictly ascend from 0 to 1 at every head and opacity', ok);
  check('nothing visible at opacity 0', W.traceGradient(0.5, 0).slice(3).filter((_, i) => i % 2).every(c => c.endsWith(',0.000)')));
}

console.log('A far trip: lands exactly, then every effect is off');
{
  const { W, advance, pending } = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const r = warp.go('dallas', dallasBounds, 'austin');
  const fly = m.calls.find(c => c[0] === 'flyTo')[1];
  check('a flight to exactly the instant framing', r.animated && r.trip.kind === 'far' && fly.center === DALLAS && fly.zoom === 11.5 && fly.pitch === 0);
  check('the effect layers sit on the zones\' own sources', m.layers['warp-edge-dallas'].source === 'service-zone-dallas' && m.layers['warp-edge-austin'].source === 'service-zone');
  check('a trace from Austin to Dallas', JSON.stringify(m.sources['warp-trace'].data.geometry.coordinates) === JSON.stringify([[AUSTIN.lng, AUSTIN.lat], [DALLAS.lng, DALLAS.lat]]));
  advance(150);
  check('disengage: the zone being left glows', m.layers['warp-edge-austin'].paint['line-opacity'] > 0.3);
  advance(1550 - 150);
  check('destination lock: the ring and the destination edge show', m.layers['warp-ring'].paint['circle-stroke-opacity'] > 0 && m.layers['warp-edge-dallas'].paint['line-opacity'] > 0);
  check('the departure glow is gone by then', m.layers['warp-edge-austin'].paint['line-opacity'] === 0);
  advance(1200);
  check('settle: every effect off, the loop stopped', effectsOff(m) && pending() === 0 && !warp.busy());
}

console.log('A same-city move glides without a trace');
{
  const { W } = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const r = warp.go('austin', { center: { lng: -97.70, lat: 30.30 }, zoom: 11 }, 'austin');
  check('easeTo, no trace data', r.trip.kind === 'local' && m.calls.some(c => c[0] === 'easeTo') && !m.sources['warp-trace'].data?.geometry);
}

console.log('A new selection cancels the old; a drag stops the effects');
{
  const { W, advance, pending } = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  warp.go('dallas', dallasBounds, 'austin'); advance(400);
  warp.go('austin', austinBounds, 'dallas');
  check('the last selection wins', m.calls.filter(c => c[0] === 'flyTo').at(-1)[1].center === AUSTIN);
  advance(3000);
  check('one loop, then nothing left on', effectsOff(m) && pending() === 0);

  warp.go('dallas', dallasBounds, 'austin'); advance(300);
  const flights = m.calls.length;
  m.fire('movestart', {});   // the page's own camera move: not the rider
  check('a programmatic move does not cancel', warp.busy());
  m.fire('movestart', { originalEvent: {} });   // the rider's drag
  check('the rider\'s drag: effects off at once, no camera move back', effectsOff(m) && !warp.busy() && m.calls.length === flights);
  advance(3000);
  check('and nothing restarts', effectsOff(m) && pending() === 0);
}

console.log('Reduce Motion and fallbacks');
{
  const { W, pending } = load({ reduced: true });
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const r = warp.go('dallas', dallasBounds, 'austin');
  check('Reduce Motion: one jump to the same framing', r.reducedMotion && m.calls.length === 1 && m.calls[0][0] === 'jumpTo' && m.calls[0][1].center === DALLAS);
  check('no effect layers, no loop', !m.layers['warp-trace'] && pending() === 0);

  const a = load(), m2 = fakeMap({ style: false });
  check('style not loaded: an instant fitBounds', !a.W.attach(m2, OPTS).go('dallas', dallasBounds).animated && m2.calls[0][0] === 'fitBounds' && m2.calls[0][1].animate === false);
  const m3 = fakeMap({ camera: false });
  check('no cameraForBounds: an instant fitBounds', !a.W.attach(m3, OPTS).go('dallas', dallasBounds).animated && m3.calls[0][0] === 'fitBounds');
  const m4 = { on() {}, fitBounds: (b, o) => { m4.o = o; }, resize() {} };
  a.W.attach(m4, OPTS).go('dallas', dallasBounds);
  check('a bare map (the page\'s test fakes) still frames the zone', m4.o && m4.o.animate === false && m4.o.padding === 40);
}

console.log('Wiring');
{
  const html = read('public/infrastructure.html');
  check('loaded on the Zones page', /<script src="js\/zone-warp\.js\?v=\d+"><\/script>/.test(html));
  check('both city switches go through it', (html.match(/frameZone\('(dallas|austin)'/g) || []).length === 2);
  check('no requests, intervals or timeouts of its own', !/fetch\(|XMLHttpRequest|setInterval|setTimeout/.test(SRC));
}

console.log('Phones: a new city closes the Zone details drawer');
async function zonesPage(wide, query = '') {
  const html = read('public/infrastructure.html').replace(/<script src="https?:[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/infrastructure' + query, pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = q => ({ matches: /min-width: 1024px/.test(q) ? wide : /max-width: 1023px/.test(q) ? !wide : false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.ResizeObserver = class { observe() {} };
  const framed = [];
  w.maplibregl = { Map: class { on() {} fitBounds(b) { framed.push(b); } resize() {} }, Marker: class { setLngLat() { return this; } setPopup() { return this; } addTo() { return this; } getPopup() { return { setHTML() {} }; } remove() {} }, Popup: class { setHTML() { return this; } }, LngLatBounds: class { extend() { return this; } } };
  w.fetch = async () => new Response('{}', { status: 404 });
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => !/tailwind\.config|scrollRestoration/.test(s)).join('\n');
  w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\n${read('public/js/austin-map.js')}\n${read('public/js/zone-warp.js')}\n${inline}`);
  await new Promise(r => setTimeout(r, 300));
  const d = w.document, panel = d.getElementById('zonePanel'), toggle = d.querySelector('[data-map-drawer-toggle]');
  const open = () => panel.classList.contains('is-open');
  const city = c => d.querySelector(`.city-btn[data-city="${c}"]`);
  return { w, d, panel, toggle, open, city, framed };
}
{
  const p = await zonesPage(false);
  p.toggle.click();
  check('the drawer opens from its toggle', p.open() && p.toggle.getAttribute('aria-expanded') === 'true');
  const before = p.framed.length;
  p.city('dallas').click();
  check('tapping Dallas closes it at once', !p.open() && p.toggle.getAttribute('aria-expanded') === 'false' && !p.d.querySelector('[data-map-drawer-backdrop]').classList.contains('is-open'));
  check('the city and panel update at once', p.city('dallas').getAttribute('aria-pressed') === 'true' && p.d.getElementById('austinContent').classList.contains('hidden') && !p.d.getElementById('dallasContent').classList.contains('hidden'));
  check('the map still moves to Dallas', p.framed.length === before + 1);
  check('focus returns to the toggle', p.d.activeElement === p.toggle);
  p.toggle.click();
  check('it reopens as usual, Dallas still chosen', p.open() && p.city('dallas').getAttribute('aria-pressed') === 'true');
  p.city('dallas').click();
  check('re-tapping the current city leaves it open', p.open());
  p.city('austin').click();
  check('and back to Austin closes it again', !p.open() && p.city('austin').getAttribute('aria-pressed') === 'true');
  p.d.querySelector('[data-map-drawer-close]').click();
  check('closed stays closed (no toggle from a dismiss)', !p.open());
  p.w.close();
}
{
  const p = await zonesPage(true);
  const focusBefore = p.d.activeElement;
  p.city('dallas').click();
  check('desktop: unchanged, no drawer state, no focus move', !p.open() && p.toggle.getAttribute('aria-expanded') === 'false' && p.d.activeElement !== p.toggle && p.city('dallas').getAttribute('aria-pressed') === 'true');
  p.w.close();
}
{
  const p = await zonesPage(false, '?city=dallas');
  check('opening with ?city=dallas: Dallas shown, drawer untouched, focus not moved', p.city('dallas').getAttribute('aria-pressed') === 'true' && !p.open() && p.d.activeElement !== p.toggle);
  p.w.close();
}

t.finish();
