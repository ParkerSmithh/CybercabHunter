// The homepage service-status banner (js/service-banner.js): live 6:00:00 –
// 22:59:59 Austin time, parked otherwise, with a countdown that rounds up and
// never goes negative; the visitor's own time zone never matters; a daylight-
// saving night counts its real hours; the countdown ticks in place.
// Run: node tests/service-banner.test.mjs   (also re-runs itself as a Pacific visitor)

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const HTML = read('public/index.html');
const pacific = process.env.TZ === 'America/Los_Angeles';

// The banner on a page whose clock reads `nowMs`; timers are captured, not run.
function page(nowMs) {
  const dom = new JSDOM(`<!doctype html><body><div id="serviceBanner"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let now = nowMs;
  const timers = [];
  w.eval(`Date.now = () => ${'__NOW__'};`.replace('__NOW__', 'window.__now'));
  w.__now = now;
  w.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  w.clearTimeout = () => {};
  // One evaluation, like two <script> tags sharing the page's global scope
  // (calc.js's top-level const is not a window property).
  w.eval(read('public/js/calc.js') + '\n;' + read('public/js/service-banner.js'));
  const el = w.document.getElementById('serviceBanner');
  return {
    w, el, timers,
    text: () => el.textContent.replace(/\s+/g, ' ').trim(),
    advance(ms) { now += ms; w.__now = now; const next = timers.pop(); if (next) next.fn(); }
  };
}
// An instant from an Austin wall-clock time ("CDT" -5 / "CST" -6).
const at = (iso, off) => Date.parse(`${iso}${off}`);

async function run() {
  console.log(`Visitor time zone: ${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log('1. One source of truth for the hours');
  {
    check('the banner reads js/calc.js SERVICE_HOURS (6:00 AM – 11:00 PM, America/Chicago)', /const H = C\.SERVICE_HOURS;/.test(read('public/js/service-banner.js')) && /SERVICE_HOURS = \{ openMinute: 6 \* 60, closeMinute: 23 \* 60, timeZone: 'America\/Chicago' \}/.test(read('public/js/calc.js')));
    check('it sits directly below the stats bar and above SERVICE ZONES', HTML.indexOf('id="statSightings"') < HTML.indexOf('id="serviceBanner"') && HTML.indexOf('id="serviceBanner"') < HTML.indexOf('id="map"') && /<script src="js\/calc\.js[^"]*"><\/script>\s*<script src="js\/service-banner\.js/.test(HTML));
  }

  console.log('2. State and countdown (Austin time, Oct 9 2026, CDT)');
  const S = page(Date.now()).w.CCHServiceBanner;
  const cases = [
    ['05:59:59', false, '1m'],      // the last second before opening
    ['06:00:00', true, '17h 0m'],   // opens exactly at 6:00:00
    ['14:47:20', true, '8h 13m'],   // 8h 12m 40s left, rounded up
    ['22:30:00', true, '30m'],      // under an hour: minutes only
    ['22:59:59', true, '1m'],       // never 0m while running
    ['23:00:00', false, '7h 0m'],   // parks exactly at 23:00:00
    ['02:15:00', false, '3h 45m']
  ];
  for (const [clock, live, cd] of cases) {
    const s = S.state(at(`2026-10-09T${clock}`, '-05:00'));
    check(`${clock} CT: ${live ? 'live' : 'parked'}, "${cd}"`, s.live === live && S.countdown(s.ms) === cd && s.ms >= 0, `${s.live} ${S.countdown(s.ms)}`);
  }

  console.log('3. Daylight-saving nights count their real hours');
  {
    const fall = S.state(at('2026-10-31T23:00:00', '-05:00'));    // 11 PM CDT -> 6 AM CST: 8 real hours
    check('the night clocks fall back: back in 8h 0m', !fall.live && S.countdown(fall.ms) === '8h 0m', S.countdown(fall.ms));
    const spring = S.state(at('2027-03-13T23:00:00', '-06:00'));  // 11 PM CST -> 6 AM CDT: 6 real hours
    check('the night clocks spring forward: back in 6h 0m', !spring.live && S.countdown(spring.ms) === '6h 0m', S.countdown(spring.ms));
  }

  console.log('4. The banner itself');
  {
    const live = page(at('2026-10-09T14:47:20', '-05:00'));
    check('live: green pulsing dot, the headline, the countdown and "central time"', live.el.dataset.state === 'live' && !!live.el.querySelector('.animate-ping.bg-emerald-400') && /Cybercabs are on the road now/.test(live.text()) && /Service ends in 8h 13m/.test(live.text()) && /All times central time \(CT\)/.test(live.text()));
    const cd = live.el.querySelector('[data-countdown]');
    check('the countdown keeps its width as it changes (tabular numbers, reserved width)', /tabular-nums/.test(cd.className) && /min-w-\[6\.5ch\]/.test(cd.className));
    check('it schedules its next tick at the next minute boundary', live.timers.length === 1 && live.timers[0].ms > 0 && live.timers[0].ms <= 60050);
    live.advance(60000);
    check('a minute later it ticks in place (same element, no reload): 8h 12m', live.el.querySelector('[data-countdown]') === cd && cd.textContent === '8h 12m');
    const parked = page(at('2026-10-09T23:30:00', '-05:00'));
    check('parked: moon, dimmed, "parked for the night", "Back on the road at 6:00 AM", "Back in 6h 30m", no pulse', parked.el.dataset.state === 'parked' && !!parked.el.querySelector('svg') && !parked.el.querySelector('.animate-ping') && /The fleet is parked for the night/.test(parked.text()) && /Back on the road at 6:00 AM/.test(parked.text()) && /Back in 6h 30m/.test(parked.text()) && /All times central time \(CT\)/.test(parked.text()));
    const edge = page(at('2026-10-09T05:59:30', '-05:00'));
    check('parked at 5:59:30 ("Back in 1m")...', edge.el.dataset.state === 'parked' && /Back in 1m/.test(edge.text()));
    edge.advance(30000);
    check('...and live on the tick at 6:00', edge.el.dataset.state === 'live' && /Service ends in 17h 0m/.test(edge.text()));
  }

  // The same checks again as a visitor on Pacific time: nothing may change.
  if (!pacific) {
    console.log('5. A visitor on Pacific time');
    let out = '', ok = false;
    try { out = execFileSync(process.execPath, [new URL(import.meta.url).pathname], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }); ok = true; } catch (e) { out = String(e.stdout || e); }
    check('every check passes with the system clock on Pacific time (still Austin time)', ok && /Visitor time zone: America\/Los_Angeles/.test(out) && / 0 failed/.test(out), out.split('\n').filter(l => /FAIL/.test(l)).join(' | '));
  }

  t.finish();
}

run().catch(e => { console.error(e); process.exit(1); });
