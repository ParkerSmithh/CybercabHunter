// The phone layout mirrors desktop, scaled down (Oct 2026 mobile density pass).
// Every phone change is a max-sm: class (below 640px only), so sm/lg layouts —
// and desktop — keep their original classes. This pins the phone arrangement
// and checks that the original classes are still there alongside it.
// Run: node tests/mobile-density.test.mjs

import fs from 'node:fs';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}public/${f}`, 'utf8');
const classOf = (html, re) => { const m = re.exec(html); return m ? m[1].split(/\s+/) : []; };
const has = (cls, ...want) => want.every(w => cls.includes(w));

const sightings = read('sightings.html');
const stats = classOf(sightings, /<div id="sightingStats" class="([^"]*)"/);
check('Sightings stats: 3 x 2 on phones; 2 / 3 / 6 columns from sm up as before', has(stats, 'max-sm:grid-cols-3', 'grid-cols-2', 'sm:grid-cols-3', 'lg:grid-cols-6', 'gap-3'));
const header = classOf(sightings, /<div class="(mb-8 flex flex-col sm:flex-row[^"]*)"/);
check('Sightings header: description and Replay Map stay on one row on phones', has(header, 'max-sm:flex-row', 'flex-col', 'sm:flex-row'));
const replay = classOf(sightings, /<a id="sightingsReplay" href="[^"]*" class="([^"]*)"/);
check('the phone Replay Map button keeps a 40px tap height', has(replay, 'max-sm:min-h-[40px]', 'max-sm:whitespace-nowrap'));
const peak = classOf(sightings, /<div id="statPeakHour" class="([^"]*)"/);
check('Peak hour keeps its sm+ one-line sizing (fit fix 3)', has(peak, 'whitespace-nowrap', 'sm:text-base', 'text-[clamp(11px,3.1vw,1rem)]'));
const sjs = fs.readFileSync(`${ROOT}public/js/sightings.js`, 'utf8');
check('phones hide only the ":00" of each peak hour, so the text itself is unchanged', /el\('span', 'max-sm:hidden', ':00'\)/.test(sjs));

const vehicles = read('vehicles.html');
const list = classOf(vehicles, /<ul id="regList" class="([^"]*)"/);
check('Vehicles: two cards per row on phones; 1 / 2 / 3 from sm up as before', has(list, 'max-sm:grid-cols-2', 'grid-cols-1', 'sm:grid-cols-2', 'xl:grid-cols-3', 'gap-6'));
const vjs = fs.readFileSync(`${ROOT}public/js/vehicles.js`, 'utf8');
check('the phone card is compact (smaller padding and image), the sm+ card unchanged', /'group block glass rounded-2xl p-6 max-sm:p-3 h-full/.test(vjs) && /'w-full h-32 object-contain mb-4 max-sm:h-16 max-sm:mb-2'/.test(vjs));
check('the long "Recorded distance" label has a phone-only short form', /stat\('Recorded distance', fmtMiles\(v\.total_distance\), 'Distance'\)/.test(vjs));

const index = read('index.html');
check('Homepage hero headline is smaller on phones only', /text-5xl lg:text-6xl leading-\[1\.05\][^"]*max-sm:text-\[2\.375rem\]/.test(index));
check('Service Zones heading and city toggle share one row on phones', /max-sm:flex-nowrap max-sm:items-center max-sm:gap-2">\s*<h2 class="[^"]*max-sm:text-xl max-sm:whitespace-nowrap">SERVICE ZONES/.test(index));
check('the fleet chart range buttons get a 40px tap height on phones, in the markup and in the JS that restyles them',
  (index.match(/range-btn [^"']*max-sm:min-h-\[40px\]/g) || []).length === 6);

const zones = read('infrastructure.html');
check('Zones keeps its 2-column fare pairs, tightened on phones', /<dl class="grid grid-cols-2 gap-x-4 gap-y-4 max-sm:gap-y-2\.5">/.test(zones));
check('the Zones Replay button still sits below the map below lg (fit fix 4)', /id="zonesReplay"[^>]*class="shine mt-3 self-end lg:!absolute/.test(zones));

// Every other page (Oct 2026, second pass).
const pages = ['index', 'sightings', 'vehicles', 'community', 'simulation', 'vehicle', 'rider', 'rider-data', 'profile', 'link-gmail'];
check('the shared footer is compact on phones (brand + Appearance on one row, links in 3 columns) on every page that has it',
  pages.every(f => /<nav aria-label="Footer" class="grid grid-cols-2 sm:grid-cols-3 [^"]*max-sm:grid-cols-3/.test(read(`${f}.html`)) && /<div class="max-sm:row-start-1 max-sm:col-start-2 max-sm:justify-self-end">/.test(read(`${f}.html`))));
check('every footer link is a 40px tap row on phones', pages.every(f => (read(`${f}.html`).match(/class="hover:text-white transition-colors max-sm:min-h-\[40px\] max-sm:flex max-sm:items-center">/g) || []).length === 7));
const css = fs.readFileSync(`${ROOT}public/css/style.css`, 'utf8');
check('the Appearance switch buttons are 40px tall on phones', /@media \(max-width:639px\)\{ \.theme-switch button\{min-height:40px;/.test(css));
check('every page loads the same stylesheet version', new Set([...pages, 'infrastructure', 'moderation', 'replay', 'privacy', 'signin', 'moderation/import-receipt'].map(f => (/css\/style\.css\?v=(\d+)/.exec(read(`${f}.html`)) || [])[1])).size === 1);

const community = read('community.html');
check('Community: the four stats in one row on phones (2 / 4 from sm up as before)', /<div id="communityStats" class="mt-8 grid grid-cols-2 lg:grid-cols-4 gap-3 [^"]*max-sm:grid-cols-4/.test(community));
const sim = read('simulation.html');
check('Fleet ROI: the three results in one row on phones', /<div class="grid grid-cols-1 sm:grid-cols-3 gap-6 max-sm:grid-cols-3 max-sm:gap-2">/.test(sim));
check('Fleet ETA: one "Ride, hours & wait" section per city, a card per model (fare, hours and wait together), side by side from lg, stacked on phones', (sim.match(/>Ride, hours &amp; wait<\/h2>/g) || []).length === 2 && (sim.match(/<article data-glow(="red")? class="dmv-card rhw-card /g) || []).length === 4 && !/>(Fares|Operating hours|Pickup wait estimate)<\/h2>/.test(sim));
check('Fleet ROI / ETA headers: the Cybercab sits beside the text on phones too (owner request 2026-10-07; replaces fit fix 2\'s stacking)', (sim.match(/grid grid-cols-\[minmax\(0,1fr\)_auto\] md:grid-cols-\[minmax\(0,32rem\)_auto\][^"]*max-sm:py-6/g) || []).length === 2 && /@media \(max-width:639px\)\{ \.sim-hero-car\{[^}]*width:clamp\(120px, 40vw, 170px\)/.test(sim) && !/@media \(max-width:639px\)\{ \.sim-hero-car\{[^}]*order:-1/.test(sim));
check('the ROI sliders get a 40px touch strip on phones, the 4px track unchanged', /@media \(max-width:639px\)\{\s*input\[type=range\]\{height:40px; background:transparent;\}/.test(sim));
check('Vehicle page: the four ride stats in one row on phones', /<div class="grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm max-sm:grid-cols-4 max-sm:gap-2">/.test(read('vehicle.html')));
const rider = read('rider.html');
check('Rider profile: stats 3 across and discovered vehicles 2 across on phones', /<div id="riderStats" class="grid grid-cols-2 sm:grid-cols-3 gap-3 max-sm:grid-cols-3/.test(rider) && /<ul id="riderVehicles" class="[^"]*max-sm:grid-cols-2/.test(rider));
const rd = read('rider-data.html');
check('Rider Data: the rides table scroll box contains its sr-only label (it used to widen the page to 546px on phones)', /<div id="ridesTableWrap" class="hidden overflow-x-auto relative">/.test(rd));
check('Rider Data: overview 3 across and ride history 4 across on phones', /grid grid-cols-2 sm:grid-cols-3 gap-3 max-sm:grid-cols-3/.test(rd) && /grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm max-sm:grid-cols-4/.test(rd));

check('Sightings: two photo cards per row on phones (1 / 2 / 3 / 4 from 480px up as before)', /<div id="sightingsGrid" class="grid grid-cols-1 min-\[480px\]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5 max-sm:grid-cols-2/.test(sightings));

// Zones and Replay (Oct 2026): below lg the map fills the screen and the
// details panel becomes a side drawer over a blurred, darkened map.
const replayPage = read('replay.html');
const mainJs = fs.readFileSync(`${ROOT}public/js/main.js`, 'utf8');
for (const [name, html, id] of [['Zones', zones, 'zonePanel'], ['Replay', replayPage, 'replayPanel']]) {
  check(`${name}: the details panel is a side drawer below lg, with a close button`, new RegExp(`<(div|aside) (id="${id}" class="[^"]*map-drawer"|class="[^"]*map-drawer" id="${id}")`).test(html) && /data-map-drawer-close aria-label="Close /.test(html));
  check(`${name}: a toggle on the map opens the drawer`, new RegExp(`data-map-drawer-toggle aria-controls="${id}" aria-expanded="false" class="map-drawer-toggle [^"]*min-h-\\[40px\\]`).test(html));
  check(`${name}: a backdrop blurs and darkens the map behind the drawer`, /class="drawer-backdrop map-drawer-backdrop" data-map-drawer-backdrop aria-hidden="true"/.test(html));
  check(`${name}: the map fills the phone screen below lg`, /max-lg:h-\[calc\(100dvh-10\.5rem-var\(--safe-bottom,0px\)\)\]/.test(html));
}
check('the drawer slides in from the left with a blurred backdrop, below lg only', /@media \(max-width:1023px\)\{\s*\.map-drawer\.map-drawer\{[^}]*transform:translateX\(-104%\)/.test(css) && /\.map-drawer-backdrop\{[^}]*backdrop-filter:blur\(8px\)/.test(css));
check('the drawer toggle, header and backdrop never show from lg up', /@media \(min-width:1024px\)\{ \.map-drawer-toggle, \.map-drawer-head, \.map-drawer-backdrop\{display:none !important;\} \}/.test(css));
check('main.js wires the drawer (toggle, backdrop, close, Escape) and closes it at lg', /function initMapDrawer\(\)/.test(mainJs) && /e\.key === 'Escape'/.test(mainJs) && /matchMedia\('\(min-width: 1024px\)'\)/.test(mainJs) && /initMapDrawer\(\);/.test(mainJs));

t.finish();
