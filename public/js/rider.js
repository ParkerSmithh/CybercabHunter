/* Public rider profile: /rider/<handle> (served as rider.html by the Worker;
   GET /api/riders/:handle, worker/community.js). Only riders who opted in AND
   set a username have one; anything else — including an unknown handle —
   shows the same "private" state, so whether an account exists is never
   revealed. Only public fields and publicly eligible vehicles ever arrive here. */
(function () {
  const API = '';
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '';
  }

  function show(state) {
    ['riderLoading', 'riderPrivate', 'riderError', 'riderProfile'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  function render(data) {
    const r = data.rider;
    document.title = `Cybercab Hunter — ${r.name}`;
    // The shared avatar (js/main.js), large variant.
    CCC.renderAvatar($('riderAvatar'), { url: r.avatar_url, name: r.name, size: 512, textClass: 'text-xl' });
    $('riderName').textContent = r.name;
    $('riderHandle').textContent = `@${r.handle}`;
    $('riderJoined').textContent = r.joined ? `Joined ${fmtMonth(r.joined)}` : '';
    $('riderBio').textContent = r.bio || '';
    $('riderBio').classList.toggle('hidden', !r.bio);

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
