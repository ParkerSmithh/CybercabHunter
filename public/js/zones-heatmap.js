/* Zones map (infrastructure.html): Normal Map / Heatmap.
   Normal Map is the page exactly as it was (default). Heatmap hides the
   camera-spotted Cybercab icons (js/austin-map.js) and shows where the
   traffic cameras have recorded Cybercabs, as a soft gold-to-red-orange glow:
   GET /api/camera-sightings/heat?city=&range= (worker/camera-sightings.js),
   per camera, from real detection records only (approved spotter photos and
   the camera watch; the same Cybercab filed twice within 2 minutes counts
   once). Heat sits at the camera that saw it; it is history, never a live
   position. A camera with no detection adds no heat.
     - range: Last 24 hours / 7 days (default) / 30 days / All time (refetched,
       cached per city + range); hour of day (Austin time) filters instantly
       from the per-camera hour x weekday grid, no refetch
     - every camera of the city stays as a small dot; a click on a dot or a
       hotspot shows that camera's detections, most recent, busiest hour and
       busiest day for the selection
     - switching back restores the icons; the map never moves
   Needs MapLibre and the page's map. CCCZonesHeat.attach(map, { city }) ->
   { refresh } (call refresh on a city switch). */
window.CCCZonesHeat = (function () {
  const RANGES = [['24h', '24H', 'the last 24 hours'], ['7d', '7D', 'the last 7 days'], ['30d', '30D', 'the last 30 days'], ['all', 'All', 'all time']];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hourName = h => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  const hourSpan = h => `${hourName(h)}–${hourName((h + 1) % 24)}`;
  const when = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT';
  // The gradient: transparent -> faint gold -> soft yellow -> bright gold -> orange -> red-orange.
  const HEAT_COLOR = ['interpolate', ['linear'], ['heatmap-density'],
    0, 'rgba(212,175,55,0)', 0.1, 'rgba(212,175,55,0.16)', 0.28, 'rgba(243,229,171,0.5)',
    0.5, 'rgba(212,175,55,0.82)', 0.75, 'rgba(249,115,22,0.88)', 1, 'rgba(255,69,0,0.95)'];

  // Per-camera numbers for the selection (hour: null = all hours).
  function statsFor(cam, hour) {
    const g = cam.grid || [];
    const byHour = new Array(24).fill(0), byDay = new Array(7).fill(0);
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const n = g[d * 24 + h] || 0;
      if (hour != null && h !== hour) continue;
      byHour[h] += n; byDay[d] += n;
    }
    const count = byDay.reduce((s, v) => s + v, 0);
    const argmax = a => { let best = -1, i = -1; a.forEach((v, k) => { if (v > best) { best = v; i = k; } }); return best > 0 ? i : null; };
    return { count, last: hour == null ? cam.last : (cam.last_by_hour || [])[hour] || null, busiestHour: argmax(byHour), busiestDay: argmax(byDay) };
  }

  function attach(map, opts = {}) {
    const cityOf = typeof opts.city === 'function' ? opts.city : () => 'austin';
    let mode = 'normal', range = '7d', hour = null, data = null, loadSeq = 0, popup = null, ready = false;
    const cache = new Map();
    let cameras = null;   // every traffic camera (public/data/traffic-cameras.json)

    // ---- the control (a MapLibre control, so it sits with the map's own) ----
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl zh-ctrl';
    box.innerHTML = `
      <div class="zh-panel" data-zh-panel hidden>
        <div class="zh-row">
          <div class="zh-seg" role="group" aria-label="Detection period">${RANGES.map(([k, label, long]) => `<button type="button" data-zh-range="${k}" aria-pressed="${k === range}" aria-label="${long[0].toUpperCase() + long.slice(1)}">${label}</button>`).join('')}</div>
          <label class="zh-hour"><span class="sr-only">Hour of day (Austin time)</span>
            <select data-zh-hour><option value="">All hours</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourSpan(h)}</option>`).join('')}</select>
          </label>
        </div>
        <div class="zh-legend" aria-hidden="true"><span>Fewer</span><i></i><span>More detections</span></div>
        <p class="zh-status" data-zh-status role="status" aria-live="polite"></p>
        <p class="zh-note">Where traffic cameras recorded Cybercabs. History, not live positions.</p>
      </div>
      <div class="zh-seg zh-mode" role="group" aria-label="Map view">
        <button type="button" data-zh-mode="normal" aria-pressed="true">Normal Map</button>
        <button type="button" data-zh-mode="heat" aria-pressed="false">Heatmap</button>
      </div>`;
    const panel = box.querySelector('[data-zh-panel]');
    const status = box.querySelector('[data-zh-status]');
    const empty = document.createElement('div');
    empty.className = 'zh-empty';
    empty.hidden = true;
    map.getContainer().appendChild(empty);
    ['click', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation()));
    // Bottom right at every width: it stacks above the map's attribution (the
    // zone panel covers the left on wide screens; the search sits on top).
    map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, 'bottom-right');

    // ---- layers ----
    const empties = () => ({ type: 'FeatureCollection', features: [] });
    function addLayers() {
      if (ready || map.getSource('zh-heat')) return;
      map.addSource('zh-heat', { type: 'geojson', data: empties() });
      map.addSource('zh-cams', { type: 'geojson', data: empties() });
      map.addLayer({ id: 'zh-heat', type: 'heatmap', source: 'zh-heat', layout: { visibility: 'none' }, paint: {
        'heatmap-weight': ['get', 'w'],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 12, 2.2, 15, 3],
        'heatmap-radius': ['interpolate', ['exponential', 1.5], ['zoom'], 9, 26, 11, 40, 13, 62, 15, 96, 17, 150],
        'heatmap-color': HEAT_COLOR,
        'heatmap-opacity': 0.9
      } });
      map.addLayer({ id: 'zh-cams', type: 'circle', source: 'zh-cams', layout: { visibility: 'none' }, paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['>', ['get', 'n'], 0], 2.2, 1.6], 15, ['case', ['>', ['get', 'n'], 0], 4.5, 3.2]],
        'circle-color': ['case', ['>', ['get', 'n'], 0], 'rgba(255,255,255,0.9)', 'rgba(148,163,184,0.5)'],
        'circle-stroke-color': 'rgba(8,10,16,0.7)',
        'circle-stroke-width': 0.75
      } });
      ready = true;
      draw();
    }
    if (map.loaded() && map.isStyleLoaded()) addLayers(); else map.on('load', addLayers);

    async function loadCameras() {
      if (cameras) return cameras;
      try { const r = await fetch('/data/traffic-cameras.json'); cameras = r.ok ? await r.json() : []; } catch (e) { cameras = []; }
      if (!Array.isArray(cameras)) cameras = [];
      return cameras;
    }

    async function load() {
      const mine = ++loadSeq, key = `${cityOf()}|${range}`;
      if (cache.has(key)) { data = cache.get(key); draw(); return; }
      data = null; draw();
      setStatus('Loading detections…');
      let body = null;
      try { const r = await fetch(`/api/camera-sightings/heat?city=${encodeURIComponent(cityOf())}&range=${range}`); body = r.ok ? await r.json() : null; } catch (e) { body = null; }
      await loadCameras();
      if (mine !== loadSeq) return;
      if (!body || !Array.isArray(body.cameras)) { data = { error: true }; draw(); return; }
      cache.set(key, body);
      data = body;
      draw();
    }

    function setStatus(text) { status.textContent = text; }
    const periodText = () => RANGES.find(r => r[0] === range)[2];

    // Heat and camera dots for the current selection.
    // The zone's gold wash is dimmed under the heat (its outline stays) and
    // restored exactly on Normal Map.
    const zoneFill = new Map();
    function dimZones(on) {
      for (const id of ['zone-fill', 'zone-fill-dallas']) {
        if (!map.getLayer(id)) continue;
        if (!zoneFill.has(id)) zoneFill.set(id, map.getPaintProperty(id, 'fill-opacity'));
        map.setPaintProperty(id, 'fill-opacity', on ? 0.04 : zoneFill.get(id));
      }
    }
    function draw() {
      if (!ready) return;
      const on = mode === 'heat';
      map.setLayoutProperty('zh-heat', 'visibility', on ? 'visible' : 'none');
      map.setLayoutProperty('zh-cams', 'visibility', on ? 'visible' : 'none');
      dimZones(on);
      empty.hidden = true;
      if (!on) return;
      if (!data) { map.getSource('zh-heat').setData(empties()); return; }
      if (data.error) { map.getSource('zh-heat').setData(empties()); setStatus("Couldn't load the detection history. Try again shortly."); return; }
      const rows = data.cameras.map(c => ({ c, s: statsFor(c, hour) })).filter(r => r.s.count > 0);
      const max = Math.max(1, ...rows.map(r => r.s.count));
      // Square-root weights: the busiest camera is hottest, and a camera with
      // one detection still glows faintly instead of vanishing.
      map.getSource('zh-heat').setData({ type: 'FeatureCollection', features: rows.map(({ c, s }) => ({
        type: 'Feature', properties: { id: c.camera_id, w: Math.sqrt(s.count / max) }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }
      })) });
      const counts = new Map(rows.map(r => [r.c.camera_id, r.s.count]));
      const city = cityOf();
      const listed = (cameras || []).filter(c => c.city === city && Number.isFinite(c.lat) && Number.isFinite(c.lng));
      // A detection at a camera missing from the list still gets its dot.
      for (const c of data.cameras) if (!listed.some(l => String(l.camera_id) === String(c.camera_id))) listed.push({ camera_id: c.camera_id, name: c.camera_name, lat: c.lat, lng: c.lng });
      map.getSource('zh-cams').setData({ type: 'FeatureCollection', features: listed.map(c => ({
        type: 'Feature', properties: { id: String(c.camera_id), name: c.name, n: counts.get(String(c.camera_id)) || 0 }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] }
      })) });
      const total = rows.reduce((s, r) => s + r.s.count, 0);
      const span = `${periodText()}${hour != null ? `, ${hourSpan(hour)}` : ''}`;
      if (!total) {
        setStatus(`No Cybercab detections in ${span}.`);
        empty.textContent = `No Cybercab detections in ${span}`;
        empty.hidden = false;
      } else {
        setStatus(`${total} detection${total === 1 ? '' : 's'} at ${rows.length} camera${rows.length === 1 ? '' : 's'} · ${span}`);
      }
    }

    // ---- a camera's numbers, on a dot or a hotspot ----
    function camById(id) { return data && data.cameras ? data.cameras.find(c => String(c.camera_id) === String(id)) : null; }
    function showCamera(id, name, lngLat) {
      const cam = camById(id);
      const s = cam ? statsFor(cam, hour) : { count: 0 };
      const span = `${periodText()}${hour != null ? `, ${hourSpan(hour)}` : ''}`;
      const rows = s.count
        ? `<div class="zh-pop-row"><span>Detections</span><b>${s.count}</b></div>
           ${s.last ? `<div class="zh-pop-row"><span>Most recent</span><b>${esc(when(s.last))}</b></div>` : ''}
           ${s.busiestHour != null && hour == null ? `<div class="zh-pop-row"><span>Busiest hour</span><b>${hourSpan(s.busiestHour)}</b></div>` : ''}
           ${s.busiestDay != null ? `<div class="zh-pop-row"><span>Busiest day</span><b>${DAYS[s.busiestDay]}</b></div>` : ''}`
        : `<div class="text-xs text-slate-400">No Cybercab detections here in ${esc(span)}.</div>`;
      if (popup) popup.remove();
      popup = new maplibregl.Popup({ offset: 10, maxWidth: '260px' }).setLngLat(lngLat).setHTML(`
        <div class="text-[11px] uppercase tracking-wide text-gold font-semibold mb-1">Traffic camera</div>
        <div class="font-display font-bold text-sm mb-1.5">${esc(cam ? cam.camera_name : name)}</div>
        ${rows}
        <div class="text-[10px] text-slate-500 mt-1.5">${esc(span[0].toUpperCase() + span.slice(1))} · Austin time</div>`).addTo(map);
    }
    map.on('click', e => {
      if (mode !== 'heat' || !ready) return;
      const p = e.point, pad = 26;
      const hits = map.queryRenderedFeatures([[p.x - pad, p.y - pad], [p.x + pad, p.y + pad]], { layers: ['zh-cams'] });
      if (!hits.length) return;
      // The nearest dot; a detected camera wins a near-tie (the hotspot).
      let best = null, bestD = Infinity;
      for (const f of hits) {
        const q = map.project(f.geometry.coordinates);
        const dist = Math.hypot(q.x - p.x, q.y - p.y) - (f.properties.n > 0 ? 12 : 0);
        if (dist < bestD) { bestD = dist; best = f; }
      }
      showCamera(best.properties.id, best.properties.name, best.geometry.coordinates);
    });
    map.on('mouseenter', 'zh-cams', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'zh-cams', () => { map.getCanvas().style.cursor = ''; });

    // ---- controls ----
    function setMode(next) {
      if (next === mode) return;
      mode = next;
      box.querySelectorAll('[data-zh-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.zhMode === mode)));
      panel.hidden = mode !== 'heat';
      map.getContainer().classList.toggle('zones-heat-on', mode === 'heat');
      if (popup) { popup.remove(); popup = null; }
      if (mode === 'heat') load(); else draw();
    }
    box.addEventListener('click', e => {
      const m = e.target.closest('[data-zh-mode]'), r = e.target.closest('[data-zh-range]');
      if (m) setMode(m.dataset.zhMode);
      if (r && r.dataset.zhRange !== range) {
        range = r.dataset.zhRange;
        box.querySelectorAll('[data-zh-range]').forEach(b => b.setAttribute('aria-pressed', String(b === r)));
        if (popup) { popup.remove(); popup = null; }
        load();
      }
    });
    box.querySelector('[data-zh-hour]').addEventListener('change', e => {
      hour = e.target.value === '' ? null : Number(e.target.value);
      if (popup) { popup.remove(); popup = null; }
      draw();
    });

    return {
      refresh() { if (popup) { popup.remove(); popup = null; } if (mode === 'heat') load(); },
      get mode() { return mode; }
    };
  }
  return { attach, statsFor };
})();
