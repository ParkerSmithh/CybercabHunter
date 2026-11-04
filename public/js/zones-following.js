/* All Sightings | Following on the service-area maps (Zones, every city). The
   server decides everything (GET /api/sightings/following, worker/sightings-public.js):
   signed in, accepted follows only, the public gallery's sightings, per viewer
   and never cached. This only draws the answer.
     - All Sightings is the map as it always was: the toggle changes nothing until
       Following is chosen, and the camera markers come straight back.
     - It asks only when the rider picks Following, changes city, or comes back to
       the tab after a minute away. It never polls, and an older request is cancelled.
     - The map stays where it is when switching.
     - One marker per vehicle at its latest sighting; other sightings are in its
       popup. Sightings with no known position are counted, never placed at a guess. */
window.CCCZonesFollowing = (function () {
  const SESSION_KEY = 'teslaSessionId';
  const RETURN_REFRESH_MS = 60000;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = () => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } };

  // Newest first in, one group per vehicle (or per spot when no public vehicle
  // is attached), at the newest sighting's position.
  function groupSightings(list) {
    const groups = new Map();
    for (const s of list || []) {
      const id = s.vehicle_id ? `v:${s.vehicle_id}` : `p:${s.lat},${s.lng}`;
      if (!groups.has(id)) groups.set(id, { id, lat: s.lat, lng: s.lng, sightings: [] });
      groups.get(id).sightings.push(s);
    }
    return [...groups.values()];
  }

  function spottedText(s) {
    if (!s.spotted_at) return '';
    const opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
    if (s.time_zone) opts.timeZone = s.time_zone;
    try { return new Date(s.spotted_at).toLocaleString('en-US', opts); } catch (e) { return ''; }
  }
  const spotterLink = p => p && p.handle
    ? `<a href="/rider/${encodeURIComponent(p.handle)}">${esc(p.name || p.handle)}</a>`
    : esc((p && p.name) || 'Someone you follow');

  function popupHtml(group) {
    const s = group.sightings[0];
    const image = typeof s.image_url === 'string' && /^\/api\/sightings\/[0-9a-f]{32}\/photo$/.test(s.image_url)
      ? `<img class="zf-pop-img" src="${s.image_url}" alt="Photo of a Cybercab${s.location ? ' at ' + esc(s.location) : ''}" loading="lazy">` : '';
    const title = s.plate
      ? (s.vehicle_id ? `<a href="/vehicle/${encodeURIComponent(s.vehicle_id)}">${esc(s.plate)}</a>` : esc(s.plate))
      : 'Cybercab sighting';
    const more = group.sightings.slice(1);
    return `<div class="zf-pop-eyebrow">Spotted by someone you follow</div>${image}
      <div class="zf-pop-plate">${title}</div>
      <div class="zf-pop-meta">${esc(spottedText(s))}</div>
      ${s.location ? `<div class="zf-pop-meta">${esc(s.location)}</div>` : ''}
      <div class="zf-pop-who">Spotted by ${spotterLink(s.spotter)}</div>
      ${more.length ? `<div class="zf-pop-more">${more.map(m => `<div class="zf-pop-more-row">${spotterLink(m.spotter)}: ${esc(spottedText(m))}${m.location ? ', ' + esc(m.location) : ''}</div>`).join('')}</div>` : ''}`;
  }

  function attach(map, opts = {}) {
    const cityOf = typeof opts.city === 'function' ? opts.city : () => 'austin';
    const features = opts.features;
    let mode = 'all', inFlight = null, seq = 0, lastLoad = 0;

    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl zh-ctrl zf-ctrl';
    box.innerHTML = `<div class="zh-seg" role="group" aria-label="Sightings shown on the map">
        <button type="button" data-zf-mode="all" aria-pressed="true">All Sightings</button>
        <button type="button" data-zf-mode="following" aria-pressed="false">Following</button>
      </div>`;
    ['click', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation()));
    map.addControl({ onAdd: () => box, onRemove: () => box.remove() }, 'bottom-right');

    const card = document.createElement('div');
    card.className = 'zf-card';
    card.hidden = true;
    card.setAttribute('role', 'status');
    ['click', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(ev => card.addEventListener(ev, e => e.stopPropagation()));
    map.getContainer().appendChild(card);
    const note = document.createElement('div');
    note.className = 'zf-note';
    note.hidden = true;
    note.setAttribute('role', 'status');
    map.getContainer().appendChild(note);

    function showCard(title, text, actions) {
      card.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="zf-actions">${actions.join('')}</div>`;
      card.hidden = false;
      note.hidden = true;
    }
    function showNote(text) { note.textContent = text; note.hidden = !text; card.hidden = true; }
    const BACK = '<button type="button" class="zf-btn" data-zf-action="all">All Sightings</button>';
    const signInHref = () => 'signin.html?returnTo=' + encodeURIComponent(location.pathname + location.search);

    function setMode(next) {
      if (next === mode) return;
      mode = next;
      box.querySelectorAll('[data-zf-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.zfMode === mode)));
      if (mode === 'all') {
        if (inFlight) inFlight.abort();
        seq++;
        card.hidden = true;
        note.hidden = true;
        if (features && features.setFollowingSpots) features.setFollowingSpots(null);
      } else {
        load();
      }
    }

    async function load() {
      if (mode !== 'following' || !features || !features.setFollowingSpots) return;
      if (inFlight) inFlight.abort();
      const mine = ++seq;
      const city = cityOf();
      features.setFollowingSpots([]);
      card.hidden = true;
      if (!session()) {
        showCard('Sign in to see Following', 'Sign in to see sightings from people you follow. The public map stays open to everyone.',
          [`<a class="zf-btn is-gold" href="${signInHref()}">Sign in</a>`, BACK]);
        return;
      }
      const ctrl = window.AbortController ? new AbortController() : null;
      inFlight = ctrl;
      let resp = null, data = null;
      try {
        resp = await fetch(`/api/sightings/following?city=${encodeURIComponent(city)}`, {
          headers: { Authorization: 'Bearer ' + session() }, signal: ctrl ? ctrl.signal : undefined
        });
        data = await resp.json();
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
      if (mine !== seq || mode !== 'following') return;
      inFlight = null;
      lastLoad = Date.now();
      if (resp && resp.status === 401) {
        showCard('Sign in to see Following', 'Your session has ended. Sign in again to see sightings from people you follow.',
          [`<a class="zf-btn is-gold" href="${signInHref()}">Sign in</a>`, BACK]);
        return;
      }
      if (!resp || !resp.ok || !data || !Array.isArray(data.sightings)) {
        showCard("Couldn't load Following", 'Check your connection and try again. All Sightings still works.',
          ['<button type="button" class="zf-btn is-gold" data-zf-action="retry">Try again</button>', BACK]);
        return;
      }
      if (data.following_count === 0) {
        showCard('No followed spotters yet', 'Follow other Cybercab spotters to see their sightings on this map.',
          ['<a class="zf-btn is-gold" href="/community?view=leaderboard">Find spotters</a>', BACK]);
        return;
      }
      const groups = groupSightings(data.sightings.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng)));
      const unplaced = Array.isArray(data.unplaced) ? data.unplaced.length : 0;
      if (!groups.length && !unplaced) {
        showCard('No sightings from followed users in this area', 'The people you follow have no recent approved sightings here.', [BACK]);
        return;
      }
      features.setFollowingSpots(groups.map(g => {
        const s = g.sightings[0];
        const who = (s.spotter && s.spotter.name) || 'someone you follow';
        return { id: g.id, lat: g.lat, lng: g.lng, html: popupHtml(g), name: s.plate || s.location || who, label: `Cybercab spotted by ${who}${s.location ? ' at ' + s.location : ''}` };
      }));
      if (!groups.length) {
        showCard('No sightings from followed users in this area', `${unplaced === 1 ? '1 recent sighting has' : unplaced + ' recent sightings have'} no map position, so ${unplaced === 1 ? "it isn't" : "they aren't"} shown here.`,
          [`<a class="zf-btn" href="/sightings?city=${encodeURIComponent(city)}">Open Sightings</a>`, BACK]);
        return;
      }
      showNote(data.next_cursor ? 'Showing the latest sightings'
        : unplaced ? `${unplaced} more ${unplaced === 1 ? 'sighting has' : 'sightings have'} no map position` : '');
    }

    box.addEventListener('click', e => {
      const b = e.target.closest('[data-zf-mode]');
      if (b) setMode(b.dataset.zfMode);
    });
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-zf-action]');
      if (!b) return;
      if (b.dataset.zfAction === 'all') setMode('all');
      if (b.dataset.zfAction === 'retry') load();
    });
    // Coming back after following someone elsewhere: once, not on a timer.
    const onReturn = () => { if (mode === 'following' && !document.hidden && Date.now() - lastLoad > RETURN_REFRESH_MS) load(); };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('pageshow', e => { if (e.persisted) { lastLoad = 0; onReturn(); } });

    return { refresh: load, mode: () => mode };
  }
  return { attach, groupSightings };
})();
