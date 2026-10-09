/* Shared Austin map pieces, so the Zones page map (infrastructure.html) and the
   homepage minimap (index.html) can't drift apart:
     - styleUrl(): the basemap, CARTO Dark Matter (every map, both themes);
       styleBasemap(map) is a no-op kept for its callers
     - addServiceZone(map, coords, look): the gold service zone (both maps;
       the replay passes a quieter look)
     - SERVICE_ZONE: the Austin service-zone boundary, for the replay (the
       Zones page and homepage keep their own copy; a test keeps all three equal)
     - DALLAS_SERVICE_ZONE: the Dallas service-zone boundary (Zones page and
       homepage minimap; the only copy)
     - addFeatures(map): the Zones map's markers only (not the minimap) —
       the real, publicly reported Cybercab charging locations (gold pins)
     - Cybercabs spotted by the traffic-camera watch (GET /api/camera-sightings,
       worker/camera-sightings.js): one marker per camera with a detection in
       the last 24 hours, refreshed every 60s and reconciled by camera_id.
   Needs MapLibre (maplibregl) and the page's map instance. */
window.CCCAustinMap = (function () {
  // Every map on the site uses CARTO's Dark Matter basemap (owner's choice,
  // Oct 2026), in both site themes: the original Dark Matter style, no key.
  // Its tiles carry their own credit (© CARTO, © OpenStreetMap contributors),
  // which MapLibre's attribution control shows.
  const DARK_MATTER = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  function styleUrl() { return DARK_MATTER; }
  // Kept for the pages that call it on load: Dark Matter is used as designed,
  // so there is nothing to recolour.
  function styleBasemap() {}

  // The Austin service zone (lng, lat), the same boundary as the Zones page.
  const SERVICE_ZONE = [
    [-97.8089523, 30.2478867], [-97.8237839, 30.2382717], [-97.8376999, 30.2433796], [-97.8522568, 30.2236824],
    [-97.8609161, 30.2139397], [-97.8681335, 30.2005615], [-97.8598862, 30.1848412], [-97.8251724, 30.1692181],
    [-97.768898, 30.1522579], [-97.731102, 30.1427193], [-97.6521378, 30.1459084], [-97.5534668, 30.2621021],
    [-97.5766525, 30.3470936], [-97.6152802, 30.3756886], [-97.6323395, 30.4018478], [-97.6431885, 30.4222393],
    [-97.6465302, 30.4300823], [-97.6558075, 30.4385662], [-97.6959686, 30.4513607], [-97.7225876, 30.4516335],
    [-97.7416763, 30.4467773], [-97.778038, 30.4356804], [-97.770607, 30.4302769], [-97.7579498, 30.423193],
    [-97.7507782, 30.4155159], [-97.7515182, 30.3973579], [-97.7567215, 30.3945923], [-97.76091, 30.3908138],
    [-97.7832413, 30.3825302], [-97.798378, 30.360218], [-97.819809, 30.3364353], [-97.8299332, 30.3258209],
    [-97.8367691, 30.2969208], [-97.8253403, 30.2669239], [-97.8089523, 30.2478867]
  ];

  // The Dallas service zone (lng, lat), digitized from Tesla's in-app Dallas
  // zone map (owner screenshot, Oct 2026), georeferenced on the map's own
  // labels and checked against the basemap: Northwest Highway on the north,
  // Loop 12 on the west, White Rock Lake on the east, Love Field cut out of the
  // northwest corner. ~80 mi² as traced; Tesla gives 81 mi².
  const DALLAS_SERVICE_ZONE = [
    [-96.85815, 32.8603], [-96.84597, 32.86391], [-96.82591, 32.86737], [-96.77756, 32.86617],
    [-96.77756, 32.87189], [-96.76234, 32.87189], [-96.75249, 32.8749], [-96.74443, 32.87309],
    [-96.73905, 32.8609], [-96.73959, 32.84374], [-96.73601, 32.82447], [-96.72921, 32.81363],
    [-96.73726, 32.77976], [-96.75284, 32.76381], [-96.78562, 32.74318], [-96.81481, 32.73566],
    [-96.92172, 32.74695], [-96.92316, 32.81619], [-96.89665, 32.81965], [-96.87964, 32.83501],
    [-96.85421, 32.84208], [-96.84525, 32.84856], [-96.85815, 32.8603]
  ];

  // The service zone in gold: a light wash (the streets show through), a soft
  // wide glow, then a crisp bright outline. Call on load. `look` overrides the
  // strengths (the replay keeps the zone quiet under its gold markers).
  // look.id names a second zone on the same map (Dallas): its source and layers
  // get that suffix; without it the ids are Austin's, as before.
  function addServiceZone(map, coords, look = {}) {
    const L = Object.assign({ fill: 0.13, glow: 0.45, line: '#FFD23F', width: 2.5, lineOpacity: 1 }, look);
    const sfx = L.id ? '-' + L.id : '';
    map.addSource('service-zone' + sfx, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }
    });
    map.addLayer({ id: 'zone-fill' + sfx, type: 'fill', source: 'service-zone' + sfx, paint: { 'fill-color': '#FFC72C', 'fill-opacity': L.fill } });
    map.addLayer({ id: 'zone-line-glow' + sfx, type: 'line', source: 'service-zone' + sfx, layout: { 'line-join': 'round' }, paint: { 'line-color': '#FFC72C', 'line-width': 10, 'line-blur': 7, 'line-opacity': L.glow } });
    map.addLayer({ id: 'zone-line' + sfx, type: 'line', source: 'service-zone' + sfx, layout: { 'line-join': 'round' }, paint: { 'line-color': L.line, 'line-width': L.width, 'line-opacity': L.lineOpacity } });
  }

  // opts.city: optional () => 'austin' | 'dallas' (the Zones page's selected
  // city); the camera markers follow it. Austin requests are unchanged.
  // Returns { refreshCameras } so the page can reload them on a city switch.
  function addFeatures(map, opts = {}) {
    const cityOf = typeof opts.city === 'function' ? opts.city : () => 'austin';
    function addPin(lat, lng, color, html, size = 14) {
      const el = document.createElement('span');
      el.className = 'marker-pulse';
      el.style.cssText = `display:block;width:${size}px;height:${size}px;border-radius:50%;background:${color};box-shadow:0 0 0 2px rgba(8,10,16,0.55);color:${color};`;
      return new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lng, lat])
        .setPopup(new maplibregl.Popup({ offset: size / 2 + 6 }).setHTML(html))
        .addTo(map);
    }

    // ---- Real, publicly reported Cybercab charging locations ----
    const chargingLocations = [
      { name: 'St. Elmo Robotaxi Charging Hub', lat: 30.2149565, lng: -97.7630241, note: '405 E St Elmo Rd, Austin, TX. 48 V4 Supercharger posts (phase 1), plus 80 wireless inductive Cybercab chargers planned (phase 2)' },
      { name: 'Ridgepoint Robotaxi Charging Site', lat: 30.3285815, lng: -97.6749944, note: '2323 Ridgepoint Dr, Austin, TX. 24-stall V4 DC fast-charging depot' }
    ];
    chargingLocations.forEach(c => {
      addPin(c.lat, c.lng, '#D4AF37', `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Charging Location</div>
         <div class="font-display font-bold text-sm mb-1">${c.name}</div>
         <div class="text-xs text-slate-300">${c.note}</div>`,
        18
      );
    });

    // Optional Dallas hubs belong to the Zones page; Austin's pins stay unchanged.
    let dallasChargingMarkers = [];
    function refreshChargingLocations() {
      dallasChargingMarkers.forEach(marker => marker.remove());
      dallasChargingMarkers = [];
      if (cityOf() !== 'dallas') return;
      (opts.dallasChargingLocations || []).forEach(c => {
        dallasChargingMarkers.push(addPin(c.lat, c.lng, '#D4AF37', `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Charging Location</div>
         <div class="font-display font-bold text-sm mb-1">${c.name}</div>
         <div class="text-xs text-slate-300">${c.note}</div>`,
          18
        ));
      });
    }
    refreshChargingLocations();

    // ---- Cybercabs spotted by the traffic-camera watch ----
    // One marker per camera with a detection in the last 24 hours (the API
    // returns each camera's latest), at the camera's own location. Refreshed
    // every 60s and reconciled by camera_id, so a refresh never duplicates a
    // marker. A failed or empty response simply leaves no camera markers.
    const CAMERA_REFRESH_MS = 60000;
    const CAMERA_TIME = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago', timeZoneName: 'short' };
    const cameraMarkers = new Map();   // camera_id -> { marker, key }
    const escapeHtml = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function cameraPopupHtml(d) {
      const when = new Date(d.observed_at).toLocaleString('en-US', CAMERA_TIME);
      const image = typeof d.image_url === 'string' && /^\/api\/camera-sightings\/[A-Za-z0-9-]+\/image$/.test(d.image_url)
        ? `<img src="${d.image_url}" alt="Traffic camera capture of a Cybercab at ${escapeHtml(d.camera_name)}" class="block rounded-lg mb-2" style="width:220px;max-width:100%;aspect-ratio:16/9;object-fit:cover;background:#0c1119;">`
        : `<div class="flex items-center justify-center rounded-lg mb-2 text-xs text-slate-400 border border-dashed border-[rgba(212,175,55,0.35)]" style="width:220px;max-width:100%;aspect-ratio:16/9;">Capture image pending</div>`;
      return `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Cybercab spotted</div>
         ${image}
         <div class="font-display font-bold text-sm mb-0.5">${escapeHtml(d.camera_name)}</div>
         <div class="text-xs text-slate-300">${escapeHtml(when)}</div>`;
    }

    function cameraMarkerElement(name) {
      // A 44px tap target around the 34px icon, so it is easy to hit on a phone.
      const el = document.createElement('div');
      el.className = 'camera-cybercab';
      el.setAttribute('aria-label', `Cybercab seen by the traffic camera at ${name}`);
      el.style.cssText = 'width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      el.innerHTML = `<span style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(8,10,16,0.8);box-shadow:0 0 0 1.5px rgba(212,175,55,0.7),0 0 12px rgba(212,175,55,0.45);"><img src="images/CybercabOverhead.png" alt="" width="30" height="30" style="width:30px;height:30px;object-fit:contain;pointer-events:none;"></span>`;
      return el;
    }

    function reconcileCameraMarkers(detections) {
      const seen = new Set();
      for (const d of detections) {
        if (!d || typeof d.camera_id !== 'string' || !Number.isFinite(d.lat) || !Number.isFinite(d.lng) || seen.has(d.camera_id)) continue;
        seen.add(d.camera_id);
        const key = `${d.observed_at}|${d.lat}|${d.lng}|${d.image_url}|${d.camera_name}`;
        const existing = cameraMarkers.get(d.camera_id);
        if (existing) {
          if (existing.key !== key) {
            existing.marker.setLngLat([d.lng, d.lat]);
            existing.marker.getPopup().setHTML(cameraPopupHtml(d));
            existing.key = key;
          }
          continue;
        }
        const marker = new maplibregl.Marker({ element: cameraMarkerElement(d.camera_name), anchor: 'center' })
          .setLngLat([d.lng, d.lat])
          .setPopup(new maplibregl.Popup({ offset: 22, maxWidth: '248px' }).setHTML(cameraPopupHtml(d)))
          .addTo(map);
        cameraMarkers.set(d.camera_id, { marker, key });
      }
      for (const [id, entry] of cameraMarkers) {
        if (!seen.has(id)) { entry.marker.remove(); cameraMarkers.delete(id); }
      }
    }

    let cameraSeq = 0;   // only the newest request's answer is shown (a city switch mid-request)
    async function refreshCameraMarkers() {
      const mine = ++cameraSeq;
      const city = cityOf();
      let detections = [];
      try {
        const r = await fetch(city === 'austin' ? '/api/camera-sightings' : `/api/camera-sightings?city=${encodeURIComponent(city)}`);
        const body = r.ok ? await r.json() : [];
        detections = Array.isArray(body) ? body : [];
      } catch (e) { detections = []; }
      if (mine !== cameraSeq) return;
      reconcileCameraMarkers(detections);
    }

    refreshCameraMarkers();
    setInterval(() => { if (!document.hidden) refreshCameraMarkers(); }, CAMERA_REFRESH_MS);
    return { refreshCameras: refreshCameraMarkers, refreshChargingLocations };
  }
  return { DARK_MATTER, styleUrl, styleBasemap, addServiceZone, addFeatures, SERVICE_ZONE, DALLAS_SERVICE_ZONE };
})();
