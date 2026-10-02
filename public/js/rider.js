/* Public rider profile: /rider/<handle> (served as rider.html by the Worker;
   GET /api/riders/:handle, worker/community.js). Only riders who opted in AND
   set a username have one; anything else — including an unknown handle —
   shows the same "private" state, so whether an account exists is never
   revealed. Only public fields and publicly eligible vehicles ever arrive here;
   ride figures are counts and city names only. Laid out like the rider's own
   Profile page, then their counts, cities, discoveries and reviews. */
(function () {
  const API = '';
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
  }

  function fmtDay(sqlTime) {
    const d = new Date(String(sqlTime || '').replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function show(state) {
    ['riderLoading', 'riderPrivate', 'riderError', 'riderProfile'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  function render(data) {
    const r = data.rider;
    document.title = `Cybercab Hunter | ${r.name}`;
    // The shared avatar (js/main.js), large variant.
    CCC.renderAvatar($('riderAvatar'), { url: r.avatar_url, name: r.name, size: 512, textClass: 'text-xl' });
    $('riderName').textContent = r.name;
    $('riderHandle').textContent = `@${r.handle}`;
    $('riderJoined').textContent = r.joined ? `Joined ${fmtMonth(r.joined)}` : '';
    // Like the Profile page: the bio, or its "No bio yet." placeholder.
    $('riderBio').textContent = r.bio || 'No bio yet.';
    $('riderBio').classList.toggle('text-slate-500', !r.bio);

    // Public counts (each an em dash if the server didn't send it).
    const rides = data.rides || {}, reviews = data.reviews || {};
    const num = (id, n) => { $(id).textContent = Number.isInteger(n) ? n.toLocaleString('en-US') : '—'; };
    num('riderRides', rides.count);
    num('riderVehiclesRidden', rides.vehicles);
    num('riderCitiesCount', Array.isArray(rides.cities) ? rides.cities.length : null);
    num('riderDiscovered', data.discovered ? data.discovered.count : null);
    num('riderReviewCount', reviews.count);
    $('riderReviewAvg').textContent = typeof reviews.average === 'number' ? `${reviews.average.toFixed(1)} ★` : '—';

    // Cities: rides in each, with its share of all their rides.
    const cities = Array.isArray(rides.cities) ? rides.cities : [];
    const total = rides.count || 0;
    $('riderCities').innerHTML = cities.map(c => {
      const pct = total ? Math.round((c.rides / total) * 100) : 0;
      return `<li>
        <div class="flex items-baseline justify-between gap-3 text-sm"><span class="font-semibold text-slate-100">${esc(c.name)}</span><span class="text-xs text-slate-400 tabular-nums">${esc(c.rides)} ${c.rides === 1 ? 'ride' : 'rides'} · ${pct}%</span></div>
        <div class="mt-1.5 h-1.5 rounded-full overflow-hidden"><div class="h-full rounded-full bg-gradient-to-r from-goldsoft to-gold" style="width:${pct}%"></div></div>
      </li>`;
    }).join('');
    $('riderNoCities').classList.toggle('hidden', cities.length > 0);

    // Their most recent reviews (text via textContent below).
    const recent = Array.isArray(reviews.recent) ? reviews.recent : [];
    $('riderReviews').innerHTML = recent.map(rv => `
      <article class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div class="flex items-center justify-between gap-3">
          <a href="/vehicle/${encodeURIComponent(rv.vehicle.id)}" class="text-xs font-display font-bold tracking-wide text-gold hover:underline">${esc(rv.vehicle.license_plate || 'Cybercab')}</a>
          <span class="text-gold tracking-wider" role="img" aria-label="${rv.rating} out of 5 stars">${'★'.repeat(rv.rating)}${'☆'.repeat(5 - rv.rating)}</span>
        </div>
        <p class="mt-2 text-sm text-slate-300 leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]" data-body></p>
        <div class="mt-2 text-[11px] text-slate-500">${esc(fmtDay(rv.created_at))} · ${rv.like_count} ${rv.like_count === 1 ? 'like' : 'likes'} · ${rv.comment_count} ${rv.comment_count === 1 ? 'comment' : 'comments'}</div>
      </article>`).join('');
    $('riderReviews').querySelectorAll('[data-body]').forEach((el, i) => { el.textContent = recent[i].body; });
    $('riderNoReviews').classList.toggle('hidden', recent.length > 0);

    const vehicles = (data.discovered && data.discovered.vehicles) || [];
    $('riderCount').textContent = String(vehicles.length);
    $('riderVehicles').innerHTML = vehicles.map(v => {
      const detail = [v.model, v.color, v.service_area].filter(Boolean).map(esc).join(' · ');
      return `<li><a href="vehicle/${encodeURIComponent(v.id)}" class="flex items-center justify-between gap-3 p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-[rgba(212,175,55,0.5)] transition-colors">
        <span class="min-w-0">
          <span class="block font-display font-bold text-sm tracking-wide truncate">${esc(v.license_plate || 'Plate not listed')}</span>
          ${detail ? `<span class="block text-[11px] text-slate-500 truncate">${detail}</span>` : ''}
        </span>
        <span class="shrink-0 text-slate-500" aria-hidden="true">&rsaquo;</span>
      </a></li>`;
    }).join('');
    $('riderNoVehicles').classList.toggle('hidden', vehicles.length > 0);
    show('riderProfile');
  }

  async function load() {
    const m = /^\/rider\/([^/]+)\/?$/.exec(location.pathname);
    if (!m) { show('riderPrivate'); return; }
    let resp;
    try { resp = await fetch(`${API}/api/riders/${m[1]}`); } catch (e) { show('riderError'); return; }
    if (resp.status === 404) { show('riderPrivate'); return; }
    let data = null;
    try { data = resp.ok ? await resp.json() : null; } catch (e) { data = null; }
    if (!data || !data.rider) { show('riderError'); return; }
    render(data);
  }

  // The Community page is this page's section in the nav.
  document.querySelectorAll('[data-nav="community"]').forEach(a => { a.classList.add('text-gold'); a.setAttribute('aria-current', 'page'); });
  load();
})();
