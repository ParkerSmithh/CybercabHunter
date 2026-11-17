/* Robotaxi facilities on the Zones map (infrastructure.html): charging hubs,
   staging grounds and combined sites, from the one shared list
   /data/facilities.json (the iOS app bundles and refreshes the same file).

     - markers: a dark rounded tile per facility, a gold bolt (charging), a
       gold P (staging) or both (combined); real <button>s, so they take
       keyboard focus, with the facility's name and type as their label
     - filter: All Facilities | Charging Hubs | Staging Grounds, kept per city
       (a combined site shows under both); it never changes the city or zones
     - popup: the thumbnail (or a placeholder), name, type, address, status
       and "View facility"
     - drawer: a side drawer on desktop (the map stays visible), a bottom
       sheet on phones: gallery (hero, previous/next, counter, thumbnails,
       full screen), the details, status, last verified, sources, and actions
       (view on map, directions, copy link, sources)
   The list is one small static file read once; photos load only when a popup
   or the drawer shows them (thumbnails first, the full image in the drawer).
   Deep link: /infrastructure?city=dallas&facility=<id>.
   Needs MapLibre and the page's map. */
window.CCCZonesFacilities = (function () {
  const DATA_URL = '/data/facilities.json?v=1';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Only the site's own facility images are ever shown (never a hotlink).
  const safeSrc = p => (typeof p === 'string' && /^\/images\/facilities\/[a-z0-9-]+\/[a-z0-9-]+\.(webp|jpg|png)$/.test(p) ? p : '');
  const safeUrl = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : '');
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.5 2 4 13.5h6.5L9 22l10-12h-6.6L13.5 2z"/></svg>';
  const PARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 3h6.2a5.3 5.3 0 0 1 0 10.6H10.4V21H7V3zm3.4 3.1v4.4h2.7a2.2 2.2 0 0 0 0-4.4h-2.7z"/></svg>';
  const icon = type => (type === 'combined' ? BOLT + PARK : type === 'staging' ? PARK : BOLT);
  const FILTERS = [['all', 'All Facilities', 'All'], ['charging', 'Charging Hubs', 'Charging'], ['staging', 'Staging Grounds', 'Staging']];
  const shows = (f, type) => f === 'all' || type === f || type === 'combined';
  const fmtDate = iso => {
    const d = new Date(String(iso) + 'T12:00:00Z');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };

  function attach(map, opts = {}) {
    const cityOf = typeof opts.city === 'function' ? opts.city : () => 'austin';
    let data = null, markers = [], openId = null, returnFocus = null, photoIndex = 0;
    const filter = { austin: 'all', dallas: 'all' };
    const label = (group, key) => (data && data.labels[group] && data.labels[group][key]) || key;

    // ---- Filter: the map's segmented style, stacked with its other controls.
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl zh-ctrl fac-ctrl';
    box.innerHTML = `<div class="zh-seg" role="group" aria-label="Facilities shown on the map">${FILTERS.map(([k, long, short]) =>
      `<button type="button" data-fac-filter="${k}" aria-pressed="${k === 'all'}" aria-label="${long}"><span class="fac-long">${long}</span><span class="fac-short" aria-hidden="true">${short}</span></button>`).join('')}</div>`;
    ['click', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation()));
    box.hidden = true;   // until the list loads
    const empty = document.createElement('div');
    empty.className = 'fac-empty';
    empty.setAttribute('role', 'status');
    empty.hidden = true;
    map.getContainer().appendChild(empty);
    map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, 'bottom-right');
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-fac-filter]');
      if (!b) return;
      filter[cityOf()] = b.dataset.facFilter;
      refresh();
    });

    // ---- Drawer (one, reused) and the full-screen viewer.
    const drawer = document.createElement('aside');
    drawer.className = 'fac-drawer';
    drawer.id = 'facilityDrawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'false');
    drawer.setAttribute('aria-labelledby', 'facDrawerTitle');
    drawer.hidden = true;
    const backdrop = document.createElement('div');
    backdrop.className = 'fac-backdrop';
    backdrop.hidden = true;
    const viewer = document.createElement('dialog');
    viewer.className = 'fac-viewer';
    viewer.setAttribute('aria-label', 'Facility photo');
    document.body.append(backdrop, drawer, viewer);
    backdrop.addEventListener('click', () => close());

    // A photo that can't load becomes the placeholder (popup, drawer, viewer).
    function placeholder(f, small) {
      const msg = f && f.photos && f.photos.length ? 'Photo unavailable' : 'No verified photos yet';
      return `<div class="fac-ph${small ? ' fac-ph-sm' : ''}" role="img" aria-label="${esc(msg)}"><span class="fac-ph-icon fac-t-${esc(f ? f.type : 'charging')}">${icon(f ? f.type : 'charging')}</span><span>${esc(msg)}</span></div>`;
    }
    const onImgError = root => root.addEventListener('error', e => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.facImg) return;
      const f = byId(img.dataset.facImg);
      const host = img.closest('[data-fac-media]') || img;
      host.outerHTML = placeholder(f, host.dataset.facMedia === 'sm');
    }, true);
    onImgError(drawer); onImgError(viewer);

    const byId = id => (data ? data.facilities.find(f => f.id === id) : null);
    const statusLine = f => `<span class="fac-status"><span class="fac-dot fac-op-${esc(f.operational)}" aria-hidden="true"></span>${esc(label('operational', f.operational))}</span><span class="fac-sep" aria-hidden="true">·</span><span>${esc(label('verification', f.verification))}</span>`;
    const typeChip = f => `<span class="fac-type fac-t-${esc(f.type)}"><span class="fac-type-icon" aria-hidden="true">${icon(f.type)}</span>${esc(label('type', f.type))}</span>`;

    function popupHtml(f) {
      const p = f.photos[0];
      const media = p && safeSrc(p.thumb)
        ? `<div class="fac-pop-media" data-fac-media="sm"><img data-fac-img="${esc(f.id)}" src="${safeSrc(p.thumb)}" alt="${esc(p.alt)}" width="480" height="${Math.round(480 * p.height / p.width)}" decoding="async"></div>`
        : placeholder(f, true);
      return `<div class="fac-pop">${media}
        <div class="fac-pop-body">${typeChip(f)}
          <div class="fac-pop-name">${esc(f.name)}</div>
          <div class="fac-pop-addr">${esc(f.address)}</div>
          <div class="fac-pop-meta">${statusLine(f)}</div>
          <button type="button" class="fac-pop-btn" data-fac-open="${esc(f.id)}">View facility</button>
        </div></div>`;
    }

    function makeMarker(f) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `fac-pin fac-pin-${f.type}`;
      el.dataset.facility = f.id;
      el.setAttribute('aria-label', `${label('type', f.type)}: ${f.name}`);
      el.innerHTML = `<span class="fac-tile">${icon(f.type)}</span>`;
      // The popup's content is built when it opens, so no photo loads with the map.
      const popup = new maplibregl.Popup({ offset: 16, maxWidth: '260px', className: 'fac-popup', focusAfterOpen: false });
      popup.on('open', () => {
        // Opened from the keyboard (or at the edge): bring it out from under the
        // zone panel (lg) and the map's edges, so the popup can be seen and used.
        const c = map.getContainer(), pt = map.project([f.lng, f.lat]);
        const left = wide() ? 380 : 40;
        if (pt.x < left || pt.x > c.clientWidth - 40 || pt.y < 200 || pt.y > c.clientHeight - (wide() ? 40 : 200)) {
          map.easeTo({ center: [f.lng, f.lat], offset: [wide() ? 170 : 0, 90], duration: reduceMotion() ? 0 : 600 });
        }
        popup.setHTML(popupHtml(f));
        const root = popup.getElement();
        if (!root) return;
        onImgError(root);
        const btn = root.querySelector('[data-fac-open]');
        if (btn) btn.addEventListener('click', () => open(f.id, el));
      });
      popup.setLngLat([f.lng, f.lat]);
      // The button handles its own activation (mouse, touch, Enter, Space) and
      // stops there, so the map never toggles the popup a second time.
      el.addEventListener('click', e => {
        e.stopPropagation();
        if (popup.isOpen()) { popup.remove(); return; }
        markers.forEach(m => { if (m.facPopup !== popup && m.facPopup.isOpen()) m.facPopup.remove(); });
        popup.addTo(map);
      });
      const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([f.lng, f.lat]).addTo(map);
      m.facilityId = f.id;
      m.facPopup = popup;
      return m;
    }

    function refresh() {
      if (!data) return;
      const city = cityOf(), f = filter[city] || 'all';
      box.hidden = !data.facilities.some(x => x.city === city);
      box.querySelectorAll('[data-fac-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.facFilter === f)));
      const want = data.facilities.filter(x => x.city === city && shows(f, x.type));
      const cityName = city === 'dallas' ? 'Dallas' : 'Austin';
      empty.textContent = want.length || f === 'all' ? '' : `No ${f === 'staging' ? 'staging grounds' : 'charging hubs'} listed in ${cityName} yet`;
      empty.hidden = !empty.textContent;
      markers = markers.filter(m => {
        if (want.some(x => x.id === m.facilityId)) return true;
        m.facPopup.remove();
        m.remove();
        return false;
      });
      want.forEach(x => { if (!markers.some(m => m.facilityId === x.id)) markers.push(makeMarker(x)); });
      renderLists();
      if (openId && !want.some(x => x.id === openId)) close(true);
    }

    // The zone panel lists each city's facilities (keyboard and screen-reader route to the same drawer).
    function renderLists() {
      document.querySelectorAll('[data-facility-list]').forEach(list => {
        const city = list.dataset.facilityList;
        const items = data.facilities.filter(x => x.city === city);
        list.innerHTML = items.length ? items.map(x => `<li><button type="button" class="fac-list-btn" data-fac-open="${esc(x.id)}">
            <span class="fac-list-icon" aria-hidden="true"><span class="fac-tile fac-tile-sm">${icon(x.type)}</span></span>
            <span class="fac-list-text"><span class="fac-list-name">${esc(x.name)}</span><span class="fac-list-meta">${esc(label('type', x.type))} · ${esc(label('operational', x.operational))}</span></span>
          </button></li>`).join('') : '';
        list.closest('[data-facility-section]') && (list.closest('[data-facility-section]').hidden = !items.length);
      });
    }
    document.addEventListener('click', e => {
      const b = e.target.closest('.fac-list-btn[data-fac-open]');
      if (b) open(b.dataset.facOpen, b);
    });

    // ---- The drawer's content.
    function galleryHtml(f) {
      if (!f.photos.length) return `<div class="fac-gallery fac-gallery-empty">${placeholder(f)}<p class="fac-review">Photos are added once they're verified and cleared for reuse.</p></div>`;
      const p = f.photos[photoIndex], n = f.photos.length;
      return `<div class="fac-gallery" aria-roledescription="carousel" aria-label="Photos of ${esc(f.name)}">
        <div class="fac-hero">
          <button type="button" class="fac-hero-open" data-fac-full aria-label="View photo ${photoIndex + 1} of ${n} full screen">
            <span class="fac-hero-media" data-fac-media="lg"><img data-fac-img="${esc(f.id)}" src="${safeSrc(p.src)}" alt="${esc(p.alt)}" width="${p.width}" height="${p.height}" decoding="async"></span>
          </button>
          ${n > 1 ? `<button type="button" class="fac-nav fac-prev" data-fac-step="-1" aria-label="Previous photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
          <button type="button" class="fac-nav fac-next" data-fac-step="1" aria-label="Next photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}
          <span class="fac-count" aria-live="polite">${photoIndex + 1} / ${n}</span>
        </div>
        <p class="fac-caption">${esc(p.caption)} <span class="fac-credit">Photo: ${esc(p.credit)}${p.license ? ' · ' + esc(p.license) : ''}</span></p>
        ${n > 1 ? `<div class="fac-thumbs" role="group" aria-label="Choose a photo">${f.photos.map((t, i) => `<button type="button" class="fac-thumb" data-fac-photo="${i}" aria-label="Photo ${i + 1} of ${n}: ${esc(t.caption)}" aria-current="${i === photoIndex}" data-fac-media="sm"><img data-fac-img="${esc(f.id)}" src="${safeSrc(t.thumb)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}
      </div>`;
    }
    function detailsList(title, items, type) {
      return items.length ? `<section class="fac-sec"><h3>${title}</h3><ul class="fac-points">${items.map(i => `<li><span class="fac-point-icon fac-t-${type}" aria-hidden="true">${type === 'staging' ? PARK : BOLT}</span>${esc(i)}</li>`).join('')}</ul></section>` : '';
    }
    function drawerHtml(f) {
      const help = data.labels.verificationHelp || {};
      return `<div class="fac-sheet-handle" aria-hidden="true"></div>
        <div class="fac-head">
          <span class="fac-eyebrow">Robotaxi facility</span>
          <button type="button" class="fac-close" data-fac-close aria-label="Close facility details"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="fac-scroll">
          <div data-fac-gallery>${galleryHtml(f)}</div>
          <div class="fac-body">
            ${typeChip(f)}
            <h2 id="facDrawerTitle" class="fac-title" tabindex="-1">${esc(f.name)}</h2>
            <p class="fac-addr">${esc(f.address)}</p>
            ${f.locationNote ? `<p class="fac-note">${esc(f.locationNote)}</p>` : ''}
            <dl class="fac-facts">
              <div><dt>Status</dt><dd><span class="fac-dot fac-op-${esc(f.operational)}" aria-hidden="true"></span>${esc(label('operational', f.operational))}</dd></div>
              <div><dt>Verification</dt><dd>${esc(label('verification', f.verification))}<span class="fac-help">${esc(help[f.verification] || '')}</span></dd></div>
              <div><dt>Last verified</dt><dd>${esc(fmtDate(f.lastVerified))}</dd></div>
            </dl>
            <p class="fac-desc">${esc(f.description)}</p>
            ${detailsList('Charging', f.charging, 'charging')}
            ${detailsList('Staging', f.staging, 'staging')}
            <div class="fac-actions">
              <button type="button" class="fac-act" data-fac-act="map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>View on map</button>
              <a class="fac-act" data-fac-act="directions" href="https://www.google.com/maps/dir/?api=1&amp;destination=${f.lat},${f.lng}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>Get directions</a>
              <button type="button" class="fac-act" data-fac-act="copy"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Copy link</button>
              <button type="button" class="fac-act" data-fac-act="sources"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h10l4 4v12H5z"/><path d="M9 12h6M9 16h6"/></svg>Sources</button>
            </div>
            <p class="fac-copied" role="status" aria-live="polite"></p>
            <section class="fac-sec" id="facSources"><h3>Sources</h3>
              <ul class="fac-sources">${f.sources.map(s => safeUrl(s.url) ? `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer"><span class="fac-src-title">${esc(s.title)}</span><span class="fac-src-meta">${esc(s.publisher)}${s.date ? ' · ' + esc(fmtDate(s.date)) : ''}</span></a></li>` : '').join('')}</ul>
            </section>
          </div>
        </div>`;
    }

    const wide = () => window.matchMedia && matchMedia('(min-width: 1024px)').matches;
    function open(id, from) {
      const f = byId(id);
      if (!f) return;
      if (openId !== id) photoIndex = 0;
      openId = id;
      returnFocus = from || document.activeElement;
      drawer.innerHTML = drawerHtml(f);
      drawer.hidden = false;
      backdrop.hidden = wide();
      drawer.setAttribute('aria-modal', String(!wide()));
      requestAnimationFrame(() => { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); });
      markers.forEach(m => m.getElement().classList.toggle('is-active', m.facilityId === id));
      markers.forEach(m => { if (m.facPopup.isOpen()) m.facPopup.remove(); });
      setUrl(id);
      drawer.querySelector('#facDrawerTitle').focus({ preventScroll: true });
    }
    function close(silent) {
      if (!openId) return;
      openId = null;
      drawer.classList.remove('is-open'); backdrop.classList.remove('is-open');
      const done = () => { if (!openId) { drawer.hidden = true; backdrop.hidden = true; drawer.innerHTML = ''; } };
      reduceMotion() ? done() : setTimeout(done, 260);
      markers.forEach(m => m.getElement().classList.remove('is-active'));
      setUrl(null);
      if (!silent && returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    }
    function setUrl(id) {
      try {
        const u = new URL(location.href);
        if (id) u.searchParams.set('facility', id); else u.searchParams.delete('facility');
        history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      } catch (e) { /* the drawer works without it */ }
    }
    function showPhoto(i) {
      const f = byId(openId);
      if (!f || !f.photos.length) return;
      photoIndex = (i + f.photos.length) % f.photos.length;
      const g = drawer.querySelector('[data-fac-gallery]');
      if (g) g.innerHTML = galleryHtml(f);
      if (viewer.open) renderViewer();
    }
    const linkFor = f => `${location.origin}/infrastructure?city=${encodeURIComponent(f.city)}&facility=${encodeURIComponent(f.id)}`;

    drawer.addEventListener('click', async e => {
      const t = e.target.closest('button, a');
      if (!t) return;
      const f = byId(openId);
      if (t.matches('[data-fac-close]')) return close();
      if (t.matches('[data-fac-step]')) return showPhoto(photoIndex + Number(t.dataset.facStep));
      if (t.matches('[data-fac-photo]')) return showPhoto(Number(t.dataset.facPhoto));
      if (t.matches('[data-fac-full]')) return openViewer();
      const act = t.dataset.facAct;
      if (!f || !act) return;
      if (act === 'map') {
        map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 15), padding: wide() ? { right: 420, left: 0, top: 0, bottom: 0 } : 0, duration: reduceMotion() ? 0 : 1200, essential: false });
        if (!wide()) close();
      } else if (act === 'copy') {
        const status = drawer.querySelector('.fac-copied');
        try { await navigator.clipboard.writeText(linkFor(f)); status.textContent = 'Link copied'; }
        catch (err) { status.textContent = linkFor(f); }
        setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 2500);
      } else if (act === 'sources') {
        const s = drawer.querySelector('#facSources');
        s.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
        const first = s.querySelector('a'); if (first) first.focus({ preventScroll: true });
      }
    });
    // Phones: swipe the hero photo.
    let touchX = null;
    drawer.addEventListener('touchstart', e => { touchX = e.target.closest('.fac-hero') ? e.touches[0].clientX : null; }, { passive: true });
    drawer.addEventListener('touchend', e => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX; touchX = null;
      if (Math.abs(dx) > 40) showPhoto(photoIndex + (dx < 0 ? 1 : -1));
    });

    // ---- Full screen: a native <dialog> (focus stays inside; Esc closes).
    function renderViewer() {
      const f = byId(openId), p = f && f.photos[photoIndex];
      if (!p) return;
      const n = f.photos.length;
      viewer.innerHTML = `<div class="fac-viewer-inner">
        <button type="button" class="fac-viewer-close" data-fac-vclose aria-label="Close full screen photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        <figure data-fac-media="lg"><img data-fac-img="${esc(f.id)}" src="${safeSrc(p.src)}" alt="${esc(p.alt)}" decoding="async">
        <figcaption>${esc(p.caption)} <span class="fac-credit">Photo: ${esc(p.credit)} · ${photoIndex + 1} / ${n}</span></figcaption></figure>
        ${n > 1 ? `<button type="button" class="fac-nav fac-prev" data-fac-vstep="-1" aria-label="Previous photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button type="button" class="fac-nav fac-next" data-fac-vstep="1" aria-label="Next photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>` : ''}
      </div>`;
    }
    function openViewer() {
      renderViewer();
      if (typeof viewer.showModal === 'function') viewer.showModal(); else viewer.setAttribute('open', '');
      const c = viewer.querySelector('[data-fac-vclose]'); if (c) c.focus();
    }
    viewer.addEventListener('click', e => {
      if (e.target === viewer || e.target.closest('[data-fac-vclose]')) return viewer.close();
      const s = e.target.closest('[data-fac-vstep]');
      if (s) { showPhoto(photoIndex + Number(s.dataset.facVstep)); const c = viewer.querySelector('[data-fac-vclose]'); if (c) c.focus(); }
    });
    viewer.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') showPhoto(photoIndex - 1);
      if (e.key === 'ArrowRight') showPhoto(photoIndex + 1);
    });
    viewer.addEventListener('close', () => { const b = drawer.querySelector('[data-fac-full]'); if (b) b.focus({ preventScroll: true }); });
    let vx = null;
    viewer.addEventListener('touchstart', e => { vx = e.touches[0].clientX; }, { passive: true });
    viewer.addEventListener('touchend', e => { if (vx == null) return; const dx = e.changedTouches[0].clientX - vx; vx = null; if (Math.abs(dx) > 40) showPhoto(photoIndex + (dx < 0 ? 1 : -1)); });

    document.addEventListener('keydown', e => {
      if (viewer.open) return;
      if (e.key === 'Escape' && openId) { e.stopPropagation(); close(); }
      if (openId && drawer.contains(document.activeElement) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement.closest('.fac-gallery')) {
        showPhoto(photoIndex + (e.key === 'ArrowLeft' ? -1 : 1));
        const b = drawer.querySelector('[data-fac-full]'); if (b) b.focus({ preventScroll: true });
      }
    });

    // ---- Load once; the map works without it.
    const ready = fetch(DATA_URL).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).then(json => {
      if (!json || !Array.isArray(json.facilities)) return;
      data = json;
      refresh();
      const want = new URLSearchParams(location.search).get('facility');
      const f = want && byId(want);
      if (f) {
        if (f.city !== cityOf() && typeof opts.setCity === 'function') opts.setCity(f.city);
        refresh();
        open(f.id);
      }
    }).catch(() => { box.hidden = true; });

    return { refresh, open, close, ready, get data() { return data; }, get filter() { return filter[cityOf()]; } };
  }

  return { attach };
})();
