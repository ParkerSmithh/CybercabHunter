/* Homepage headline counts are lifetime counters for the public registry,
   recorded rides and approved human/camera sightings. City-specific detail rows continue using the shared city loader.
   Failed refreshes retain the last good value; initial failures keep a dash. */
(function () {
  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  const TOTALS_POLL_MS = 30 * 1000;
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
  const $ = id => document.getElementById(id);

  function loadTotals() {
    // A versioned, uncached request cannot reuse a pre-counter API payload.
    fetch('/api/registry/stats?lifetime=1', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))))
      .then(body => {
        if (!body || typeof body !== 'object') return;
        for (const [id, n] of [['statVehicles', body.public_vehicles], ['statRides', body.recorded_rides], ['statSightings', body.sightings_all_time]]) {
          const el = $(id);
          if (el && isCount(n) && el.dataset.value !== String(n)) reveal(el, n);
        }
      }).catch(() => { /* retain the last good totals; a failed read is not zero */ });
  }

  let totalsTimer = null;
  function startTotals() {
    if (totalsTimer) clearInterval(totalsTimer);
    totalsTimer = document.hidden ? null : setInterval(loadTotals, TOTALS_POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadTotals();
    startTotals();
  });

  loadTotals();
  startTotals();
})();
