/* Sightings replay (/replay): every camera-spotted Cybercab in a time window,
   replayed in order on a map. Data: GET /api/camera-sightings/history (public,
   paged; worker/camera-sightings.js). Nothing is invented: a window with few or
   no sightings simply shows what exists.

   URL: /replay?range=24h|7d|30d[&date=YYYY-MM-DD]
     no date  -> the window ends now ("Today's replay": the last 24 hours)
     date     -> the window ends at the end of that day in Austin (or now, if
                 that day isn't over) — so a shared link replays the same window
   The link is the shareable thing: it works for anyone, signed in or not.

   Look ("golden day"): a light basemap with a tint that follows the replay's
   time of day (indigo night, gold dawn, clear midday, amber dusk). Everything
   that moves is drawn on ONE canvas — gold pings as sightings land, the site's
   Cybercab icon (camera watch) or a gold diamond (spotter) where they settle,
   and a warm glow that grows hotter where sightings repeat. The activity ribbon
   under the map is a histogram of the window that fills gold behind the
   playhead; drag it to scrub. The counter rolls like an odometer. */
window.CCCReplay = (function () {
  const ZONE = 'America/Chicago';
  const RANGES = { '24h': { ms: 864e5, label: 'Last 24 hours', bins: 48 }, '7d': { ms: 7 * 864e5, label: 'Last 7 days', bins: 56 }, '30d': { ms: 30 * 864e5, label: 'Last 30 days', bins: 60 } };
  const SPEEDS = [1, 4, 16, 60];
  const BASE_RATE = 600;          // 1x: 10 minutes of sighting time per second
  const PING_MS = 1100;           // a landing ping's life, in real time
  const MAX_PAGES = 40;
  const GOLD = '#D4AF37';

  // ---- Time (Austin) ----
  function zoneParts(ms) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
  }
  // UTC ms of local midnight starting Austin date y-m-d (CST/CDT aware).
  function zoneMidnight(y, m, d) {
    for (const off of [5, 6]) { const t = Date.UTC(y, m - 1, d, off); const p = zoneParts(t); if (p.h === 0 && p.d === d) return t; }
    return Date.UTC(y, m - 1, d, 6);
  }
  // The replay window from the URL: { range, date, start, end }.
  function windowFor(search, now = Date.now()) {
    const q = new URLSearchParams(search);
    const range = RANGES[q.get('range')] ? q.get('range') : '24h';
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.get('date') || '');
    let end = now, date = null;
    if (dm) {
      // the end of that Austin day (the next local midnight), never in the future
      end = Math.min(now, zoneMidnight(...nextDay(+dm[1], +dm[2], +dm[3])));
      date = `${dm[1]}-${dm[2]}-${dm[3]}`;
    }
    return { range, date, start: end - RANGES[range].ms, end };
  }
  function nextDay(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d + 1)); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; }
  const isoZ = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const todayDate = (now = Date.now()) => { const p = zoneParts(now); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

  // ---- Data ----
  async function fetchAll(start, end, fetchImpl = fetch) {
    const out = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ from: isoZ(start), to: isoZ(end), limit: '1000' });
      if (cursor) q.set('cursor', cursor);
      const r = await fetchImpl(`/api/camera-sightings/history?${q}`);
      if (!r.ok) throw new Error('http_' + r.status);
      const body = await r.json();
      for (const d of body.detections || []) {
        const t = Date.parse(d.t);
        if (Number.isFinite(t) && Number.isFinite(d.lat) && Number.isFinite(d.lng)) out.push({ t, lat: d.lat, lng: d.lng, key: d.camera_id, name: d.camera_name, source: d.source === 'spotter' ? 'spotter' : 'watch' });
      }
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    return out.sort((a, b) => a.t - b.t);   // chronological, whatever the page order
  }

  // How many sightings fall at or before time T (dots are sorted).
  function countUpTo(dots, T) {
    let lo = 0, hi = dots.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dots[mid].t <= T) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function histogram(dots, start, end, bins) {
    const h = new Array(bins).fill(0);
    for (const d of dots) { const i = Math.min(bins - 1, Math.floor((d.t - start) / (end - start) * bins)); if (i >= 0) h[i]++; }
    return h;
  }

  // ---- Golden-day tint: the colour washed over the map at local hour h ----
  const TINT_KEYS = [[0, [38, 44, 112, 0.40]], [5, [38, 44, 112, 0.34]], [6.5, [255, 176, 80, 0.30]], [9, [255, 214, 140, 0.10]], [12, [255, 255, 255, 0]], [16, [255, 214, 140, 0.10]], [18.5, [255, 140, 60, 0.30]], [20.5, [60, 50, 120, 0.34]], [24, [38, 44, 112, 0.40]]];
  function tintAt(hour) {
    for (let i = 1; i < TINT_KEYS.length; i++) {
      const [h1, c1] = TINT_KEYS[i];
      if (hour <= h1) {
        const [h0, c0] = TINT_KEYS[i - 1];
        const f = (hour - h0) / (h1 - h0);
        const c = c0.map((v, k) => v + (c1[k] - v) * f);
        return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
      }
    }
    return 'rgba(0,0,0,0)';
  }

  // ---- The page ----
  const state = { dots: [], start: 0, end: 0, T: 0, playing: false, speed: 4, shown: 0, appeared: [], pings: new Map(), map: null, range: '24h', date: null };

  function init() {
    const $ = id => document.getElementById(id);
    const canvas = $('replayCanvas'), ribbon = $('replayRibbon');
    if (!canvas || !ribbon) return;
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const icon = new Image();
    icon.src = 'images/CybercabOverhead.png';

    // Map: light basemap; pannable and zoomable (cooperative gestures on a page that scrolls).
    if (window.maplibregl) {
      try {
        state.map = new maplibregl.Map({
          container: 'replayMap', style: 'https://tiles.openfreemap.org/styles/positron',
          center: [-97.735, 30.29], zoom: 10.3, cooperativeGestures: true, dragRotate: false, pitchWithRotate: false,
          attributionControl: { compact: true }
        });
        if (state.map.touchZoomRotate) state.map.touchZoomRotate.disableRotation();
        state.map.on('move', () => draw());
      } catch (e) { state.map = null; }
    }
    const project = (lng, lat) => {
      if (state.map && state.map.project) { const p = state.map.project([lng, lat]); return [p.x, p.y]; }
      // No map (e.g. WebGL unavailable): a plain projection of the Austin area.
      const w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
      return [(lng + 98.05) / 0.6 * w, (30.6 - lat) / 0.55 * h];
    };

    // ---- Odometer ----
    const counterEl = $('replayCounter');
    function setCounter(n) {
      const digits = String(n).split('');
      while (counterEl.children.length < digits.length) {
        const col = document.createElement('span');
        col.className = 'od-col';
        col.innerHTML = `<span class="od-strip">${'0123456789'.split('').map(x => `<span>${x}</span>`).join('')}</span>`;
        counterEl.insertBefore(col, counterEl.firstChild);
      }
      while (counterEl.children.length > digits.length) counterEl.removeChild(counterEl.firstChild);
      [...counterEl.children].forEach((col, i) => { col.firstChild.style.transform = `translateY(-${Number(digits[i])}em)`; });
      counterEl.dataset.value = String(n);
      counterEl.setAttribute('aria-label', `${n} sightings`);
    }

    // ---- Drawing ----
    function sizeCanvas(c) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth || 600, h = c.clientHeight || 300;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = c.getContext && c.getContext('2d');
      if (ctx && ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }

    function draw() {
      const { ctx, w, h } = sizeCanvas(canvas);
      const n = countUpTo(state.dots, state.T);
      // Record arrivals in order (and give each a ping) as the playhead passes them.
      if (n > state.shown) {
        const nowReal = performance.now();
        for (let i = state.shown; i < n; i++) { state.appeared.push(state.dots[i].t); if (state.playing) state.pings.set(i, nowReal); }
      }
      state.shown = n;
      canvas.dataset.dots = String(n);
      setCounter(n);
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        // Heat: repeat sightings at one camera glow hotter.
        const byKey = new Map();
        for (let i = 0; i < n; i++) { const d = state.dots[i]; const k = d.key || `${d.lat},${d.lng}`; const e = byKey.get(k) || { d, count: 0 }; e.count++; e.d = d; byKey.set(k, e); }
        for (const { d, count } of byKey.values()) {
          if (count < 2) continue;
          const [x, y] = project(d.lng, d.lat);
          const r = 14 + 9 * Math.sqrt(count);
          const g = ctx.createRadialGradient ? ctx.createRadialGradient(x, y, 0, x, y, r) : null;
          if (g) { g.addColorStop(0, `rgba(255,${Math.max(90, 190 - count * 8)},40,${Math.min(0.55, 0.18 + count * 0.04)})`); g.addColorStop(1, 'rgba(255,170,40,0)'); ctx.fillStyle = g; }
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        // Markers (one per location, its latest sighting).
        for (const { d } of byKey.values()) {
          const [x, y] = project(d.lng, d.lat);
          ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fillStyle = '#fffaf0'; ctx.fill();
          ctx.lineWidth = 2.5; ctx.strokeStyle = GOLD; ctx.stroke();
          if (d.source === 'watch' && icon.complete && icon.naturalWidth) ctx.drawImage(icon, x - 7, y - 7, 14, 14);
          else if (d.source === 'spotter') { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = GOLD; ctx.fillRect(-4, -4, 8, 8); ctx.restore(); }
          else { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill(); }
        }
        // Pings: an expanding gold ring as each sighting lands.
        const nowReal = performance.now();
        for (const [i, born] of state.pings) {
          const age = (nowReal - born) / PING_MS;
          if (age >= 1) { state.pings.delete(i); continue; }
          const d = state.dots[i];
          const [x, y] = project(d.lng, d.lat);
          ctx.beginPath(); ctx.arc(x, y, 8 + 30 * age, 0, Math.PI * 2);
          ctx.lineWidth = 3 * (1 - age); ctx.strokeStyle = `rgba(212,175,55,${(1 - age).toFixed(3)})`; ctx.stroke();
        }
      }
      drawRibbon();
      // Clock + time-of-day tint.
      const p = zoneParts(state.T);
      $('replayTint').style.background = tintAt(p.h + p.mi / 60);
      const dt = new Date(state.T);
      $('replayClockDate').textContent = dt.toLocaleDateString('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' });
      $('replayClockTime').textContent = dt.toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
    }

    let bins = [];
    function drawRibbon() {
      const { ctx, w, h } = sizeCanvas(ribbon);
      const frac = (state.T - state.start) / (state.end - state.start);
      ribbon.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const max = Math.max(1, ...bins);
      const bw = w / bins.length;
      bins.forEach((v, i) => {
        const bh = v ? Math.max(3, (v / max) * (h - 6)) : 2;
        ctx.fillStyle = (i + 1) / bins.length <= frac ? GOLD : 'rgba(148,163,184,0.28)';
        ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
      });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.min(w - 2, Math.max(0, frac * w - 1)), 0, 2, h);
    }

    // ---- Playback ----
    const playBtn = $('replayPlay');
    const PLAY = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3.2v9.6L12.8 8z" fill="currentColor"/></svg>';
    const PAUSE = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="4" y="3" width="2.8" height="10" rx="0.6" fill="currentColor"/><rect x="9.2" y="3" width="2.8" height="10" rx="0.6" fill="currentColor"/></svg>';
    function syncPlay() { playBtn.innerHTML = state.playing ? PAUSE : PLAY; playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play'); }
    let last = 0;
    function tick(ts) {
      if (!state.playing) return;
      if (last) state.T = Math.min(state.end, state.T + Math.min(100, ts - last) * BASE_RATE * state.speed);
      last = ts;
      draw();
      if (state.T >= state.end) { state.playing = false; syncPlay(); return; }
      requestAnimationFrame(tick);
    }
    function play() {
      if (state.T >= state.end) seek(state.start);
      state.playing = true; last = 0; syncPlay(); requestAnimationFrame(tick);
    }
    function pause() { state.playing = false; syncPlay(); }
    // Jump the playhead (no pings for what a jump passes over).
    function seek(T) {
      state.T = Math.max(state.start, Math.min(state.end, T));
      const n = countUpTo(state.dots, state.T);
      state.pings.clear();
      state.appeared = state.dots.slice(0, n).map(d => d.t);
      state.shown = n;
      draw();
    }
    playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
    document.querySelectorAll('#replaySpeed [data-speed]').forEach(b => b.addEventListener('click', () => {
      state.speed = Number(b.dataset.speed);
      document.querySelectorAll('#replaySpeed [data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }));
    document.querySelector(`#replaySpeed [data-speed="${state.speed}"]`).setAttribute('aria-pressed', 'true');

    // Scrub on the ribbon (mouse, touch, or arrow keys).
    let scrubbing = false;
    const scrubTo = e => { const r = ribbon.getBoundingClientRect(); const f = r.width ? (e.clientX - r.left) / r.width : 0; seek(state.start + Math.max(0, Math.min(1, f)) * (state.end - state.start)); };
    ribbon.addEventListener('pointerdown', e => { scrubbing = true; if (ribbon.setPointerCapture) ribbon.setPointerCapture(e.pointerId); scrubTo(e); });
    ribbon.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
    ribbon.addEventListener('pointerup', () => { scrubbing = false; });
    ribbon.addEventListener('keydown', e => {
      const step = (state.end - state.start) / 48;
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.T + step); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.T - step); }
      else if (e.key === ' ') { e.preventDefault(); state.playing ? pause() : play(); }
    });

    // ---- Range + link ----
    const fmtEdge = ms => new Date(ms).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    async function load(search) {
      pause();
      const win = windowFor(search);
      Object.assign(state, { range: win.range, date: win.date, start: win.start, end: win.end, T: win.start, dots: [], shown: 0, appeared: [] });
      state.pings.clear();
      document.querySelectorAll('#replayRange [data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === win.range)));
      $('replayRangeLabel').textContent = RANGES[win.range].label;
      $('replayStartLabel').textContent = fmtEdge(win.start);
      $('replayEndLabel').textContent = fmtEdge(win.end);
      $('replayLoading').classList.remove('hidden');
      $('replayEmpty').classList.add('hidden');
      let dots = [];
      try { dots = await fetchAll(win.start, win.end); } catch (e) { dots = []; }
      state.dots = dots;
      bins = histogram(dots, win.start, win.end, RANGES[win.range].bins);
      $('replayLoading').classList.add('hidden');
      $('replayEmpty').classList.toggle('hidden', dots.length > 0);
      if (reduceMotion) { seek(state.end); return; }   // no animation: straight to the full picture
      seek(state.start);
      if (dots.length) play();
    }
    document.querySelectorAll('#replayRange [data-range]').forEach(b => b.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('range', b.dataset.range);
      history.replaceState(null, '', `${location.pathname}?${q}`);
      load(location.search);
    }));
    $('replayShare').addEventListener('click', async () => {
      // A shareable link pinned to the day being viewed.
      const q = new URLSearchParams({ range: state.range, date: state.date || todayDate() });
      const link = `${location.origin}/replay?${q}`;
      try { await navigator.clipboard.writeText(link); if (window.CCC && CCC.toast) CCC.toast('Replay link copied.', 'success'); }
      catch (e) { window.prompt('Copy this link:', link); }
    });
    window.addEventListener('resize', () => draw());

    syncPlay();
    setCounter(0);
    load(location.search);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { state, windowFor, countUpTo, histogram, tintAt, fetchAll, zoneMidnight, RANGES, SPEEDS };
})();
