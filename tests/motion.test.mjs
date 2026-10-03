// The motion details ported from React Bits (public/js/main.js, css/style.css):
// CountUp counts once to the real value and never counts up an empty state;
// AnimatedList runs on the Sightings page's first load only; Magnet and
// TiltedCard exist only for a fine pointer; everything is still under
// prefers-reduced-motion; and none of it adds a colored shadow. Batch two:
// DecryptedText resolves once to the real eyebrow and keeps it readable by
// screen readers, ElasticSlider never touches a slider's value, GlareHover is
// a neutral 12% highlight for fine pointers only, and the CircularText badge
// stands still under reduced motion.
// Run: node tests/motion.test.mjs

import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const MAIN = read('public/js/main.js');
const CSS = read('public/css/style.css');
const wait = ms => new Promise(r => setTimeout(r, ms));

// A bare page with main.js loaded. `visible` decides what the stub
// IntersectionObserver reports; `media` which media queries match.
function open(body, { media = [], visible = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/', pretendToBeVisual: true });
  const w = dom.window;
  const observed = [];
  w.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(el) { observed.push(el); if (visible) setTimeout(() => this.cb([{ isIntersecting: true, target: el }]), 0); }
    unobserve() {} disconnect() {}
  };
  w.matchMedia = q => ({ matches: media.some(m => q.includes(m)), addEventListener() {}, removeEventListener() {} });
  w.eval(`${MAIN}\nwindow.__CCC = CCC;`);   // CCC is a top-level const: read it in the same script
  return { w, d: w.document, CCC: w.__CCC, observed };
}

