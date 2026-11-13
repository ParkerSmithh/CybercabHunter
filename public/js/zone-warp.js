/* Zone Warp: the Zones page's city-to-city camera move (infrastructure.html).
   MapLibre's own camera animations do the travel; three small map layers,
   invisible between switches, carry the effects:
     - warp-edge-<city>: a soft gold glow along a zone's boundary (the zone's own
       source; its geometry, colours and data are never changed)
     - warp-trace: the Golden Route Trace, a thin gold line from where the view
       was toward the destination, drawn only on long trips and gone before
       arrival (a direction of travel, not a road route or a service link)
     - warp-ring: one thin gold ring that expands from the destination and fades
   Choreography, scaled to the distance (center to center):
     local  < 30 km   glide (easeTo)             ~700 ms (phones ~560)
     near   < 150 km  flight, gentle zoom-out    ~1150 ms (~950)
     far              flight, wider zoom-out     ~1900 ms (~1500) + route trace
   Disengage (the zone being left glows, then fades), travel, destination lock
   (ring + the destination boundary glows once), settle on the exact framing the
   page asked for (cameraForBounds of the zone). A new selection cancels the old
   one; a drag/zoom/rotate by the rider stops the effects and the camera (no
   fighting); Reduce Motion jumps straight there with no effects; without a
   ready map it falls back to an instant fitBounds. No requests, no timers left
   behind: one requestAnimationFrame loop runs only during a transition. */
