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
       the real, publicly reported Cybercab charging locations (gold bolt tiles)
     - Cybercabs spotted by the traffic-camera watch (GET /api/camera-sightings,
       worker/camera-sightings.js): one marker per camera with a detection in
       the last 24 hours, refreshed every 60s and reconciled by camera_id.
     - setFollowingSpots(list): the Following filter (js/zones-following.js)
       draws its own markers with the same look and grouping, in place of the
       camera markers; null goes back to the cameras, with no refresh while hidden.
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
  // Expanded Nov 2026: measured from three of Tesla's maps, about 440 mi²
  // (docs/verification/austin-zone-expansion).
  const SERVICE_ZONE = [
    [-97.723472, 30.452872], [-97.777366, 30.434371], [-97.757950, 30.423193], [-97.750778, 30.415516],
    [-97.751518, 30.397358], [-97.756722, 30.394592], [-97.761346, 30.389903], [-97.783881, 30.381349],
    [-97.798378, 30.360218], [-97.819809, 30.336435], [-97.829933, 30.325821], [-97.832132, 30.325339],
    [-97.885771, 30.338962], [-97.909771, 30.307901], [-97.897044, 30.288371], [-97.902014, 30.256838],
    [-97.935832, 30.178153], [-97.936279, 30.175427], [-97.806915, 30.105630], [-97.681138, 30.127452],
    [-97.666714, 30.107566], [-97.628565, 30.050949], [-97.562004, 30.070279], [-97.542289, 30.131728],
    [-97.541842, 30.135236], [-97.601792, 30.177340], [-97.603322, 30.178746], [-97.479603, 30.368874],
    [-97.528728, 30.392212], [-97.654048, 30.438097], [-97.694168, 30.450539], [-97.723472, 30.452872]
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
  // A refined zone: a faint gold wash (streets and labels read through it), a
  // barely-there halo and a thin crisp outline that thickens a touch as you
  // zoom in. A look can still pass its own width (a number).
  function addServiceZone(map, coords, look = {}) {
    const L = Object.assign({ fill: 0.05, glow: 0.18, line: '#FAE030', width: ['interpolate', ['linear'], ['zoom'], 8, 1.4, 11, 1.7, 14, 2.2], lineOpacity: 0.95 }, look);
    const sfx = L.id ? '-' + L.id : '';
    map.addSource('service-zone' + sfx, {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }
    });
    map.addLayer({ id: 'zone-fill' + sfx, type: 'fill', source: 'service-zone' + sfx, paint: { 'fill-color': '#FAE030', 'fill-opacity': L.fill } });
    map.addLayer({ id: 'zone-line-glow' + sfx, type: 'line', source: 'service-zone' + sfx, layout: { 'line-join': 'round' }, paint: { 'line-color': '#FAE030', 'line-width': 4, 'line-blur': 3, 'line-opacity': L.glow } });
    map.addLayer({ id: 'zone-line' + sfx, type: 'line', source: 'service-zone' + sfx, layout: { 'line-join': 'round' }, paint: { 'line-color': L.line, 'line-width': L.width, 'line-opacity': L.lineOpacity } });
  }

  // opts.city: optional () => 'austin' | 'dallas' (the Zones page's selected
  // city); the camera markers follow it. Austin requests are unchanged.
  // Returns { refreshCameras } so the page can reload them on a city switch.
  function addFeatures(map, opts = {}) {
    const cityOf = typeof opts.city === 'function' ? opts.city : () => 'austin';
    // A charging location, as in the iOS app: a compact dark rounded tile with a
    // gold lightning bolt (distinct from the round Cybercab markers), 44px target.
    const BOLT = '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="#FAE030" d="M13.5 2 4 13.5h6.5L9 22l10-12h-6.6L13.5 2z"/></svg>';
    function addChargingPin(lat, lng, name, html) {
      const el = document.createElement('div');
      el.className = 'charging-pin';
      el.setAttribute('aria-label', `Charging location, ${name}`);
      el.style.cssText = 'width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      el.innerHTML = `<span style="width:22px;height:22px;border-radius:6.5px;display:flex;align-items:center;justify-content:center;background:rgba(15,16,17,0.94);box-shadow:0 0 0 1px rgba(250,224,48,0.85),0 1.5px 3px rgba(0,0,0,0.55);">${BOLT}</span>`;
      return new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([lng, lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setHTML(html))
        .addTo(map);
    }

    // ---- Real, publicly reported Cybercab charging locations ----
    const chargingLocations = [
      { name: 'St. Elmo Robotaxi Charging Hub', lat: 30.2149565, lng: -97.7630241, note: '405 E St Elmo Rd, Austin, TX. 48 V4 Supercharger posts (phase 1), plus 80 wireless inductive Cybercab chargers planned (phase 2)' },
      { name: 'Ridgepoint Robotaxi Charging Site', lat: 30.3285815, lng: -97.6749944, note: '2323 Ridgepoint Dr, Austin, TX. 24-stall V4 DC fast-charging depot' }
    ];
    chargingLocations.forEach(c => {
      addChargingPin(c.lat, c.lng, c.name, `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Charging Location</div>
         <div class="font-display font-bold text-sm mb-1">${c.name}</div>
         <div class="text-xs text-slate-300">${c.note}</div>`);
    });

    // Optional Dallas hubs belong to the Zones page; Austin's pins stay unchanged.
    let dallasChargingMarkers = [];
    function refreshChargingLocations() {
      dallasChargingMarkers.forEach(marker => marker.remove());
      dallasChargingMarkers = [];
      if (cityOf() !== 'dallas') return;
      (opts.dallasChargingLocations || []).forEach(c => {
        dallasChargingMarkers.push(addChargingPin(c.lat, c.lng, c.name, `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Charging Location</div>
         <div class="font-display font-bold text-sm mb-1">${c.name}</div>
         <div class="text-xs text-slate-300">${c.note}</div>`));
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
    const followingMarkers = new Map();   // js/zones-following.js: spot id -> { marker, name }
    let followingOn = false;
    const escapeHtml = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function cameraPopupHtml(d) {
      const when = new Date(d.observed_at).toLocaleString('en-US', CAMERA_TIME);
      const image = typeof d.image_url === 'string' && /^\/api\/camera-sightings\/[A-Za-z0-9-]+\/image$/.test(d.image_url)
        ? `<img src="${d.image_url}" alt="Traffic camera capture of a Cybercab at ${escapeHtml(d.camera_name)}" class="block rounded-lg mb-2" style="width:220px;max-width:100%;aspect-ratio:16/9;object-fit:cover;background:#0c1119;">`
        : `<div class="flex items-center justify-center rounded-lg mb-2 text-xs text-slate-400 border border-dashed border-[rgba(250,224,48,0.35)]" style="width:220px;max-width:100%;aspect-ratio:16/9;">Capture image pending</div>`;
      return `
         <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Cybercab spotted</div>
         ${image}
         <div class="font-display font-bold text-sm mb-0.5">${escapeHtml(d.camera_name)}</div>
         <div class="text-xs text-slate-300">${escapeHtml(when)}</div>`;
    }

    function cameraMarkerElement(name, label) {
      // As in the iOS app: a 26px dark disc with a thin gold ring and a soft
      // shadow (no glow), inside a 44px tap target so it is easy to hit on a phone.
      const el = document.createElement('div');
      el.className = 'camera-cybercab';
      el.setAttribute('aria-label', label || `Cybercab seen by the traffic camera at ${name}`);
      el.style.cssText = 'width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      el.innerHTML = `<span style="width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(15,16,17,0.94);box-shadow:0 0 0 1px rgba(250,224,48,0.85),0 1.5px 3px rgba(0,0,0,0.55);"><img src="images/CybercabOverhead.png" alt="" width="20" height="20" style="width:20px;height:20px;object-fit:contain;pointer-events:none;"></span>`;
      return el;
    }

    // ---- Grouping, as in the iOS app: Cybercabs that would overlap on screen
    // merge into one marker with a count; a click zooms in until they separate.
    // Positions and counts are the real ones; nothing is moved or invented.
    const GROUP_PX = 40;
    const clusterMarkers = [];
    function clusterElement(n) {
      const el = document.createElement('div');
      el.className = 'camera-cybercab-cluster';
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', followingOn ? `${n} Cybercabs spotted nearby by people you follow. Click to zoom in.` : `${n} Cybercabs seen by nearby traffic cameras. Click to zoom in.`);
      el.style.cssText = 'position:relative;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      el.innerHTML = `<span style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(15,16,17,0.94);box-shadow:0 0 0 1.25px #FAE030,0 1.5px 3px rgba(0,0,0,0.55);"><img src="images/CybercabOverhead.png" alt="" width="22" height="22" style="width:22px;height:22px;object-fit:contain;pointer-events:none;"></span>`
        + `<span style="position:absolute;top:2px;right:0;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#FAE030;color:#1a1204;font:700 10.5px/16px Inter,system-ui,sans-serif;text-align:center;">${n}</span>`;
      return el;
    }
    function listPopupHtml(members) {
      return `<div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">${members.length} Cybercabs here</div>`
        + members.map(m => `<div class="text-xs text-slate-200 py-0.5">${escapeHtml(m.name)}</div>`).join('');
    }
    function regroup() {
      clusterMarkers.splice(0).forEach(c => c.remove());
      const entries = followingOn ? [...followingMarkers.values()] : [...cameraMarkers.values()];
      if (typeof map.project !== 'function') return;   // no screen projection: leave every marker as is
      const pts = entries.map(e => ({ e, p: map.project(e.marker.getLngLat()) }));
      const used = new Set();
      for (const a of pts) {
        if (used.has(a)) continue;
        const group = pts.filter(b => !used.has(b) && Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) <= GROUP_PX);
        group.forEach(g => used.add(g));
        if (group.length === 1) { a.e.marker.getElement().style.display = 'flex'; continue; }
        group.forEach(g => { g.e.marker.getElement().style.display = 'none'; const pop = g.e.marker.getPopup(); if (pop && pop.isOpen && pop.isOpen()) pop.remove(); });
        const lls = group.map(g => g.e.marker.getLngLat());
        const lng = lls.reduce((s, l) => s + l.lng, 0) / lls.length, lat = lls.reduce((s, l) => s + l.lat, 0) / lls.length;
        const el = clusterElement(group.length);
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map);
        el.addEventListener('click', ev => {
          ev.stopPropagation();
          // Already zoomed right in (cameras metres apart): list them instead.
          if (map.getZoom() >= 16) {
            new maplibregl.Popup({ offset: 20, maxWidth: '248px' }).setLngLat([lng, lat]).setHTML(listPopupHtml(group.map(g => g.e))).addTo(map);
            return;
          }
          const b = new maplibregl.LngLatBounds();
          lls.forEach(l => b.extend(l));
          map.fitBounds(b, { padding: 90, maxZoom: 16.5, duration: 700 });
        });
        clusterMarkers.push(marker);
      }
    }
    let regroupFrame = 0;
    const regroupSoon = () => { if (!regroupFrame) regroupFrame = requestAnimationFrame(() => { regroupFrame = 0; regroup(); }); };
    if (typeof map.on === 'function') { map.on('zoom', regroupSoon); map.on('moveend', regroupSoon); }

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
            existing.name = d.camera_name;
          }
          continue;
        }
        const marker = new maplibregl.Marker({ element: cameraMarkerElement(d.camera_name), anchor: 'center' })
          .setLngLat([d.lng, d.lat])
          .setPopup(new maplibregl.Popup({ offset: 18, maxWidth: '248px' }).setHTML(cameraPopupHtml(d)))
          .addTo(map);
        cameraMarkers.set(d.camera_id, { marker, key, name: d.camera_name });
      }
      for (const [id, entry] of cameraMarkers) {
        if (!seen.has(id)) { entry.marker.remove(); cameraMarkers.delete(id); }
      }
      regroup();
    }

    // The Following filter's markers: drawn by this file so they group the same
    // way. A list replaces the camera markers; null brings the cameras back.
    function setFollowingSpots(spots) {
      followingMarkers.forEach(e => e.marker.remove());
      followingMarkers.clear();
      if (spots === null) {
        followingOn = false;
        refreshCameraMarkers();
        regroup();
        return;
      }
      if (!followingOn) {
        followingOn = true;
        cameraSeq++;   // a camera answer still on its way must not land on this view
        cameraMarkers.forEach(e => e.marker.remove());
        cameraMarkers.clear();
      }
      for (const s of spots) {
        const popup = new maplibregl.Popup({ offset: 18, maxWidth: '268px' }).setHTML(s.html);
        const marker = new maplibregl.Marker({ element: cameraMarkerElement(s.name, s.label), anchor: 'center' })
          .setLngLat([s.lng, s.lat]).setPopup(popup).addTo(map);
        followingMarkers.set(s.id, { marker, name: s.name });
      }
      regroup();
    }

    let cameraSeq = 0;   // only the newest request's answer is shown (a city switch mid-request)
    async function refreshCameraMarkers() {
      if (followingOn) return;   // Following shows its own markers and asks for nothing here
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
    return { refreshCameras: refreshCameraMarkers, refreshChargingLocations, setFollowingSpots };
  }
  return { DARK_MATTER, styleUrl, styleBasemap, addServiceZone, addFeatures, SERVICE_ZONE, DALLAS_SERVICE_ZONE };
})();
