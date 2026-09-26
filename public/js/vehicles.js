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

  // Generic Cybercab illustration, shown only once a moderator has approved
  // this vehicle as a Cybercab and saved its VIN (v.vin != null — see
  // worker/vehicles.js's apiListVehicles, which only ever forwards a vin for
  // a vehicle that already passed publicVehicleEligibleSql). It is the SAME
  // file for every vehicle, never a photo of that specific VIN. Built via
  // createElement/attribute assignment, never innerHTML, matching every
  // other element on this page.
  function cybercabImage() {
    const img = document.createElement('img');
    img.src = 'images/Cybercab2.png';
    img.alt = 'Cybercab (generic vehicle-type image, not a photo of this specific vehicle)';
    img.className = 'w-full h-32 object-contain mb-4';
    return img;
  }

  function card(v) {
    const li = el('li');
    const a = el('a', 'block glass rounded-2xl p-6 h-full hover:bg-white/5 transition-colors min-w-0');
    a.href = '/vehicle/' + encodeURIComponent(v.id);
    if (v.vin) a.appendChild(cybercabImage());
    a.appendChild(el('h2', 'font-display font-bold text-2xl tracking-tight [overflow-wrap:anywhere]', v.license_plate || 'Plate not recorded'));
    // A confirmed Cybercab (vin present) gets the same compact gold/yellow
    // badge used on the vehicle detail page (vCybercabBadge), never plain
    // text — matching styles exactly rather than inventing a new treatment.
    // An unconfirmed vehicle keeps the existing plain-text model line as-is.
    if (v.vin) {
      a.appendChild(el('span', 'inline-block mt-1 text-xs font-bold px-3 py-1.5 rounded-full border border-[rgba(212,175,55,0.35)] text-slate-200 uppercase tracking-wide', 'Cybercab'));
    } else {
      a.appendChild(el('p', 'text-slate-400 text-sm mt-1 [overflow-wrap:anywhere]', v.model || 'Model not confirmed'));
    }
    // service_area is the record's own field; service_areas are the cities of its counted rides.
    const area = v.service_area || (v.service_areas ? String(v.service_areas).split(',').join(', ') : '');
    a.appendChild(el('p', 'text-slate-500 text-xs mt-1 [overflow-wrap:anywhere]', area || 'Service area not recorded'));
    const stats = el('div', 'grid grid-cols-2 gap-4 mt-5 pt-4 border-t border-[rgba(212,175,55,0.12)]');
    stats.appendChild(stat('Rides', fmtInt(v.trip_count)));
    stats.appendChild(stat('Recorded distance', fmtMiles(v.total_distance)));
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
