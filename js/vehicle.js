/* Public vehicle page. Unlike every other page/*.js in this project, this
   one is NOT signed-in state — it never reads a session, never sends an
   Authorization header, and calls exactly one endpoint:
   GET /api/robotaxi-vehicles/:id (worker/vehicles.js), which is itself
   public and privacy-tested. No other API is called from this file.
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

    $('vTripCount').textContent = fmtInt(h.trip_count);
    $('vTotalDistance').textContent = fmtMiles(h.total_distance);
    $('vFirstRide').textContent = fmtDate(h.first_ride_date);
    $('vLastRide').textContent = fmtDate(h.last_ride_date);
    $('vServiceAreasNote').textContent = h.service_areas
      ? `Recorded in: ${h.service_areas.split(',').join(', ')}.`
      : 'No service area recorded for these rides yet.';

    document.title = `${v.license_plate || 'Vehicle'} — Cybercab Hunter`;
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
  }

  function init() {
    const vehicleId = extractVehicleId();
    if (!vehicleId) { setView('invalid'); return; }
    $('vehicleRetry').addEventListener('click', () => load(vehicleId));
    load(vehicleId);
  }

  init();
})();
