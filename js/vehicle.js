/* Public vehicle page. Unlike every other page/*.js in this project, this
   one is NOT signed-in state — it never reads a session, never sends an
   Authorization header, and calls only public endpoints:
   GET /api/robotaxi-vehicles/:id (worker/vehicles.js), which is itself
   public and privacy-tested — plus, once that vehicle has loaded, the
   equally public GET /api/robotaxi-vehicles/:id/sightings for the
   Community Sightings section. No other API is called from this file.
   States: invalid (the URL itself has no usable id) / loading / notFound /
   error (network/server) / loaded. Missing values render as an em dash,
   never as 0 — matching every other page here. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  // Every API-sourced value on this page goes in through .textContent, never
  // .innerHTML — there's no per-item list markup to template here (unlike
  // js/rider-data.js's renderCities/renderVehicles), so there's no HTML
  // string-building step for a plate/model/color to sneak into in the first
  // place. textContent never interprets its argument as markup, so this is
  // safe against XSS regardless of what the API returns.

  // ---------- formatting (same conventions as js/rider-data.js) ----------
  const fmtInt = n => (n == null ? '—' : Number(n).toLocaleString());
  const fmtMiles = mi => (mi == null ? '—' : Number(mi).toFixed(1) + ' mi');
  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(sqlTs) {
    if (!sqlTs) return '—';
    const dt = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
    return isNaN(dt) ? '—' : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // "2026-09-18" -> "September 18, 2026". Parsed as a calendar date, not an
  // instant, so it can't shift a day with the viewer's timezone.
  function fmtLongDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return '';
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(dt) ? '' : dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  // ---------- view state ----------
  function setView(view) {
    show('vehicleLoading', view === 'loading');
    show('vehicleInvalid', view === 'invalid');
    show('vehicleNotFound', view === 'notFound');
    show('vehicleError', view === 'error');
    show('vehicleLoaded', view === 'loaded');
  }

  // The id comes only from the URL path — never a query param, never any
  // stored/rider-specific value. A path that doesn't match this shape is
  // treated as an invalid link before any network request is made.
  function extractVehicleId() {
    const m = location.pathname.match(/^\/vehicle\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function renderVehicle(body) {
    const v = body.vehicle, h = body.history;

    $('vLicensePlate').textContent = v.license_plate || 'Plate unknown';
    $('vModelLine').textContent = v.model || 'Model not confirmed';
    $('vVerificationNote').textContent = v.verification_status === 'unverified'
      ? 'Verification: Not independently verified by Cybercab Hunter.'
      : `Verification: ${v.verification_status || 'unknown'}`;

    $('vProvider').textContent = v.provider || '—';
    $('vColor').textContent = v.color || 'Not recorded';
    $('vServiceArea').textContent = v.service_area || 'Not recorded';
    $('vFirstSeen').textContent = fmtDateTime(v.first_seen_at);
    $('vLastSeen').textContent = fmtDateTime(v.last_seen_at);

    // A vin is present only once a moderator has approved this vehicle as a
    // Cybercab and saved its VIN (worker/vehicles.js only ever forwards one
    // for an already publicly-eligible vehicle). The image is the same
    // generic Cybercab2.png for every vehicle — never a photo of this
    // specific VIN — and, like vin itself, is simply absent otherwise.
    show('vVinRow', !!v.vin);
    show('vCybercabImage', !!v.vin);
    $('vVin').textContent = v.vin || '';

    $('vTripCount').textContent = fmtInt(h.trip_count);
    $('vTotalDistance').textContent = fmtMiles(h.total_distance);
    $('vFirstRide').textContent = fmtDate(h.first_ride_date);
    $('vLastRide').textContent = fmtDate(h.last_ride_date);
    $('vServiceAreasNote').textContent = h.service_areas
      ? `Recorded in: ${h.service_areas.split(',').join(', ')}.`
      : 'No service area recorded for these rides yet.';

    document.title = `${v.license_plate || 'Vehicle'} — Cybercab Hunter`;
  }

  // ---------- community sightings ----------
  // Independent of the vehicle card: a failure here only swaps this one
  // section into its own error state and never touches the rest of the page.
  // Entries are built with createElement + textContent — nothing from the
  // API is ever parsed as markup.
  function setSightingsView(view) {
    show('vSightingsLoading', view === 'loading');
    show('vSightingsEmpty', view === 'empty');
    show('vSightingsError', view === 'error');
    show('vSightingsList', view === 'list');
  }

  function renderSightings(sightings) {
    const list = $('vSightingsList');
    list.textContent = '';
    for (const s of sightings) {
      const li = document.createElement('li');
      li.className = 'rounded-xl border border-[rgba(212,175,55,0.15)] bg-white/5 px-4 py-3 [overflow-wrap:anywhere]';
      const head = document.createElement('div');
      head.className = 'text-sm font-semibold';
      head.textContent = [s.service_area, fmtLongDate(s.date)].filter(Boolean).join(' · ');
      const sub = document.createElement('div');
      sub.className = 'text-xs text-slate-500 mt-0.5';
      sub.textContent = 'Community sighting';
      li.append(head, sub);
      list.appendChild(li);
    }
  }

  async function loadSightings(vehicleId) {
    setSightingsView('loading');
    try {
      const resp = await fetch(`${WORKER}/api/robotaxi-vehicles/${encodeURIComponent(vehicleId)}/sightings`);
      if (!resp.ok) throw new Error('status ' + resp.status);
      const body = await resp.json();
      const sightings = Array.isArray(body && body.sightings) ? body.sightings : null;
      if (!sightings) throw new Error('unexpected body');
      if (sightings.length === 0) { setSightingsView('empty'); return; }
      renderSightings(sightings);
      setSightingsView('list');
    } catch (e) {
      setSightingsView('error');
    }
  }

  async function load(vehicleId) {
    setView('loading');
    let resp;
    try {
      resp = await fetch(`${WORKER}/api/robotaxi-vehicles/${encodeURIComponent(vehicleId)}`);
    } catch (e) {
      // Network failure — distinct from a 404: the request never completed.
      $('vehicleErrorDetail').textContent = "Something went wrong reaching the server. Check your connection and try again.";
      setView('error');
      return;
    }

    if (resp.status === 400) { setView('invalid'); return; }
    if (resp.status === 404) { setView('notFound'); return; }
    if (!resp.ok) {
      $('vehicleErrorDetail').textContent = `The server had a problem (code ${resp.status}). Try again in a moment.`;
      setView('error');
      return;
    }

    let body;
    try {
      body = await resp.json();
    } catch (e) {
      $('vehicleErrorDetail').textContent = 'The server sent back something unexpected. Try again in a moment.';
      setView('error');
      return;
    }

    renderVehicle(body);
    setView('loaded');
    loadSightings(vehicleId);
  }

  function init() {
    const vehicleId = extractVehicleId();
    if (!vehicleId) { setView('invalid'); return; }
    $('vehicleRetry').addEventListener('click', () => load(vehicleId));
    $('vSightingsRetry').addEventListener('click', () => loadSightings(vehicleId));
    load(vehicleId);
  }

  init();
})();
