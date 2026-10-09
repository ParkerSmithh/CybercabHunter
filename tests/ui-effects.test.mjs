// The React Bits ports in js/main.js and css/style.css: RubberSegment on the
// segmented controls, and BorderGlow only on the cards marked [data-glow].
// jsdom has no layout, so this checks wiring and the bugs that need none:
// the BrokenButtons.mov regression (the Zones page rewrites every .city-btn's
// classes, which used to catch the thumb's label copies too).
// Run: node tests/ui-effects.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const MAIN = fs.readFileSync(process.env.MAIN_FILE || `${ROOT}public/js/main.js`, 'utf8');

async function run() {
  console.log('1. RubberSegment: label copies are never mistaken for the page\'s buttons');
  {
    const ACTIVE = 'city-btn flex-1 py-2 rounded-lg text-xs font-semibold bg-white/[0.08] text-white';
    const INACTIVE = 'city-btn flex-1 py-2 rounded-lg text-xs font-semibold text-slate-400';
    const dom = new JSDOM(`<!doctype html><body>
      <div id="citySelector" role="group" class="flex p-1 rounded-xl">
        <button data-city="austin" aria-pressed="true" class="${ACTIVE}">Austin</button>
        <button data-city="dallas" aria-pressed="false" class="${INACTIVE}">Dallas</button>
      </div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window, d = w.document;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.eval(`${MAIN}\nCCC.initRubberSegments();`);
    // The Zones page's own switch code (infrastructure.html), run after init.
    w.eval(`
      const cityBtns = document.querySelectorAll('.city-btn');
      cityBtns.forEach(btn => btn.addEventListener('click', () => {
        cityBtns.forEach(b => { b.className = ${JSON.stringify(INACTIVE)}; b.setAttribute('aria-pressed', 'false'); });
        btn.className = ${JSON.stringify(ACTIVE)}; btn.setAttribute('aria-pressed', 'true');
      }));`);
    const track = d.getElementById('citySelector');
    const copies = [...track.querySelectorAll('.rs-copy')];
    check('a thumb holds one copy per label', !!track.querySelector('.rs-thumb') && copies.length === 2 && copies.map(c => c.textContent).join() === 'Austin,Dallas');
    check('the copies carry none of the buttons\' classes (so .city-btn finds only the 2 real buttons)', d.querySelectorAll('.city-btn').length === 2 && copies.every(c => c.className === 'rs-copy'));
    d.querySelector('[data-city="dallas"]').click();
    await new Promise(r => setTimeout(r, 20));
    check('after the page switches city, every copy is still a positioned label copy', [...track.querySelectorAll('.rs-copy')].length === 2 && copies.every(c => c.className === 'rs-copy' && c.parentElement.classList.contains('rs-thumb')));
    check('the thumb is still shown', track.querySelector('.rs-thumb').classList.contains('is-on'));
    w.close();
  }
  {
    const css = read('public/css/style.css');
    check('the rubber styles are keyed on structure, not on classes a page can rewrite', /\.rs-track > :is\(button, a\)\{position:relative; z-index:1; background:transparent !important;\}/.test(css) && !/\.rs-item\b|\.rs-active\b/.test(css + MAIN));
  }

  console.log('2. BorderGlow: only on the cards marked [data-glow]');
  {
    check('the listener looks for [data-glow], not every .glass', /e\.target\.closest\('\[data-glow\]'\)/.test(MAIN) && !/closest\('\.glass'\)/.test(MAIN));
    const count = f => (read(`public/${f}`).match(/\bdata-glow\b/g) || []).length;
    check('Sightings: the six stat tiles and the empty / error messages; not the city / sort bar', count('sightings.html') === 8 && !/data-glow class="glass rounded-2xl p-3 mb-6/.test(read('public/sightings.html')));
    check('Community: the four stat tiles only (not Reviews, not the leaderboard)', count('community.html') === 4 && !/id="reviews" data-glow|data-glow[^>]*id="reviews"/.test(read('public/community.html')));
    {
      // simulation.html: Fleet ROI's three result tiles, and on Fleet ETA only the
      // model cards (Cybercab gold, Model Y red), Austin and Dallas: fleet mix + ride/hours/wait.
      const sim = read('public/simulation.html'), roi = sim.slice(sim.indexOf('id="simPanelRoi"'), sim.indexOf('id="simPanelEta"')), eta = sim.slice(sim.indexOf('id="simPanelEta"'));
      const n = t => (t.match(/\bdata-glow\b/g) || []).length;
      check('Fleet ROI: the three result tiles only (not the inputs or the graph)', n(roi) === 3);
      check('Fleet ETA: the eight model cards only, red on Model Y', n(eta) === 8 && (eta.match(/data-glow="red"/g) || []).length === 4 && [...eta.matchAll(/data-glow(?:="red")? class="([^"]*)"/g)].every(m => /\bdmv-card\b/.test(m[1])));
    }
    check('the vehicle cards and the sighting cards are marked by their scripts', /a\.dataset\.glow = kind\.glow/.test(read('public/js/vehicles.js')) && /article\.dataset\.glow = ''/.test(read('public/js/sightings.js')));
    // vehicle.html: only its hero card (the Fleet ETA model-card redesign, owner request 2026-10-09).
    check('Vehicle page: the hero card only', count('vehicle.html') === 1 && /id="vHero" data-glow /.test(read('public/vehicle.html')));
    const none = ['index.html', 'infrastructure.html', 'replay.html', 'rider-data.html', 'rider.html', 'moderation.html', 'profile.html', 'link-gmail.html', 'vehicles.html'];
    check('no glow anywhere else (Zones, Replay, Rider Data, profiles, Moderation, Profile settings, ...)', none.every(f => count(f) === 0), none.filter(f => count(f)).join());
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
