/* Community page: the leaderboards (GET /api/community/leaderboard,
   worker/community.js): Top Overall (default), Most Vehicles Discovered, Most
   Miles, Most Rides, Most Vehicles Ridden — one tab each, switched without a
   reload. Riders who haven't opted in are never sent (worker/community.js).
   Same origin (edge-cached responses). */
(function () {
  const API = '';
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The shared avatar (CCC.renderAvatar in js/main.js: photo, else
  // initials), filled in below.
  function avatarHtml(e) {
    return `<span class="block w-full h-full" data-avatar-url="${esc(e.avatar_url || '')}" data-avatar-name="${esc(e.name)}"></span>`;
  }
  let unit = ['vehicle', 'vehicles'];
  const fmtNum = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;
  // Top Overall: what the score is made of, in one short line.
  const breakdown = e => [plural(e.discovered, 'found', 'found'), plural(e.rides, 'ride', 'rides'), plural(e.unique_vehicles, 'car', 'cars'),
    plural(e.cities, 'city', 'cities'), `${fmtNum(e.miles)} mi`].join(' · ');

  function rowHtml(e, i) {
    const first = e.rank === 1;
    const rankBadge = first
      ? `<span class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-display font-bold text-sm bg-gradient-to-br from-goldsoft to-gold text-[#1a1204]" aria-label="Rank 1">1</span>`
      : `<span class="w-8 h-8 shrink-0 flex items-center justify-center font-display font-bold text-sm text-slate-400" aria-label="Rank ${e.rank}">${e.rank}</span>`;
    const sub = e.handle ? `@${esc(e.handle)}` : 'No public profile yet';
    const detail = activeBoard === 'overall' && Number.isFinite(e.rides)
      ? `<span class="block text-[11px] text-slate-500 truncate mt-0.5 max-sm:text-[10px]">${esc(breakdown(e))}</span>` : '';
    const inner = `
      ${rankBadge}
      <span class="w-10 h-10 max-sm:w-9 max-sm:h-9 shrink-0 rounded-xl overflow-hidden">${avatarHtml(e)}</span>
      <span class="min-w-0 flex-1 text-left">
        <span class="block font-semibold text-sm text-slate-100 truncate">${esc(e.name)}</span>
        <span class="block text-xs ${e.handle ? 'text-gold' : 'text-slate-500'} truncate">${sub}</span>${detail}
      </span>
      <span class="shrink-0 text-right">
        <span class="block stat-value font-semibold text-xl max-sm:text-lg ${first ? 'text-gold' : 'text-white'} leading-none">${esc(fmtNum(e.count))}</span>
        <span class="block text-[11px] uppercase tracking-wide text-slate-500 mt-1">${esc(e.count === 1 ? unit[0] : unit[1])}</span>
      </span>`;
    const box = `w-full flex items-center gap-3 p-3 max-sm:gap-2.5 max-sm:px-2.5 max-sm:py-2 rounded-xl border transition-colors ${first
      ? 'border-[rgba(212,175,55,0.45)] bg-gradient-to-r from-[rgba(212,175,55,0.12)] to-transparent'
      : 'border-transparent hover:bg-white/[0.03]'}`;
    if (e.profile && e.handle) {
      return `<li><a href="/rider/${encodeURIComponent(e.handle)}" class="${box} hover:border-[rgba(212,175,55,0.5)]">${inner}</a></li>`;
    }
    // No public page: tapping explains why, and nothing else.
    const note = "This spotter hasn't set up a public profile yet.";
    return `<li>
      <button type="button" data-row="${i}" aria-expanded="false" aria-controls="rowNote${i}" class="${box} cursor-pointer">${inner}</button>
      <p id="rowNote${i}" class="hidden px-3 pt-1.5 text-xs text-slate-400">${note}</p>
    </li>`;
  }

  function show(state) {
    ['boardLoading', 'boardList', 'boardEmpty', 'boardError'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  // Totals over every credited spotter (counts only): the Spotters tile, and
  // under the Discovered board.
  function renderTotals(t) {
    const ok = t && Number.isInteger(t.spotters) && Number.isInteger(t.vehicles);
    if ($('statSpotters')) $('statSpotters').textContent = ok ? t.spotters.toLocaleString('en-US') : '—';
    const el = $('boardTotals');
    if (!el) return;
    el.classList.toggle('hidden', !ok || t.spotters === 0 || activeBoard !== 'discovered');
    if (ok) el.textContent = `${t.spotters.toLocaleString('en-US')} ${t.spotters === 1 ? 'spotter' : 'spotters'} credited · ${t.vehicles.toLocaleString('en-US')} ${t.vehicles === 1 ? 'vehicle' : 'vehicles'} discovered in all`;
  }

  // Public Cybercabs, for the at-a-glance tile (GET /api/registry/stats).
  async function loadRegistryCount() {
    if (!$('statVehicles')) return;
    try {
      const resp = await fetch(`${API}/api/registry/stats`);
      const data = resp.ok ? await resp.json() : null;
      $('statVehicles').textContent = data && Number.isInteger(data.public_vehicles) ? data.public_vehicles.toLocaleString('en-US') : '—';
    } catch (e) { $('statVehicles').textContent = '—'; }
  }

  let activeBoard = null;
  // Built once; later loads only move the selection (the row keeps its scroll).
  function renderTabs(boards) {
    const tabs = $('boardTabs');
    if (!Array.isArray(boards) || boards.length <= 1) { tabs.classList.add('hidden'); tabs.innerHTML = ''; return; }
    if (!tabs.children.length) {
      tabs.innerHTML = boards.map(b => `<button type="button" role="tab" data-board="${esc(b.id)}" aria-selected="false" aria-controls="boardList" class="city-filter board-tab shrink-0 whitespace-nowrap inline-flex items-center min-h-[40px] px-4 rounded-full text-xs font-semibold border transition-colors max-sm:min-h-[36px] max-sm:px-3.5">${esc(b.label)}</button>`).join('');
    }
    [...tabs.children].forEach(b => {
      const on = b.dataset.board === activeBoard;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && b.scrollIntoView && tabs.scrollWidth > tabs.clientWidth) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    tabs.classList.remove('hidden');
  }
  const EMPTY = {
    discovered: ['No discoveries yet', "Be the first: ride in a Cybercab and add your receipt, or submit a sighting of one that isn't in the registry yet."],
    other: ['No riders here yet', 'Add a Cybercab ride receipt to get on the board.']
  };

  async function load(board) {
    show('boardLoading');
    let data = null;
    try {
      const resp = await fetch(`${API}/api/community/leaderboard${board ? `?board=${encodeURIComponent(board)}` : ''}`);
      data = resp.ok ? await resp.json() : null;
    } catch (e) { data = null; }
    if (!data || !Array.isArray(data.entries)) { show('boardError'); return; }
    activeBoard = data.board;
    if (Array.isArray(data.unit) && data.unit.length === 2) unit = data.unit;
    renderTotals(data.totals);
    $('boardTitle').textContent = String(data.label || '').toUpperCase();
    if (data.help) $('boardHelp').textContent = data.help;
    renderTabs(data.boards);
    const [emptyTitle, emptyText] = EMPTY[activeBoard === 'discovered' ? 'discovered' : 'other'];
    $('boardEmptyTitle').textContent = emptyTitle;
    $('boardEmptyText').textContent = emptyText;
    if (!data.entries.length) { show('boardEmpty'); return; }
    $('boardList').innerHTML = data.entries.map(rowHtml).join('');
    // Small spots use the 128 px variant; a failed photo falls back to initials.
    $('boardList').querySelectorAll('[data-avatar-name]').forEach(el =>
      CCC.renderAvatar(el, { url: el.dataset.avatarUrl || null, name: el.dataset.avatarName, size: 128 }));
    show('boardList');
  }

  $('boardList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-row]');
    if (!btn) return;
    const note = $(btn.getAttribute('aria-controls'));
    const open = note.classList.toggle('hidden') === false;
    btn.setAttribute('aria-expanded', String(open));
  });
  $('boardTabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-board]');
    if (btn && btn.dataset.board !== activeBoard) load(btn.dataset.board);
  });
  // Arrow keys move between the tabs (the tablist pattern).
  $('boardTabs').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...$('boardTabs').children];
    const i = tabs.findIndex(b => b.dataset.board === activeBoard);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next) { e.preventDefault(); next.focus(); load(next.dataset.board); }
  });

  load(null);
  loadRegistryCount();
})();
