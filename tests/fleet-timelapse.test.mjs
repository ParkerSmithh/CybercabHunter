// The homepage Fleet Growth chart's timelapse playback (public/index.html, initFleetGrowthChart).
//   - a real <button> with an aria-label: play -> pause -> resume, replay once finished
//   - the line draws from the ACTIVE range's first visible day to the latest day, eased,
//     over ~4s (90D), ~6s (6M), ~8s (1Y / All), with a "N Cybercabs — date" readout
//   - a range change mid-play stops it and restores the static full view
//   - prefers-reduced-motion jumps straight to the finished view
// The real inline chart script runs in jsdom with a hand-driven requestAnimationFrame clock
// and a fixed "now" (so the four ranges start on different days).
// Run: node tests/fleet-timelapse.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const HTML = fs.readFileSync(`${ROOT}public/index.html`, 'utf8');
const CHART = HTML.slice(HTML.indexOf('function initFleetGrowthChart()'), HTML.lastIndexOf('initFleetGrowthChart();'));

const DAY = 86400000;
const NOW = Date.UTC(2027, 5, 1, 12);            // June 1, 2027
const FLOOR = Date.UTC(2026, 8, 24);             // the chart's AUSTIN_FLOOR
// One Austin vehicle every 5 days from the floor to now, plus a Dallas one that must never count.
const VEHICLES = [];
for (let ms = FLOOR + DAY / 2; ms < NOW; ms += 5 * DAY) VEHICLES.push({ service_area: 'Austin', first_seen_at: new Date(ms).toISOString().slice(0, 19).replace('T', ' ') });
VEHICLES.push({ service_area: 'Dallas', first_seen_at: '2027-01-01 00:00:00' });
const countAt = ms => VEHICLES.filter(v => v.service_area === 'Austin' && Date.parse(v.first_seen_at.replace(' ', 'T') + 'Z') <= ms).length;
const RANGE_START = { '90d': NOW - 90 * DAY, '6m': NOW - 182 * DAY, '1y': FLOOR, all: FLOOR };
const RANGE_MS = { '90d': 4000, '6m': 6000, '1y': 8000, all: 8000 };
const fmt = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

