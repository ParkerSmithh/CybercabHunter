// AnimatedContent, sitewide (public/js/animated-content.js, css/style.css,
// the local GSAP + ScrollTrigger in /vendor): the shared entrance system.
//   - nothing is ever left hidden: no GSAP, Reduce Motion, no motion-ok, a
//     script error -> everything shown at once, no inline styles
//   - presets and AnimatedContent's props (distance, duration, ease, delay,
//     opacity, scale, blur, threshold); phones: shorter, no blur, no 3D tilt
//   - one one-shot ScrollTrigger per element, killed when it fires or the
//     element finishes; elements entering together play in document order
//   - hidden elements wait for a size; scrolled-past content just shows
//   - live lists: only never-seen items enter (keys), at most 24 at a time,
//     skeletons/unkeyed rows and data-animate-ignore items never
//   - focus finishes an entrance at once; sideways travel never crosses the
//     viewport edge
//   - wiring: every public page loads the same pinned files; admin pages and
//     maps, drawers and elements with their own entrance are never opted in
// Run: node tests/animated-content.test.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { makeCheck } from './helpers/env.mjs';

const t = makeCheck();
const { check } = t;
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(`${ROOT}${f}`, 'utf8');
const SRC = read('public/js/animated-content.js');
const CSS = read('public/css/style.css');
const tick = () => new Promise(r => setTimeout(r, 0));

