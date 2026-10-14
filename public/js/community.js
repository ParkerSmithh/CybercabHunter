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
  // A no-break space keeps each number with its unit when the line wraps.
  const plural = (n, one, many) => `${fmtNum(n)}\u00a0${n === 1 ? one : many}`;
  // Top Overall: what the score is made of, in one short line.
  const breakdown = e => [plural(e.discovered, 'found', 'found'), plural(e.rides, 'ride', 'rides'), plural(e.unique_vehicles, 'car', 'cars'),
    plural(e.cities, 'city', 'cities'), `${fmtNum(e.miles)}\u00a0mi`].join(' · ');

  // Top Overall's points, term by term (worker/community.js overallScore).
  const POINTS = [['discovered', 10, 'found', 'found'], ['rides', 3, 'ride', 'rides'], ['unique_vehicles', 2, 'car', 'cars'], ['cities', 5, 'city', 'cities']];
  function pointsMath(e) {
    const terms = POINTS.map(([k, per, one, many]) => ({ label: `${fmtNum(e[k])} ${e[k] === 1 ? one : many} × ${per}`, pts: e[k] * per }));
    terms.push({ label: `${fmtNum(e.miles)} mi ÷ 10`, pts: Math.round(e.miles / 10) });
    return `<div class="lb-math" aria-label="How ${esc(fmtNum(e.score))} points add up">${terms.map(t => `<span><b>${fmtNum(t.pts)}</b>${esc(t.label)}</span>`).join('<i aria-hidden="true">+</i>')}<i aria-hidden="true">=</i><span class="lb-math-total"><b>${esc(fmtNum(e.score))}</b>pts</span></div>`;
  }
  const METRICS = [['discovered', 'Found'], ['rides', 'Rides'], ['miles', 'Miles'], ['unique_vehicles', 'Cars ridden'], ['cities', 'Cities'], ['xp', 'Spotter XP']];
  const MEDAL = ['gold', 'silver', 'bronze'];

  // A row: the rank (gold / silver / bronze for 1-3; a shared rank is shown
  // once per row, never repeated), avatar, name, the board's number. Tapping it
  // opens the full breakdown (and the public profile link, if there is one).
  function rowHtml(e, i, all) {
    const tied = all.filter(x => x.rank === e.rank).length > 1;
    const medal = e.rank <= 3 ? MEDAL[e.rank - 1] : '';
    const rankBadge = `<span class="lb-rank ${medal ? `is-${medal}` : ''}"><span class="sr-only">Rank </span>${e.rank}${tied ? '<span class="sr-only">, tied</span>' : ''}</span>`;
    const sub = e.handle ? `@${esc(e.handle)}` : 'No public profile yet';
    const detail = activeBoard === 'overall' && Number.isFinite(e.rides)
      ? `<span class="block text-[11px] text-slate-500 truncate mt-0.5 max-sm:text-[10px] max-sm:whitespace-normal max-sm:leading-snug">${esc(breakdown(e))}</span>` : '';
    const metrics = `<dl class="lb-metrics">${METRICS.filter(([k]) => Number.isFinite(e[k])).map(([k, label]) => `<div><dt>${label}</dt><dd class="stat-value">${esc(fmtNum(k === 'miles' ? e[k] : e[k]))}</dd></div>`).join('')}</dl>`;
    const more = e.profile && e.handle
      ? `<a class="lb-profile" href="/rider/${encodeURIComponent(e.handle)}">View @${esc(e.handle)}'s profile <span aria-hidden="true">→</span></a>`
      : `<p class="lb-noprofile">This spotter hasn't set up a public profile yet.</p>`;
    return `<li class="lb-item ${e.rank === 1 ? 'is-first' : ''}">
      <button type="button" class="lb-row ${e.rank === 1 ? 'border-[rgba(250,224,48,0.45)]' : ''}" data-row="${i}" aria-expanded="false" aria-controls="rowNote${i}">
        ${rankBadge}
        <span class="w-10 h-10 max-sm:w-9 max-sm:h-9 shrink-0 rounded-xl overflow-hidden">${avatarHtml(e)}</span>
        <span class="min-w-0 flex-1 text-left">
          <span class="block font-semibold text-sm text-slate-100 truncate">${esc(e.name)}${e.spotter_rank ? ` <span class="lb-spotter-rank spotter-rank rank-${esc(e.spotter_rank_key)}">— ${esc(e.spotter_rank)}</span>` : ''}${tied ? ' <span class="lb-tie">Tied</span>' : ''}</span>
          <span class="block text-xs ${e.handle ? 'text-gold' : 'text-slate-500'} truncate">${sub}${Number.isFinite(e.level) ? `<span class="lb-level"> · Level ${esc(e.level)} · ${esc(fmtNum(e.xp || 0))} XP</span>` : ''}</span>${detail}
        </span>
        <span class="shrink-0 text-right">
          <span class="block stat-value font-semibold text-xl max-sm:text-lg ${e.rank === 1 ? 'text-gold' : 'text-white'} leading-none">${esc(fmtNum(e.count))}</span>
          <span class="block text-[11px] uppercase tracking-wide text-slate-500 mt-1">${esc(e.count === 1 ? unit[0] : unit[1])}</span>
        </span>
        <svg class="lb-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>
      </button>
      <div id="rowNote${i}" class="lb-details" hidden>
        <div class="lb-details-inner">
          ${metrics}
          ${activeBoard === 'overall' && Number.isFinite(e.rides) ? pointsMath(e) : ''}
          ${more}
        </div>
      </div>
    </li>`;
  }

  function show(state) {
    ['boardLoading', 'boardList', 'boardEmpty', 'boardError'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  // Totals over every credited spotter (counts only): the Spotters tile, and
  // under the Discovered board.
  // The Spotters tile counts riders CREDITED WITH A DISCOVERY (anyone who
  // found a vehicle); a board ranks everyone with a figure on it (riders with
  // rides only, too). The line under the board says both, so they never
  // seem to disagree.
  let lastTotals = null, lastBoardSize = null;
  function renderTotals(t) {
    lastTotals = t;
    const ok = t && Number.isInteger(t.spotters) && Number.isInteger(t.vehicles);
    const stat = window.CommunityStats;
    if (stat) { stat.set('statSpotters', ok ? t.spotters : null); stat.set('statDiscovered', ok ? t.vehicles : null); }
    else {
      if ($('statSpotters')) $('statSpotters').textContent = ok ? t.spotters.toLocaleString('en-US') : '—';
      if ($('statDiscovered')) $('statDiscovered').textContent = ok ? t.vehicles.toLocaleString('en-US') : '—';
    }
    const el = $('boardTotals');
    if (!el) return;
    el.classList.toggle('hidden', !ok || lastBoardSize == null);
    if (ok && lastBoardSize != null) el.textContent = `${lastBoardSize.toLocaleString('en-US')} ${lastBoardSize === 1 ? 'rider' : 'riders'} ranked on this board · ${t.spotters.toLocaleString('en-US')} ${t.spotters === 1 ? 'spotter' : 'spotters'} credited with a discovery (${t.vehicles.toLocaleString('en-US')} ${t.vehicles === 1 ? 'vehicle' : 'vehicles'} found in all)`;
  }

  // Public Cybercabs, for the at-a-glance tile (GET /api/registry/stats).
  async function loadRegistryCount() {
    // The same number on the Leaderboard tab and, as "Open to review", on Reviews.
    const ids = ['statVehicles', 'statVehiclesReview'].filter(id => $(id));
    if (!ids.length) return;
    let text = '—';
    try {
      const resp = await fetch(`${API}/api/registry/stats`);
      const data = resp.ok ? await resp.json() : null;
      if (data && Number.isInteger(data.public_vehicles)) text = data.public_vehicles.toLocaleString('en-US');
    } catch (e) { text = '—'; }
    const n = text === '—' ? null : Number(text.replace(/,/g, ''));
    ids.forEach(id => { if (window.CommunityStats) window.CommunityStats.set(id, n); else $(id).textContent = text; });
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
    lastTotals = data.totals;
    // The Top score tile: the Top Overall leader's points (a public board row).
    if (activeBoard === 'overall' && $('statTopScore')) {
      const lead = data.entries[0];
      $('statTopScore').textContent = lead && Number.isFinite(lead.score) ? Number(lead.score).toLocaleString('en-US') : '—';
      const sub = document.querySelector('[data-sub="statTopScore"]');
      if (sub) sub.textContent = lead ? `${lead.name} · Top Overall` : 'Leading Top Overall';
    }
    $('boardTitle').textContent = String(data.label || '').toUpperCase();
    $('boardHelp').textContent = data.help || '';
    $('boardHelp').classList.toggle('hidden', !data.help);
    renderTabs(data.boards);
    const [emptyTitle, emptyText] = EMPTY[activeBoard === 'discovered' ? 'discovered' : 'other'];
    $('boardEmptyTitle').textContent = emptyTitle;
    $('boardEmptyText').textContent = emptyText;
    // The heading says how many are actually ranked; under the board, who is
    // ranked here vs. credited with a discovery (the Spotters tile), honestly.
    const n = data.entries.length;
    $('boardCount').textContent = n >= 10 ? 'Top 10' : `${n} ranked`;
    const invite = $('boardInvite');
    invite.classList.toggle('hidden', n === 0 || n >= 10);
    invite.textContent = n && n < 10 ? `Room for ${10 - n} more on this board. Spot a Cybercab or add a ride receipt to join it.` : '';
    lastBoardSize = n;
    renderTotals(lastTotals);
    if (!n) { show('boardEmpty'); return; }
    $('boardList').innerHTML = data.entries.map((e, i) => rowHtml(e, i, data.entries)).join('');
    // Small spots use the 128 px variant; a failed photo falls back to initials.
    $('boardList').querySelectorAll('[data-avatar-name]').forEach(el =>
      CCC.renderAvatar(el, { url: el.dataset.avatarUrl || null, name: el.dataset.avatarName, size: 128 }));
    show('boardList');
  }

  // A row opens its breakdown (one at a time); the panel eases open in CSS.
  $('boardList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-row]');
    if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    $('boardList').querySelectorAll('button[data-row][aria-expanded="true"]').forEach(b => { if (b !== btn) { b.setAttribute('aria-expanded', 'false'); $(b.getAttribute('aria-controls')).hidden = true; } });
    btn.setAttribute('aria-expanded', String(open));
    $(btn.getAttribute('aria-controls')).hidden = !open;
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
