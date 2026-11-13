/* AnimatedContent, sitewide: the React Bits AnimatedContent component
   (reactbits.dev, JS + CSS variant, GSAP + ScrollTrigger) rebuilt for this
   plain-HTML site as one shared, declarative system. Every page loads the same
   local GSAP 3.13.0 and ScrollTrigger (/vendor) and this file; markup opts in.

   AnimatedContent's props map to data attributes (defaults in DEFAULTS):
     distance, direction + reverse   data-animate preset (fade-up/-down/-left/-right)
     duration, ease, delay           data-animate-duration / -ease / -delay (seconds)
     initialOpacity, animateOpacity  data-animate-opacity (start opacity; 1 = no fade)
     scale                           data-animate-scale (start scale)
     threshold                       data-animate-threshold (share of the viewport:
                                     0.1 plays when the top reaches 90% down)
     once (no replay on scroll back) always: an entrance plays once
   Additions in the same spirit: blur, wipe, tilt presets and group stagger.

   Markup:
     data-animate="fade-up|fade-down|fade-left|fade-right|scale|blur|wipe|tilt"
       one element. fade-left moves left into place (starts to the right).
     data-animate-stagger="<preset>"
       a group: each element child enters in turn (data-animate-each, s).
     data-animate-live="<preset>"
       a list the page's own script fills: only items it has never shown
       before enter (keyed by data-animate-key="<attr>", else data-post /
       data-id / id / the first link); a refresh that redraws the same items,
       skeletons and unkeyed rows appear at once. data-animate-ignore="<css>":
       items that bring their own entrance (e.g. a just-published post).
     data-animate-scroller on an ancestor: that element is the scroll container.

   Behaviour:
     - Elements entering in the same frame form one batch, played in document
       order ~60ms apart (heading, then text, then cards): the page entrance.
     - Hidden elements (a state panel, a tab) wait, and enter the first time
       they get a size. Already-scrolled-past content is shown at once.
     - Phones: shorter travel and duration; no blur or 3D tilt.
     - Reduce Motion, no GSAP, or a script error: nothing is hidden (CSS only
       hides [data-animate] under html.motion-ok, set by js/theme.js, with a
       2.5s CSS failsafe; no JavaScript: nothing is hidden).
     - Opacity, never visibility: content stays in the accessibility tree;
       focusing anything inside an entering element finishes it at once.
     - Each trigger is one-shot and killed when it fires; finished elements
       get their inline styles cleared, so no transform lingers (fixed and
       sticky children, map pointer maths).
   Never put data-animate on a MapLibre map element or its canvas, on an
   ancestor of a position:fixed/sticky element, or on an element that has its
   own entrance (SplitText h2[data-split], BlurText, AnimatedList). */