// A page with the module, a stub GSAP/ScrollTrigger that records calls, and
// a fake layout (jsdom has none): every element not inside .hidden has a box,
// stacked 100px apart in document order.
function open(body, { gsap = true, reduce = false, motionOk = true, compact = false, width = 1440, scrolled = 0 } = {}) {
  const dom = new JSDOM(`<!doctype html><html${motionOk ? ' class="motion-ok"' : ''}><body>${body}</body></html>`, { runScripts: 'outside-only', url: 'https://cybercabhunter.com/', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.matchMedia = q => ({ matches: (q.includes('reduce') && reduce) || (q.includes('max-width: 639px') && compact), addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(d.documentElement, 'clientWidth', { configurable: true, get: () => width });
  const order = el => [...d.querySelectorAll('*')].indexOf(el);
  w.Element.prototype.getClientRects = function () { return this.closest('.hidden') ? [] : [{}]; };
  w.Element.prototype.getBoundingClientRect = function () { const top = order(this) * 100 - scrolled; return { top, bottom: top + 80, left: this.dataset.left ? +this.dataset.left : 24, right: this.dataset.right ? +this.dataset.right : width - 24, width: 100, height: 80 }; };
  const rec = { sets: [], tos: [], creates: [], kills: 0 };
  const props = new Map();
  if (gsap) {
    w.gsap = {
      registerPlugin() {},
      set(el, v) { rec.sets.push([el, v]); if (v.clearProps) { el.removeAttribute('style'); props.delete(el); } else { props.set(el, { ...(props.get(el) || {}), ...v }); el.style.opacity = String(v.opacity ?? el.style.opacity); } },
      to(el, v) { const tw = { el, v, killed: false, kill() { this.killed = true; }, done() { v.onComplete && v.onComplete(); } }; rec.tos.push(tw); return tw; },
      getProperty(el, p) { return (props.get(el) || {})[p] || 0; },
    };
    w.ScrollTrigger = {
      create(v) { const tr = { v, killed: false, kill() { if (!this.killed) { this.killed = true; rec.kills++; } } }; rec.creates.push(tr); return tr; },
      maxScroll: () => 5000, refresh() {}, getAll: () => rec.creates.filter(c => !c.killed),
    };
  }
  const sizeCbs = [];
  w.ResizeObserver = class { constructor(cb) { this.cb = cb; sizeCbs.push(this); this.els = new Set(); } observe(el) { this.els.add(el); } unobserve(el) { this.els.delete(el); } disconnect() {} };
  const resize = () => sizeCbs.forEach(o => o.cb([...o.els].map(target => ({ target }))));
  w.requestAnimationFrame = fn => setTimeout(() => fn(0), 0);
  w.eval(SRC);
  const enterAll = () => rec.creates.filter(c => !c.killed).forEach(c => c.v.onEnter());
  return { w, d, A: w.CCCAnimate, rec, resize, enterAll };
}

async function run() {
  console.log('1. Nothing is ever left hidden');
  for (const [label, opts] of [['no GSAP (failed to load)', { gsap: false }], ['Reduce Motion', { reduce: true }], ['motion not allowed by theme.js', { motionOk: false }]]) {
    const { d, rec } = open('<h1 data-animate="fade-up">A</h1><div data-animate-stagger="fade-up"><p>1</p><p>2</p></div>', opts);
    await tick();
    check(`${label}: html.ac-off, every element done, nothing armed or styled`, d.documentElement.classList.contains('ac-off') && d.querySelectorAll('.ac-done').length === 3 && !d.querySelector('.ac-armed') && !d.querySelector('[style]') && rec.creates.length === 0);
  }
  check('CSS hides opted-in content only under motion-ok, never with ac-off, done or armed', /\.motion-ok:not\(\.ac-off\) \[data-animate\]:not\(\.ac-done\):not\(\.ac-armed\)/.test(CSS) && /\[data-animate-stagger\]>:not\(\.ac-done\):not\(\.ac-armed\)/.test(CSS));
  check('a 2.5s CSS failsafe shows it if the script never runs', /animation:ac-failsafe 0s linear 2\.5s forwards/.test(CSS) && /@keyframes ac-failsafe\{ to\{ opacity:1; \} \}/.test(CSS));
  check('opacity, never visibility (screen readers keep the content)', !/visibility|autoAlpha/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('CSS transitions are off only while an element is held', /\.ac-armed\{transition:none !important;\}/.test(CSS));
  check('theme.js only sets motion-ok without Reduce Motion', /if \(!\(window\.matchMedia && window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\)\) root\.classList\.add\('motion-ok'\)/.test(read('public/js/theme.js')));

  console.log('2. Presets and props');
  {
    const { d, A } = open('<div id="a" data-animate="fade-up"></div><div id="b" data-animate="fade-right" data-animate-distance="30" data-animate-duration="0.6" data-animate-delay="0.2"></div><div id="c" data-animate="blur"></div><div id="e" data-animate="tilt"></div><div id="f" data-animate="wipe"></div><div id="g" data-animate="scale"></div>');
    const v = id => A.varsFor(d.getElementById(id), d.getElementById(id).dataset.animate);
    check('defaults: 40px up, 0.8s, power3.out, from opacity 0, threshold 0.1', v('a').start.y === 40 && v('a').start.opacity === 0 && v('a').end.duration === 0.8 && v('a').end.ease === 'power3.out' && v('a').threshold === 0.1);
    check('fade-right: from the left (as far as the 24px gutter allows), its own duration and delay', v('b').start.x === -23 && v('b').end.duration === 0.6 && v('b').delay === 0.2);
    check('blur: up to 4px, back to 0', v('c').start.filter === 'blur(4px)' && v('c').end.filter === 'blur(0px)');
    check('tilt: a 3D tilt with perspective', v('e').start.rotateX === 10 && v('e').start.transformPerspective === 900);
    check('wipe: a clip-path reveal', v('f').start.clipPath === 'inset(0% 100% 0% 0%)' && v('f').end.clipPath === 'inset(0% 0% 0% 0%)');
    check('scale: from 0.96', v('g').start.scale === 0.96);
    check('the end state is always the element\'s own (no leftover offset)', v('a').end.x === 0 && v('a').end.y === 0 && v('a').end.scale === 1 && v('a').end.opacity === 1);
  }
  {
    const { d, A } = open('<div id="a" data-animate="fade-up"></div><div id="c" data-animate="blur"></div><div id="e" data-animate="tilt"></div>', { compact: true });
    const v = id => A.varsFor(d.getElementById(id), d.getElementById(id).dataset.animate);
    check('phones: 60% of the travel, 85% of the duration', v('a').start.y === 24 && Math.abs(v('a').end.duration - 0.68) < 1e-9);
    check('phones: no blur, no 3D tilt', !v('c').start.filter && !v('e').start.rotateX);
  }
  {
    const { d, A } = open('<div id="l" data-animate="fade-left" data-animate-distance="40" data-right="1420"></div><div id="r" data-animate="fade-right" data-animate-distance="40" data-left="10"></div>', { width: 1440 });
    check('sideways travel never crosses the viewport edge', A.varsFor(d.getElementById('l'), 'fade-left').start.x === 19 && A.varsFor(d.getElementById('r'), 'fade-right').start.x === -9);
  }

  console.log('3. Triggers, batches, cleanup');
  {
    const { d, w, rec, enterAll } = open('<h1 id="h" data-animate="fade-up">T</h1><p id="p" data-animate="fade-up" data-animate-delay="0.1">P</p><ul data-animate-stagger="fade-up" data-animate-each="0.05"><li>1</li><li>2</li><li>3</li></ul>');
    await tick();
    check('every opted-in element is held in its start state', d.querySelectorAll('.ac-armed').length === 5 && rec.sets.filter(s => s[1].opacity === 0).length === 5);
    check('one one-shot ScrollTrigger per element', rec.creates.length === 5 && rec.creates.every(c => c.v.once === true && typeof c.v.start === 'function'));
    const top = d.getElementById('h').getBoundingClientRect().top;
    check('its line is the element\'s top at 90% of the viewport, never past the page end', rec.creates[0].v.start() === Math.min(top - w.innerHeight * 0.9, 4998));
    [...rec.creates].reverse().forEach(c => c.v.onEnter());   // enter out of order
    await tick(); await tick();
    const delays = rec.tos.map(tw => [tw.el.id || tw.el.textContent, +tw.v.delay.toFixed(3)]);
    check('a batch plays in document order, ~60ms apart (group items by their own step)', JSON.stringify(delays.map(x => x[0])) === '["h","p","1","2","3"]' && delays[0][1] === 0 && delays[1][1] === 0.16 && delays[3][1] === 0.15);
    rec.tos.forEach(tw => tw.done());
    check('finished: done, inline styles cleared, triggers killed', d.querySelectorAll('.ac-done').length === 5 && !d.querySelector('.ac-armed') && !d.querySelector('[style]') && rec.kills === 5);
    enterAll(); await tick(); await tick();
    check('nothing replays', rec.tos.length === 5);
  }
  {
    const { d, rec } = open('<div style="height:1px"></div><p id="past" data-animate="fade-up">x</p><p id="next" data-animate="fade-up">y</p>', { scrolled: 2000 });
    await tick();
    check('content already scrolled past just shows (no entrance, no trigger)', d.getElementById('past').classList.contains('ac-done') && !d.getElementById('past').getAttribute('style') && rec.creates.length === 0);
  }
  {
    const { d, rec, resize } = open('<div id="panel" class="hidden" data-animate="scale">Empty</div><p data-animate="fade-up">v</p>');
    await tick();
    check('a hidden panel waits (held, no trigger yet)', d.getElementById('panel').classList.contains('ac-armed') && rec.creates.length === 1);
    d.getElementById('panel').classList.remove('hidden'); resize();
    check('it gets its trigger the first time it has a size', rec.creates.length === 2 && rec.creates[1].v.trigger === d.getElementById('panel'));
  }

  console.log('4. Live lists');
  {
    const { d, w, rec } = open('<ul id="list" data-animate-live="fade-up" data-animate-ignore=".is-new"><li data-skel="1">loading</li></ul>');
    await tick();
    const list = d.getElementById('list');
    const add = (ids, cls = '') => { ids.forEach(id => { const li = d.createElement('li'); if (id) li.dataset.post = id; if (cls) li.className = cls; li.textContent = id || 'row'; list.appendChild(li); }); };
    list.textContent = ''; add(['a', 'b', 'c']); await tick();
    check('first items enter', ['a', 'b', 'c'].every(id => list.querySelector(`[data-post="${id}"]`).classList.contains('ac-armed')) && rec.creates.length === 3);
    list.textContent = ''; add(['a', 'b', 'c', 'd']); await tick();
    check('a refresh that redraws them: only the new one enters', list.querySelectorAll('.ac-armed').length === 1 && list.querySelector('[data-post="d"]').classList.contains('ac-armed'));
    add([null]); add(['x'], 'is-new'); await tick();
    check('unkeyed rows (skeletons) and items with their own entrance never do', !list.lastElementChild.classList.contains('ac-armed') && !list.lastElementChild.previousElementSibling.classList.contains('ac-armed'));
    add(Array.from({ length: 40 }, (_, i) => 'n' + i)); await tick();
    check('at most 24 items from one insertion', list.querySelectorAll('.ac-armed').length === 1 + 24);
  }
  {
    const { d, A, rec } = open('<dl id="f"></dl>');
    const dl = d.getElementById('f');
    for (let i = 0; i < 4; i++) dl.appendChild(d.createElement('div'));
    A.enter(dl.children, 'fade-up');
    check('enter() before the system is ready does nothing (no hide-then-show flash)', !d.querySelector('.ac-armed'));
    await tick();
    A.enter(dl.children, 'fade-up', { distance: 16, each: 0.07 });
    check('enter(): the first figures enter as a group, 16px', d.querySelectorAll('.ac-armed').length === 4 && rec.sets[0][1].y === 16);
  }
  {
    const daily = read('public/js/daily.js');
    check('Cybercab Daily calls enter() on its first figures only', /if \(!entered\) \{ entered = true; [^\n]*CCCAnimate\.enter\(figures\.children, 'fade-up', \{ distance: 16, each: 0\.07 \}\)/.test(daily) && (daily.match(/CCCAnimate\.enter/g) || []).length === 1);
  }

  console.log('5. Focus');
  {
    const { d, w } = open('<form data-animate="fade-up"><input id="q"></form>');
    await tick();
    d.getElementById('q').focus();
    const form = d.querySelector('form');
    check('focusing inside an entering element finishes it at once', form.classList.contains('ac-done') && !form.classList.contains('ac-armed') && !form.getAttribute('style'));
  }

  console.log('6. Wiring');
  const pages = fs.readdirSync(`${ROOT}public`).filter(f => f.endsWith('.html'));
  const admin = ['moderation.html'];
  const TAGS = '<script src="/vendor/gsap-3.13.0.min.js" defer></script>\n<script src="/vendor/ScrollTrigger-3.13.0.min.js" defer></script>\n<script src="js/animated-content.js?v=1" defer></script>\n</body>';
  check('every public page loads the same local GSAP, ScrollTrigger and module, deferred, once', pages.filter(f => !admin.includes(f)).every(f => read(`public/${f}`).includes(TAGS) && (read(`public/${f}`).match(/gsap-3\.13\.0/g) || []).length === 1));
  check('admin tools are left alone', !/animated-content|gsap/.test(read('public/moderation.html')) && !/animated-content|gsap/.test(read('public/moderation/import-receipt.html')));
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(`${ROOT}public/vendor/${f}`)).digest('hex');
  check('the vendored files are GSAP 3.13.0 exactly as published on npm', sha('gsap-3.13.0.min.js') === '96c01b81f44a3290e2b4532f55e2c9534b2adc43273a19f3756b2cb41f0fd0b6' && sha('ScrollTrigger-3.13.0.min.js') === '308219390e5e3b84cda0c481e70caa9820883ae10bda44e6e9a149a81aac4b3f');
  const all = pages.map(f => read(`public/${f}`)).join('\n');
  const tagsWith = re => (all.match(/<[a-z]+\b[^>]*>/g) || []).filter(tag => /data-animate/.test(tag) && re.test(tag));
  check('never on a map, the Zones drawer panel or a replay panel', tagsWith(/id="(infraMap|replayMap|zoneMap-[a-z]+|zonePanel|replayPanel)"|maplibregl|map-drawer"/).length === 0);
  check('never on elements with their own entrance (SplitText, BlurText, news cards)', tagsWith(/data-split|blur-word|news-card/).length === 0);
  check('never on a sticky element (the hero, the news filter bar)', tagsWith(/id="hero"|id="heroPin"|news-subbar|sticky/).length === 0);
  check('public pages no longer use the old reveal-on-scroll', pages.filter(f => !admin.includes(f)).every(f => !/reveal-on-scroll/.test(read(`public/${f}`))));
  check('every page that opts in loads the module', pages.every(f => !/data-animate/.test(read(`public/${f}`)) || /animated-content\.js/.test(read(`public/${f}`))));
  check('one GSAP setup, no requests, polling or timers beyond a debounce', (SRC.match(/registerPlugin/g) || []).length === 1 && !/fetch\(|XMLHttpRequest|setInterval/.test(SRC));

  t.finish();
}
run().catch(e => { console.error(e); process.exit(1); });
