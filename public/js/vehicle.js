/* Public vehicle page. Unlike every other page/*.js in this project, this
   one is NOT signed-in state — it never reads a session, never sends an
   Authorization header, and calls only the one public endpoint:
   GET /api/robotaxi-vehicles/:id (worker/vehicles.js), which is itself
   public and privacy-tested.
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

    // The Cybercab badge and the generic image both key off vin alone — set
    // only once a moderator has approved this vehicle as a Cybercab
    // (worker/vehicles.js only ever forwards a vin for an already
    // publicly-eligible vehicle) — never inferred here. An ordinary approved
    // vehicle with no vin gets no badge, since Cybercab Hunter never claims
    // a classification it hasn't verified.
    show('vCybercabBadge', !!v.vin);
    show('vCybercabImage', !!v.vin);

    // One plain-text summary line built only from the facts actually on
    // record, joined with " · " — never a fixed template with "Not
    // recorded" filler for whatever is missing.
    const clauses = [];
    if (v.service_area) clauses.push(`Operating in ${v.service_area}`);
    if (v.color) clauses.push(`${v.color} exterior`);
    if (v.vin) clauses.push(`VIN ${v.vin}`);
    $('vSummaryLine').textContent = clauses.join(' · ');
    show('vSummaryLine', clauses.length > 0);

    $('vTripCount').textContent = fmtInt(h.trip_count);
    $('vTotalDistance').textContent = fmtMiles(h.total_distance);
    $('vFirstRide').textContent = fmtDate(h.first_ride_date);
    $('vLastRide').textContent = fmtDate(h.last_ride_date);
    $('vServiceAreasNote').textContent = h.service_areas
      ? `Recorded in: ${h.service_areas.split(',').join(', ')}.`
      : 'No service area recorded for these rides yet.';

    document.title = `${v.license_plate || 'Vehicle'} — Cybercab Hunter`;
    setShare(v);
  }

  // ---------- share ----------
  // Same wording rules as the share card (worker/og-card.js): "Cybercab" only
  // with a moderator-recorded VIN, the city only when it's a known one.
  const CITIES = { austin: 'Austin, TX', dallas: 'Dallas, TX', houston: 'Houston, TX', 'san antonio': 'San Antonio, TX' };
  let share = null;

  function setShare(v) {
    const city = CITIES[String(v.service_area || '').trim().replace(/\s+/g, ' ').toLowerCase()];
    const kind = v.vin ? 'Tesla Cybercab' : 'Tesla Robotaxi';
    const plate = v.license_plate || 'a vehicle';
    // The canonical page URL: no query string or fragment from however this
    // visit arrived.
    const url = `${location.origin}/vehicle/${encodeURIComponent(v.id)}`;
    const text = `I spotted ${plate} — a ${kind}${city ? ` in ${city}` : ''}`;
    // The share card image (worker/og-card.js) — same origin as this page,
    // so it can be fetched into a File and saved with a download link.
    const cardUrl = `${location.origin}/api/og/vehicle/${encodeURIComponent(v.id)}.png`;
    const fileName = `${String(v.license_plate || 'vehicle').replace(/[^A-Za-z0-9-]/g, '')}-cybercab-hunter.png`;
    share = { title: `${plate} — Cybercab Hunter`, text, url, cardUrl, fileName, file: null };
    $('vCardPreview').src = cardUrl;
    $('vCardPreview').alt = `Share card: ${text}`;
    ['vCardDownload', 'vShareDownload'].forEach(id => { $(id).href = cardUrl; $(id).setAttribute('download', fileName); });
    prepareCardFile(share);
    $('vShareX').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    $('vShareFacebook').href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  }

  function note(message, type) {
    if (typeof CCC !== 'undefined' && CCC.toast) CCC.toast(message, type);
  }

  function setMenu(open) {
    show('vShareMenu', open);
    $('vShareBtn').setAttribute('aria-expanded', String(open));
  }

  // Phones that can share files (Web Share API level 2) get the card image
  // itself, so it can go straight into Instagram, X, Facebook or Messages.
  // Fetched ahead of time: the share must start inside the tap, and some
  // browsers (iOS Safari) cancel it if a download is awaited first.
  async function prepareCardFile(s) {
    if (!navigator.canShare) return;
    try {
      const resp = await fetch(s.cardUrl);
      if (!resp.ok) return;
      const file = new File([await resp.arrayBuffer()], s.fileName, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) s.file = file;
    } catch (e) { /* link sharing still works */ }
  }

  async function onShare() {
    if (!share) return;
    if (share.file) {
      // Apps that take an image (Instagram) ignore the text; the others keep
      // the link in it.
      try { await navigator.share({ files: [share.file], title: share.title, text: `${share.text} ${share.url}` }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }  // otherwise fall back to sharing the link
    }
    if (navigator.share) {
      try { await navigator.share(share); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }  // dismissed: nothing to do
    }
    setMenu($('vShareMenu').classList.contains('hidden'));
  }

  async function copyLink() {
    setMenu(false);
    try {
      await navigator.clipboard.writeText(share.url);
      note('Link copied', 'success');
    } catch (e) {
      window.prompt('Copy this link:', share.url);
    }
  }

  function initShare() {
    $('vShareBtn').addEventListener('click', onShare);
    $('vShareCopy').addEventListener('click', copyLink);
    ['vShareX', 'vShareFacebook', 'vShareDownload'].forEach(id => $(id).addEventListener('click', () => setMenu(false)));
    document.addEventListener('click', e => {
      if (!e.target.closest('#vShareBtn, #vShareMenu')) setMenu(false);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
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
    initShare();
    $('vehicleRetry').addEventListener('click', () => load(vehicleId));
    load(vehicleId);
  }

  init();
})();