console.log('1. CountUp');
{
  const p = open('<span id="n">—</span>');
  const el = p.d.getElementById('n');
  const writes = [];
  new p.w.MutationObserver(() => writes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  check('a real value is accepted', p.CCC.countUp(el, 1247) === true);
  await wait(1500);
  check('it counts up through intermediate values and lands on the exact real number', el.textContent === '1,247' && writes.length > 5 && writes.some(v => v !== '1,247'), writes.slice(0, 4).join(' '));
  writes.length = 0;
  p.CCC.countUp(el, 1250);
  await wait(20);   // MutationObserver callbacks are asynchronous
  check('a second value for the same element (a refresh) is written at once, not counted again', el.textContent === '1,250' && writes.length === 1);
  check('a missing value is refused, so the caller keeps its em dash', p.CCC.countUp(el, null) === false && p.CCC.countUp(el, NaN) === false);
}
{
  const p = open('<span id="n">—</span>', { visible: false });
  const el = p.d.getElementById('n');
  p.CCC.countUp(el, 45);
  await wait(50);
  check('off screen it waits (the dash stays until the number is in view)', el.textContent === '—');
  p.CCC.countUp(el, null);
  el.textContent = '—';
  check('...and an empty state that arrives meanwhile cancels the pending count', p.observed.length === 1 && el.textContent === '—');
}
{
  const p = open('<span id="n">—</span>', { media: ['reduce'] });
  const el = p.d.getElementById('n');
  p.CCC.countUp(el, 38);
  check('reduced motion: the final value is written at once', el.textContent === '38');
  p.CCC.animateCounter(el, 0, 99, 1200);
  check('reduced motion: animateCounter also jumps straight to its final value', el.textContent === '99');
}

console.log('2. AnimatedList');
{
  const p = open('<div id="a"></div><div id="b"></div>', { visible: false });
  p.CCC.enterList([p.d.getElementById('a'), p.d.getElementById('b')]);
  check('cards wait hidden until they enter the viewport', p.d.querySelectorAll('.list-pending').length === 2);
  const r = open('<div id="a"></div>', { media: ['reduce'] });
  r.CCC.enterList([r.d.getElementById('a')]);
  check('reduced motion: cards are never hidden or animated', !r.d.querySelector('.list-pending, .list-enter'));
  const js = read('public/js/sightings.js');
  check('Sightings: entrances stop for good once the city or the sort changes', /animateEntrances = false;\s*order =/.test(js) && /animateEntrances = false; selectCity/.test(js));
  check('Sightings: cards added by the minute poll never animate', !/enterList/.test(js.slice(js.indexOf('async function poll'), js.indexOf('function startPolling'))));
}

console.log('3. Magnet and TiltedCard: fine pointers only');
{
  const body = '<button id="b" class="btn-magnetic" data-magnet>Submit</button><article id="c" class="glass" data-tilt></article>';
  function setup(media) {
    const p = open(body, { media });
    p.d.getElementById('b').getBoundingClientRect = () => ({ left: 100, top: 100, width: 80, height: 40, right: 180, bottom: 140 });
    p.d.getElementById('c').getBoundingClientRect = () => ({ left: 300, top: 300, width: 200, height: 200, right: 500, bottom: 500 });
    p.CCC.initMagnet(); p.CCC.initTilt();
    const ev = (target, type, x, y) => target.dispatchEvent(new p.w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    return { ...p, ev, btn: p.d.getElementById('b'), card: p.d.getElementById('c') };
  }
  const fine = setup(['hover: hover']);
  fine.ev(fine.d, 'pointermove', 200, 150);   // just outside the button's corner, inside the 40px field
  await wait(60);
  const [tx, ty] = fine.btn.style.translate.split(' ').map(parseFloat);
  check('mouse: the Submit button leans toward a nearby cursor, 6px at most', fine.btn.classList.contains('is-pulled') && tx > 0 && ty > 0 && tx <= 6 && ty <= 6, fine.btn.style.translate);
  fine.ev(fine.d, 'pointermove', 600, 600);
  await wait(60);
  check('...and lets go once the cursor leaves the field', !fine.btn.style.translate && !fine.btn.classList.contains('is-pulled'));
  fine.ev(fine.card, 'pointerover', 490, 310);
  fine.ev(fine.card, 'pointermove', 490, 310);
  await wait(400);
  const angles = (fine.card.style.transform.match(/-?[\d.]+deg/g) || []).map(parseFloat);
  check('mouse: a photo card tilts toward the pointer, within 6 degrees, with the neutral-shadow class', fine.card.classList.contains('is-tilting') && angles.length === 2 && angles.every(a => a !== 0 && Math.abs(a) <= 6), fine.card.style.transform);
  fine.ev(fine.card, 'pointerleave', 0, 0);
  await wait(3000);
  check('...and settles flat after the pointer leaves, then the loop stops (inline styles cleared)', !fine.card.classList.contains('is-tilting') && fine.card.style.transform === '');

  for (const [label, media] of [['touch device', []], ['reduced motion', ['hover: hover', 'reduce']]]) {
    const p = setup(media);
    p.ev(p.d, 'pointermove', 200, 150);
    p.ev(p.card, 'pointerover', 490, 310); p.ev(p.card, 'pointermove', 490, 310);
    await wait(100);
    check(`${label}: the Submit button never moves and no card tilts`, !p.btn.style.translate && !p.card.classList.contains('is-tilting') && !p.card.style.transform);
  }
}

console.log('4. Where each effect is wired');
{
  const index = read('public/index.html'), sightings = read('public/sightings.html'), zones = read('public/infrastructure.html');
  check('BlurText: only the homepage headline', (index.match(/class="blur-word/g) || []).length === 5 && /<h1[^>]*>\s*<span class="blur-word"/.test(index) && ![sightings, zones].some(s => /blur-word/.test(s)));
  check('ShinyText: only the two gold Replay buttons', /id="sightingsReplay"[^>]*class="shine /.test(sightings) && /id="zonesReplay"[^>]*class="shine /.test(zones) && !/class="shine/.test(index));
  check('Magnet: only the Submit button', (index.match(/data-magnet/g) || []).length === 1 && /id="openSightingDrawer" data-magnet/.test(index));
  check('CountUp: Fleet & Fares on the Zones page', /CCC\.countUp\(el, value, \{ format: fmt \}\)/.test(zones));
}

console.log('5. Stylesheet rules');
{
  const motion = CSS.slice(CSS.indexOf('/* ---------- Motion details'), CSS.indexOf('/* ---------- Header'));
  const shadows = [...motion.matchAll(/box-shadow:([^;]+);/g)].map(m => m[1]);
  check('no colored shadow: every shadow added is the neutral --shadow / --ink token', shadows.length > 0 && shadows.every(s => !/#|rgba?\(\s*\d|--gold/.test(s)));
  const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'));
  check('reduced motion stops BlurText, AnimatedList and ShinyText outright (not just shortened)', /\.blur-word/.test(reduced) && /\.list-enter/.test(reduced) && /\.shine\.is-shining::after/.test(reduced) && /animation:none/.test(reduced) && /\.list-pending\{opacity:1;\}/.test(reduced));
  check('the shine sweep animates a transform (no repaint) and only while on screen', /\.shine\.is-shining::after\{animation:shine-sweep/.test(motion) && /@keyframes shine-sweep\{[^}]*transform/.test(motion));
}

console.log('6. DecryptedText (batch two)');
{
  const p = open('<p id="e" data-decrypt>Community spotted</p><h1>SIGHTINGS</h1>');
  p.CCC.initDecrypt();
  const e = p.d.getElementById('e');
  await wait(300);
  const sr = e.querySelector('.decrypt-sr'), shown = e.querySelector('[aria-hidden="true"]');
  check('mid-run: screen readers get the real text, the scrambling copy is aria-hidden', sr && sr.textContent === 'Community spotted' && shown && shown.textContent.length === 'Community spotted'.length);
  check('mid-run: it really scrambles, using only uppercase letters and digits (no symbols)', shown.textContent !== 'Community spotted' && [...shown.textContent].every((c, i) => c === 'Community spotted'[i] || /[A-Z0-9]/.test(c)) && shown.textContent[9] === ' ', shown.textContent);
  check('...and resolves left to right (the start is already real)', shown.textContent.startsWith('Co'));
  await wait(900);
  check('after ~0.9s it is the real label again, as plain text (no extra spans)', e.textContent === 'Community spotted' && e.children.length === 0 && !e.style.width);
  check('it runs once: the element is observed a single time', p.observed.filter(x => x === e).length === 1);
  const still = open('<p id="e" data-decrypt>Your Data</p>', { media: ['reduce'] });
  still.CCC.initDecrypt();
  await wait(100);
  check('reduced motion: the label is never touched', still.d.getElementById('e').innerHTML === 'Your Data' && still.observed.length === 0);
  const pages = ['index', 'sightings', 'community', 'rider-data', 'simulation', 'infrastructure'].map(f => read(`public/${f}.html`)).join('\n');
  const labels = [...pages.matchAll(/data-decrypt[^>]*>([^<]*)</g)].map(m => m[1]);
  check('wired to the seven eyebrows that sit above a heading, and nothing else', labels.sort().join('|') === ['Community spotted', 'Investor tools', 'Riders &amp; Spotters', 'Service Area', 'Service Zone', 'Service Zone', 'Your Data'].sort().join('|'), labels.join('|'));
}

console.log('7. ElasticSlider (batch two)');
{
  const body = '<input type="range" id="r" data-elastic min="0" max="400" step="1" value="150">';
  const p = open(body);
  const r = p.d.getElementById('r');
  r.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 20, width: 400, height: 20 });
  p.CCC.initElastic();
  r.value = '160'; r.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  await wait(60);
  check('keyboard / programmatic changes (no drag) never stretch the handle', !r.style.getPropertyValue('--thumb-sx'));
  r.dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true, clientX: 150 }));
  await wait(20);
  r.value = '400'; r.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.w.dispatchEvent(new p.w.MouseEvent('pointermove', { clientX: 460 }));
  await wait(120);
  const sx = parseFloat(r.style.getPropertyValue('--thumb-sx')), tx = parseFloat(r.style.getPropertyValue('--thumb-x'));
  check('dragging (and pulling past the end) stretches the handle a little, never more than 30%', sx > 1 && sx <= 1.3 && tx > 0 && tx <= 8, `${sx} ${tx}`);
  check('the physics never writes the value: the slider holds what the drag set', r.value === '400');
  p.w.dispatchEvent(new p.w.MouseEvent('pointerup', {}));
  await wait(1500);
  check('let go: it springs back and the loop stops (variables cleared)', !r.style.getPropertyValue('--thumb-sx') && !r.style.getPropertyValue('--thumb-x'));
  const still = open(body, { media: ['reduce'] });
  const r2 = still.d.getElementById('r');
  still.CCC.initElastic();
  r2.dispatchEvent(new still.w.MouseEvent('pointerdown', { bubbles: true }));
  r2.value = '0'; r2.dispatchEvent(new still.w.Event('input', { bubbles: true }));
  await wait(80);
  check('reduced motion: no stretch at all', !r2.style.getPropertyValue('--thumb-sx'));
  const sim = read('public/simulation.html');
  check('wired to the three Fleet ROI sliders, read by the thumb transform', ['fleetSize', 'electricityRate', 'dailyMiles'].every(id => new RegExp(`id="${id}" data-elastic`).test(sim)) && (sim.match(/transform:translateX\(var\(--thumb-x, 0px\)\) scale\(var\(--thumb-sx, 1\), var\(--thumb-sy, 1\)\)/g) || []).length === 2);
}

console.log('8. GlareHover and CircularText (batch two)');
{
  const body = '<article id="c" class="glass" data-tilt></article>';
  const fine = open(body, { media: ['hover: hover'] });
  const c = fine.d.getElementById('c');
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  fine.CCC.initTilt();
  c.dispatchEvent(new fine.w.MouseEvent('pointerover', { bubbles: true }));
  c.dispatchEvent(new fine.w.MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 75 }));
  check('mouse: the glare is centered on the pointer', c.style.getPropertyValue('--glare-x') === '25.0%' && c.style.getPropertyValue('--glare-y') === '75.0%');
  const touch = open(body);
  const t2 = touch.d.getElementById('c');
  touch.CCC.initTilt();
  t2.dispatchEvent(new touch.w.MouseEvent('pointerover', { bubbles: true }));
  t2.dispatchEvent(new touch.w.MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 75 }));
  check('touch device: no glare position, and the glare layer only shows on a tilting card', !t2.style.getPropertyValue('--glare-x') && /\.glass\[data-tilt\]::after\{[^}]*opacity:0;/.test(CSS) && /\.glass\[data-tilt\]\.is-tilting::after\{opacity:1;\}/.test(CSS));
  const glare = (CSS.match(/\.glass\[data-tilt\]::after\{[^}]*\}/) || [''])[0];
  const colors = [...glare.matchAll(/rgb\(([^)]*)\)/g)].map(m => m[1]);
  check('the glare is neutral white at 12% at most (no tint, no shadow)', colors.length === 2 && colors.every(c => /^255 255 255 \/ (0\.12|0)$/.test(c)) && !/box-shadow|filter/.test(glare));
  const zones = read('public/infrastructure.html');
  check('the badge reads exactly "AUSTIN • LIVE FLEET • ", is decorative, with a gold center dot', /<svg class="spin-badge[^"]*"[^>]*aria-hidden="true"/.test(zones) && />AUSTIN • LIVE FLEET • <\/textPath>/.test(zones) && /<circle cx="40" cy="40" r="3\.5" style="fill:rgb\(var\(--gold\)\)"\/>/.test(zones));
  check('the badge text respects the 11px floor', /font-size:11px[^>]*><textPath href="#coverageBadgeRing"/.test(zones));
  check('one turn per 12s, CSS only, and still under reduced motion', /\.spin-badge\.is-spinning \.spin-ring\{animation:spin-badge 12s linear infinite;\}/.test(CSS) && /prefers-reduced-motion: reduce\)\{[^}]*\.spin-badge\.is-spinning \.spin-ring\{animation:none;\}/.test(CSS.replace(/\n\s*/g, '')));
}

t.finish();
