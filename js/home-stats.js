/* Homepage statistics (index.html "Stats bar"). The two numbers come from ONE
   public endpoint, GET /api/registry/stats (worker/vehicles.js): how many
   vehicles are in the public registry and how many recorded rides belong to
   exactly those vehicles. Nothing on this bar is hard-coded.
   A tile starts as an em dash and only ever becomes a number the server sent.
   If the request fails, or the value is not a whole number >= 0, it STAYS an
   em dash: "could not load" is not the same as zero, and a real zero (an empty
   registry) is shown as 0. Like js/vehicle.js this reads no session and sends
   no Authorization header. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const TILES = [['statVehicles', 'public_vehicles'], ['statRides', 'recorded_rides']];

  const isCount = n => typeof n === 'number' && Number.isInteger(n) && n >= 0;

  function reveal(el, n) {
    el.dataset.value = String(n);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animate = () => {
      if (typeof CCC !== 'undefined' && CCC.animateCounter) CCC.animateCounter(el, 0, n, 1400);
      else el.textContent = n.toLocaleString();
    };
    if (still || typeof IntersectionObserver !== 'function') { el.textContent = n.toLocaleString(); return; }
    // Same behavior as before: count up once, when the tile scrolls into view.
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { io.disconnect(); animate(); }
    }, { threshold: 0.4 });
    io.observe(el);
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
})();
