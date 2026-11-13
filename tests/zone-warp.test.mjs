// Zone Warp (public/js/zone-warp.js), the Zones page's city-to-city camera move:
//   - camera only: one flyTo per switch (pull back, travel, zoom in), no
//     layers, sources or effects
//   - durations by distance, shorter on phones
//   - lands on exactly the camera cameraForBounds gives (the instant framing)
//   - REGRESSION: every switch animates, not only the first. Zone Warp used
//     isStyleLoaded() as "ready"; it is false whenever any source reloads,
//     and the effect layers' own setData made it false on every later switch,
//     so those fell back to the instant jump. Readiness is now the load event.
//   - interruption, the rider's drag, Reduce Motion, fallbacks
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
  const sandbox = { window: {}, Math, Object, Array, Number, JSON };
  sandbox.window.matchMedia = q => ({ matches: q.includes('reduce') ? reduced : compact });
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.CCCZoneWarp;
}

const AUSTIN = { lng: -97.74, lat: 30.27 }, DALLAS = { lng: -96.87, lat: 32.81 };
// A MapLibre stand-in. styleLoaded: what isStyleLoaded() says (false: some
// source is reloading, as after any setData). loaded: whether load has fired.
function fakeMap({ loaded = true, camera = true } = {}) {
  const handlers = {}, calls = [];
  let center = AUSTIN, zoom = 10.2;
  const map = {
    calls, styleLoaded: true,
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    fire: ev => (handlers[ev] || []).forEach(fn => fn({})),
    loaded: () => loaded,
    isStyleLoaded: () => map.styleLoaded,
    getCenter: () => center,
    getZoom: () => zoom,
    fitBounds: (b, o) => { calls.push(['fitBounds', o]); center = b.center; zoom = b.zoom; },
    jumpTo: c => { calls.push(['jumpTo', c]); center = c.center; zoom = c.zoom; },
    flyTo: o => { calls.push(['flyTo', o]); center = o.center; zoom = o.zoom; },
    easeTo: o => { calls.push(['easeTo', o]); },
    addLayer: () => calls.push(['addLayer']), addSource: () => calls.push(['addSource']), setPaintProperty: () => calls.push(['setPaintProperty']),
  };
  if (camera) map.cameraForBounds = b => ({ center: b.center, zoom: b.zoom, bearing: 0 });
  return map;
}
const OPTS = { padding: () => 40 };
const dallasBounds = { center: DALLAS, zoom: 11.5 }, austinBounds = { center: AUSTIN, zoom: 10.2 };
const flights = m => m.calls.filter(c => c[0] === 'flyTo');
const instants = m => m.calls.filter(c => c[0] === 'fitBounds' || c[0] === 'jumpTo');

console.log('Trip tiers');
{
  const W = load();
  check('Austin to Dallas is ~290 km', Math.abs(W.distanceKm(AUSTIN, DALLAS) - 290) < 15);
  const local = W.plan(5, false), near = W.plan(80, false), far = W.plan(290, false);
  check('same city: ~600–850 ms', local.kind === 'local' && local.duration >= 600 && local.duration <= 850);
  check('nearby: ~900–1300 ms', near.kind === 'near' && near.duration >= 900 && near.duration <= 1300);
  check('distant: ~1500–2000 ms', far.kind === 'far' && far.duration >= 1500 && far.duration <= 2000);
  check('phones: shorter at every tier', [5, 80, 290].every(k => W.plan(k, true).duration < W.plan(k, false).duration));
  check('the pull-back grows with the distance', local.curve < near.curve && near.curve < far.curve);
}

console.log('Camera only');
{
  const W = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const r = warp.go('dallas', dallasBounds);
  const fly = flights(m)[0][1];
  check('one flyTo to exactly the instant framing', r.animated && flights(m).length === 1 && fly.center === DALLAS && fly.zoom === 11.5 && fly.bearing === 0 && fly.pitch === 0);
  check('eased in and out, Austin to Dallas ~1.8 s', typeof fly.easing === 'function' && fly.easing(0) === 0 && fly.easing(1) === 1 && fly.easing(0.25) < 0.25 && fly.easing(0.75) > 0.75 && fly.duration === 1800);
  check('no layers, sources or paint changes', !m.calls.some(c => /addLayer|addSource|setPaintProperty/.test(c[0])));
  check('no effect code or route/ring layers left in the module', !/addLayer|addSource|setPaintProperty|requestAnimationFrame|warp-trace|warp-ring|line-gradient/.test(SRC));
}

console.log('REGRESSION: Austin -> Dallas -> Austin -> Dallas -> Austin, every switch animates');
{
  const W = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const seq = [['dallas', dallasBounds], ['austin', austinBounds], ['dallas', dallasBounds], ['austin', austinBounds]];
  let ok = true, landed = true;
  seq.forEach(([city, b], i) => {
    m.styleLoaded = i % 2 === 1;   // between switches some source reloads: isStyleLoaded() false, as in the browser
    const before = flights(m).length, r = warp.go(city, b);
    if (!r.animated || flights(m).length !== before + 1) ok = false;
    if (m.getCenter() !== b.center || m.getZoom() !== b.zoom) landed = false;
  });
  check('four switches, four flights', ok && flights(m).length === 4);
  check('never an instant jump instead', instants(m).length === 0);
  check('each lands on its destination', landed);
  m.styleLoaded = false;
  check('a switch while a source reloads still animates (the bug)', warp.go('dallas', dallasBounds).animated && flights(m).length === 5);
}

