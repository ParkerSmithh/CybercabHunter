/* Cybercab Sightings gallery (sightings.html). Public: no session, only the
   public GET /api/sightings list and each photo's public URL
   (worker/sightings-public.js). Newest first, 24 per page, more loaded as the
   visitor scrolls (or taps "Load more"); photos load lazily. The "Seen"
   number is the server's live count for the selected city. Every value from
   the API goes in through textContent / attributes, never innerHTML. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const CITY_NAMES = { all: 'All', austin: 'Austin', dallas: 'Dallas', miami: 'Miami', orlando: 'Orlando' };

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

  let city = 'all';
  let cursor = null;
  let loading = false;
  let generation = 0;   // bumps on every filter change; stale responses are dropped

  function fmtSpotted(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // One card. Fields that weren't provided are simply left out.
  function card(s) {
    const article = el('article', 'glass rounded-2xl overflow-hidden flex flex-col');
    const frame = el('div', 'aspect-[4/3] bg-panel overflow-hidden');
    const img = el('img', 'w-full h-full object-cover');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = WORKER + s.image_url;
    img.alt = s.city ? `Cybercab spotted in ${s.city}` : 'Cybercab sighting';
    // A photo that can't load (e.g. it just expired) is removed, never shown broken.
    img.addEventListener('error', () => article.remove());
    frame.appendChild(img);
    article.appendChild(frame);

    const body = el('div', 'p-5 flex flex-col gap-2.5');
    const top = el('div', 'flex items-center justify-between gap-3 flex-wrap');
    if (s.city) top.appendChild(el('span', 'text-xs font-semibold px-2.5 py-1 rounded-full border border-[rgba(212,175,55,0.3)] text-gold uppercase tracking-wider', s.city));
    const when = fmtSpotted(s.spotted_at);
    if (when) {
      const time = el('time', 'text-xs text-slate-500', when);
      time.dateTime = s.spotted_at;
      top.appendChild(time);
    }
    if (top.childNodes.length) body.appendChild(top);
    if (s.location) body.appendChild(el('p', 'text-sm text-slate-300 [overflow-wrap:anywhere]', s.location));
    if (s.plate) body.appendChild(el('span', 'self-start font-display font-bold text-sm tracking-wider px-3 py-1 rounded-md bg-black/30 border border-[rgba(212,175,55,0.2)]', s.plate));
    if (body.childNodes.length) article.appendChild(body);
    return article;
  }

  function setSeen(n) {
    $('seenNumber').textContent = Number(n).toLocaleString('en-US');
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
      $('sightingsGrid').replaceChildren();
      show('sightingsEmpty', false);
      show('sightingsError', false);
      show('sightingsMore', false);
      show('sightingsLoading', true);
    }
    $('sightingsMore').disabled = true;

    const params = new URLSearchParams({ city });
    if (cursor) params.set('cursor', cursor);
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
      if (reset) { $('seenNumber').textContent = '—'; show('sightingsError', true); }
      else show('sightingsMore', true);   // keep what's shown; the button retries
      return;
    }

    setSeen(body.seen);
    const grid = $('sightingsGrid');
    body.sightings.forEach(s => grid.appendChild(card(s)));
    cursor = body.next_cursor || null;
    show('sightingsMore', !!cursor);
    // The observer only fires on a change, so if the end of the list is still
    // on screen after this page (a tall screen), keep going.
    if (cursor && 'IntersectionObserver' in window) {
      const r = $('sightingsSentinel').getBoundingClientRect();
      if (r.top < window.innerHeight + 600) setTimeout(() => loadPage(false), 0);
    }

    if (reset && body.sightings.length === 0) {
      $('sightingsEmptyText').textContent = city === 'all'
        ? 'No Cybercab sightings have been shared yet. Spotted one? Submit a photo and it will appear here once it has been reviewed.'
        : `No Cybercab sightings from ${CITY_NAMES[city]} yet. Spotted one there? Submit a photo.`;
      show('sightingsEmpty', true);
    }
  }

  function selectCity(next) {
    if (!CITY_NAMES[next]) next = 'all';
    city = next;
    setActiveFilter();
    // Keep the choice in the URL, so a filtered view can be shared or reloaded.
    try {
      const url = new URL(location.href);
      if (city === 'all') url.searchParams.delete('city'); else url.searchParams.set('city', city);
      history.replaceState(null, '', url);
    } catch (e) { /* not essential */ }
    loadPage(true);
  }

  function init() {
    document.querySelectorAll('#cityFilters [data-city]').forEach(btn => {
      btn.addEventListener('click', () => selectCity(btn.dataset.city));
    });
    $('sightingsMore').addEventListener('click', () => loadPage(false));
    $('sightingsRetry').addEventListener('click', () => loadPage(true));

    // Infinite scroll: load the next page as the end of the list comes into view.
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting) && cursor && !loading) loadPage(false);
      }, { rootMargin: '600px 0px' }).observe($('sightingsSentinel'));
    }

    const initial = (new URLSearchParams(location.search).get('city') || 'all').toLowerCase();
    selectCity(initial);
  }

  init();
})();
