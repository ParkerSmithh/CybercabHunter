/* Community page: the leaderboards (GET /api/community/leaderboard,
   worker/community.js). The boards come from the server; tab buttons are
   shown only when there is more than one. A rider who hasn't opted in arrives
   as "Private spotter" with no name, handle or photo — this page never has
   anything else about them to show. Same origin (edge-cached responses). */
(function () {
  const API = '';
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERSON_ICON = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/></svg>';

  function initials(name) {
    const words = String(name || '').replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
    return (words.map(w => w[0]).slice(0, 2).join('') || 'CH').toUpperCase();
  }

  // Photo, else initials (an opted-in rider), else a person icon (private).
  function avatarHtml(e) {
    const initialsTile = `<span class="w-full h-full flex items-center justify-center font-display font-bold text-sm bg-gradient-to-br from-goldsoft to-gold text-[#1a1204]">${esc(initials(e.name))}</span>`;
    if (e.avatar_url) {
      return `<img src="${esc(e.avatar_url)}" alt="" referrerpolicy="no-referrer" class="w-full h-full object-cover" data-initials="${esc(initials(e.name))}">`;
    }
    if (e.name === 'Private spotter' && !e.handle) return `<span class="w-full h-full flex items-center justify-center bg-panel text-slate-500">${PERSON_ICON}</span>`;
    return initialsTile;
  }

  function rowHtml(e, i) {
    const first = e.rank === 1;
    const rankBadge = first
      ? `<span class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-display font-bold text-sm bg-gradient-to-br from-goldsoft to-gold text-[#1a1204]" aria-label="Rank 1">1</span>`
      : `<span class="w-8 h-8 shrink-0 flex items-center justify-center font-display font-bold text-sm text-slate-400" aria-label="Rank ${e.rank}">${e.rank}</span>`;
    const sub = e.handle ? `@${esc(e.handle)}` : (e.name === 'Private spotter' ? 'Profile private' : 'No public profile yet');
    const inner = `
      ${rankBadge}
      <span class="w-10 h-10 shrink-0 rounded-xl overflow-hidden">${avatarHtml(e)}</span>
      <span class="min-w-0 flex-1 text-left">
        <span class="block font-semibold text-sm text-slate-100 truncate">${esc(e.name)}</span>
        <span class="block text-[11px] ${e.handle ? 'text-gold' : 'text-slate-500'} truncate">${sub}</span>
      </span>
      <span class="shrink-0 text-right">
        <span class="block font-display font-bold text-xl text-gold tabular-nums leading-none">${esc(e.count)}</span>
        <span class="block text-[10px] uppercase tracking-wider text-slate-500 mt-1">${e.count === 1 ? 'vehicle' : 'vehicles'}</span>
      </span>`;
    const box = `w-full flex items-center gap-3 p-3 rounded-xl border transition-colors ${first
      ? 'border-[rgba(212,175,55,0.45)] bg-gradient-to-r from-[rgba(212,175,55,0.12)] to-transparent'
      : 'border-white/[0.06] bg-white/[0.02]'}`;
    if (e.profile && e.handle) {
      return `<li><a href="/rider/${encodeURIComponent(e.handle)}" class="${box} hover:border-[rgba(212,175,55,0.5)]">${inner}</a></li>`;
    }
    // No public page: tapping explains why, and nothing else.
    const note = e.name === 'Private spotter' ? "This spotter's profile is private." : "This spotter hasn't set up a public profile yet.";
    return `<li>
      <button type="button" data-row="${i}" aria-expanded="false" aria-controls="rowNote${i}" class="${box} cursor-pointer">${inner}</button>
      <p id="rowNote${i}" class="hidden px-3 pt-1.5 text-xs text-slate-400">${note}</p>
    </li>`;
  }

  function show(state) {
    ['boardLoading', 'boardList', 'boardEmpty', 'boardError'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  let activeBoard = null;
  function renderTabs(boards) {
    const tabs = $('boardTabs');
    if (!Array.isArray(boards) || boards.length <= 1) { tabs.classList.add('hidden'); tabs.innerHTML = ''; return; }
    tabs.innerHTML = boards.map(b => `<button type="button" role="tab" data-board="${esc(b.id)}" aria-selected="${b.id === activeBoard}" class="city-filter inline-flex items-center min-h-[40px] px-4 rounded-full text-xs font-semibold border transition-colors">${esc(b.label)}</button>`).join('');
    tabs.classList.remove('hidden');
  }

  async function load(board) {
    show('boardLoading');
    let data = null;
    try {
      const resp = await fetch(`${API}/api/community/leaderboard${board ? `?board=${encodeURIComponent(board)}` : ''}`);
      data = resp.ok ? await resp.json() : null;
    } catch (e) { data = null; }
    if (!data || !Array.isArray(data.entries)) { show('boardError'); return; }
    activeBoard = data.board;
    $('boardTitle').textContent = String(data.label || '').toUpperCase();
    renderTabs(data.boards);
    if (!data.entries.length) { show('boardEmpty'); return; }
    $('boardList').innerHTML = data.entries.map(rowHtml).join('');
    // A photo that fails to load falls back to the rider's initials.
    $('boardList').querySelectorAll('img[data-initials]').forEach(img => img.addEventListener('error', () => {
      const tile = document.createElement('span');
      tile.className = 'w-full h-full flex items-center justify-center font-display font-bold text-sm bg-gradient-to-br from-goldsoft to-gold text-[#1a1204]';
      tile.textContent = img.dataset.initials;
      img.replaceWith(tile);
    }, { once: true }));
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

  load(null);
})();
