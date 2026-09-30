/* Cybercab Sightings gallery (sightings.html). Public: no session, only the
   public GET /api/sightings list and each photo's public URL
   (worker/sightings-public.js). Most or least recent first (the choice is
   remembered), 24 per page, more loaded as the visitor scrolls (or taps "Load
   more"); photos load lazily. The "Seen" number and the stat cards are the
   server's figures for the selected city, re-checked every minute while the
   tab is visible (LIVE): new sightings are added without a reload. A stat that
   could not be loaded shows an em dash, never 0. Every value from the API goes
   in through textContent / attributes, never innerHTML. */
(function () {
  // Same origin (cybercabhunter.com): the list/stats responses are edge-cached
  // there (worker/sightings-public.js), which workers.dev would bypass.
  const WORKER = '';
  // The filter buttons: one per supported service area (GET /api/service-areas,
  // worker/service-areas.js), in that order; the page opens on the first.
  let CITY_NAMES = {};
  let defaultCity = null;

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

  let city = 'austin';
  let cursor = null;
  let loading = false;
  let generation = 0;   // bumps on every filter change; stale responses are dropped
  let isModerator = false;   // moderators get a Delete button on each photo (the server checks too)
  const SESSION_KEY = 'teslaSessionId';
  const ORDER_KEY = 'sightingsOrder';
  const POLL_MS = 60 * 1000;
  let order = 'desc';          // 'desc' = most recent first, 'asc' = least recent first
  const shown = new Set();     // public ids of the cards on the page
  let pollTimer = null;
  try { if (localStorage.getItem(ORDER_KEY) === 'asc') order = 'asc'; } catch (e) { /* default */ }

  // In the sighting area's own time zone when known (e.g. "4:10 PM CDT" for
  // Austin), otherwise the viewer's.
  function fmtSpotted(iso, zone) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const tz = {};
    if (zone) { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); tz.timeZone = zone; } catch (e) { /* unknown zone */ } }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...tz }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...tz, ...(tz.timeZone ? { timeZoneName: 'short' } : {}) });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // One card: a smallish photo (click it to expand) and the facts provided.
  // Fields that weren't provided are simply left out.
  function card(s) {
    const article = el('article', 'glass rounded-2xl overflow-hidden flex flex-col');
    const caption = [s.city, s.location, s.plate, fmtSpotted(s.spotted_at, s.time_zone)].filter(Boolean).join(' · ');
    const open = el('button', 'block w-full aspect-[4/3] bg-panel overflow-hidden cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-gold');
    open.type = 'button';
    open.setAttribute('aria-label', 'View larger photo');
    const img = el('img', 'w-full h-full object-cover transition-transform duration-300 hover:scale-105');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = WORKER + s.image_url;
    img.alt = s.city ? `Cybercab spotted in ${s.city}` : 'Cybercab sighting';
    // A photo that can't load (e.g. it just expired) is removed, never shown broken.
    img.addEventListener('error', () => article.remove());
    open.addEventListener('click', () => openViewer(img.src, img.alt, caption, open));
    open.appendChild(img);
    const frame = el('div', 'relative');
    frame.appendChild(open);
    // Moderators only: hovering darkens the photo and shows a red Delete
    // button. Nothing is added to the page for anyone else.
    if (isModerator) {
      frame.classList.add('mod-photo');
      frame.appendChild(el('div', 'mod-photo-shade absolute inset-0 bg-black/55'));
      const del = el('button', 'mod-photo-delete whitespace-nowrap absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold bg-crimson text-white shadow-lg hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white', 'Delete');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete this photo');
      del.addEventListener('click', () => deletePhoto(s.id, article, del));
      frame.appendChild(del);
    }
    article.appendChild(frame);

    const body = el('div', 'p-3 flex flex-col gap-1.5');
    const top = el('div', 'flex items-center justify-between gap-2 flex-wrap');
    if (s.city) top.appendChild(el('span', 'text-[10px] font-semibold px-2 py-0.5 rounded-full border border-[rgba(212,175,55,0.3)] text-gold uppercase tracking-wider', s.city));
    if (s.plate) top.appendChild(el('span', 'font-display font-bold text-xs tracking-wider px-2 py-0.5 rounded bg-black/30 border border-[rgba(212,175,55,0.2)]', s.plate));
    if (s.cybercab) top.appendChild(el('span', 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-gradient-to-r from-goldsoft to-gold text-[#1a1204] uppercase tracking-wider', 'Cybercab'));
    if (top.childNodes.length) body.appendChild(top);
    if (s.location) body.appendChild(el('p', 'text-xs text-slate-300 leading-snug [overflow-wrap:anywhere]', s.location));
    const when = fmtSpotted(s.spotted_at, s.time_zone);
    if (when) {
      const time = el('time', 'text-[11px] text-slate-500', when);
      time.dateTime = s.spotted_at;
      body.appendChild(time);
    }
    if (body.childNodes.length) article.appendChild(body);
    return article;
  }

  // ---------- moderator delete ----------
  function note(message, type) {
    if (typeof CCC !== 'undefined' && CCC.toast) CCC.toast(message, type);
  }

  async function checkModerator() {
    let session = null;
    try { session = localStorage.getItem(SESSION_KEY); } catch (e) { /* none */ }
    if (!session) return false;
    try {
      const resp = await fetch(`${WORKER}/api/moderation/access`, { headers: { Authorization: 'Bearer ' + session } });
      const body = resp.ok ? await resp.json() : null;
      return !!(body && body.moderator === true);
    } catch (e) { return false; }
  }

  async function deletePhoto(publicId, article, button) {
    if (!window.confirm('Delete this photo? It is removed permanently and can’t be undone.')) return;
    let session = null;
    try { session = localStorage.getItem(SESSION_KEY); } catch (e) { /* none */ }
    button.disabled = true;
    let resp = null;
    try {
      resp = await fetch(`${WORKER}/api/moderation/sightings/${encodeURIComponent(publicId)}/photo`, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + session }
      });
    } catch (e) { resp = null; }
    button.disabled = false;
    if (resp && resp.ok) {
      article.remove();
      const current = Number(String($('seenNumber').textContent).replace(/,/g, ''));
      if (Number.isFinite(current) && current > 0) setSeen(current - 1);
      note('Photo deleted.', 'success');
    } else if (resp && (resp.status === 401 || resp.status === 403)) {
      note('Only moderators can delete photos.', 'error');
    } else {
      note("Couldn't delete the photo. Please try again.", 'error');
    }
  }

  // ---------- expanded photo ----------
  let returnFocus = null;
  function openViewer(src, alt, caption, trigger) {
    $('sightingViewerImg').src = src;
    $('sightingViewerImg').alt = alt;
    $('sightingViewerCaption').textContent = caption;
    returnFocus = trigger || null;
    show('sightingViewer', true);
    document.body.style.overflow = 'hidden';
    $('sightingViewerClose').focus();
  }
  function closeViewer() {
    if ($('sightingViewer').classList.contains('hidden')) return;
    show('sightingViewer', false);
    document.body.style.overflow = '';
    $('sightingViewerImg').removeAttribute('src');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  // ---------- stat cards ----------
  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const fmtHour = h => `${(h % 12) || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
  function fmtDay(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }

  // Any value that isn't a proper count stays (or goes back to) an em dash.
  function renderStats(stats) {
    const ok = stats && typeof stats === 'object';
    const num = (id, n) => { $(id).textContent = ok && isCount(n) ? n.toLocaleString('en-US') : '—'; };
    num('statWeek', ok && stats.last_7_days);
    num('statToday', ok && stats.today);
    $('statTodayLabel').textContent = ok && stats.today === 1 ? 'Cybercab spotted today' : 'Cybercabs spotted today';
    num('statMonth', ok && stats.this_month);
    let monthName = '';
    try { monthName = new Date().toLocaleDateString('en-US', { month: 'long', timeZone: (ok && stats.time_zone) || 'America/Chicago' }); } catch (e) { /* plain label */ }
    $('statMonthLabel').textContent = monthName ? `sightings in ${monthName}` : 'sightings this month';
    const peak = ok && stats.peak_hour;
    if (peak && Number.isInteger(peak.hour) && peak.hour >= 0 && peak.hour < 24 && isCount(peak.count)) {
      $('statPeakHour').textContent = `${fmtHour(peak.hour)} – ${fmtHour((peak.hour + 1) % 24)}`;
      $('statPeakCount').textContent = plural(peak.count, 'sighting', 'sightings');
    } else {
      $('statPeakHour').textContent = ok && stats.total === 0 ? 'None yet' : '—';
      $('statPeakCount').textContent = '';
    }
    const best = ok && stats.best_day;
    const bestDay = best && fmtDay(best.date);
    if (bestDay && isCount(best.count)) {
      $('statBestDay').textContent = bestDay;
      $('statBestCount').textContent = plural(best.count, 'sighting', 'sightings');
    } else {
      $('statBestDay').textContent = ok && stats.total === 0 ? 'None yet' : '—';
      $('statBestCount').textContent = '';
    }
  }

  // ---------- LIVE ----------
  function setLive(healthy) {
    $('liveIndicator').classList.toggle('is-stale', !healthy);
    $('liveIndicator').title = healthy ? 'Checking for new sightings every minute' : "Couldn't check for new sightings — retrying";
  }
  function flashLive() {
    const dot = $('liveDot');
    dot.classList.remove('live-flash');
    void dot.offsetWidth;   // restart the animation
    dot.classList.add('live-flash');
  }

  function setSeen(n) {
    $('seenNumber').textContent = Number(n).toLocaleString('en-US');
  }

  function setActiveOrder() {
    document.querySelectorAll('#sortToggle [data-order]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.order === order));
    });
  }

  function selectOrder(next) {
    order = next === 'asc' ? 'asc' : 'desc';
    try { localStorage.setItem(ORDER_KEY, order); } catch (e) { /* not essential */ }
    setActiveOrder();
    loadPage(true);
  }

  function setActiveFilter() {
    document.querySelectorAll('#cityFilters [data-city]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.city === city));
    });
  }

  async function loadPage(reset) {
    if (loading && !reset) return;
    const mine = reset ? ++generation : generation;
    loading = true;
    if (reset) {
      cursor = null;
      shown.clear();
      $('sightingsGrid').replaceChildren();
      show('sightingsEmpty', false);
      show('sightingsError', false);
      show('sightingsMore', false);
      show('sightingsLoading', true);
    }
    $('sightingsMore').disabled = true;

    const params = new URLSearchParams({ city, order });
    if (cursor) params.set('cursor', cursor);
    if (reset) params.set('stats', '1');
    let body = null;
    try {
      const resp = await fetch(`${WORKER}/api/sightings?${params}`);
      if (resp.ok) body = await resp.json();
    } catch (e) { body = null; }
    if (mine !== generation) return;   // the filter changed while this was loading
    loading = false;
    show('sightingsLoading', false);
    $('sightingsMore').disabled = false;

    if (!body || !Array.isArray(body.sightings)) {
      if (reset) { $('seenNumber').textContent = '—'; renderStats(null); setLive(false); show('sightingsError', true); }
      else show('sightingsMore', true);   // keep what's shown; the button retries
      return;
    }

    setSeen(body.seen);
    if (reset) { renderStats(body.stats); setLive(true); }
    const grid = $('sightingsGrid');
    body.sightings.forEach(s => { shown.add(s.id); grid.appendChild(card(s)); });
    cursor = body.next_cursor || null;
    show('sightingsMore', !!cursor);
    // The observer only fires on a change, so if the end of the list is still
    // on screen after this page (a tall screen), keep going.
    if (cursor && 'IntersectionObserver' in window) {
      const r = $('sightingsSentinel').getBoundingClientRect();
      if (r.top < window.innerHeight + 600) setTimeout(() => loadPage(false), 0);
    }

    if (reset && body.sightings.length === 0) {
      $('sightingsEmptyText').textContent = `No Cybercab sightings from ${CITY_NAMES[city]} yet. Spotted one there? Submit a photo.`;
      show('sightingsEmpty', true);
    }
  }

  // Every minute (while the tab is visible): refresh Seen and the stats, and
  // add any sightings not on the page yet — at the top when showing the most
  // recent first; at the end when showing the least recent first and the
  // whole list is already loaded (otherwise they arrive with "Load more").
  async function poll() {
    if (loading || !defaultCity) return;
    const mine = generation;
    let body = null;
    try {
      const resp = await fetch(`${WORKER}/api/sightings?${new URLSearchParams({ city, order: 'desc', stats: '1' })}`);
      if (resp.ok) body = await resp.json();
    } catch (e) { body = null; }
    if (mine !== generation || loading) return;   // the view changed meanwhile
    if (!body || !Array.isArray(body.sightings)) { setLive(false); return; }   // keep what's shown
    setLive(true);
    setSeen(body.seen);
    renderStats(body.stats);
    const fresh = body.sightings.filter(s => !shown.has(s.id));
    if (!fresh.length) return;
    const grid = $('sightingsGrid');
    if (order === 'desc') {
      fresh.slice().reverse().forEach(s => { shown.add(s.id); grid.prepend(card(s)); });
    } else if (!cursor) {
      fresh.slice().reverse().forEach(s => { shown.add(s.id); grid.appendChild(card(s)); });
    }
    show('sightingsEmpty', false);
    flashLive();
  }

  function startPolling() {
    stopPolling();
    if (!document.hidden) pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function selectCity(next) {
    if (!CITY_NAMES[next]) next = defaultCity;
    city = next;
    setActiveFilter();
    // Keep the choice in the URL, so a filtered view can be shared or reloaded.
    try {
      const url = new URL(location.href);
      if (city === defaultCity) url.searchParams.delete('city'); else url.searchParams.set('city', city);
      history.replaceState(null, '', url);
    } catch (e) { /* not essential */ }
    loadPage(true);
  }

  // Builds the city filter buttons from the supported service areas.
  async function loadCities() {
    let areas = null;
    try {
      const resp = await fetch(`${WORKER}/api/service-areas`);
      if (resp.ok) areas = ((await resp.json()) || {}).areas;
    } catch (e) { areas = null; }
    if (!Array.isArray(areas) || !areas.length) return false;
    const box = $('cityFilters');
    box.replaceChildren();
    CITY_NAMES = {};
    areas.forEach(a => {
      CITY_NAMES[a.key] = a.name;
      const btn = el('button', 'city-filter min-h-[44px] px-5 rounded-full text-sm font-semibold border transition-colors', a.name);
      btn.type = 'button';
      btn.dataset.city = a.key;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => selectCity(a.key));
      box.appendChild(btn);
    });
    defaultCity = areas[0].key;
    return true;
  }

  function init() {
    setActiveOrder();
    document.querySelectorAll('#sortToggle [data-order]').forEach(btn => {
      btn.addEventListener('click', () => selectOrder(btn.dataset.order));
    });
    // Pause while the tab is hidden; catch up at once when it's shown again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling();
      else { poll(); startPolling(); }
    });
    $('sightingsMore').addEventListener('click', () => loadPage(false));
    $('sightingsRetry').addEventListener('click', () => (defaultCity ? loadPage(true) : start()));
    $('sightingViewerClose').addEventListener('click', closeViewer);
    // A click anywhere outside the photo itself closes it.
    $('sightingViewer').addEventListener('click', e => { if (e.target !== $('sightingViewerImg')) closeViewer(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });

    // Infinite scroll: load the next page as the end of the list comes into view.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting) && cursor && !loading) loadPage(false);
      }, { rootMargin: '600px 0px' }).observe($('sightingsSentinel'));
    }

    start();
  }

  // Cities and moderator status first, so the filters exist and cards render
  // with (or without) the delete control from the start.
  async function start() {
    show('sightingsError', false);
    show('sightingsLoading', true);
    const [ok, mod] = await Promise.all([loadCities(), checkModerator()]);
    isModerator = mod;
    if (!ok) { show('sightingsLoading', false); renderStats(null); setLive(false); show('sightingsError', true); return; }
    const initial = (new URLSearchParams(location.search).get('city') || defaultCity).toLowerCase();
    selectCity(initial);
    startPolling();
  }

  init();
})();