window.CCCZoneWarp = (function () {
  const GOLD = [250, 224, 48];
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  // A 0→1→0 bump between a and d (rising a→b, holding b→c, falling c→d).
  function bump(t, a, b, c, d) {
    if (t <= a || t >= d) return 0;
    if (t < b) return (t - a) / (b - a);
    if (t <= c) return 1;
    return 1 - (t - c) / (d - c);
  }

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

  // The trip: how far, how long, which effects.
  function plan(km, compact) {
    if (km < 30) return { kind: 'local', duration: compact ? 560 : 700, trace: false, curve: 1 };
    if (km < 150) return { kind: 'near', duration: compact ? 950 : 1150, trace: false, curve: 1.2 };
    return { kind: 'far', duration: compact ? 1500 : 1900, trace: true, curve: 1.5 };
  }

  // The trace's look at progress `head` (0..1 along the line) and opacity `a`:
  // a bright head, a short fading tail, nothing ahead of it.
  function traceGradient(head, a) {
    const stops = [0, rgba(GOLD, 0)];
    const add = (p, color) => { if (p > stops[stops.length - 2] + 1e-4 && p < 1) stops.push(p, color); };
    if (head > 0.02 && a > 0) {
      add(Math.max(0, head - 0.4), rgba(GOLD, 0));
      add(head - 0.012, rgba(GOLD, 0.85 * a));
      add(head, rgba([255, 247, 196], a));
      add(head + 0.002, rgba(GOLD, 0));
    }
    stops.push(1, rgba(GOLD, 0));
    return ['interpolate', ['linear'], ['line-progress'], ...stops];
  }

  /* attach(map, { sources: { austin: 'service-zone', dallas: 'service-zone-dallas' },
                   padding: () => paddingOrNumber })
     → { go(city, bounds, fromCity), cancel(), busy() } */
  function attach(map, opts = {}) {
    const sources = opts.sources || {};
    const padding = typeof opts.padding === 'function' ? opts.padding : () => opts.padding || 0;
    let token = 0, frame = 0, ready = false, active = null;

    const canAnimate = () => typeof map.flyTo === 'function' && typeof map.easeTo === 'function' && typeof map.cameraForBounds === 'function'
      && typeof map.addLayer === 'function' && typeof map.setPaintProperty === 'function'
      && (typeof map.isStyleLoaded !== 'function' || map.isStyleLoaded());

    function ensureLayers() {
      if (ready) return true;
      try {
        for (const [city, source] of Object.entries(sources)) {
          if (!map.getSource || !map.getSource(source)) return false;
          if (!map.getLayer('warp-edge-' + city)) {
            map.addLayer({ id: 'warp-edge-' + city, type: 'line', source, layout: { 'line-join': 'round' },
              paint: { 'line-color': rgba(GOLD, 1), 'line-width': 5, 'line-blur': 2.5, 'line-opacity': 0 } });
          }
        }
        if (!map.getSource('warp-trace')) map.addSource('warp-trace', { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } });
        if (!map.getLayer('warp-trace')) {
          map.addLayer({ id: 'warp-trace', type: 'line', source: 'warp-trace', layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-width': 1.6, 'line-gradient': traceGradient(0, 0) } });
        }
        if (!map.getSource('warp-ring')) map.addSource('warp-ring', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        if (!map.getLayer('warp-ring')) {
          map.addLayer({ id: 'warp-ring', type: 'circle', source: 'warp-ring',
            paint: { 'circle-radius': 0, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': rgba(GOLD, 1), 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0, 'circle-pitch-alignment': 'map' } });
        }
        ready = true;
      } catch (e) { ready = false; }
      return ready;
    }

    const set = (layer, prop, value) => { try { if (map.getLayer(layer)) map.setPaintProperty(layer, prop, value); } catch (e) { /* the style changed under us */ } };
    const setData = (source, data) => { try { const s = map.getSource(source); if (s && s.setData) s.setData(data); } catch (e) { /* ignore */ } };
    const EMPTY = { type: 'FeatureCollection', features: [] };

    // Every effect off: nothing lingers after a transition, a cancel or a drag.
    function clearEffects() {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      active = null;
      if (!ready) return;
      for (const city of Object.keys(sources)) set('warp-edge-' + city, 'line-opacity', 0);
      set('warp-trace', 'line-gradient', traceGradient(0, 0));
      setData('warp-trace', EMPTY);
      set('warp-ring', 'circle-stroke-opacity', 0);
      set('warp-ring', 'circle-radius', 0);
      setData('warp-ring', EMPTY);
    }

    function cancel() { token++; clearEffects(); }

    // A drag, pinch, wheel or rotate by the rider: stop decorating and let them
    // drive (MapLibre itself stops the camera animation on their input).
    if (typeof map.on === 'function') {
      map.on('movestart', e => { if (active && e && e.originalEvent) cancel(); });
    }

    function go(city, bounds, fromCity) {
      const my = ++token;
      clearEffects();
      const pad = padding();
      if (!canAnimate()) {
        if (typeof map.fitBounds === 'function') map.fitBounds(bounds, { padding: pad, animate: false });
        return { animated: false };
      }
      const target = map.cameraForBounds(bounds, { padding: pad });
      if (!target || !target.center) {
        map.fitBounds(bounds, { padding: pad, animate: false });
        return { animated: false };
      }
      const camera = { center: target.center, zoom: target.zoom, bearing: target.bearing || 0, pitch: 0 };
      if (prefersReducedMotion()) {
        map.jumpTo(camera);
        return { animated: false, reducedMotion: true };
      }
      const from = map.getCenter();
      const to = typeof target.center.lng === 'number' ? target.center : { lng: target.center[0], lat: target.center[1] };
      const trip = plan(distanceKm(from, to), isCompact());
      if (trip.kind === 'local') map.easeTo({ ...camera, duration: trip.duration, easing: easeInOutCubic, essential: false });
      else map.flyTo({ ...camera, duration: trip.duration, curve: trip.curve, easing: easeInOutCubic, essential: false });

      const effects = ensureLayers();
      if (!effects) return { animated: true, trip };
      const compact = isCompact();
      const ringMax = compact ? 80 : 130;
      if (trip.trace) {
        setData('warp-trace', { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] } });
      }
      setData('warp-ring', { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [to.lng, to.lat] } });
      const D = trip.duration, total = D + 380, start = performance.now();
      const leaving = fromCity && fromCity !== city && sources[fromCity] ? fromCity : null;
      active = { city, trip };
      const tick = now => {
        if (my !== token) return;
        const t = now - start;
        // Disengage: the zone being left glows, then fades as the camera pulls back.
        if (leaving) set('warp-edge-' + leaving, 'line-opacity', 0.6 * bump(t, 0, 0.08 * D, 0.12 * D, 0.32 * D));
        // Travel (far trips): the Golden Route Trace draws, then fades before arrival.
        if (trip.trace) {
          const head = easeOutCubic(clamp01((t - 0.12 * D) / (0.6 * D)));
          const a = bump(t, 0.12 * D, 0.2 * D, 0.62 * D, 0.82 * D);
          set('warp-trace', 'line-gradient', traceGradient(head, a));
        }
        // Destination lock: one ring expands and fades; the destination boundary glows once.
        const ring = clamp01((t - 0.72 * D) / 560);
        if (ring > 0 && ring < 1) {
          set('warp-ring', 'circle-radius', 6 + easeOutCubic(ring) * ringMax);
          set('warp-ring', 'circle-stroke-opacity', 0.7 * (1 - ring));
        } else if (ring >= 1) set('warp-ring', 'circle-stroke-opacity', 0);
        set('warp-edge-' + city, 'line-opacity', 0.65 * bump(t, 0.68 * D, 0.86 * D, 0.92 * D, total));
        // Settle: everything off; the camera is already where the page asked.
        if (t >= total) { clearEffects(); return; }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return { animated: true, trip };
    }

    return { go, cancel, busy: () => !!active };
  }

  return { attach, plan, distanceKm, traceGradient };
})();