async function page({ reducedMotion = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="fleetChartRange">
    <button data-range="90d" class="range-btn">90D</button><button data-range="6m" class="range-btn">6M</button>
    <button data-range="1y" class="range-btn">1Y</button><button data-range="all" class="range-btn">All</button>
    </div><div id="fleetChartMount"></div></body>`, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/' });
  const w = dom.window;
  const RealDate = w.Date;
  w.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
  w.matchMedia = q => ({ matches: reducedMotion && /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} disconnect() {} };
  const fetches = [];
  w.fetch = async u => { fetches.push(String(u)); return { ok: true, json: async () => ({ vehicles: VEHICLES, total: VEHICLES.length }) }; };
  // Hand-driven animation frames: advance(ms) runs 16ms frames until that much time has passed.
  let queue = [], nextId = 1, clock = 1000;
  w.requestAnimationFrame = cb => { const id = nextId++; queue.push({ id, cb }); return id; };
  w.cancelAnimationFrame = id => { queue = queue.filter(f => f.id !== id); };
  const advance = ms => {
    const end = clock + ms;
    while (clock < end && queue.length) { clock += 16; const batch = queue; queue = []; batch.forEach(f => f.cb(clock)); }
  };
  w.eval(`${CHART}\ninitFleetGrowthChart();`);
  await new Promise(r => setTimeout(r, 20));
  const d = w.document;
  const $ = id => d.getElementById(id);
  const btn = () => $('fleetPlayBtn');
  const readout = () => $('fleetPlayReadout');
  const lineD = () => $('fleetLine').getAttribute('d');
  const lineEndX = () => { const n = lineD().trim().split(/\s+/); return Number(n[n.length - 2]); };
  const range = r => d.querySelector(`#fleetChartRange [data-range="${r}"]`).click();
  return { w, d, $, fetches, btn, readout, lineD, lineEndX, range, advance, pending: () => queue.length };
}

async function run() {
  console.log('1. The button');
  {
    const p = await page();
    const b = p.btn();
    check('the play control is a real <button type="button">', b && b.tagName === 'BUTTON' && b.type === 'button');
    check('it starts as "Play" with an aria-label', b.getAttribute('aria-label') === 'Play fleet growth timelapse' && b.dataset.state === 'idle');
    check('the button reads "Timelapse" with the play icon beside it', b.textContent.trim() === 'Timelapse' && b.querySelector('#fleetPlayIcon svg'));
    b.click();
    check('the "Timelapse" text stays while the icon switches to pause', b.textContent.trim() === 'Timelapse' && b.querySelectorAll('#fleetPlayIcon path').length === 2);
    b.click(); p.range('90d');
    check('the readout is hidden before playing', p.readout().classList.contains('hidden'));
    const before = p.fetches.length;
    b.click(); p.advance(5000); p.range('all'); p.btn().click(); p.advance(9000);
    check('playback reuses the loaded data: no request beyond the chart\'s one registry fetch', before === 1 && p.fetches.length === 1 && /\/api\/robotaxi-vehicles\?/.test(p.fetches[0]));
  }

  console.log('2. Play, pause, resume, finish, replay (90D, the default range)');
  {
    const p = await page();
    const staticD = p.lineD();
    p.btn().click();
    check('clicking starts playback: the button becomes "Pause"', p.btn().dataset.state === 'playing' && p.btn().getAttribute('aria-label') === 'Pause fleet growth timelapse');
    check('the readout shows while playing', !p.readout().classList.contains('hidden'));
    check('frame 0 starts at the range\'s first visible day with the count on that day', p.readout().textContent === `${countAt(RANGE_START['90d'])} Cybercabs — ${fmt(RANGE_START['90d'])}`, p.readout().textContent);
    check('frame 0 draws (almost) nothing yet', p.lineEndX() <= 31, p.lineEndX());
    p.advance(RANGE_MS['90d'] / 2);
    const midX = p.lineEndX();
    check('halfway through 90D (eased 0.5) the line has reached the middle of the plot', Math.abs(midX - 310) < 12, midX);
    const mid = RANGE_START['90d'] + 0.5 * (NOW - RANGE_START['90d']);
    const m = /^(\d+) Cybercabs — (.+)$/.exec(p.readout().textContent);
    check('the readout date is the playhead\'s day, and the count is the real cumulative count then', m && Math.abs(Date.parse(m[2] + ' UTC') - Date.parse(fmt(mid) + ' UTC')) <= DAY && Math.abs(Number(m[1]) - countAt(mid)) <= 1, p.readout().textContent);

    p.btn().click();
    check('clicking mid-animation pauses: the button offers "Resume"', p.btn().dataset.state === 'paused' && p.btn().getAttribute('aria-label') === 'Resume fleet growth timelapse' && p.pending() === 0);
    const pausedD = p.lineD();
    p.advance(2000);
    check('while paused nothing moves', p.lineD() === pausedD && !p.readout().classList.contains('hidden'));
    p.$('fleetHoverCatcher').dispatchEvent(new p.w.FocusEvent('focus'));
    check('the hover tooltip stays out of the way during a paused timelapse', p.$('fleetTooltip').classList.contains('hidden'));
    p.btn().click();
    check('clicking again resumes from the same place', p.btn().dataset.state === 'playing' && p.lineD() === pausedD);
    p.advance(RANGE_MS['90d'] / 2 - 200);
    check('it is still playing just before 4s of play time', p.btn().dataset.state === 'playing');
    p.advance(400);
    check('after ~4s it finishes: the button offers "Replay"', p.btn().dataset.state === 'done' && p.btn().getAttribute('aria-label') === 'Replay fleet growth timelapse');
    check('the finished line is exactly the static full view', p.lineD() === staticD);
    check('the readout hides again when finished, and no frames keep running', p.readout().classList.contains('hidden') && p.pending() === 0);
    p.btn().click();
    check('Replay restarts from the first visible day', p.btn().dataset.state === 'playing' && p.lineEndX() <= 31 && p.readout().textContent.endsWith(fmt(RANGE_START['90d'])));
  }

  console.log('3. Every range: its own start, its own duration, the same final shape');
  for (const r of ['90d', '6m', '1y', 'all']) {
    const p = await page();
    p.range(r);
    const staticD = p.lineD();
    p.btn().click();
    check(`${r}: playback starts on the range's first visible day (${fmt(RANGE_START[r])})`, p.readout().textContent === `${countAt(RANGE_START[r])} Cybercab${countAt(RANGE_START[r]) === 1 ? '' : 's'} — ${fmt(RANGE_START[r])}`, p.readout().textContent);
    let lastX = p.lineEndX(), monotonic = true;
    for (let i = 0; i < 10; i++) { p.advance(RANGE_MS[r] / 10 - 50); if (p.btn().dataset.state !== 'playing') break; const x = p.lineEndX(); if (x < lastX) monotonic = false; lastX = x; }
    check(`${r}: the line draws left to right`, monotonic);
    check(`${r}: still playing just before ${RANGE_MS[r] / 1000}s`, p.btn().dataset.state === 'playing');
    p.advance(800);
    check(`${r}: finished at ~${RANGE_MS[r] / 1000}s, ending on the static full view`, p.btn().dataset.state === 'done' && p.lineD() === staticD);
  }

  console.log('4. Changing range mid-play');
  {
    const p = await page();
    p.btn().click();
    p.advance(1500);
    p.range('1y');
    const fresh = await page(); fresh.range('1y');
    check('the animation stops: no frames pending, button back to "Play"', p.pending() === 0 && p.btn().dataset.state === 'idle' && p.btn().getAttribute('aria-label') === 'Play fleet growth timelapse');
    check('the chart resets to the new range\'s static full view', p.lineD() === fresh.lineD());
    check('the readout is hidden', p.readout().classList.contains('hidden'));
    p.btn().click();
    check('playing again runs the NEW range from its own first visible day', p.readout().textContent.endsWith(fmt(RANGE_START['1y'])));
    p.btn().click(); p.range('90d');
    check('a range change while paused also resets cleanly', p.btn().dataset.state === 'idle' && p.pending() === 0 && p.readout().classList.contains('hidden'));
  }

  console.log('5. Reduced motion');
  {
    const p = await page({ reducedMotion: true });
    const staticD = p.lineD();
    p.btn().click();
    check('the button jumps straight to the finished state: no animation frames', p.btn().dataset.state === 'done' && p.pending() === 0);
    check('the chart shows the final (static) view, no readout', p.lineD() === staticD && p.readout().classList.contains('hidden'));
    p.btn().click();
    check('Replay is instant too', p.btn().dataset.state === 'done' && p.pending() === 0);
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