console.log('Interruption and the rider');
{
  const W = load();
  const m = fakeMap(), warp = W.attach(m, OPTS);
  warp.go('dallas', dallasBounds);
  warp.go('austin', austinBounds);   // mid-flight: flyTo stops the old one and starts from where the camera is
  check('the new selection is a new flight to Austin, nothing queued', flights(m).length === 2 && flights(m)[1][1].center === AUSTIN);
  m.fire('movestart'); m.fire('dragstart');
  check('a drag/zoom by the rider: no camera call from Zone Warp', m.calls.length === 2);
  check('and the next switch animates as usual', warp.go('dallas', dallasBounds).animated && flights(m).length === 3);
}

console.log('Reduce Motion and fallbacks');
{
  const W = load({ reduced: true });
  const m = fakeMap(), warp = W.attach(m, OPTS);
  const r = warp.go('dallas', dallasBounds);
  check('Reduce Motion: one immediate jump to the same framing', r.reducedMotion && m.calls.length === 1 && m.calls[0][0] === 'jumpTo' && m.calls[0][1].center === DALLAS && m.calls[0][1].zoom === 11.5);
  check('every time', warp.go('austin', austinBounds).reducedMotion && flights(m).length === 0);

  const A = load();
  const early = fakeMap({ loaded: false }), w2 = A.attach(early, OPTS);
  check('before the map has loaded (?city=dallas on open): the instant fitBounds', !w2.go('dallas', dallasBounds).animated && early.calls[0][0] === 'fitBounds' && early.calls[0][1].animate === false && early.calls[0][1].padding === 40);
  early.fire('load');
  check('after load: it animates', w2.go('austin', austinBounds).animated);
  const m3 = fakeMap({ camera: false });
  check('no cameraForBounds: the instant fitBounds', !A.attach(m3, OPTS).go('dallas', dallasBounds).animated && m3.calls[0][0] === 'fitBounds');
  const m4 = { on() {}, fitBounds: (b, o) => { m4.o = o; }, resize() {} };
  A.attach(m4, OPTS).go('dallas', dallasBounds);
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
async function zonesPage(wide, query = '', { camera = false } = {}) {
  const html = read('public/infrastructure.html').replace(/<script src="https?:[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/infrastructure' + query, pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = q => ({ matches: /min-width: 1024px/.test(q) ? wide : /max-width: 1023px/.test(q) ? !wide : false, addEventListener() {}, addListener() {}, removeEventListener() {} });
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.ResizeObserver = class { observe() {} };
  const framed = [];
  const flights = [];
  // camera: a map that has loaded and has the camera API; isStyleLoaded() is
  // false (a source reloading), as it was on every switch after the first.
  const Map = camera ? class { on() {} loaded() { return true; } isStyleLoaded() { return false; } resize() {}
      fitBounds(b) { framed.push(b); } getCenter() { return this.c || { lng: -97.74, lat: 30.27 }; }
      cameraForBounds(b) { return { center: b.center(), zoom: 10, bearing: 0 }; } flyTo(o) { flights.push(o); this.c = o.center; } jumpTo(o) { framed.push(o); this.c = o.center; } }
    : class { on() {} fitBounds(b) { framed.push(b); } resize() {} };
  class LngLatBounds { constructor(a, b) { this.pts = [a, b].filter(Boolean); } extend(p) { this.pts.push(p); return this; }
    center() { const n = this.pts.length; return { lng: this.pts.reduce((s, p) => s + p[0], 0) / n, lat: this.pts.reduce((s, p) => s + p[1], 0) / n }; } }
  w.maplibregl = { Map, LngLatBounds, Marker: class { setLngLat() { return this; } setPopup() { return this; } addTo() { return this; } getPopup() { return { setHTML() {} }; } remove() {} }, Popup: class { setHTML() { return this; } } };
  w.fetch = async () => new Response('{}', { status: 404 });
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => !/tailwind\.config|scrollRestoration/.test(s)).join('\n');
  w.eval(`${read('public/js/calc.js')}\n${read('public/js/main.js')}\n${read('public/js/austin-map.js')}\n${read('public/js/zone-warp.js')}\n${inline}`);
  await new Promise(r => setTimeout(r, 300));
  const d = w.document, panel = d.getElementById('zonePanel'), toggle = d.querySelector('[data-map-drawer-toggle]');
  const open = () => panel.classList.contains('is-open');
  const city = c => d.querySelector(`.city-btn[data-city="${c}"]`);
  return { w, d, panel, toggle, open, city, framed, flights };
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

console.log('The Zones page: Austin -> Dallas -> Austin -> Dallas -> Austin, desktop and phone');
for (const wide of [true, false]) {
  const p = await zonesPage(wide, '', { camera: true });
  const label = wide ? 'desktop' : 'phone';
  const seq = ['dallas', 'austin', 'dallas', 'austin'];
  const framedAtStart = p.framed.length;   // the page's own framing on open
  let ok = true;
  for (const c of seq) {
    if (!wide) p.toggle.click();   // the switch is in the drawer
    const before = p.flights.length;
    p.city(c).click();
    const f = p.flights[p.flights.length - 1];
    if (p.flights.length !== before + 1 || !f || (c === 'dallas') !== (f.center.lat > 31.5)) ok = false;
    if (!wide && p.open()) ok = false;
  }
  check(`${label}: every switch starts a flight to the chosen city`, ok && p.flights.length === 4);
  check(`${label}: never an instant jump instead`, p.framed.length === framedAtStart);
  if (!wide) p.toggle.click();
  const before = p.flights.length;
  p.city('austin').click();
  check(`${label}: re-selecting the current city: no flight`, p.flights.length === before);
  if (!wide) check('phone: and the drawer stays open', p.open());
  p.w.close();
}

t.finish();
