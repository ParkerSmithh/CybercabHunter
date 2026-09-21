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
  function fmtDateTime(sqlTs) {
    if (!sqlTs) return '—';
    const dt = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
    return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  let loaded = 0;      // vehicles shown so far (the next offset)
  let total = 0;
  let busy = false;

  function setView(view) {
    show('regLoading', view === 'loading');
    show('regEmpty', view === 'empty');
    show('regError', view === 'error');
    show('regLoaded', view === 'loaded');
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function stat(label, value) {
    const box = el('div', 'min-w-0');
    box.appendChild(el('div', 'text-[11px] text-slate-500 uppercase tracking-wider mb-0.5', label));
    box.appendChild(el('div', 'text-sm font-semibold [overflow-wrap:anywhere]', value));
    return box;
  }

  function card(v) {
    const li = el('li');
    const a = el('a', 'block glass rounded-2xl p-6 h-full hover:bg-white/5 transition-colors min-w-0');
    a.href = '/vehicle/' + encodeURIComponent(v.id);
    a.appendChild(el('h2', 'font-display font-bold text-2xl tracking-tight [overflow-wrap:anywhere]', v.license_plate || 'Plate not recorded'));
    a.appendChild(el('p', 'text-slate-400 text-sm mt-1 [overflow-wrap:anywhere]', v.model || 'Model not confirmed'));
    // service_area is the record's own field; service_areas are the cities of its counted rides.
    const area = v.service_area || (v.service_areas ? String(v.service_areas).split(',').join(', ') : '');
    a.appendChild(el('p', 'text-slate-500 text-xs mt-1 [overflow-wrap:anywhere]', area || 'Service area not recorded'));
    const stats = el('div', 'grid grid-cols-3 gap-4 mt-5 pt-4 border-t border-[rgba(212,175,55,0.12)]');
    stats.appendChild(stat('Rides', fmtInt(v.trip_count)));
    stats.appendChild(stat('First seen', fmtDateTime(v.first_seen_at)));
    stats.appendChild(stat('Last seen', fmtDateTime(v.last_seen_at)));
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
    const resp = await fetch(`${WORKER}/api/robotaxi-vehicles?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!resp.ok) throw new Error('http_' + resp.status);
    const body = await resp.json();
    if (!body || !Array.isArray(body.vehicles)) throw new Error('bad_body');
    return body;
  }

  async function loadFirst() {
    setView('loading');
    $('regList').textContent = '';
    loaded = 0;
    try {
      const body = await fetchPage(0);
      total = Number(body.total) || 0;
      if (!body.vehicles.length) { setView('empty'); return; }
      render(body.vehicles);
      setView('loaded');
    } catch (e) {
      setView('error');
    }
  }

  async function loadMore() {
    if (busy) return;
    busy = true; show('regMoreError', false);
    $('regMore').disabled = true;
    try {
      const body = await fetchPage(loaded);
      total = Number(body.total) || total;
      render(body.vehicles);
      if (!body.vehicles.length) show('regMore', false);   // nothing further (the list shrank)
    } catch (e) {
      show('regMoreError', true);
    } finally {
      busy = false; $('regMore').disabled = false;
    }
  }

  $('regRetry').addEventListener('click', loadFirst);
  $('regMore').addEventListener('click', loadMore);
  $('regMoreRetry').addEventListener('click', loadMore);
  loadFirst();
})();