window.CCCAnimate = (function () {
  'use strict';
  const DEFAULTS = { distance: 40, duration: 0.8, ease: 'power3.out', delay: 0, opacity: 0, scale: 1, blur: 0, threshold: 0.1, each: 0.07 };
  const STEP = 0.06, MAX_STEP = 8;            // batch sequencing
  const LIVE_CAP = 24;                        // most items one insertion animates
  const PRESETS = {
    'fade-up': { y: 1 },
    'fade-down': { y: -1 },
    'fade-left': { x: 1 },
    'fade-right': { x: -1 },
    'scale': { y: 0.4, scale: 0.96 },
    'blur': { y: 0.5, blur: 4 },
    'wipe': { y: 0.3, wipe: true },
    'tilt': { y: 0.8, rotateX: 10 },
  };
  const DONE = 'ac-done', ARMED = 'ac-armed';
  const root = document.documentElement;
  const state = new WeakMap();                // el -> { vars, tween, trigger, step }
  let gsap = null, ST = null, ready = false, bootAt = 0;
  let sizeWatch = null;                       // ResizeObserver: hidden elements waiting for a size
  const waiting = new Set();

  const mm = q => { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; } };
  const reducedMotion = () => mm('(prefers-reduced-motion: reduce)');
  const compact = () => mm('(max-width: 639px)');
  const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

  // The animation an element (or a group's child) gets, from its preset and data attributes.
  function varsFor(el, preset, from) {
    const src = from || el;
    const p = PRESETS[preset] || PRESETS['fade-up'];
    const small = compact();
    const o = {
      distance: num(src.dataset.animateDistance, DEFAULTS.distance),
      duration: num(src.dataset.animateDuration, DEFAULTS.duration),
      ease: src.dataset.animateEase || DEFAULTS.ease,
      delay: num(el.dataset.animateDelay, from ? 0 : DEFAULTS.delay),
      opacity: num(src.dataset.animateOpacity, DEFAULTS.opacity),
      scale: num(src.dataset.animateScale, p.scale || DEFAULTS.scale),
      blur: num(src.dataset.animateBlur, p.blur || DEFAULTS.blur),
      threshold: num(src.dataset.animateThreshold, DEFAULTS.threshold),
    };
    if (small) { o.distance *= 0.6; o.duration *= 0.85; o.blur = 0; }
    const start = { opacity: o.opacity };
    const end = { opacity: 1, x: 0, y: 0, scale: 1, rotateX: 0, duration: o.duration, ease: o.ease };
    if (p.x) start.x = sideways(el, p.x, o.distance);
    if (p.y) start.y = p.y * o.distance;
    if (o.scale !== 1) start.scale = o.scale;
    if (o.blur > 0) { start.filter = `blur(${o.blur}px)`; end.filter = 'blur(0px)'; }
    if (p.wipe) { start.clipPath = 'inset(0% 100% 0% 0%)'; end.clipPath = 'inset(0% 0% 0% 0%)'; }
    if (p.rotateX && !small) { start.rotateX = p.rotateX; start.transformPerspective = 900; start.transformOrigin = '50% 100%'; }
    return { start, end, delay: o.delay, threshold: o.threshold };
  }

  // Sideways travel never crosses the viewport edge (no horizontal scroll):
  // at most the room the element has on the side it starts from. (Measured
  // without any start offset already applied.)
  function sideways(el, dir, distance) {
    if (!el.getClientRects().length) return dir * distance;
    const r = el.getBoundingClientRect(), shift = gsap ? +gsap.getProperty(el, 'x') || 0 : 0;
    const left = r.left - shift, right = r.right - shift;
    return dir * Math.max(0, Math.min(distance, dir > 0 ? document.documentElement.clientWidth - right - 1 : left - 1));
  }

  function scrollerFor(el) { const s = el.parentElement && el.parentElement.closest('[data-animate-scroller]'); return s || undefined; }
  const hasSize = el => el.getClientRects().length > 0;

  function finish(el, instant) {
    const s = state.get(el);
    if (s && s.tween) s.tween.kill();
    if (gsap) gsap.set(el, { clearProps: 'opacity,transform,filter,clipPath' });
    el.classList.remove(ARMED);
    el.classList.add(DONE);
    if (s && s.trigger) { s.trigger.kill(); s.trigger = null; }
    if (instant) state.delete(el);
  }

  function play(el, delay) {
    const s = state.get(el);
    if (!s || s.tween || !el.classList.contains(ARMED)) return;
    s.tween = gsap.to(el, { ...s.vars.end, delay: delay + s.vars.delay, onComplete: () => finish(el) });
  }

  // Hold an element in its start state and wait for it to enter.
  function arm(el, vars) {
    if (state.has(el) || el.classList.contains(DONE)) return false;
    state.set(el, { vars });
    gsap.set(el, vars.start);
    el.classList.add(ARMED);
    return true;
  }

  // Give each element in view-able state its one-shot trigger (hidden ones
  // wait for a size; content already scrolled past just shows).
  function watch(els) {
    const groups = new Map();
    for (const el of els) {
      const s = state.get(el);
      if (!s) continue;
      if (!hasSize(el)) { waitForSize(el); continue; }
      if (s.vars.start.x) { const x = sideways(el, Math.sign(s.vars.start.x), Math.abs(s.vars.start.x)); s.vars.start.x = x; gsap.set(el, { x }); }
      // Already scrolled past (back navigation, an anchor link): no entrance.
      const r = el.getBoundingClientRect();
      if (r.bottom < 0) { finish(el, true); continue; }
      const sc = scrollerFor(el);
      const key = s.vars.threshold + '|' + (sc ? 'custom' : 'page');
      if (!groups.has(key)) groups.set(key, { sc, threshold: s.vars.threshold, els: [] });
      groups.get(key).els.push(el);
    }
    for (const g of groups.values()) {
      for (const el of g.els) {
        // One-shot trigger per element. Its line: the element's top at
        // (1 - threshold) of the viewport, but never past the page's end, so
        // content near the bottom still plays (recomputed on every refresh).
        const t = ST.create({ trigger: el, scroller: g.sc, once: true, onEnter: () => queue(el),
          start: () => startFor(el, g.sc, g.threshold) });
        state.get(el).trigger = t;
      }
    }
  }

  function startFor(el, sc, threshold) {
    const view = sc ? sc.clientHeight : innerHeight;
    const scrolled = sc ? sc.scrollTop : (scrollY || document.documentElement.scrollTop);
    const top = el.getBoundingClientRect().top - (sc ? sc.getBoundingClientRect().top : 0) + scrolled;
    return Math.min(top - view * (1 - threshold), ST.maxScroll(sc || window) - 2);
  }

  // Elements entering in the same frame play together, in document order,
  // STEP apart (the page entrance: heading, then text, then cards).
  let pending = [], flushing = 0;
  function queue(el) {
    pending.push(el);
    if (!flushing) flushing = requestAnimationFrame(() => {
      flushing = 0;
      const batch = pending.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      pending = [];
      batch.forEach((el, i) => play(el, Math.min(i, MAX_STEP) * (state.get(el)?.step ?? STEP)));
    });
  }

  function waitForSize(el) {
    if (!sizeWatch) { finish(el, true); return; }
    waiting.add(el);
    sizeWatch.observe(el);
  }

  // Static markup: single elements and groups.
  function scan(scope) {
    const found = [];
    scope.querySelectorAll('[data-animate]').forEach(el => {
      if (arm(el, varsFor(el, el.dataset.animate))) found.push(el);
    });
    scope.querySelectorAll('[data-animate-stagger]').forEach(group => {
      const preset = group.dataset.animateStagger;
      const each = num(group.dataset.animateEach, DEFAULTS.each);
      for (const child of group.children) {
        if (child.hasAttribute('data-animate') || child.tagName === 'TEMPLATE' || child.tagName === 'SCRIPT') continue;
        if (arm(child, varsFor(child, preset, group))) { state.get(child).step = each; found.push(child); }
      }
    });
    return found;
  }

  // Lists filled by the page's own scripts.
  function keyOf(el, attr) {
    if (attr) return el.getAttribute(attr);
    const a = el.getAttribute('data-post') || el.getAttribute('data-id') || el.id;
    if (a) return a;
    const link = el.matches('a[href]') ? el : el.querySelector('a[href]');
    return link ? link.getAttribute('href') : null;
  }
  function live(list) {
    const preset = list.dataset.animateLive;
    const attr = list.dataset.animateKey || null;
    const each = num(list.dataset.animateEach, DEFAULTS.each);
    const ignore = list.dataset.animateIgnore || null;   // items with their own entrance
    const seen = new Set();
    for (const c of list.children) { const k = keyOf(c, attr); if (k) seen.add(k); }
    new MutationObserver(records => {
      const fresh = [];
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        const k = keyOf(n, attr);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        if (ignore && n.matches(ignore)) continue;
        if (fresh.length < LIVE_CAP && n.isConnected) fresh.push(n);
      }
      if (!fresh.length || !ready) return;
      const armed = fresh.filter(n => arm(n, varsFor(n, preset, list)) && (state.get(n).step = each, true));
      if (armed.length) watch(armed);
    }).observe(list, { childList: true });
  }

  function showAll() {
    root.classList.add('ac-off');
    document.querySelectorAll('[data-animate],[data-animate-stagger]>*,.' + ARMED).forEach(el => {
      if (el.classList.contains(ARMED) && gsap) { const s = state.get(el); if (s && s.tween) s.tween.kill(); gsap.set(el, { clearProps: 'opacity,transform,filter,clipPath' }); }
      el.classList.remove(ARMED); el.classList.add(DONE);
    });
  }

  function init() {
    if (ready) return;
    bootAt = performance.now();
    gsap = window.gsap; ST = window.ScrollTrigger;
    if (!gsap || !ST || reducedMotion() || !root.classList.contains('motion-ok')) { showAll(); return; }
    try {
      gsap.registerPlugin(ST);
      if (typeof ResizeObserver === 'function') {
        sizeWatch = new ResizeObserver(entries => {
          const now = [];
          for (const e of entries) if (waiting.has(e.target) && hasSize(e.target)) { waiting.delete(e.target); sizeWatch.unobserve(e.target); now.push(e.target); }
          if (now.length) watch(now);
        });
      }
      const els = scan(document);
      // A very slow start: the CSS failsafe has already shown the first
      // screen; don't hide it again.
      if (bootAt > 2300) for (const el of els) { const r = el.getBoundingClientRect(); if (r.top < innerHeight) finish(el, true); }
      ready = true;
      watch(els.filter(el => state.has(el)));
      document.querySelectorAll('[data-animate-live]').forEach(live);
      // Focus never lands on something invisible.
      document.addEventListener('focusin', e => { let el = e.target.closest && e.target.closest('.' + ARMED); while (el) { finish(el); el = el.parentElement && el.parentElement.closest('.' + ARMED); } });
      // Content loaded later moves things down: re-measure, debounced.
      let t = 0, lastH = document.documentElement.scrollHeight;
      const remeasure = () => { clearTimeout(t); t = setTimeout(() => { const h = document.documentElement.scrollHeight; if (Math.abs(h - lastH) > 40) { lastH = h; ST.refresh(); } }, 200); };
      if (typeof ResizeObserver === 'function') new ResizeObserver(remeasure).observe(document.body);
    } catch (e) {
      showAll();
    }
  }

  // Elements added later outside a live list (rare): opt them in by hand.
  function refresh(scope) { if (!ready) return; watch(scan(scope || document)); }

  // Imperative: nodes a script has just rendered for the first time enter as
  // a group (e.g. Cybercab Daily's four figures on the first data). Before
  // init, or without motion, it does nothing: they are already visible, and
  // hiding them again would flash.
  function enter(nodes, preset = 'fade-up', opts = {}) {
    const list = Array.from(nodes || []).filter(n => n && n.nodeType === 1).slice(0, LIVE_CAP);
    if (!list.length) return;
    if (!ready) return;
    const each = num(opts.each, DEFAULTS.each);
    const src = { dataset: { animateDistance: opts.distance, animateDuration: opts.duration } };
    const armed = list.filter(n => arm(n, varsFor(n, preset, src)) && (state.get(n).step = each, true));
    if (armed.length) watch(armed);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
  return { init, refresh, enter, varsFor, PRESETS, DEFAULTS, _state: state };
})();
