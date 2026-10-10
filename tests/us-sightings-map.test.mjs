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
const w = new JSDOM('<!doctype html><body><div data-us-map></div></body>', { runScripts: 'outside-only' }).window;
w.eval(DATA);
const D = w.CCH_US_MAP;
{
  const ids = new Set(D.states.map(s => s.id));
  check('51 shapes: the 50 states and DC, each a path', D.states.length === 51 && ids.size === 51 && ids.has('DC') && D.states.every(s => /^M[\d.,LZMlzm\s-]+/.test(s.d)));
  check('every sighted id is a real state (or DC)', D.sighted.length > 0 && D.sighted.every(id => ids.has(id)));
  check('every city sits in the 975 x 610 frame, in a sighted state', D.cities.length > 0 && D.cities.every(c => c.x > 0 && c.x < 975 && c.y > 0 && c.y < 610 && D.sighted.includes(c.st)));
  const austin = D.cities.find(c => c.name === 'Austin'), sac = D.cities.find(c => c.name === 'Sacramento');
  check('cities land where they should: Austin in south-central Texas, Sacramento far west', austin && austin.st === 'TX' && austin.x > 400 && austin.x < 480 && austin.y > 430 && sac && sac.x < 120);
  check('the source is credited with its date', D.source && /CuriousPejjy/.test(D.source.name) && /2026/.test(D.source.date));
}

console.log('2. No map service');
check('no map library, tile server or geocoder in either file', !/maplibre|mapbox|leaflet|tile|api\.|https?:\/\/(?!x\.com)/i.test(DATA.replace(/https:\/\/x\.com\/CuriousPejjy/, '') + MAP.replace(/D\.source\.url/, '')));
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
  check('the totals: states (DC counted separately) and cities', new RegExp(`${D.sighted.filter(s => s !== 'DC').length}\\s*\\+ DC`).test(el.textContent) && el.textContent.includes(String(D.cities.length)));
  check('no pan or zoom: nothing listens for wheel or drag', !/wheel|pointerdown|mousedown|touchstart|drag/.test(MAP));
}

t.finish();
