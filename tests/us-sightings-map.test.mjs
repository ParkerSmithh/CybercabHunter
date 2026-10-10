// The homepage "Cybercab sightings across the US" map (js/us-sightings-data.js,
// js/us-sightings-map.js): a fixed SVG built from static data — no map service,
// no pan or zoom — with the sighted states tinted, a dot per named city, the
// cities listed by state, and the community source credited.
// Run: node tests/us-sightings-map.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const DATA = read('public/js/us-sightings-data.js');
const MAP = read('public/js/us-sightings-map.js');
const HTML = read('public/index.html');

console.log('1. The data');
const w = new JSDOM('<!doctype html><body><div data-us-map></div></body>', { runScripts: 'outside-only', url: 'https://cybercabhunter.com/' }).window;
w.eval(DATA);
const D = w.CCH_US_MAP;
{
  const ids = new Set(D.states.map(s => s.id));
  check('51 shapes: the 50 states and DC, each a path', D.states.length === 51 && ids.size === 51 && ids.has('DC') && D.states.every(s => /^M[\d.,LZMlzm\s-]+/.test(s.d)));
  check('every sighted id is a real state (or DC)', D.sighted.length > 0 && D.sighted.every(id => ids.has(id)));
  check('every city sits in the 975 x 610 frame, in a sighted state', D.cities.length > 0 && D.cities.every(c => c.x > 0 && c.x < 975 && c.y > 0 && c.y < 610 && D.sighted.includes(c.st)));
  const austin = D.cities.find(c => c.name === 'Austin'), sac = D.cities.find(c => c.name === 'Sacramento');
  check('cities land where they should: Austin in south-central Texas, Sacramento far west', austin && austin.st === 'TX' && austin.x > 400 && austin.x < 480 && austin.y > 430 && sac && sac.x < 120);
  check('both sources are credited with their dates', D.sources.length === 2 && D.sources.some(x => /MyCybercab/.test(x.name)) && D.sources.some(x => /CuriousPejjy/.test(x.name)) && D.sources.every(x => /2026/.test(x.date)));
  check('no city is listed twice; counts are whole numbers', new Set(D.cities.map(c => c.name + '|' + c.st)).size === D.cities.length && D.cities.every(c => c.n === undefined || (Number.isInteger(c.n) && c.n > 0)));
}

console.log('2. No map service');
check('no map library, tile server or geocoder in either file', !/maplibre|mapbox|leaflet|tile|api\.|https?:\/\//i.test(DATA.replace(/https:\/\/(x\.com\/CuriousPejjy|mycybercab\.com)/g, '') + MAP));
check('the homepage loads both files, after the DMV panel section', HTML.indexOf('data-dmv-panel') < HTML.indexOf('data-us-map') && /<script src="js\/us-sightings-data\.js[^"]*"><\/script>\s*<script src="js\/us-sightings-map\.js/.test(HTML));

console.log('3. The rendered panel');
{
  w.eval(MAP);
  const el = w.document.querySelector('[data-us-map]');
  const svg = el.querySelector('svg');
  check('one fixed SVG with every state shape and a dot per city', !!svg && svg.querySelectorAll('.us-states path').length === 51 && svg.querySelectorAll('.us-city').length === D.cities.length);
  check('the sighted states are tinted, the rest are not', svg.querySelectorAll('path.is-sighted').length === D.sighted.length);
  const withCities = new Set(D.cities.map(c => c.st));
  check('a row per state with a named city, plus "Also reported in" for the rest', el.querySelectorAll('li[data-state-row]').length === withCities.size && /Also reported in/.test(el.textContent));
  const ca = el.querySelector('li[data-state-row="CA"]');
  check('a long state lists its busiest cities first, the rest behind "+N more"', /^\s*San Diego/.test(ca.querySelector('p').textContent) && ca.querySelectorAll('[data-more].hidden').length > 0 && !!ca.querySelector('[data-more-btn]'));
  ca.querySelector('[data-more-btn]').click();
  check('...which shows them all', ca.querySelectorAll('[data-more].hidden').length === 0 && !ca.querySelector('[data-more-btn]'));
  const big = svg.querySelector('.us-city[data-city="' + D.cities.findIndex(c => c.name === 'San Diego') + '"] .us-city-dot'), small = svg.querySelector('.us-city[data-city="' + D.cities.findIndex(c => c.name === 'Lawton') + '"] .us-city-dot');
  check('dots are sized by sightings (San Diego 31 > Lawton 1)', Number(big.getAttribute('r')) > Number(small.getAttribute('r')));
  check('the totals: states (DC counted separately) and cities', new RegExp(`${D.sighted.filter(s => s !== 'DC').length}\\s*\\+ DC`).test(el.textContent) && el.textContent.includes(String(D.cities.length)));
  check('no sighting counts are shown: not in the list, the totals or the hover names', !/San Diego\s*31|Pittsburgh\s*31/.test(el.textContent) && !/Sightings/.test(el.querySelector('dl').textContent) && ![...svg.querySelectorAll('.us-city title')].some(t => /\d+\s*sighting/.test(t.textContent)));
  // Dots / Heatmap
  const btn = v => el.querySelector(`[data-us-view="${v}"]`);
  check('two map styles, Dots selected by default, with a heatmap canvas in the frame', btn('dots').getAttribute('aria-pressed') === 'true' && btn('heat').getAttribute('aria-pressed') === 'false' && !!el.querySelector('[data-us-frame] canvas[data-us-heat]') && !el.classList.contains('us-view-heat'));
  btn('heat').click();
  check('Heatmap: the panel switches view (dots hidden by CSS), the button shows it, and the choice is remembered', el.classList.contains('us-view-heat') && btn('heat').getAttribute('aria-pressed') === 'true' && btn('dots').getAttribute('aria-pressed') === 'false' && w.localStorage.getItem('cch:us-map-view') === 'heat');
  btn('dots').click();
  check('...and back to Dots', !el.classList.contains('us-view-heat') && w.localStorage.getItem('cch:us-map-view') === 'dots');
  check('the heatmap is drawn from the same data, clipped to the US outline with clip() (not a destination-in fill)', /usOutline\.addPath\(new Path2D\(st\.d\)\)/.test(MAP) && /ctx\.clip\(usOutline\)/.test(MAP) && !/globalCompositeOperation\s*=\s*'destination-in'/.test(MAP));
  check('no pan or zoom: nothing listens for wheel or drag', !/wheel|pointerdown|mousedown|touchstart|drag/.test(MAP));
}

t.finish();
