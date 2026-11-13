/* Zone Warp: the Zones page's city-to-city camera move (infrastructure.html).
   Camera only: no extra layers, sources or effects. One MapLibre flyTo per
   switch: the camera pulls back from the current zone, travels, and zooms in,
   with an ease-in-out so it accelerates and settles naturally, ending on
   exactly the framing the page asks for (cameraForBounds of the zone; bearing
   and pitch as the page uses them). Duration scales with the distance
   (center to center):
     local  < 30 km    ~750 ms  (phones ~650)
     near   < 150 km   ~1100 ms (~950)
     far               ~1800 ms (~1500)   e.g. Austin <-> Dallas
   A new selection mid-flight starts a new flight from wherever the camera is
   (flyTo stops the previous one; nothing queues). A drag, pinch or wheel by
   the rider stops the flight (MapLibre's own behaviour); nothing fights it.
   Reduce Motion: an immediate jump to the same framing. Before the map has
   loaded (e.g. opening on ?city=dallas), or on a map without the camera API:
   the instant fitBounds the page always used.

   Readiness is "the map has fired load", never isStyleLoaded(): that one is
   false whenever any source is reloading (any setData), which made every
   switch after the first fall back to the instant jump. */
window.CCCZoneWarp = (function () {
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function isCompact() {
    try { return window.matchMedia ? window.matchMedia('(max-width: 1023px)').matches : window.innerWidth < 1024; } catch (e) { return false; }
  }

  // Great-circle distance in km.
  function distanceKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // The trip: how far and how long. curve: how far the camera pulls back
  // (MapLibre's flyTo; ~1.42 is its default).
  function plan(km, compact) {
    if (km < 30) return { kind: 'local', duration: compact ? 650 : 750, curve: 1.2 };
    if (km < 150) return { kind: 'near', duration: compact ? 950 : 1100, curve: 1.35 };
    return { kind: 'far', duration: compact ? 1500 : 1800, curve: 1.45 };
  }

  /* attach(map, { padding: () => paddingOrNumber }) → { go(city, bounds) } */
  function attach(map, opts = {}) {
    const padding = typeof opts.padding === 'function' ? opts.padding : () => opts.padding || 0;
    let loaded = false;
    try { loaded = typeof map.loaded === 'function' && map.loaded(); } catch (e) { loaded = false; }
    if (typeof map.on === 'function') map.on('load', () => { loaded = true; });

    const canAnimate = () => loaded && typeof map.flyTo === 'function' && typeof map.cameraForBounds === 'function';
    const instant = (bounds, pad) => { if (typeof map.fitBounds === 'function') map.fitBounds(bounds, { padding: pad, animate: false }); };

    function go(city, bounds) {
      const pad = padding();
      if (!canAnimate()) { instant(bounds, pad); return { animated: false }; }
      const target = map.cameraForBounds(bounds, { padding: pad });
      if (!target || !target.center) { instant(bounds, pad); return { animated: false }; }
      const camera = { center: target.center, zoom: target.zoom, bearing: target.bearing || 0, pitch: 0 };
      if (prefersReducedMotion()) { map.jumpTo(camera); return { animated: false, reducedMotion: true }; }
      const to = typeof target.center.lng === 'number' ? target.center : { lng: target.center[0], lat: target.center[1] };
      const trip = plan(distanceKm(map.getCenter(), to), isCompact());
      map.flyTo({ ...camera, duration: trip.duration, curve: trip.curve, easing: easeInOutCubic, essential: false });
      return { animated: true, trip };
    }

    return { go };
  }

  return { attach, plan, distanceKm };
})();
