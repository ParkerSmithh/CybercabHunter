/* Sightings replay (/replay): every camera-spotted Cybercab in a time window,
   replayed in order on a map. Data: GET /api/camera-sightings/history (public,
   paged; worker/camera-sightings.js). Nothing is invented: a window with few or
   no sightings simply shows what exists.

   URL: /replay?range=month|24h|7d[&date=YYYY-MM-DD]   (default: month)
     month    -> "This Month": the calendar month in Austin, from the 1st to now
                 (with a date: that date's whole month, or up to now if it's
                 this month). The headline view. (Old ?range=30d links open it.)
     24h, 7d  -> the last 24 hours / 7 days, ending now (with a date: ending at
                 the end of that day in Austin, or now if that day isn't over)
     So a shared link replays the same window.
   The link is the shareable thing: it works for anyone, signed in or not.

   Look ("golden day"): a light basemap under a sky that follows the replay's
   time of day — deep indigo night, gold dawn, clear midday, amber dusk —
   plainly, with a Night/Dawn/Midday/Dusk chip on the clock. Everything
   that moves is drawn on ONE canvas — gold pings as sightings land, the site's
   Cybercab icon (camera watch) or a gold diamond (spotter) where they settle,
   and a warm glow that grows hotter where sightings repeat. The activity ribbon
   under the map is a histogram of the window that fills gold behind the
   playhead; drag it to scrub. The counter rolls like an odometer.
   Underneath: every camera in the watch (public/data/traffic-cameras.json) as a
   dim dot from the start — it lights up gold once a sighting lands there, so the
   month view is also a coverage map — and the service zone (the same boundary
   as the Zones page, js/austin-map.js), kept quiet under the gold. */
