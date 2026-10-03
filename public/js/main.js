/* Cybercab Hunter — shared runtime: seed data, storage, nav, Tesla-link,
   scroll reveal, counters, confetti, toasts. Loaded after js/calc.js on
   every page; each page's own inline <script> calls CCC.init() first. */

const CCC = (() => {
  const NS = 'cybercabCentral.';

  /* ---------------- Seed data ---------------- */
  const data = {
    cybercabs: [
      { id: 'CC-0412', lat: 30.2672, lng: -97.7431, battery: 82, status: 'Unsupervised', lastSeen: '2m ago' },
      { id: 'CC-0388', lat: 30.2849, lng: -97.7341, battery: 61, status: 'Unsupervised', lastSeen: '4m ago' },
      { id: 'CC-0455', lat: 30.2489, lng: -97.7622, battery: 94, status: 'Unsupervised', lastSeen: '6m ago' },
      { id: 'CC-0201', lat: 30.2711, lng: -97.7091, battery: 47, status: 'Charging', lastSeen: '1m ago' },
      { id: 'CC-0509', lat: 30.3005, lng: -97.7550, battery: 73, status: 'Unsupervised', lastSeen: '9m ago' }
    ],
    modelYs: [
      { id: 'MY-1187', lat: 32.7831, lng: -96.7994, battery: 58, status: 'Employee Test', lastSeen: '3m ago' },
      { id: 'MY-1042', lat: 32.7963, lng: -96.7691, battery: 88, status: 'Employee Test', lastSeen: '5m ago' },
      { id: 'MY-1299', lat: 30.2601, lng: -97.7519, battery: 65, status: 'Unsupervised', lastSeen: '2m ago' }
    ],
    deadZones: [
      { lat: 30.2950, lng: -97.7150, radius: 900, label: 'East Austin high-demand gap' },
      { lat: 32.8100, lng: -96.7500, radius: 800, label: 'North Dallas gap' }
    ],
    sightings: [
      { id: 's1', vehicle: 'CC-0412', loc: 'S Congress Ave, Austin, TX', time: 'Just now', type: 'Unsupervised', verified: true },
      { id: 's2', vehicle: 'MY-1187', loc: 'Uptown, Dallas, TX', time: '2m ago', type: 'Employee Test', verified: true },
      { id: 's3', vehicle: 'CC-0455', loc: 'Rainey St, Austin, TX', time: '5m ago', type: 'Unsupervised', verified: true },
      { id: 's4', vehicle: 'MY-1042', loc: 'Deep Ellum, Dallas, TX', time: '12m ago', type: 'Employee Test', verified: false }
    ],
    bounties: [
      { id: 'b1', title: 'First sighting in Zilker', reward: 250, progress: 3, goal: 5 },
      { id: 'b2', title: 'Night-time unsupervised clip', reward: 400, progress: 1, goal: 3 },
      { id: 'b3', title: 'Inductive pad in-use photo', reward: 150, progress: 4, goal: 4 }
    ]
  };

  /* ---------------- Storage ---------------- */
  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(NS + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) {}
    }
  };

  function merge(seedArray, storageKey) {
    return seedArray.concat(storage.get(storageKey, []));
  }

  /* ---------------- Nav ---------------- */
  function initNav() {
    const links = document.querySelectorAll('[data-nav]');
    const indicator = document.getElementById('navIndicator');
    let path = location.pathname.split('/').pop() || 'index.html';
    path = path.replace('.html', '') || 'index';

    // The mobile bottom nav (#mobileBottomNav) duplicates these same
    // [data-nav] links so both copies highlight together, but only the copy
    // inside the desktop <nav> (indicator's own parent) can host the sliding
    // gold indicator — the bottom nav's copy is a different element entirely
    // and has no indicator of its own.
    let activeLink = null;
    links.forEach(link => {
      if (link.dataset.nav === path) {
        link.classList.add('text-gold');
        link.setAttribute('aria-current', 'page');
        if (indicator && link.parentElement === indicator.parentElement) activeLink = link;
      } else {
        link.classList.remove('text-gold');
        link.removeAttribute('aria-current');
      }
    });

    if (activeLink && indicator) {
      const navRect = indicator.parentElement.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      indicator.style.left = '0px';
      indicator.style.width = linkRect.width + 'px';
      indicator.style.transform = `translateX(${linkRect.left - navRect.left}px)`;
      indicator.classList.add('is-active');
    }
  }

  /* ---------------- Reveal on scroll ---------------- */
  function initReveal() {
    const els = document.querySelectorAll('.reveal-on-scroll');
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          let delay = el.dataset.delay;
          if (delay === undefined) {
            const siblings = el.parentElement
              ? Array.from(el.parentElement.children).filter(c => c.classList.contains('reveal-on-scroll'))
              : [];
            const idx = siblings.indexOf(el);
            delay = idx > 0 ? Math.min(idx, 8) * 70 : 0;
          }
          el.style.transitionDelay = delay + 'ms';
          el.classList.add('is-visible');
          io.unobserve(el);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ---------------- Motion details ----------------
     Six small effects ported from React Bits (reactbits.dev) to plain JS +
     CSS: CountUp, BlurText (CSS only, index.html), ShinyText, AnimatedList,
     Magnet and TiltedCard. Each one renders its final state at once under
     prefers-reduced-motion; Magnet and TiltedCard exist only for a fine
     pointer that can hover; no loop runs while its element is off screen. */
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const finePointer = () => !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  const counters = new WeakMap();   // el -> { raf, io, counted }
  const counterState = el => { let s = counters.get(el); if (!s) counters.set(el, s = {}); return s; };

  /* ---------------- Counter animation ----------------
     A new call on the same element stops the one in flight, so two loops
     never write to one number. */
  function animateCounter(el, from, to, duration = 1200, formatFn) {
    if (!el) return;
    const fmt = formatFn || (v => Math.round(v).toLocaleString());
    const isInput = el.tagName === 'INPUT';
    const set = v => { if (isInput) el.value = v; else el.textContent = v; };
    const state = counterState(el);
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (reducedMotion() || typeof requestAnimationFrame !== 'function') { set(fmt(to)); return; }
    const start = performance.now();
    function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = easeOutExpo(t);
      set(fmt(from + (to - from) * eased));
      if (t < 1) state.raf = requestAnimationFrame(tick);
      else { state.raf = 0; set(fmt(to)); }
    }
    state.raf = requestAnimationFrame(tick);
  }

  /* CountUp: counts from 0 to the REAL value once, the first time the number
     scrolls into view (1.2s, ease-out). Later calls for the same element
     (a refresh, a filter change) write the new value at once. A value that
     isn't a finite number cancels any pending count and returns false: the
     caller shows its own empty state (an em dash), never a counted one. */
  function countUp(el, value, { duration = 1200, format } = {}) {
    if (!el) return false;
    const state = counterState(el);
    if (state.io) { state.io.disconnect(); state.io = null; }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
    if (typeof value !== 'number' || !isFinite(value)) return false;
    const fmt = format || (v => Math.round(v).toLocaleString());
    if (state.counted || reducedMotion() || typeof IntersectionObserver !== 'function' || typeof requestAnimationFrame !== 'function') {
      state.counted = true;
      el.textContent = fmt(value);
      return true;
    }
    state.io = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      state.io.disconnect(); state.io = null;
      state.counted = true;
      animateCounter(el, 0, value, duration, fmt);
    }, { threshold: 0.4 });
    state.io.observe(el);
    return true;
  }

  /* AnimatedList: cards fade and rise in as they enter the viewport, 45ms
     apart within one batch. Only nodes passed here animate, so a caller
     decides which renders get it (the Sightings page: the first load only). */
  let listObserver = null;
  function enterList(nodes) {
    if (!nodes || reducedMotion() || typeof IntersectionObserver !== 'function') return;
    if (!listObserver) {
      listObserver = new IntersectionObserver(entries => {
        let i = 0;
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          listObserver.unobserve(el);
          el.style.setProperty('--enter-delay', Math.min(i++, 8) * 45 + 'ms');
          el.classList.remove('list-pending');
          el.classList.add('list-enter');
          el.addEventListener('animationend', () => { el.classList.remove('list-enter'); el.style.removeProperty('--enter-delay'); }, { once: true });
        });
      }, { threshold: 0.1 });
    }
    Array.from(nodes).forEach(el => { el.classList.add('list-pending'); listObserver.observe(el); });
  }

  /* ShinyText: one light sweep across a gold Replay accent (.shine, CSS
     keyframes on a transform) the first time it comes into view, pointing
     the eye at it once. It never loops. */
  function initShine() {
    const els = document.querySelectorAll('.shine');
    if (!els.length || reducedMotion() || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-shining'); io.unobserve(e.target); } });
    }, { threshold: 0.6 });
    els.forEach(el => io.observe(el));
  }

  /* Magnet: a [data-magnet] button leans up to 6px toward a cursor within
     40px of it. Mouse/trackpad only; one passive pointermove listener,
     coalesced to one read per frame. Uses the CSS `translate` property so
     the button's own hover/press transform is untouched. */
  function initMagnet() {
    const els = Array.from(document.querySelectorAll('[data-magnet]'));
    if (!els.length || !finePointer() || reducedMotion() || typeof requestAnimationFrame !== 'function') return;
    const PAD = 40, MAX = 6;
    let px = 0, py = 0, queued = false;
    function update() {
      queued = false;
      els.forEach(el => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
        const near = Math.abs(dx) < r.width / 2 + PAD && Math.abs(dy) < r.height / 2 + PAD;
        el.classList.toggle('is-pulled', near);
        if (near) {
          const clamp = v => Math.max(-MAX, Math.min(MAX, v / 6));
          el.style.translate = `${clamp(dx).toFixed(1)}px ${clamp(dy).toFixed(1)}px`;
        } else if (el.style.translate) {
          el.style.translate = '';
        }
      });
    }
    document.addEventListener('pointermove', e => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      px = e.clientX; py = e.clientY;
      if (!queued) { queued = true; requestAnimationFrame(update); }
    }, { passive: true });
  }

  /* TiltedCard: a [data-tilt] card tilts toward the pointer (6deg at most)
     with a soft neutral shadow, on a spring (stiffness 100, damping 30, as
     the original). Mouse/trackpad only. The spring loop runs only while a
     card is moving and stops once it settles. */
  function initTilt() {
    if (!finePointer() || reducedMotion() || typeof requestAnimationFrame !== 'function') return;
    const MAX = 6, K = 100, C = 30;
    const springs = new Map();   // card -> { x, y, vx, vy, tx, ty, raf, last }
    function step(card, s, now) {
      const dt = Math.min(0.032, (now - s.last) / 1000 || 0.016);
      s.last = now;
      s.vx += (K * (s.tx - s.x) - C * s.vx) * dt; s.x += s.vx * dt;
      s.vy += (K * (s.ty - s.y) - C * s.vy) * dt; s.y += s.vy * dt;
      const settled = Math.abs(s.tx - s.x) < 0.01 && Math.abs(s.ty - s.y) < 0.01 && Math.abs(s.vx) < 0.01 && Math.abs(s.vy) < 0.01;
      if (settled && !s.tx && !s.ty && !s.active) {
        card.style.transform = ''; card.style.transition = '';
        springs.delete(card);
        return;
      }
      card.style.transform = `perspective(900px) translateY(-2px) rotateX(${s.x.toFixed(2)}deg) rotateY(${s.y.toFixed(2)}deg)`;
      s.raf = settled ? 0 : requestAnimationFrame(t => step(card, s, t));
    }
    function kick(card, s) { if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(t => step(card, s, t)); } }
    function onMove(e) {
      const card = e.currentTarget, s = springs.get(card);
      if (!s) return;
      const r = card.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      s.ty = (fx - 0.5) * 2 * MAX;
      s.tx = -(fy - 0.5) * 2 * MAX;
      // GlareHover: the glare layer (css/style.css) is centered on the pointer.
      card.style.setProperty('--glare-x', (fx * 100).toFixed(1) + '%');
      card.style.setProperty('--glare-y', (fy * 100).toFixed(1) + '%');
      kick(card, s);
    }
    function onLeave(e) {
      const card = e.currentTarget, s = springs.get(card);
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerleave', onLeave);
      card.classList.remove('is-tilting');
      if (!s) return;
      s.active = false; s.tx = 0; s.ty = 0;
      kick(card, s);
    }
    document.addEventListener('pointerover', e => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const card = e.target.closest && e.target.closest('[data-tilt]');
      if (!card || card.classList.contains('is-tilting')) return;
      let s = springs.get(card);
      if (!s) springs.set(card, s = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, last: 0 });
      s.active = true;
      card.style.transition = 'box-shadow var(--t) var(--ease), border-color var(--t) var(--ease)';
      card.classList.add('is-tilting');
      card.addEventListener('pointermove', onMove, { passive: true });
      card.addEventListener('pointerleave', onLeave);
    }, { passive: true });
  }

  /* DecryptedText: a [data-decrypt] eyebrow scrambles through uppercase
     letters and digits, then resolves left to right to its real text, once,
     the first time it scrolls into view (~0.9s; glyphs change every 50ms as
     in the original). While it runs, screen readers get the real text from a
     visually hidden copy and the scrambling copy is aria-hidden; afterwards
     the element holds its original plain text again. Its width is held for
     the run so nothing beside it moves. */
  const DECRYPT_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function decrypt(el) {
    const text = el.textContent;
    const chars = [...text];
    const scrambles = chars.map(c => /[A-Za-z0-9]/.test(c));
    const pick = () => DECRYPT_GLYPHS[Math.floor(Math.random() * DECRYPT_GLYPHS.length)];
    const width = el.getBoundingClientRect().width;
    if (width) { el.style.width = width + 'px'; el.style.whiteSpace = 'nowrap'; }
    const real = document.createElement('span');
    real.className = 'decrypt-sr';
    real.textContent = text;
    const shown = document.createElement('span');
    shown.setAttribute('aria-hidden', 'true');
    el.replaceChildren(real, shown);
    const TOTAL = 900, TICK = 50;
    const start = performance.now();
    let lastTick = -1;
    function frame(now) {
      const t = Math.min(1, (now - start) / TOTAL);
      const tick = Math.floor((now - start) / TICK);
      if (t >= 1) {
        el.textContent = text;
        el.style.width = ''; el.style.whiteSpace = '';
        return;
      }
      if (tick !== lastTick) {
        lastTick = tick;
        const revealed = Math.floor(t * chars.length);
        shown.textContent = chars.map((c, i) => (i < revealed || !scrambles[i] ? c : pick())).join('');
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function initDecrypt() {
    const els = document.querySelectorAll('[data-decrypt]');
    if (!els.length || reducedMotion() || typeof IntersectionObserver !== 'function' || typeof requestAnimationFrame !== 'function') return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        decrypt(e.target);
      });
    }, { threshold: 0.6 });
    els.forEach(el => io.observe(el));
  }

  /* ElasticSlider: a [data-elastic] range input's handle stretches with the
     drag (faster = longer, and further when pulled past either end, with the
     original's sigmoid decay over 50px), then springs back with the
     original's bounce of 0.5 when let go. Visual only: it writes three CSS
     variables the thumb's transform reads, never the input's value, so the
     keyboard and screen-reader behavior is the browser's own. The loop runs
     only while a handle is moving. */
  function initElastic() {
    const els = document.querySelectorAll('input[type="range"][data-elastic]');
    if (!els.length || reducedMotion() || typeof requestAnimationFrame !== 'function') return;
    const MAX_OVERFLOW = 50, K = 300, C = 2 * 0.5 * Math.sqrt(300);   // bounce 0.5 = damping ratio 0.5
    const decay = (v, max) => max * (2 / (1 + Math.exp(-v / max)) - 1);
    els.forEach(input => {
      const s = { stretch: 0, v: 0, target: 0, shift: 0, raf: 0, last: 0, dragging: false, lastVal: 0, lastT: 0 };
      const write = () => {
        const sx = 1 + s.stretch;
        input.style.setProperty('--thumb-sx', sx.toFixed(3));
        input.style.setProperty('--thumb-sy', (1 / Math.sqrt(sx)).toFixed(3));
        input.style.setProperty('--thumb-x', s.shift.toFixed(2) + 'px');
      };
      function step(now) {
        const dt = Math.min(0.032, (now - s.last) / 1000 || 0.016);
        s.last = now;
        if (s.dragging && now - s.lastT > 90) s.target = Math.min(s.target, s.overflowTarget || 0);   // the hand stopped: relax
        s.v += (K * (s.target - s.stretch) - C * s.v) * dt;
        s.stretch += s.v * dt;
        if (!s.dragging) s.shift += (0 - s.shift) * Math.min(1, dt * 14);
        write();
        const still = Math.abs(s.target - s.stretch) < 0.001 && Math.abs(s.v) < 0.001 && Math.abs(s.shift) < 0.05;
        if (still && !s.dragging) {
          input.style.removeProperty('--thumb-sx'); input.style.removeProperty('--thumb-sy'); input.style.removeProperty('--thumb-x');
          s.raf = 0; return;
        }
        s.raf = requestAnimationFrame(step);
      }
      const kick = () => { if (!s.raf) { s.last = performance.now(); s.raf = requestAnimationFrame(step); } };
      function onMove(e) {
        const r = input.getBoundingClientRect();
        const over = e.clientX < r.left ? e.clientX - r.left : e.clientX > r.right ? e.clientX - r.right : 0;
        const pulled = decay(over, MAX_OVERFLOW);
        s.shift = pulled * 0.16;                       // up to 8px past the end
        s.overflowTarget = Math.abs(pulled) / MAX_OVERFLOW * 0.3;
        s.target = Math.max(s.target, s.overflowTarget);
        kick();
      }
      input.addEventListener('input', () => {
        if (!s.dragging) return;
        const now = performance.now(), val = Number(input.value);
        const span = Number(input.max) - Number(input.min) || 1;
        const speed = Math.abs(val - s.lastVal) / span / Math.max(0.008, (now - s.lastT) / 1000);   // track widths per second
        s.lastVal = val; s.lastT = now;
        s.target = Math.max(s.overflowTarget || 0, Math.min(0.3, speed * 0.06));
        kick();
      });
      input.addEventListener('pointerdown', e => {
        s.dragging = true; s.lastVal = Number(input.value); s.lastT = performance.now(); s.overflowTarget = 0;
        window.addEventListener('pointermove', onMove, { passive: true });
        const up = () => {
          s.dragging = false; s.target = 0; s.overflowTarget = 0;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
          kick();
        };
        window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      });
    });
  }

  /* SplitText: an [data-split] h2 section heading's words rise into place
     (fade + 8px, 40ms apart, ~0.5s), once, when the heading enters the view
     (at once if it is already in view). Only text nodes are wrapped, so the
     heading's text and any inner elements are unchanged. Under reduced
     motion, or without IntersectionObserver, headings are simply shown. */
  function initSplit() {
    const heads = document.querySelectorAll('h2[data-split]');
    if (!heads.length) return;
    const still = reducedMotion() || typeof IntersectionObserver !== 'function';
    if (still) { heads.forEach(h => h.classList.add('split-done')); return; }
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        e.target.classList.remove('split-pending');
        e.target.classList.add('split-play');
      });
    }, { threshold: 0.2 });
    heads.forEach(h => {
      let i = 0;
      const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      texts.forEach(node => {
        const parts = node.nodeValue.split(/(\s+)/);
        if (parts.every(p => !p.trim())) return;
        const frag = document.createDocumentFragment();
        parts.forEach(p => {
          if (!p) return;
          if (!p.trim()) { frag.appendChild(document.createTextNode(p)); return; }
          const w = document.createElement('span');
          w.className = 'split-word';
          w.style.setProperty('--i', Math.min(i++, 8));
          w.textContent = p;
          frag.appendChild(w);
        });
        node.parentNode.replaceChild(frag, node);
      });
      h.classList.add('split-done', 'split-pending');
      io.observe(h);
    });
  }

  /* PixelCard: a newly chosen photo's preview starts as large pixel blocks
     and resolves to full sharpness over ~0.8s (canvas over the preview: the
     photo drawn small, then scaled up with smoothing off, in finer steps).
     Visual only: the upload uses the file, never this canvas. The canvas is
     always removed at the end, if the photo changes, if anything fails, and
     in any case after 1.5s, so a preview is never left pixelated. Under
     reduced motion the sharp preview shows at once. */
  let pixelRun = 0;
  async function pixelReveal(img) {
    const run = ++pixelRun;
    const host = img.parentElement;
    if (host) host.querySelectorAll('canvas.pixel-veil').forEach(c => c.remove());
    if (reducedMotion() || !host || typeof requestAnimationFrame !== 'function') return;
    const src = img.src;
    try { if (img.decode) await img.decode(); } catch (e) { return; }
    if (run !== pixelRun || img.src !== src || !img.naturalWidth) return;
    const w = img.clientWidth, h = img.clientHeight;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!w || !h || !ctx) return;
    host.classList.add('pixel-host');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.className = 'pixel-veil';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    Object.assign(canvas.style, { left: img.offsetLeft + 'px', top: img.offsetTop + 'px', width: w + 'px', height: h + 'px' });
    host.appendChild(canvas);
    // Where object-contain actually draws the photo inside the preview box.
    const fit = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * fit, dh = img.naturalHeight * fit, dx = (w - dw) / 2, dy = (h - dh) / 2;
    const small = document.createElement('canvas');
    const sctx = small.getContext('2d');
    const BLOCKS = [28, 20, 14, 10, 7, 5, 3, 2], STEP = 100;   // 8 steps x 100ms = 0.8s
    const finish = () => { canvas.remove(); };
    setTimeout(finish, 1500);   // the backstop: never left pixelated
    const start = performance.now();
    let shown = -1;
    function frame(now) {
      if (run !== pixelRun || img.src !== src || !canvas.isConnected) { finish(); return; }
      const k = Math.floor((now - start) / STEP);
      if (k >= BLOCKS.length) { finish(); return; }
      if (k !== shown) {
        shown = k;
        const b = BLOCKS[k];
        small.width = Math.max(1, Math.round(dw / b)); small.height = Math.max(1, Math.round(dh / b));
        sctx.drawImage(img, 0, 0, small.width, small.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, 0, 0, small.width, small.height, dx, dy, dw, dh);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------------- Confetti ---------------- */
  function spawnConfetti(originEl) {
    const colors = ['#D4AF37', '#F3E5AB', '#B8954A', '#ECEEF1'];   // the one accent, in three tones, plus ink
    const rect = originEl ? originEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < 28; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = originX + 'px';
      piece.style.top = originY + 'px';
      piece.style.background = colors[i % colors.length];
      const dx = (Math.random() - 0.5) * 360;
      const dy = (Math.random() * -260) - 40;
      const rot = (Math.random() - 0.5) * 720;
      piece.style.setProperty('--dx', dx + 'px');
      piece.style.setProperty('--dy', dy + 'px');
      piece.style.setProperty('--rot', rot + 'deg');
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 1700);
    }
  }

  /* ---------------- Toast ---------------- */
  function toast(message, type = 'info') {
    let root = document.getElementById('toastRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toastRoot';
      root.className = 'fixed bottom-24 lg:bottom-6 right-4 left-4 sm:left-auto sm:right-6 z-[200] flex flex-col gap-2 items-stretch sm:items-end';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      document.body.appendChild(root);
    }
    const colors = { success: 'border-gold/60 text-gold', info: 'border-slate-600 text-white', error: 'border-crimson/70 text-red-300' };
    const el = document.createElement('div');
    el.className = 'toast glass px-4 py-3 rounded-xl text-sm font-medium border ' + (colors[type] || colors.info);
    el.textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 350);
    }, 3200);
  }

  /* ---------------- Avatars (the ONE shared avatar component) ----------------
     Every place that shows a rider's picture uses these, so they can't drift:
     the account button, the profile page, the Community board and rider pages.
     A picture uploaded on Profile is "/api/avatars/<key>" (worker/avatars.js)
     and comes in two generated sizes: the 128 px variant for small spots, the
     512 px one for large. A Google photo URL is used as it is. No picture, or
     one that fails to load, falls back to the rider's initials. */
  function avatarSrc(url, size = 128) {
    if (typeof url !== 'string' || !url) return null;
    if (/^\/api\/avatars\/[a-f0-9]{32}$/.test(url)) return `${url}/${size > 128 ? 512 : 128}`;
    return /^https:\/\//.test(url) ? url : null;
  }
  function avatarInitials(name) {
    const words = String(name || '').replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
    return (words.map(w => w[0]).slice(0, 2).join('') || 'CH').toUpperCase();
  }
  // Fills `el` (a sized, rounded box) with the picture or the initials tile.
  function renderAvatar(el, { url, name, size = 128, textClass = 'text-sm' } = {}) {
    if (!el) return;
    const tile = () => {
      el.innerHTML = '';
      const span = document.createElement('span');
      span.className = `w-full h-full flex items-center justify-center font-display font-bold ${textClass} bg-slate-800 text-slate-100`;   // neutral, like a contact card: gold stays for actions
      span.textContent = avatarInitials(name);
      el.appendChild(span);
    };
    const src = avatarSrc(url, size);
    if (!src) { tile(); return; }
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.className = 'w-full h-full object-cover';
    img.addEventListener('error', tile, { once: true });
    el.appendChild(img);
  }

  /* ---------------- Sighting drawer (shared across pages) ----------------
     POST /api/vehicle-sightings/photo (worker/sightings.js): a required photo
     plus the optional sighting fields, as multipart/form-data, authenticated
     with the same bearer session Tesla/Google sign-in and the account menu
     already use (TESLA_SESSION_KEY). Submitting only ever queues a PENDING,
     private sighting for review; nothing about it is public, and no vehicle
     is created or changed by it (that trust boundary lives entirely in the
     backend). The server validates the photo itself; the checks here are
     only for fast, friendly feedback. */
  const SIGHTING_ERROR_MESSAGES = {
    invalid_license_plate: "That doesn't look like a valid license plate.",
    invalid_service_area: 'Choose a city from the list first.',
    location_outside_area: "That location isn't in the city you chose. Pick a location in that city's area.",
    invalid_observed_at: "That doesn't look like a valid date and time.",
    missing_photo: 'Please add a photo of the Cybercab.',
    unsupported_file_type: 'Please choose a JPEG, PNG or WebP photo.',
    invalid_location: 'Choose the location from the suggestions list.',
    invalid_traffic_camera: 'Traffic cameras are in Austin. Choose Austin as the city, or "Not a traffic camera".',
    location_unavailable: "Location search isn't available right now. Try again, or leave Location empty.",
    invalid_form_data: "That sighting couldn't be submitted. Check the fields and try again.",
    invalid_body: "That sighting couldn't be submitted. Check the fields and try again."
  };

  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;       // the server's limit (worker/sightings.js)
  const MAX_PICKED_BYTES = 40 * 1024 * 1024;      // larger picks are shrunk below before upload
  const MAX_PHOTO_EDGE = 2560;

  // Re-encodes the photo as a JPEG no larger than MAX_PHOTO_EDGE on its long
  // edge. This keeps phone photos well under the upload limit, bakes in the
  // camera's rotation, and drops embedded metadata (EXIF, including any GPS
  // position) — nothing about the photo beyond its pixels is needed. Falls
  // back to the original file where the browser can't do this.
  async function preparePhoto(file) {
    try {
      if (!window.createImageBitmap) return file;
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      return blob ? new File([blob], 'sighting.jpg', { type: 'image/jpeg' }) : file;
    } catch (err) {
      return file;
    }
  }

  const SIGN_IN_PAGE = 'signin.html';   // relative on purpose: vehicle.html's <base href="/"> makes it resolve from the site root

  function initSightingDrawer() {
    const drawer = document.getElementById('sightingDrawer');
    const backdrop = document.getElementById('sightingBackdrop');
    const form = document.getElementById('sightingForm');
    const signInRequired = document.getElementById('sightingSignInRequired');
    if (!drawer || !backdrop || !form || !signInRequired) return;

    const openBtns = [document.getElementById('openSightingDrawer'), document.getElementById('heroSightingBtn')].filter(Boolean);
    const closeBtn = document.getElementById('closeSightingDrawer');
    const submitBtn = document.getElementById('sightingSubmitBtn');
    const photoField = document.getElementById('sightingPhoto');
    const photoPreview = document.getElementById('sightingPhotoPreview');
    const photoPrompt = document.getElementById('sightingPhotoPrompt');
    const photoError = document.getElementById('sightingPhotoError');
    const serviceAreaField = document.getElementById('sightingServiceArea');
    const locationField = document.getElementById('sightingLoc');
    const dateField = document.getElementById('sightingDate');
    const notesField = document.getElementById('sightingNotes');
    const plateField = document.getElementById('sightingVehicle');
    const success = document.getElementById('sightingSuccess');
    const locIdField = document.getElementById('sightingLocId');
    const locOptions = document.getElementById('sightingLocOptions');
    const locError = document.getElementById('sightingLocError');
    const cameraField = document.getElementById('sightingCamera');
    let inFlight = false;
    let previewUrl = null;

    // Re-checked every time the drawer opens (not just once at page load) so
    // signing in/out between openings is reflected without a page reload.
    function refreshAuthGate() {
      const signedIn = !!localStorage.getItem(TESLA_SESSION_KEY);
      signInRequired.classList.toggle('hidden', signedIn);
      form.classList.toggle('hidden', !signedIn);
      if (success) success.classList.add('hidden');
      return signedIn;
    }

    function showPhotoError(message) {
      photoError.textContent = message || '';
      photoError.classList.toggle('hidden', !message);
    }

    function clearPhoto() {
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      photoPreview.removeAttribute('src');
      photoPreview.classList.add('hidden');
      photoPrompt.textContent = 'Upload Photo';
    }

    function resetForm() {
      form.reset();
      clearPhoto();
      showPhotoError('');
      if (locIdField) locIdField.value = '';
      showLocError('');
      closeLocOptions();
      syncLocationToCity();
    }

    // ---- City first: the City dropdown is built from the supported service
    // areas (GET /api/service-areas, worker/service-areas.js), and Location
    // stays disabled until a City is chosen. Location suggestions come only
    // from that City's area; changing the City clears the Location.
    const selectedArea = () => {
      const value = serviceAreaField.value;
      if (!value) return null;
      const opt = [...serviceAreaField.options].find(o => o.value === value);
      return { key: (opt && opt.dataset.key) || value.toLowerCase(), name: value };
    };

    function syncLocationToCity() {
      if (!locationField) return;
      const area = selectedArea();
      locationField.disabled = !area;
      locationField.placeholder = area ? `Search an address or place in ${area.name}` : 'Choose a city first';
    }

    let areasLoaded = false;
    async function loadServiceAreas() {
      if (areasLoaded) return;
      try {
        const resp = await fetch(TESLA_WORKER_URL + '/api/service-areas');
        const areas = resp.ok ? ((await resp.json()) || {}).areas : null;
        if (!Array.isArray(areas)) return;
        const current = serviceAreaField.value;
        [...serviceAreaField.options].slice(1).forEach(o => o.remove());   // keep "Choose a city"
        areas.forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.name;
          opt.dataset.key = a.key;
          opt.textContent = a.name;
          serviceAreaField.appendChild(opt);
        });
        if (current) serviceAreaField.value = current;
        areasLoaded = true;
        syncLocationToCity();
      } catch (e) { /* retried the next time the drawer opens */ }
    }

    // ---- Traffic camera (optional): the 50 City of Austin cameras, from the
    // same list the server checks against (public/data/traffic-cameras.json).
    // Left at "Not a traffic camera", nothing about the sighting changes.
    let camerasLoaded = false;
    async function loadTrafficCameras() {
      if (camerasLoaded || !cameraField) return;
      try {
        const resp = await fetch('data/traffic-cameras.json');
        const cameras = resp.ok ? await resp.json() : null;
        if (!Array.isArray(cameras)) return;
        const current = cameraField.value;
        [...cameraField.options].slice(1).forEach(o => o.remove());   // keep "Not a traffic camera"
        cameras.slice().sort((a, b) => a.name.localeCompare(b.name) || a.camera_id.localeCompare(b.camera_id, undefined, { numeric: true })).forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.camera_id;
          opt.textContent = `${c.name} (#${c.camera_id})`;
          cameraField.appendChild(opt);
        });
        if (current) cameraField.value = current;
        camerasLoaded = true;
      } catch (e) { /* retried the next time the drawer opens */ }
    }

    serviceAreaField.addEventListener('change', () => {
      // A picked Location may not be in the new City: start it over.
      locationField.value = '';
      if (locIdField) locIdField.value = '';
      showLocError('');
      closeLocOptions();
      syncLocationToCity();
    });

    // ---- Location: real places only (search + pick from the list) ----
    // Typing searches GET /api/places (worker/places.js); a place counts only
    // once it is picked from the list, which sets sightingLocId. Typing again
    // afterwards un-picks it. The server re-checks the picked place.
    let locResults = [];
    let locQuery = '';        // the search text that produced locResults
    let pickedQuery = '';     // ...and the one the picked place came from (sent so the server can re-run it)
    let locActive = -1;
    let locTimer = null;
    let locSeq = 0;

    function showLocError(message) {
      if (!locError) return;
      locError.textContent = message || '';
      locError.classList.toggle('hidden', !message);
    }

    function closeLocOptions() {
      if (!locOptions) return;
      locOptions.classList.add('hidden');
      locOptions.replaceChildren();
      locationField.setAttribute('aria-expanded', 'false');
      locationField.removeAttribute('aria-activedescendant');
      locResults = [];
      locActive = -1;
    }

    function renderLocOptions(message) {
      locOptions.replaceChildren();
      if (message) {
        const li = document.createElement('li');
        li.className = 'px-3 py-2.5 text-xs text-slate-500';
        li.textContent = message;
        locOptions.appendChild(li);
      }
      locResults.forEach((place, i) => {
        const li = document.createElement('li');
        li.id = `sightingLocOption${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === locActive));
        li.className = 'px-3 py-2.5 text-sm cursor-pointer text-slate-200 hover:bg-white/5' + (i === locActive ? ' bg-white/10' : '');
        li.textContent = place.label;
        // mousedown (not click) so the choice lands before the input blurs.
        li.addEventListener('mousedown', e => { e.preventDefault(); pickPlace(i); });
        locOptions.appendChild(li);
      });
      locOptions.classList.remove('hidden');
      locationField.setAttribute('aria-expanded', 'true');
      if (locActive >= 0) locationField.setAttribute('aria-activedescendant', `sightingLocOption${locActive}`);
      else locationField.removeAttribute('aria-activedescendant');
    }

    function pickPlace(i) {
      const place = locResults[i];
      if (!place) return;
      locationField.value = place.label;
      locIdField.value = place.id;
      pickedQuery = locQuery;
      showLocError('');
      closeLocOptions();
    }

    async function searchPlaces(query) {
      const seq = ++locSeq;
      const area = selectedArea();
      if (!area) return;
      const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
      let places = null;
      try {
        const resp = await fetch(TESLA_WORKER_URL + '/api/places?q=' + encodeURIComponent(query) + '&area=' + encodeURIComponent(area.key), {
          headers: { Authorization: 'Bearer ' + sessionId }
        });
        if (resp.ok) places = ((await resp.json()) || {}).places || [];
      } catch (e) { places = null; }
      if (seq !== locSeq || locationField.value.trim() !== query) return;   // a newer search superseded this one
      locResults = places || [];
      locQuery = query;
      locActive = -1;
      renderLocOptions(places === null ? "Location search isn't available right now." : (locResults.length ? '' : `No matching places in ${area.name}. Try a street or landmark.`));
    }

    if (locationField && locIdField && locOptions) {
      locationField.addEventListener('input', () => {
        locIdField.value = '';          // typed text is never a chosen place
        showLocError('');
        clearTimeout(locTimer);
        const query = locationField.value.trim().replace(/\s+/g, ' ');
        if (query.length < 3) { locSeq++; closeLocOptions(); return; }
        locTimer = setTimeout(() => searchPlaces(query), 250);
      });
      locationField.addEventListener('keydown', e => {
        if (locOptions.classList.contains('hidden') || !locResults.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); locActive = (locActive + 1) % locResults.length; renderLocOptions(''); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); locActive = (locActive - 1 + locResults.length) % locResults.length; renderLocOptions(''); }
        else if (e.key === 'Enter' && locActive >= 0) { e.preventDefault(); pickPlace(locActive); }
        else if (e.key === 'Escape') { closeLocOptions(); }
      });
      locationField.addEventListener('blur', () => setTimeout(closeLocOptions, 150));
    }

    // Signed out: the drawer is never opened. The visitor goes straight to the
    // existing sign-in page (Google), so the submit form is only ever reachable
    // signed in. The in-drawer sign-in prompt above stays as the fallback for a
    // session that turns out to be rejected while the drawer is already open.
    function open() {
      if (!refreshAuthGate()) { window.location.href = SIGN_IN_PAGE; return; }
      // No future dates in the picker (the server rejects them too).
      if (dateField) {
        const now = new Date();
        dateField.max = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      }
      loadServiceAreas();
      loadTrafficCameras();
      drawer.classList.add('is-open'); backdrop.classList.add('is-open');
    }
    function close() { drawer.classList.remove('is-open'); backdrop.classList.remove('is-open'); }

    openBtns.forEach(btn => btn.addEventListener('click', open));
    if (closeBtn) closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    // Preview + quick type/size check as soon as a photo is picked.
    photoField.addEventListener('change', () => {
      clearPhoto();
      showPhotoError('');
      const file = photoField.files && photoField.files[0];
      if (!file) return;
      if (!PHOTO_TYPES.includes(file.type)) { showPhotoError(SIGHTING_ERROR_MESSAGES.unsupported_file_type); photoField.value = ''; return; }
      if (file.size > MAX_PICKED_BYTES) { showPhotoError('That photo is too large. Please choose one under 10 MB.'); photoField.value = ''; return; }
      try {
        previewUrl = URL.createObjectURL(file);
        photoPreview.src = previewUrl;
        photoPreview.classList.remove('hidden');
        pixelReveal(photoPreview);   // visual only (PixelCard, above)
      } catch (err) { /* no preview; the upload still works */ }
      photoPrompt.textContent = 'Change Photo';
    });

    if (success) {
      document.getElementById('sightingAnother').addEventListener('click', () => {
        success.classList.add('hidden');
        form.classList.remove('hidden');
      });
      document.getElementById('sightingDone').addEventListener('click', close);
    }

    function setSubmitting(submitting) {
      inFlight = submitting;
      submitBtn.disabled = submitting;
      submitBtn.textContent = submitting ? 'Uploading…' : 'Submit';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (inFlight) return; // guards a double-click/rapid-repeat submit

      // The authoritative check is always the sessionId read fresh right
      // here — refreshAuthGate() at open-time is just the honest UI state;
      // this covers a sign-out that happened while the drawer was open.
      const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
      if (!sessionId) { refreshAuthGate(); return; }

      const picked = photoField.files && photoField.files[0];
      if (!picked) { showPhotoError(SIGHTING_ERROR_MESSAGES.missing_photo); return; }
      // A location needs a city (only that city's places are allowed).
      if (locationField.value.trim() && !selectedArea()) {
        showLocError(SIGHTING_ERROR_MESSAGES.invalid_service_area);
        return;
      }
      // A typed location that wasn't picked from the list isn't a real place.
      if (locationField.value.trim() && !(locIdField && locIdField.value)) {
        showLocError(SIGHTING_ERROR_MESSAGES.invalid_location);
        return;
      }

      setSubmitting(true);
      const photo = await preparePhoto(picked);
      if (photo.size > MAX_PHOTO_BYTES) {
        setSubmitting(false);
        showPhotoError('That photo is too large. Please choose one under 10 MB.');
        return;
      }

      const body = new FormData();
      body.append('photo', photo, photo.name || 'sighting.jpg');
      const fields = {
        service_area: serviceAreaField.value.trim(),
        approx_location: locationField.value.trim(),
        notes: notesField ? notesField.value.trim() : '',
        license_plate: plateField.value.trim()   // never the old "Unlisted" fallback. Missing stays missing
      };
      // Only the DATE is chosen; the server records the exact time of
      // submission in the area's local time (worker/timezones.js). The
      // browser's own time zone is sent as a fallback for an unknown area.
      if (dateField && dateField.value) fields.observed_date = dateField.value;
      try { fields.time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* optional */ }
      if (fields.approx_location && locIdField) { fields.location_id = locIdField.value; fields.location_query = pickedQuery; }
      if (cameraField && cameraField.value) fields.camera_id = cameraField.value;
      Object.entries(fields).forEach(([k, v]) => { if (v) body.append(k, v); });

      let resp;
      try {
        resp = await fetch(TESLA_WORKER_URL + '/api/vehicle-sightings/photo', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sessionId },   // the browser sets the multipart Content-Type
          body
        });
      } catch (err) {
        setSubmitting(false);
        toast("Couldn't submit the sighting. Please try again.", 'error');
        return; // entered fields and the chosen photo are left as they were
      }

      let json = null;
      try { json = await resp.json(); } catch (err) { /* non-JSON body */ }
      setSubmitting(false);

      if (resp.status === 401) {
        localStorage.removeItem(TESLA_SESSION_KEY);
        refreshAuthGate();
        return;
      }
      if (resp.status === 400) {
        const code = json && json.error;
        const message = (code && SIGHTING_ERROR_MESSAGES[code]) || SIGHTING_ERROR_MESSAGES.invalid_body;
        if (code === 'missing_photo' || code === 'unsupported_file_type') showPhotoError(message);
        else if (code === 'invalid_location' || code === 'location_outside_area') showLocError(message);
        else toast(message, 'error');
        return;
      }
      if (resp.status === 413) {
        showPhotoError('That photo is too large. Please choose one under 10 MB.');
        return;
      }
      if (resp.status === 502 && json && json.error === 'location_unavailable') {
        showLocError(SIGHTING_ERROR_MESSAGES.location_unavailable);
        return;
      }
      if (!resp.ok) {
        toast("Couldn't submit the sighting. Please try again.", 'error');
        return;
      }

      if (json && json.duplicate) {
        toast('That sighting was already submitted.', 'info');
        close();
        resetForm();
        return;
      }
      resetForm();
      form.classList.add('hidden');
      if (success) success.classList.remove('hidden');
      else { toast('Sighting submitted!', 'success'); close(); }
    });
  }

  /* ---------------- Ambient particles ---------------- */
  // Retired in the redesign (the backdrop is still; motion is reserved for
  // content and feedback). Kept as a no-op so callers don't break.
  function initParticles() {
    return;
    const mesh = document.querySelector('.bg-mesh');
    if (!mesh) return;
    for (let i = 0; i < 14; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = 2 + Math.random() * 4;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.bottom = '-20px';
      p.style.animationDuration = (14 + Math.random() * 14) + 's';
      p.style.animationDelay = (Math.random() * 14) + 's';
      mesh.appendChild(p);
    }
  }

  /* ---------------- Tesla account link (real OAuth via Cloudflare Worker) ----------------
     The Worker holds the Tesla client secret and all tokens server-side; this
     script only ever learns a boolean "linked" state via a same-origin-safe
     cross-site fetch (credentials: 'include' + the Worker's own CORS allow-list). */
  const TESLA_WORKER_URL = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const TESLA_ICON_SVG = '<path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/> <path d="M15 19l2 2l4 -4"/>';   // Tabler 'shield-check' (MIT)

  const TESLA_SESSION_KEY = 'teslaSessionId';
  let googleSignInJustCompleted = false;   // set by initTeslaLink on ?signin=success

  function initTeslaLink() {
    // The callback hands back a one-time session ID in the URL fragment
    // (never sent to any server) the first time the browser lands here after
    // linking. Capture it into localStorage, then scrub it from the URL.
    // This ID is not a Tesla token — it's an opaque pointer to the token
    // record the Worker keeps server-side; a cross-site cookie would have
    // worked the same way in principle, but Chrome/Safari both block
    // third-party cookies by default, so the Worker uses this instead and
    // the frontend sends it back explicitly as an Authorization header.
    const hashMatch = location.hash.match(/tesla_session=([^&]+)/);
    if (hashMatch) {
      localStorage.setItem(TESLA_SESSION_KEY, decodeURIComponent(hashMatch[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }

    // Show a one-time result toast for a just-completed OAuth round trip,
    // then scrub the query param so it doesn't re-fire on refresh/share.
    const params = new URLSearchParams(location.search);
    const result = params.get('tesla');
    if (result) {
      const messages = {
        linked: ['Tesla account linked', 'success'],
        cancelled: ['Tesla linking was cancelled.', 'info'],
        invalid_state: ['Tesla linking failed. Please try again.', 'error'],
        token_exchange_failed: ['Tesla linking failed. Please try again.', 'error'],
        already_linked_elsewhere: ['That Tesla account is already linked to a different sign-in.', 'error'],
        error: ['Tesla linking failed. Please try again.', 'error']
      };
      const [msg, type] = messages[result] || messages.error;
      toast(msg, type);
      params.delete('tesla');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    // Same one-time toast/scrub for the Google Sign-In round trip
    // (worker/google-auth.js's callback uses ?signin= instead of ?tesla=
    // since it's not Tesla-specific).
    // After a self-serve account deletion (profile.html -> DELETE /api/account).
    if (params.get('account') === 'deleted') {
      toast('Your account has been deleted.', 'success');
      params.delete('account');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    const signinResult = params.get('signin');
    if (signinResult === 'success') googleSignInJustCompleted = true;   // for initGmailOnboarding
    if (signinResult) {
      const messages = {
        success: ['Signed in', 'success'],
        cancelled: ['Sign-in was cancelled.', 'info'],
        invalid_state: ['Sign-in failed. Please try again.', 'error'],
        token_exchange_failed: ['Sign-in failed. Please try again.', 'error'],
        error: ['Sign-in failed. Please try again.', 'error']
      };
      const [msg, type] = messages[signinResult] || messages.error;
      toast(msg, type);
      params.delete('signin');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    const btn = document.getElementById('teslaLinkBtn');
    if (!btn) return;

    const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
    const startUrl = TESLA_WORKER_URL + '/oauth/tesla/start';

    // What connecting Tesla actually does: it gives Cybercab Hunter access to
    // the eligible vehicle information on the rider's Tesla account. It does
    // NOT import Robotaxi ride history — rides come from receipts.
    btn.href = startUrl;
    btn.title = 'Connect your Tesla account so Cybercab Hunter can see your eligible Tesla vehicle information. This does not import Robotaxi ride history.';
    btn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TESLA_ICON_SVG}</svg>Link Tesla Account`;

    // The button only exists for a rider who is signed in (Google Sign-In is
    // how an account is created) and has not linked Tesla yet. Signed out, or
    // once linked, it is hidden — it starts hidden in the markup, so nothing
    // flashes while /api/me answers, and any failure leaves it hidden.
    // Unlinking, if the account is signed in, happens from rider-data.html.
    function render(show) {
      btn.classList.toggle('hidden', !show);
    }

    if (sessionId) {
      fetch(TESLA_WORKER_URL + '/api/me', {
        headers: { Authorization: 'Bearer ' + sessionId }
      })
        .then(r => (r.ok ? r.json() : null))
        .then(d => render(!!(d && d.authenticated === true && !(d.tesla && d.tesla.connected))))
        .catch(() => render(false));
    }

    // A signed-in browser must tell the Worker WHICH account is linking so
    // Tesla attaches to it instead of creating a separate account — but the
    // long-lived session id must never appear in a URL. So ask (over an
    // authenticated fetch) for a one-time, two-minute link token and put only
    // that in the URL. Signed out, this is just an ordinary link.
    btn.addEventListener('click', (e) => {
      if (!sessionId) { btn.textContent = 'Connecting…'; return; }
      e.preventDefault();
      const label = btn.innerHTML;
      btn.textContent = 'Connecting…';
      fetch(TESLA_WORKER_URL + '/oauth/tesla/link', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sessionId }
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          // A rejected session means we aren't really signed in — the plain flow is right then.
          location.href = startUrl + (d && d.link_token ? '?link=' + encodeURIComponent(d.link_token) : '');
        })
        .catch(() => {
          // Never silently fall back to a plain link here: for a signed-in
          // rider that would create a second, separate account.
          btn.innerHTML = label;
          toast('Could not start Tesla linking. Please try again.', 'error');
        });
    });
  }

  /* ---------------- Account menu (real session via /api/me) ----------------
     Signed-in state is driven by the same opaque bearer session Tesla
     linking uses (TESLA_SESSION_KEY) — Google Sign-In's OAuth callback hands
     one back through the identical #tesla_session= fragment (see
     worker/google-auth.js), so this reads whichever provider created it the
     same way. */
  const PERSON_ICON_SVG = '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/> <path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>';   // Tabler 'user' (MIT)

  function initAccountMenu() {
    const signedOut = document.getElementById('accountSignedOut');
    const signedIn = document.getElementById('accountSignedIn');
    if (!signedOut || !signedIn) return;

    function showSignedOut() {
      signedOut.classList.remove('hidden');
      signedIn.classList.add('hidden');
    }

    function showSignedIn({ label, avatarUrl, onSignOut }) {
      signedOut.classList.add('hidden');
      signedIn.classList.remove('hidden');

      const avatarIcon = document.getElementById('accountAvatarIcon');
      const avatarImg = document.getElementById('accountAvatarImg');
      if (avatarSrc(avatarUrl, 128) && avatarImg) {
        avatarImg.src = avatarSrc(avatarUrl, 128);
        avatarImg.classList.remove('hidden');
        if (avatarIcon) avatarIcon.classList.add('hidden');
      } else {
        if (avatarImg) avatarImg.classList.add('hidden');
        if (avatarIcon) { avatarIcon.classList.remove('hidden'); avatarIcon.innerHTML = PERSON_ICON_SVG; }
      }

      const providerLabel = document.getElementById('accountMenuProviderLabel');
      if (providerLabel) providerLabel.textContent = label;

      // Slides in from the right, same drawer/backdrop pattern as the
      // "Submit" sighting drawer — not a small anchored popover.
      const trigger = document.getElementById('accountMenuTrigger');
      const drawer = document.getElementById('accountDrawer');
      const backdrop = document.getElementById('accountBackdrop');
      const closeBtn = document.getElementById('closeAccountDrawer');
      if (trigger && drawer && backdrop) {
        function openDrawer() { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); }
        function closeDrawer() { drawer.classList.remove('is-open'); backdrop.classList.remove('is-open'); }
        trigger.addEventListener('click', openDrawer);
        if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
        backdrop.addEventListener('click', closeDrawer);
      }

      const signOutBtn = document.getElementById('accountMenuSignOut');
      if (signOutBtn) signOutBtn.addEventListener('click', onSignOut);
    }

    // A "Moderation" entry beside Profile / Rider Data, for moderators only.
    // It is a convenience and nothing more: whether the account is a moderator
    // comes from the server (GET /api/moderation/access, which answers only
    // about the caller's own account), and every moderation API call is
    // authorized again server-side. Anything unexpected leaves the link out.
    function showModerationLink(sessionId) {
      const anchor = document.querySelector('#accountDrawer a[href="rider-data.html"]');
      if (!anchor || document.getElementById('accountMenuModeration')) return;
      fetch(TESLA_WORKER_URL + '/api/moderation/access', { headers: { Authorization: 'Bearer ' + sessionId } })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d || d.moderator !== true || document.getElementById('accountMenuModeration')) return;
          const link = anchor.cloneNode(false);
          link.id = 'accountMenuModeration';
          link.setAttribute('href', '/moderation');
          link.innerHTML = '<svg class="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/> <path d="M15 19l2 2l4 -4"/></svg>Moderation';
          anchor.insertAdjacentElement('afterend', link);
        })
        .catch(() => { /* no link on any failure */ });
    }

    const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
    if (!sessionId) {
      showSignedOut();
      return;
    }

    fetch(TESLA_WORKER_URL + '/api/me', {
      headers: { Authorization: 'Bearer ' + sessionId }
    })
      .then(r => r.ok ? r.json() : { authenticated: false })
      .then(d => {
        if (!d.authenticated) {
          localStorage.removeItem(TESLA_SESSION_KEY);
          showSignedOut();
          return;
        }
        showModerationLink(sessionId);
        showSignedIn({
          label: d.user.display_name || 'Signed in',
          avatarUrl: d.user.avatar_url,
          onSignOut: () => {
            fetch(TESLA_WORKER_URL + '/oauth/tesla/disconnect', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + sessionId }
            }).finally(() => {
              localStorage.removeItem(TESLA_SESSION_KEY);
              location.href = 'index.html';
            });
          }
        });
      })
      .catch(() => showSignedOut());
  }

  /* ---------------- Gmail onboarding (right after Google sign-in) ----------------
     Offered once, straight after a successful Google sign-in, to an account
     whose Gmail import is available (the server reports it configured) and not
     connected. Gmail stays optional: "Connect Gmail" runs the SAME flow as
     Rider Data's button (POST /api/gmail/connect → Google's own consent page,
     where the rider grants or refuses Gmail access), and "Skip for now" just
     closes it. Either choice is remembered per account in this browser
     (gmailOnboardingDone:<userId>) — the account has no server-side field for
     it — so the prompt doesn't return on every sign-in; Rider Data keeps its
     own Connect Gmail for later. Built with the site's existing .modal-backdrop
     / .modal-panel styles; every string is set with textContent. */
  const GMAIL_ONBOARDING_KEY = 'gmailOnboardingDone:';

  function gmailOnboardingDone(userId) {
    try { return localStorage.getItem(GMAIL_ONBOARDING_KEY + userId) === '1'; } catch (e) { return false; }
  }
  function markGmailOnboardingDone(userId) {
    try { localStorage.setItem(GMAIL_ONBOARDING_KEY + userId, '1'); } catch (e) { /* storage blocked: it may be offered again */ }
  }

  async function initGmailOnboarding() {
    if (!googleSignInJustCompleted) return;
    let sessionId = null;
    try { sessionId = localStorage.getItem(TESLA_SESSION_KEY); } catch (e) { return; }
    if (!sessionId) return;
    const get = path => fetch(TESLA_WORKER_URL + path, { headers: { Authorization: 'Bearer ' + sessionId } })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [me, gmail] = await Promise.all([get('/api/me'), get('/api/gmail/status')]);
    const userId = me && me.authenticated && me.user && me.user.id;
    if (!userId || !gmail || !gmail.configured || gmail.state !== 'not_connected') return;
    if (gmailOnboardingDone(userId)) return;
    showGmailOnboarding(sessionId, userId);
  }

  function showGmailOnboarding(sessionId, userId) {
    const el = (tag, className, text) => {
      const e = document.createElement(tag);
      if (className) e.className = className;
      if (text != null) e.textContent = text;
      return e;
    };
    const backdrop = el('div', 'modal-backdrop fixed inset-0 z-[150] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4');
    backdrop.id = 'gmailOnboarding';
    const panel = el('div', 'modal-panel glass-strong rounded-2xl w-full max-w-md p-6 sm:p-7');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'gmailOnboardingTitle');
    panel.appendChild(el('p', 'text-xs font-semibold text-gold uppercase tracking-[0.2em] mb-2', 'Welcome'));
    const title = el('h2', 'font-display font-bold text-2xl tracking-tight mb-2', 'Automatically import your Tesla Robotaxi receipts?');
    title.id = 'gmailOnboardingTitle';
    panel.appendChild(title);
    panel.appendChild(el('p', 'text-sm text-slate-400 leading-relaxed mb-5', 'Connect Gmail to automatically find your Robotaxi receipt emails and add your rides to Cybercab Hunter.'));

    const connect = el('button', 'btn-magnetic w-full px-5 py-3 rounded-lg text-sm font-bold bg-gradient-to-r from-goldsoft to-gold text-[#1a1204] disabled:opacity-50', 'Connect Gmail');
    connect.type = 'button';
    connect.id = 'gmailOnboardingConnect';
    panel.appendChild(connect);
    panel.appendChild(el('p', 'text-xs text-slate-500 mt-2 mb-4', 'Only the Robotaxi receipt emails needed for your ride history are imported.'));

    const skip = el('button', 'w-full px-5 py-3 rounded-lg text-sm font-semibold border border-[rgba(212,175,55,0.35)] text-slate-100 hover:bg-white/5 transition-colors', 'Skip for now');
    skip.type = 'button';
    skip.id = 'gmailOnboardingSkip';
    panel.appendChild(skip);
    panel.appendChild(el('p', 'text-xs text-slate-500 mt-2', 'You can connect Gmail later from Rider Data.'));

    const error = el('p', 'hidden text-sm text-amber-200 mt-4', '');
    error.id = 'gmailOnboardingError';
    error.setAttribute('role', 'alert');
    panel.appendChild(error);
    panel.appendChild(el('p', 'text-xs text-slate-500 leading-relaxed mt-5 pt-4 border-t border-[rgba(212,175,55,0.12)]', "Gmail is optional. Signing in with Google doesn't give Cybercab Hunter access to your Gmail. If you choose Connect Gmail, Google asks for your permission first."));

    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-open'));

    const close = () => {
      markGmailOnboardingDone(userId);
      document.removeEventListener('keydown', onKey);
      backdrop.classList.remove('is-open');
      setTimeout(() => backdrop.remove(), 350);
    };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    skip.addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    connect.addEventListener('click', () => {
      connect.disabled = true;
      connect.textContent = 'Connecting…';
      error.classList.add('hidden');
      markGmailOnboardingDone(userId);   // offered and taken up; Rider Data covers any retry
      fetch(TESLA_WORKER_URL + '/api/gmail/connect', { method: 'POST', headers: { Authorization: 'Bearer ' + sessionId } })
        .then(r => r.json().catch(() => null).then(body => ({ ok: r.ok, body })))
        .catch(() => ({ ok: false, body: null }))
        .then(({ ok, body }) => {
          const url = ok && body && body.authorize_url;
          // Only ever navigate to Google's own authorization page.
          if (url && /^https:\/\/accounts\.google\.com\//.test(url)) { location.assign(url); return; }
          connect.disabled = false;
          connect.textContent = 'Connect Gmail';
          error.textContent = body && body.error === 'google_signin_required'
            ? 'Gmail import needs an account that signs in with Google.'
            : "Couldn't start connecting Gmail. You can skip for now and try again later from Rider Data.";
          error.classList.remove('hidden');
        });
    });
    connect.focus();
  }

  /* ---------------- Init ---------------- */
  function init() {
    initNav();
    initReveal();
    initParticles();
    initSightingDrawer();
    initShine();
    initMagnet();
    initTilt();
    initDecrypt();
    initSplit();
    initElastic();
    initTeslaLink();
    initAccountMenu();
    initGmailOnboarding();
  }

  return { data, storage, merge, initNav, initReveal, animateCounter, countUp, enterList, initMagnet, initTilt, initDecrypt, initElastic, initSplit, pixelReveal, spawnConfetti, toast, initParticles, initSightingDrawer, initTeslaLink, initAccountMenu, initGmailOnboarding, init, avatarSrc, avatarInitials, renderAvatar };
})();
