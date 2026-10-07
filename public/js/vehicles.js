/* Public vehicle registry (/vehicles). Like js/vehicle.js this is NOT signed-in
   state: it never reads a session, never sends an Authorization header, and
   calls exactly one public endpoint, GET /api/robotaxi-vehicles
   (worker/vehicles.js), which only ever returns vehicles that are public AND
   have a counted ride — the same gate as the per-vehicle page. Each entry
   links to the existing detail page at /vehicle/<id>; nothing of that page is
   duplicated here.
   States: loading / empty (nothing public yet) / error (network or server —
   NOT the same as empty) / loaded, plus "Show more" for the next page.
   Every API value goes in through .textContent, never .innerHTML, so there is
   no markup-building step for a plate or model to sneak into. Missing values
   render as an em dash or an honest "not confirmed"/"not recorded", never 0. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const PAGE_SIZE = 50;
  const VEHICLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

  const fmtInt = n => (n == null ? '—' : Number(n).toLocaleString());
  const fmtMiles = mi => (mi == null ? '—' : Number(mi).toFixed(1) + ' mi');
  // A calendar date ('YYYY-MM-DD', e.g. a ride_date) shown as a date, not an
  // instant — parsed at LOCAL midnight (no 'Z'), so it never shifts a day
  // backward for a viewer west of UTC the way appending 'Z' to a bare date
  // would. Same pattern as js/vehicle.js and js/rider-data.js's fmtDate.
  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  let loaded = 0;      // vehicles shown so far (the next offset)
  let total = 0;
  let busy = false;
  let query = '';      // the search the current list reflects
  // The city whose Cybercabs are listed (Austin by default; ?city=dallas in the URL).
  const CITIES = ['austin', 'dallas'];
  let city = 'austin';
  try {
    const fromUrl = new URLSearchParams(location.search).get('city');
    if (CITIES.includes(fromUrl)) city = fromUrl;
  } catch (e) { /* default */ }
  // A Dallas car: its own city is Dallas, or (with none of its own) its rides are in Dallas.
  const isDallas = v => {
    const own = String(v.service_area || '').trim().toLowerCase();
    if (own) return own === 'dallas';
    return String(v.service_areas || '').toLowerCase().split(',').some(c => c.trim() === 'dallas');
  };
  let generation = 0;  // bumped per new search, so a slow older response is dropped

  function setView(view) {
    show('regLoading', view === 'loading');
    show('regEmpty', view === 'empty');
    show('regNoMatch', view === 'nomatch');
    show('regError', view === 'error');
    show('regLoaded', view === 'loaded');
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // phoneLabel: an optional shorter label shown only on phones (max-sm:),
  // where the cards are two to a row; sm and up always show `label`.
  function stat(label, value, phoneLabel) {
    const box = el('div', 'min-w-0');
    const lbl = el('div', 'text-xs text-slate-500 mb-0.5 max-sm:text-[10px] max-sm:leading-tight max-sm:truncate');
    if (phoneLabel) {
      lbl.appendChild(el('span', 'max-sm:hidden', label));
      lbl.appendChild(el('span', 'sm:hidden', phoneLabel));
    } else {
      lbl.textContent = label;
    }
    box.appendChild(lbl);
    box.appendChild(el('div', 'stat-value text-[15px] font-semibold text-white [overflow-wrap:anywhere] max-sm:text-xs max-sm:leading-tight max-sm:[overflow-wrap:normal]', value));
    return box;
  }

  // Every moderator approval is an Approve Cybercab (v.approval_basis is set,
  // migrations/0025), so both kinds get the Cybercab image and pill. No page
  // shows a "VIN verified" badge.
  const approvedCybercab = v => v.approval_basis === 'vin-verified' || v.approval_basis === 'manual';

  // Generic Cybercab illustration, shown for an approved Cybercab
  // (worker/vehicles.js's apiListVehicles only lists vehicles that already
  // passed publicVehicleEligibleSql). It is the SAME
  // file for every vehicle, never a photo of that specific VIN. Built via
  // createElement/attribute assignment, never innerHTML, matching every
  // other element on this page.
  function cybercabImage() {
    const img = document.createElement('img');
    img.src = 'images/Cybercab2.png';
    img.alt = 'Cybercab (generic vehicle-type image, not a photo of this specific vehicle)';
    img.className = 'w-full h-32 object-contain mb-4 max-sm:h-16 max-sm:mb-2';
    return img;
  }

  function card(v) {
    const li = el('li');
    // Phones (max-sm:) get a compact two-column card; sm and up are unchanged.
    const a = el('a', 'group block glass rounded-2xl p-6 max-sm:p-3 h-full min-w-0 hover:border-[rgba(212,175,55,0.45)] hover:-translate-y-0.5 transition-[transform,border-color] duration-300 ease-out');
    a.href = '/vehicle/' + encodeURIComponent(v.id);
    if (approvedCybercab(v)) a.appendChild(cybercabImage());
    // The plate, styled like one (the same treatment as the Sightings cards).
    a.appendChild(el('h2', v.license_plate
      // leading-none + tight padding hug the characters; the right padding is
      // reduced by the letter-spacing so the trailing space after the last
      // character doesn't make the right side wider than the left.
      ? 'inline-block font-display font-bold text-lg leading-none tracking-[0.18em] pl-2 pr-[calc(0.5rem-0.18em)] py-1.5 max-sm:text-sm max-sm:pl-1.5 max-sm:pr-[calc(0.375rem-0.18em)] max-sm:py-1 rounded-md bg-[#f4efe3] text-[#141008] border-2 border-[#1a1406]/80 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.6)] [overflow-wrap:anywhere]'
      : 'font-display font-bold text-lg text-slate-400', v.license_plate || 'Plate not recorded'));
    // An approved Cybercab gets the same compact gold/yellow badge used on
    // the vehicle detail page (vCybercabBadge). Any other vehicle keeps the
    // plain-text model line, and no badge.
    if (approvedCybercab(v)) {
      a.appendChild(el('span', 'inline-block mt-1 text-xs font-bold px-3 py-1.5 rounded-full border border-[rgba(212,175,55,0.35)] text-slate-200 uppercase tracking-wide max-sm:block max-sm:w-fit max-sm:mt-1.5 max-sm:text-[9px] max-sm:px-2 max-sm:py-0.5', 'Cybercab'));
    } else {
      a.appendChild(el('p', 'text-slate-400 text-sm mt-1 [overflow-wrap:anywhere] max-sm:text-xs', v.model || 'Model not confirmed'));
    }
    // service_area is the record's own field; service_areas are the cities of its counted rides.
    const area = v.service_area || (v.service_areas ? String(v.service_areas).split(',').join(', ') : '');
    a.appendChild(el('p', 'text-slate-500 text-xs mt-1 [overflow-wrap:anywhere] max-sm:text-[10px]', area || 'Service area not recorded'));
    // Dallas cars carry a Dallas tag (the Dallas launch); Austin cards are unchanged.
    if (isDallas(v)) a.appendChild(el('span', 'inline-block mt-2 text-[11px] font-bold px-2.5 py-1 rounded-full border border-cyan/40 text-cyan uppercase tracking-wide max-sm:text-[9px] max-sm:px-2 max-sm:py-0.5 max-sm:mt-1.5', 'Dallas'));
    const stats = el('div', 'grid grid-cols-2 gap-x-4 gap-y-3 mt-5 pt-4 border-t border-white/[0.07] max-sm:gap-x-2 max-sm:gap-y-2 max-sm:mt-3 max-sm:pt-2.5');
    stats.appendChild(stat('Rides', fmtInt(v.trip_count)));
    stats.appendChild(stat('Recorded distance', fmtMiles(v.total_distance), 'Distance'));
    // First/Last seen reflect the RIDE dates a receipt reported (v.first_ride_date/last_ride_date),
    // not when the registry row was created or last touched — those are ingestion timestamps
    // (v.first_seen_at/last_seen_at) that can be much later than the ride itself if a receipt was
    // imported well after the fact, and would otherwise show the wrong date here.
    stats.appendChild(stat('First seen', fmtDate(v.first_ride_date)));
    stats.appendChild(stat('Last seen', fmtDate(v.last_ride_date)));
    a.appendChild(stats);
    li.appendChild(a);
    return li;
  }

  function render(vehicles) {
    const list = $('regList');
    for (const v of vehicles) {
      if (!v || typeof v.id !== 'string' || !VEHICLE_ID_RE.test(v.id)) continue;   // never link to a malformed id
      list.appendChild(card(v));
      loaded += 1;
    }
    $('regCount').textContent = total === 1 ? '1 vehicle' : total.toLocaleString() + ' vehicles';
    show('regMore', loaded < total);
  }

  async function fetchPage(offset) {
    const q = query ? '&q=' + encodeURIComponent(query) : '';
    const resp = await fetch(`${WORKER}/api/robotaxi-vehicles?limit=${PAGE_SIZE}&offset=${offset}&sort=${encodeURIComponent(sort)}&city=${city}${q}`);
    if (!resp.ok) throw new Error('http_' + resp.status);
    const body = await resp.json();
    if (!body || !Array.isArray(body.vehicles)) throw new Error('bad_body');
    return body;
  }

  async function loadFirst() {
    const gen = ++generation;
    setView('loading');
    $('regList').textContent = '';
    loaded = 0;
    busy = false;
    try {
      const body = await fetchPage(0);
      if (gen !== generation) return;   // a newer search replaced this one
      total = Number(body.total) || 0;
      if (!body.vehicles.length) {
        if (query) { $('regNoMatchQuery').textContent = '\u201c' + query + '\u201d'; setView('nomatch'); }
        else {
          const h = document.querySelector('#regEmpty h2');
          if (h) h.textContent = city === 'dallas' ? 'No Dallas Cybercabs yet' : 'No vehicles found';
          setView('empty');
        }
        return;
      }
      render(body.vehicles);
      setView('loaded');
    } catch (e) {
      if (gen === generation) setView('error');
    }
  }

  async function loadMore() {
    if (busy) return;
    const gen = generation;
    busy = true; show('regMoreError', false);
    $('regMore').disabled = true;
    try {
      const body = await fetchPage(loaded);
      if (gen !== generation) return;   // the search changed while this page was loading
      total = Number(body.total) || total;
      render(body.vehicles);
      if (!body.vehicles.length) show('regMore', false);   // nothing further (the list shrank)
    } catch (e) {
      if (gen === generation) show('regMoreError', true);
    } finally {
      if (gen === generation) { busy = false; $('regMore').disabled = false; }
    }
  }

  // Search as you type (debounced), searching the whole registry server-side
  // rather than filtering only the cards already on the page.
  let debounce = null;
  function onSearchInput() {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const next = $('regSearch').value.trim();
      if (next === query) return;
      query = next;
      loadFirst();
    }, 250);
  }
  $('regSearch').addEventListener('input', onSearchInput);

  // Sort menu: Recently Used (default), Used Least Recently, Most Miles, Most
  // Rides — applied server-side across the whole registry, kept in the URL.
  const SORTS = ['recent', 'least_recent', 'most_miles', 'most_rides'];
  let sort = 'recent';
  try {
    const fromUrl = new URLSearchParams(location.search).get('sort');
    if (SORTS.includes(fromUrl)) sort = fromUrl;
  } catch (e) { /* default */ }
  $('regSort').value = sort;
  $('regSort').addEventListener('change', () => {
    sort = SORTS.includes($('regSort').value) ? $('regSort').value : 'recent';
    try {
      const url = new URL(location.href);
      if (sort === 'recent') url.searchParams.delete('sort'); else url.searchParams.set('sort', sort);
      history.replaceState(null, '', url);
    } catch (e) { /* not essential */ }
    loadFirst();
  });

  // City buttons: Austin / Dallas, kept in the URL like the sort.
  const cityBtns = [...document.querySelectorAll('#regCity [data-city]')];
  const syncCity = () => cityBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.city === city)));
  syncCity();
  cityBtns.forEach(b => b.addEventListener('click', () => {
    if (b.dataset.city === city) return;
    city = b.dataset.city;
    syncCity();
    try {
      const url = new URL(location.href);
      if (city === 'austin') url.searchParams.delete('city'); else url.searchParams.set('city', city);
      history.replaceState(null, '', url);
    } catch (e) { /* not essential */ }
    loadFirst();
  }));

  $('regRetry').addEventListener('click', loadFirst);
  $('regMore').addEventListener('click', loadMore);
  $('regMoreRetry').addEventListener('click', loadMore);
  loadFirst();
})();