window.CCCReplay = (function () {
  const ZONE = 'America/Chicago';
  const RANGES = { month: { label: 'This Month' }, '24h': { ms: 864e5, label: 'Last 24 hours' }, '7d': { ms: 7 * 864e5, label: 'Last 7 days' } };
  const RANGE_ALIASES = { '30d': 'month' };   // links shared before "This Month" existed
  const DEFAULT_RANGE = 'month';
  const SPEEDS = [1, 4, 16, 60];
  const PLAY_MS_AT_1X = 150000;   // at 1x any window plays in ~2.5 minutes (4x: ~37 s, 60x: ~2.5 s)
  const PING_MS = 1100;           // a landing ping's life, in real time
  const MAX_PAGES = 40;
  const GOLD = '#D4AF37';
  // The city replayed (?city=dallas; Austin by default, its URLs unchanged).
  // Dallas: its TxDOT camera captures, framed on its service zone like Austin
  // (cameras outside it are a pan away). Same time zone.
  const CITY = (() => { try { return new URLSearchParams(location.search).get('city') === 'dallas' ? 'dallas' : 'austin'; } catch (e) { return 'austin'; } })();

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
    const asked = RANGE_ALIASES[q.get('range')] || q.get('range');
    const range = RANGES[asked] ? asked : DEFAULT_RANGE;
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.get('date') || '');
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null;
    if (range === 'month') {
      const p = dm ? { y: +dm[1], m: +dm[2] } : zoneParts(now);
      const start = zoneMidnight(p.y, p.m, 1);
      const next = p.m === 12 ? [p.y + 1, 1, 1] : [p.y, p.m + 1, 1];
      return { range, date, start, end: Math.min(now, zoneMidnight(...next)) };
    }
    // the end of that Austin day (the next local midnight), never in the future
    const end = dm ? Math.min(now, zoneMidnight(...nextDay(+dm[1], +dm[2], +dm[3]))) : now;
    return { range, date, start: end - RANGES[range].ms, end };
  }
  // Ribbon bars: one per half hour (24h), per 3 hours (7d), per 12 hours (month).
  function binsFor(range, start, end) {
    if (range === '24h') return 48;
    if (range === '7d') return 56;
    return Math.max(2, Math.ceil((end - start) / (12 * 3600e3)));
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
      if (CITY !== 'austin') q.set('city', CITY);
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
  // Strong enough to read at a glance on a phone; midday stays clear.
  const TINT_KEYS = [[0, [22, 26, 88, 0.58]], [4.5, [30, 32, 100, 0.54]], [6.5, [255, 146, 56, 0.46]], [8.5, [255, 200, 110, 0.24]], [11, [255, 245, 220, 0.04]], [12, [255, 255, 255, 0]], [15, [255, 222, 150, 0.12]], [18.5, [255, 108, 40, 0.48]], [20.5, [62, 40, 118, 0.54]], [24, [22, 26, 88, 0.58]]];
  function tintColor(hour) {
    for (let i = 1; i < TINT_KEYS.length; i++) {
      const [h1, c1] = TINT_KEYS[i];
      if (hour <= h1) {
        const [h0, c0] = TINT_KEYS[i - 1];
        const f = (hour - h0) / (h1 - h0);
        return c0.map((v, k) => v + (c1[k] - v) * f);
      }
    }
    return [0, 0, 0, 0];
  }
  // The sky over the map: the tint, deeper toward the top like a real sky.
  function skyAt(hour) {
    const [r, g, b, a] = tintColor(hour).map((v, k) => (k < 3 ? Math.round(v) : v));
    const at = x => `rgba(${r},${g},${b},${Math.min(0.85, x).toFixed(3)})`;
    return `linear-gradient(180deg, ${at(a * 1.45)} 0%, ${at(a)} 45%, ${at(a * 0.8)} 100%)`;
  }
  // Night / Dawn / Midday / Dusk, with a chip colour.
  function phaseAt(hour) {
    if (hour < 5 || hour >= 21) return { name: 'Night', color: '#1e2470', text: '#ffffff' };
    if (hour < 9) return { name: 'Dawn', color: '#ff9a3c', text: '#2a1600' };
    if (hour < 17) return { name: 'Midday', color: '#ffe08a', text: '#2a2210' };
    return { name: 'Dusk', color: '#e8622a', text: '#ffffff' };
  }
  function tintAt(hour) {
    const c = tintColor(hour);
    return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3].toFixed(3)})`;
  }

  // ---- The page ----
  const state = { dots: [], start: 0, end: 0, T: 0, playing: false, speed: 4, shown: 0, appeared: [], pings: new Map(), map: null, range: '24h', date: null, cameras: [] };

  function init() {
    const $ = id => document.getElementById(id);
    const canvas = $('replayCanvas'), ribbon = $('replayRibbon');
    if (!canvas || !ribbon) return;
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const icon = new Image();
    icon.src = 'images/CybercabOverhead.png';

    // On lg+ the sidebar floats over the map's left side (as on Zones): keep
    // the service zone in the open area to its right.
    const panel = $('replayPanel');
    const sideInset = () => (panel && window.innerWidth >= 1024 ? panel.offsetWidth + 32 : 0);
    const zoneBounds = () => {
      const z = window.CCCAustinMap
        ? (CITY === 'dallas' ? CCCAustinMap.DALLAS_SERVICE_ZONE : CCCAustinMap.SERVICE_ZONE)
        : (CITY === 'dallas' ? [[-96.93, 32.73], [-96.72, 32.88]] : [[-97.87, 30.14], [-97.55, 30.46]]);
      const lng = z.map(c => c[0]), lat = z.map(c => c[1]);
      return [[Math.min(...lng), Math.min(...lat)], [Math.max(...lng), Math.max(...lat)]];
    };
    const fitPadding = () => { const l = sideInset(); return l ? { top: 40, bottom: 40, left: l + 16, right: 40 } : 16; };

    // Map: the site's Dark Matter basemap; pannable and zoomable (cooperative gestures on a page that scrolls).
    if (window.maplibregl) {
      try {
        state.map = new maplibregl.Map({
          container: 'replayMap', style: window.CCCAustinMap ? CCCAustinMap.styleUrl() : 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
          bounds: zoneBounds(), fitBoundsOptions: { padding: fitPadding() }, cooperativeGestures: true, dragRotate: false, pitchWithRotate: false,
          attributionControl: { compact: true }
        });
        if (state.map.touchZoomRotate) state.map.touchZoomRotate.disableRotation();
        state.map.on('move', () => draw());
      } catch (e) { state.map = null; }
    }
    const project = (lng, lat) => {
      if (state.map && state.map.project) { const p = state.map.project([lng, lat]); return [p.x, p.y]; }
      // No map (e.g. WebGL unavailable): the zone's box, fitted beside the sidebar.
      const w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
      const [[x0, y0], [x1, y1]] = zoneBounds(), left = sideInset() + 24, pad = 24;
      const k = Math.min((w - left - pad) / (x1 - x0), (h - 2 * pad) / ((y1 - y0) * 1.15));
      const ox = left + ((w - left - pad) - k * (x1 - x0)) / 2, oy = pad + ((h - 2 * pad) - k * (y1 - y0) * 1.15) / 2;
      return [ox + (lng - x0) * k, oy + (y1 - lat) * k * 1.15];
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
      // One entry per location so far (its latest sighting and how many).
      const byKey = new Map();
      for (let i = 0; i < n; i++) { const d = state.dots[i]; const k = d.key || `${d.lat},${d.lng}`; const e = byKey.get(k) || { d, count: 0 }; e.count++; e.d = d; byKey.set(k, e); }
      const lit = state.cameras.filter(c => byKey.has(c.camera_id)).length;
      canvas.dataset.cameras = String(state.cameras.length);
      canvas.dataset.camerasLit = String(lit);
      $('replayCamerasLit').textContent = String(lit);
      $('replayCamerasTotal').textContent = state.cameras.length ? String(state.cameras.length) : '—';
      if (ctx) {
        ctx.clearRect(0, 0, w, h);
        // The service zone, on the canvas so it sits ABOVE the sky tint (a map
        // layer would vanish under the night indigo) and under every marker.
        const ring = window.CCCAustinMap && (CITY === 'dallas' ? CCCAustinMap.DALLAS_SERVICE_ZONE : CCCAustinMap.SERVICE_ZONE);
        if (ring) {
          ctx.beginPath();
          ring.forEach(([lng, lat], i) => { const [x, y] = project(lng, lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          ctx.closePath();
          ctx.fillStyle = 'rgba(255,199,44,0.10)'; ctx.fill();
          ctx.lineJoin = 'round';
          ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,199,44,0.22)'; ctx.stroke();   // soft glow
          ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,210,63,0.95)'; ctx.stroke();   // crisp edge
        }
        // Every watched camera: a pale dot with a dark ring (reads on the light
        // map and the night sky alike) until a sighting lands on it.
        for (const c of state.cameras) {
          if (byKey.has(c.camera_id)) continue;
          const [x, y] = project(c.lng, c.lat);
          ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,250,236,0.92)'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(60,50,30,0.75)'; ctx.stroke();
        }
        // Heat: repeat sightings at one camera glow hotter.
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
      const hour = p.h + p.mi / 60;
      $('replayTint').style.background = skyAt(hour);
      const phase = phaseAt(hour);
      const chip = $('replayPhase');
      if (chip) { chip.textContent = phase.name; chip.style.background = phase.color; chip.style.color = phase.text; }
      const dt = new Date(state.T);
      $('replayClockDate').textContent = dt.toLocaleDateString('en-US', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
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
    const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z"/></svg>';
    const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z"/> <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z"/></svg>';
    function syncPlay() { playBtn.innerHTML = state.playing ? PAUSE : PLAY; playBtn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play'); }
    let last = 0;
    function tick(ts) {
      if (!state.playing) return;
      if (last) state.T = Math.min(state.end, state.T + Math.min(100, ts - last) * ((state.end - state.start) / PLAY_MS_AT_1X) * state.speed);
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
      let dots = [];
      try { dots = await fetchAll(win.start, win.end); } catch (e) { dots = []; }
      state.dots = dots;
      bins = histogram(dots, win.start, win.end, binsFor(win.range, win.start, win.end));
      $('replayLoading').classList.add('hidden');
      if (reduceMotion) { seek(state.end); return; }   // no animation: straight to the full picture
      seek(state.start);
      play();   // always: a window with no sightings still plays its clock and sky
    }
    // City switch (#replayCityNav): links to each city's replay at the current
    // range; the selected city is highlighted like the Zones switch.
    function syncCityNav() {
      const range = new URLSearchParams(location.search).get('range') || 'month';
      document.querySelectorAll('#replayCityNav [data-city]').forEach(a => {
        const on = a.dataset.city === CITY;
        const q = new URLSearchParams({ range });
        if (a.dataset.city === 'dallas') q.set('city', 'dallas');
        a.setAttribute('href', `/replay?${q}`);
        a.classList.toggle('bg-white/[0.08]', on);
        a.classList.toggle('text-white', on);
        a.classList.toggle('text-slate-400', !on);
        a.classList.toggle('hover:text-slate-200', !on);
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      });
    }
    syncCityNav();
    document.querySelectorAll('#replayRange [data-range]').forEach(b => b.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('range', b.dataset.range);
      history.replaceState(null, '', `${location.pathname}?${q}`);
      syncCityNav();
      load(location.search);
    }));
    $('replayShare').addEventListener('click', async () => {
      // A shareable link pinned to the day being viewed.
      const q = new URLSearchParams({ range: state.range, date: state.date || todayDate() });
      if (CITY !== 'austin') q.set('city', CITY);
      const link = `${location.origin}/replay?${q}`;
      try { await navigator.clipboard.writeText(link); if (window.CCC && CCC.toast) CCC.toast('Replay link copied.', 'success'); }
      catch (e) { window.prompt('Copy this link:', link); }
    });
    window.addEventListener('resize', () => draw());
    // Crossing the lg breakpoint moves the sidebar on or off the map: refit.
    if (window.matchMedia && state.map) {
      const mq = window.matchMedia('(min-width: 1024px)');
      if (mq.addEventListener) mq.addEventListener('change', () => { try { state.map.fitBounds(zoneBounds(), { padding: fitPadding(), animate: false }); } catch (e) { /* keep the view */ } });
    }

    // The camera base layer (the same list the server checks sightings against).
    fetch('data/traffic-cameras.json').then(r => (r.ok ? r.json() : [])).then(list => {
      state.cameras = (Array.isArray(list) ? list : []).filter(c => c && (c.city || 'austin') === CITY && Number.isFinite(c.lat) && Number.isFinite(c.lng)).map(c => ({ camera_id: String(c.camera_id), lat: c.lat, lng: c.lng }));
      draw();
    }).catch(() => {});

    syncPlay();
    setCounter(0);
    load(location.search);
  }

  if (CITY === 'dallas') {
    document.title = 'Cybercab Hunter | Dallas Replay';
    const heading = document.getElementById('replayCity');
    if (heading) heading.textContent = 'DALLAS, TX';
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', 'Every camera-spotted Cybercab this month, replayed on a map of Dallas as it happened.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  return { state, windowFor, binsFor, countUpTo, histogram, tintAt, skyAt, phaseAt, fetchAll, zoneMidnight, RANGES, SPEEDS };
})();
