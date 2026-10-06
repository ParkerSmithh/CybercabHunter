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

t.finish();
