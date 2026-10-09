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

  // The card's colour (the Fleet ETA model cards, js/dmv-panel.js): gold for a
  // Cybercab, red for a Model Y, slate for anything else; `glow` is the React
  // Bits BorderGlow colour ([data-glow], js/main.js; "" = gold).
  const KINDS = {
    cybercab: { rgb: '212 175 55', hex: '#D4AF37', text: 'text-gold', glow: '' },
    modely: { rgb: '239 68 68', hex: '#ef4444', text: 'text-red-400', glow: 'red' },
    other: { rgb: '148 163 184', hex: '#94a3b8', text: 'text-slate-300', glow: '' }
  };
  const kindOf = v => (approvedCybercab(v) ? 'cybercab' : /model\s*y/i.test(String(v.model || '')) ? 'modely' : 'other');

  // A small line icon (static path data only; never API values), built with
  // the DOM like everything else here.
  const ICONS = {
    distance: 'M4 19h4l3-14h2l3 14h4M12 9v2M12 14v2',
    first: 'M5 21V4M5 4h11l-2 4 2 4H5',
    last: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2'
  };
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // phoneLabel: an optional shorter label shown only on phones (max-sm:),
  // where the cards are two to a row; sm and up always show `label`.
  function stat(label, value, phoneLabel, iconName) {
    const box = el('div', 'min-w-0');
    const lbl = el('div', 'vcard-label');
    if (iconName) lbl.appendChild(icon(iconName));
    if (phoneLabel) {
      lbl.appendChild(el('span', 'max-sm:hidden', label));
      lbl.appendChild(el('span', 'sm:hidden', phoneLabel));
    } else {
      lbl.appendChild(el('span', null, label));
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
  // other element on this page. It sits in its own clipped layer (top right)
  // so the card's glow can spill past the card's edge.
  function cybercabImage() {
    const layer = el('div', 'absolute inset-0 overflow-hidden rounded-[inherit] pointer-events-none');
    const img = document.createElement('img');
    img.src = 'images/dmv-cybercab.webp';
    img.alt = 'Cybercab (generic vehicle-type image, not a photo of this specific vehicle)';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'absolute right-[-10%] top-3 w-[62%] max-w-[260px] opacity-95 max-sm:top-2 max-sm:w-[58%]';
    layer.appendChild(img);
    return layer;
  }

  function card(v) {
    const li = el('li');
    const kind = KINDS[kindOf(v)];
    // Phones (max-sm:) get a compact two-column card.
    const a = el('a', 'vcard dmv-card group relative flex flex-col h-full min-w-0 rounded-2xl border p-5 max-sm:p-3 hover:-translate-y-0.5 transition-transform duration-300 ease-out');
    a.dataset.glow = kind.glow;   // BorderGlow (js/main.js), in the card's colour
    a.style.setProperty('--c', kind.rgb);
    a.style.borderColor = kind.hex + '59';
    a.style.background = `linear-gradient(135deg, ${kind.hex}1c, transparent 62%)`;
    a.href = '/vehicle/' + encodeURIComponent(v.id);
    if (approvedCybercab(v)) a.appendChild(cybercabImage());

    const top = el('div', 'relative');
    // Eyebrow: the model in its colour. An approved Cybercab gets the
    // "Cybercab" pill; any other vehicle its model line (or "not confirmed").
    const eyebrow = el('div', 'flex flex-wrap items-center gap-x-2 gap-y-1');
    if (approvedCybercab(v)) {
      eyebrow.appendChild(el('span', 'vcard-pill', 'Cybercab'));
    } else {
      const m = el('p', `flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${kind.text} [overflow-wrap:anywhere] max-sm:text-[10px]`);
      m.appendChild(el('span', 'w-1.5 h-1.5 rounded-full bg-current shrink-0'));
      m.appendChild(el('span', null, v.model || 'Model not confirmed'));
      eyebrow.appendChild(m);
    }
    // Dallas cars carry a Dallas tag (the Dallas launch) in place of the plain
    // city line (it would say Dallas twice).
    if (isDallas(v)) eyebrow.appendChild(el('span', 'vcard-city', 'Dallas'));
    top.appendChild(eyebrow);
    // The plate, styled like one (the same treatment as the Sightings cards).
    top.appendChild(el('h2', v.license_plate
      ? 'mt-3 inline-block font-display font-bold text-lg leading-none tracking-[0.18em] pl-2 pr-[calc(0.5rem-0.18em)] py-1.5 max-sm:mt-2 max-sm:text-sm max-sm:pl-1.5 max-sm:pr-[calc(0.375rem-0.18em)] max-sm:py-1 rounded-md bg-[#f4efe3] text-[#141008] border-2 border-[#1a1406]/80 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.6)] [overflow-wrap:anywhere]'
      : 'mt-3 font-display font-bold text-lg text-slate-400 max-sm:mt-2 max-sm:text-sm', v.license_plate || 'Plate not recorded'));
    // service_area is the record's own field; service_areas are the cities of its counted rides.
    const area = v.service_area || (v.service_areas ? String(v.service_areas).split(',').join(', ') : '');
    if (!isDallas(v)) top.appendChild(el('p', 'text-slate-500 text-xs mt-2 [overflow-wrap:anywhere] max-sm:text-[10px] max-sm:mt-1.5', area || 'Service area not recorded'));
    a.appendChild(top);

    // The ride count, large, in the card's light.
    const rides = el('div', 'relative mt-auto pt-6 max-sm:pt-3');
    const rl = el('div', 'flex items-baseline gap-2');
    rl.appendChild(el('span', 'dmv-card-num stat-value font-semibold text-4xl text-white leading-none max-sm:text-2xl', fmtInt(v.trip_count)));
    rl.appendChild(el('span', 'text-xs text-slate-400 max-sm:text-[10px]', v.trip_count === 1 ? 'ride' : 'rides'));
    rides.appendChild(el('div', 'vcard-label', 'Rides'));
    rides.appendChild(rl);
    a.appendChild(rides);

    // First/Last seen reflect the RIDE dates a receipt reported (v.first_ride_date/last_ride_date),
    // not when the registry row was created or last touched — those are ingestion timestamps
    // (v.first_seen_at/last_seen_at) that can be much later than the ride itself if a receipt was
    // imported well after the fact, and would otherwise show the wrong date here.
    const stats = el('div', 'relative grid grid-cols-3 gap-x-3 mt-4 pt-4 border-t border-white/[0.07] max-sm:grid-cols-1 max-sm:gap-y-2 max-sm:mt-3 max-sm:pt-2.5');
    stats.appendChild(stat('Distance', fmtMiles(v.total_distance), null, 'distance'));
    stats.appendChild(stat('First seen', fmtDate(v.first_ride_date), null, 'first'));
    stats.appendChild(stat('Last seen', fmtDate(v.last_ride_date), null, 'last'));
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
