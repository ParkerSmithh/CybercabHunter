/* Homepage statistics (index.html "Stats bar") and the shared loader for the
   homepage's city rows (js/home-rows.js).
   The bar follows the page's Austin / Dallas tabs: each tile shows the selected
   city, with the all-cities total on a line beneath it.
     Cybercabs Spotted / Total Rides: GET /api/homepage-stats?city= (worker/
       homepage-stats.js) — `hero.city` and `hero.all` (the registry rules).
     Sightings: approved sightings, kept live — re-read every 30s while the tab
       is visible and at once on return (GET /api/sightings?city=<city>|all,
       its `seen`, the Sightings page's own count).
   Nothing on this bar is hard-coded. A tile starts as an em dash and only ever
   becomes a number the server sent; a failed read keeps the dash (or the last
   good number): "could not load" is not the same as zero, and a real zero is
   shown as 0. Same origin; no session, no Authorization header. */
(function () {
  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  const SIGHTINGS_POLL_MS = 30 * 1000;
  const DATA_TTL_MS = 5 * 60 * 1000;

  // ---- The homepage data, one request per city, kept 5 minutes ----
  const cache = new Map();   // city -> { at, promise }
  function getCity(city) {
    const hit = cache.get(city);
    if (hit && Date.now() - hit.at < DATA_TTL_MS) return hit.promise;
    const promise = fetch(`/api/homepage-stats?city=${encodeURIComponent(city)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))))
      .catch(e => { cache.delete(city); throw e; });
    cache.set(city, { at: Date.now(), promise });
    return promise;
  }
  window.CCHHomeData = { get: getCity };

  // The tiles are deliberately NOT live regions (no aria-live / role=status); they are ordinary text, so the
  // value is read normally. tests/registry-stats.test.mjs guards this.
  // The number is written straight away, the moment it arrives.
  function reveal(el, n) {
    if (!el) return;
    el.dataset.value = String(n);
    el.textContent = n.toLocaleString();
  }
  function dash(el) { if (el) { delete el.dataset.value; el.textContent = '—'; } }
  const $ = id => document.getElementById(id);

  let city = 'austin', seq = 0;
  function setCity(next) {
    city = next === 'dallas' ? 'dallas' : 'austin';
    const mine = ++seq;
    const label = $('statCityLabel');
    if (label) label.textContent = city === 'dallas' ? 'Dallas' : 'Austin';
    // Until this city's numbers arrive, its tiles show a dash, never the other city's.
    ['statVehicles', 'statRides', 'statSightings'].forEach(id => dash($(id)));
    getCity(city).then(body => {
      if (mine !== seq || !body || !body.hero) return;
      const c = body.hero.city || {}, a = body.hero.all || {};
      if (isCount(c.vehicles)) reveal($('statVehicles'), c.vehicles);
      if (isCount(c.rides)) reveal($('statRides'), c.rides);
      if (isCount(a.vehicles)) reveal($('statVehiclesAll'), a.vehicles);
      if (isCount(a.rides)) reveal($('statRidesAll'), a.rides);
    }).catch(() => { /* leave the dashes */ });
    loadSightings();
  }

  // ---- Sightings: live for the selected city and for all cities ----
  let sightingsTimer = null;
  function loadSightings() {
    const want = city;
    const read = q => fetch(`/api/sightings?city=${q}&limit=1`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))));
    read(want).then(body => {
      const el = $('statSightings');
      if (want === city && el && body && isCount(body.seen) && el.dataset.value !== String(body.seen)) reveal(el, body.seen);
    }).catch(() => { /* keep what is shown */ });
    read('all').then(body => {
      const el = $('statSightingsAll');
      if (el && body && isCount(body.seen) && el.dataset.value !== String(body.seen)) reveal(el, body.seen);
    }).catch(() => { /* keep what is shown */ });
  }
  function startSightings() {
    if (sightingsTimer) clearInterval(sightingsTimer);
    sightingsTimer = document.hidden ? null : setInterval(loadSightings, SIGHTINGS_POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadSightings();
    startSightings();
  });

  window.setHomeStatsCity = setCity;
  setCity('austin');
  startSightings();
})();
