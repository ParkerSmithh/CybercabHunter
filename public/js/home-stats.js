/* Homepage statistics (index.html "Stats bar"). Vehicles and rides come from
   GET /api/registry/stats (worker/vehicles.js): how many vehicles are in the
   public registry and how many recorded rides belong to exactly those
   vehicles. Sightings is every city's approved sightings (GET /api/sightings),
   kept live (below). Nothing on this bar is hard-coded.
   A tile starts as an em dash and only ever becomes a number the server sent.
   If the request fails, or the value is not a whole number >= 0, it STAYS an
   em dash: "could not load" is not the same as zero, and a real zero (an empty
   registry) is shown as 0. Like js/vehicle.js this reads no session and sends
   no Authorization header. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const TILES = [['statVehicles', 'public_vehicles'], ['statRides', 'recorded_rides']];

  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;

  // The tiles are deliberately NOT live regions (no aria-live / role=status); they are ordinary text, so the
  // value is read normally. tests/registry-stats.test.mjs guards this.
  // The number is written straight away, the moment it arrives: the stats bar is already on the page when it
  // loads, with no count-up and nothing waiting for it to scroll into view.
  function reveal(el, n) {
    el.dataset.value = String(n);
    el.textContent = n.toLocaleString();
  }

  fetch(WORKER + '/api/registry/stats')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))))
    .then(body => {
      for (const [id, key] of TILES) {
        const el = document.getElementById(id);
        if (el && body && isCount(body[key])) reveal(el, body[key]);
      }
    })
    .catch(() => { /* leave the dashes */ });

  // Sightings: approved sightings in every city (GET /api/sightings?city=all,
  // worker/sightings-public.js — its `seen`, the Sightings page's own count).
  // Kept current: re-read every 30s while the tab is visible (the answer is
  // edge-cached for 30s), and at once when the tab comes back. A failed read
  // keeps the last good number (or the dash).
  const SIGHTINGS_POLL_MS = 30 * 1000;
  let sightingsTimer = null;
  function loadSightings() {
    fetch(WORKER + '/api/sightings?city=all&limit=1')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status))))
      .then(body => {
        const el = document.getElementById('statSightings');
        if (el && body && isCount(body.seen) && el.dataset.value !== String(body.seen)) reveal(el, body.seen);
      })
      .catch(() => { /* keep what is shown */ });
  }
  function startSightings() {
    if (sightingsTimer) clearInterval(sightingsTimer);
    sightingsTimer = document.hidden ? null : setInterval(loadSightings, SIGHTINGS_POLL_MS);
  }
  loadSightings();
  startSightings();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadSightings();
    startSightings();
  });
})();
