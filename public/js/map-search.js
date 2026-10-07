/* Zones map place search (infrastructure.html #mapSearch).
   Type 3+ letters and Austin places are suggested (GET /api/places/map,
   worker/places.js: public, Austin only, Photon/OpenStreetMap data). Picking
   one flies the map there and drops a single gold pin; the next pick moves
   it, and the clear button removes it. Keyboard: Up/Down to move through the
   suggestions, Enter to pick (the first one if none is highlighted), Escape
   to close. An ARIA combobox, so screen readers announce the suggestions.
   Needs MapLibre (maplibregl) and the page's map instance:
     CCCMapSearch.attach(map) */
window.CCCMapSearch = (function () {
  const MIN_QUERY = 3;
  const DEBOUNCE_MS = 250;
  const ZOOM = 15.5;

  // opts.area: optional () => 'austin' | 'dallas', the city whose places are
  // suggested (default Austin; Austin requests are unchanged). Returns
  // { reset } to clear the box and the pin, e.g. on a city switch.
  function attach(map, opts = {}) {
    const areaOf = typeof opts.area === 'function' ? opts.area : () => 'austin';
    const $ = id => document.getElementById(id);
    const input = $('mapSearchInput'), list = $('mapSearchList'), clear = $('mapSearchClear'), status = $('mapSearchStatus');
    if (!input || !list || !map) return;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'mapSearchList');
    input.setAttribute('aria-expanded', 'false');
    list.setAttribute('role', 'listbox');

    let places = [];
    let active = -1;
    let timer = 0;
    let seq = 0;              // only the newest request's answer is shown
    let pin = null;

    const say = text => { if (status) status.textContent = text; };
    const showClear = () => { if (clear) clear.classList.toggle('hidden', !input.value); };

    function close() {
      list.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }

    function highlight(i) {
      active = i;
      [...list.children].forEach((li, n) => li.setAttribute('aria-selected', n === i ? 'true' : 'false'));
      if (i >= 0 && list.children[i]) {
        input.setAttribute('aria-activedescendant', list.children[i].id);
        list.children[i].scrollIntoView && list.children[i].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function render() {
      list.replaceChildren();
      places.forEach((p, i) => {
        const li = document.createElement('li');
        li.id = `mapSearchOption${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.className = 'map-search-option';
        // "Name, City, TX": the name on top, the rest underneath.
        const [first, ...rest] = String(p.label).split(', ');
        const name = document.createElement('span');
        name.className = 'block text-sm text-white truncate';
        name.textContent = first;
        const where = document.createElement('span');
        where.className = 'block text-xs text-slate-400 truncate';
        where.textContent = rest.join(', ');
        li.append(name, where);
        // mousedown, not click: picking must happen before the input's blur.
        li.addEventListener('mousedown', e => { e.preventDefault(); pick(i); });
        list.append(li);
      });
      if (places.length) {
        list.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        say(`${places.length} place${places.length === 1 ? '' : 's'} found.`);
      } else {
        close();
        say(input.value.trim().length >= MIN_QUERY ? 'No Austin places match.' : '');
      }
      active = -1;
    }

    function pick(i) {
      const p = places[i];
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
      input.value = p.label;
      showClear();
      close();
      if (pin) pin.remove();
      const el = document.createElement('div');
      el.className = 'map-search-pin';
      el.setAttribute('aria-label', p.label);
      pin = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
      map.flyTo({ center: [p.lng, p.lat], zoom: ZOOM, essential: true });
      say(`Showing ${p.label} on the map.`);
    }

    async function search(q) {
      const mine = ++seq;
      let resp;
      try {
        const area = areaOf();
        resp = await fetch(`/api/places/map?q=${encodeURIComponent(q)}${area === 'austin' ? '' : `&area=${encodeURIComponent(area)}`}`);
      } catch (e) { resp = null; }
      if (mine !== seq) return;               // a newer search is under way
      if (!resp || !resp.ok) {
        places = [];
        close();
        say(resp && resp.status === 429 ? 'Too many searches. Try again in a minute.' : "Couldn't search places right now. Try again in a moment.");
        return;
      }
      let body = null;
      try { body = await resp.json(); } catch (e) { body = null; }
      if (mine !== seq) return;
      places = (body && Array.isArray(body.places) ? body.places : []).filter(p => p && typeof p.label === 'string');
      render();
    }

    input.addEventListener('input', () => {
      showClear();
      clearTimeout(timer);
      const q = input.value.trim().replace(/\s+/g, ' ');
      if (q.length < MIN_QUERY) { seq++; places = []; close(); say(''); return; }
      timer = setTimeout(() => search(q), DEBOUNCE_MS);
    });

    input.addEventListener('keydown', e => {
      const open = !list.classList.contains('hidden') && places.length;
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlight(Math.min(active + 1, places.length - 1)); }
      else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter' && places.length) { e.preventDefault(); pick(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') { close(); }
    });

    input.addEventListener('focus', () => { if (places.length && input.value.trim().length >= MIN_QUERY && input.value !== (places[0] && places[0].label)) render(); });
    input.addEventListener('blur', () => setTimeout(close, 120));

    if (clear) clear.addEventListener('click', () => {
      input.value = '';
      places = [];
      seq++;
      close();
      showClear();
      if (pin) { pin.remove(); pin = null; }
      say('');
      input.focus();
    });

    return {
      reset() {
        input.value = ''; places = []; seq++; close(); showClear(); say('');
        if (pin) { pin.remove(); pin = null; }
      }
    };
  }

  return { attach };
})();
