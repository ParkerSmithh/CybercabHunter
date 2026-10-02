/* "Find riders" on the Community page (GET /api/rider-search,
   worker/community.js). From the first character, and 250ms after the last
   keystroke, asks the server for up to 8 matching riders — only ones with a
   public profile ever come back — and shows them as suggestions. Clicking
   one, or choosing it with the arrow keys and Enter, opens /rider/<handle>.
   Escape or a click outside closes the list. A slower, older answer never
   replaces a newer one. Names go in through textContent. */
window.CCCRiderSearch = (function () {
  const api = { navigate: url => location.assign(url) };   // replaceable in tests
  const $ = id => document.getElementById(id);
  const input = $('riderSearchInput');
  const list = $('riderSearchList');
  if (!input || !list) return api;
  const MIN = 1;
  const DEBOUNCE_MS = 250;
  const PERSON_ICON = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/> <path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/></svg>';

  let timer = null;
  let seq = 0;            // the latest request; older answers are ignored
  let results = [];
  let active = -1;        // highlighted suggestion, or -1

  function close() {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function open() {
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }
  function note(text) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'px-3 py-3 text-xs text-slate-400';
    li.setAttribute('role', 'presentation');
    li.dataset.note = '';
    li.textContent = text;
    list.appendChild(li);
    results = [];
    open();
  }

  function highlight(i) {
    active = i;
    [...list.querySelectorAll('[role="option"]')].forEach((el, n) => {
      const on = n === i;
      el.setAttribute('aria-selected', String(on));
      el.classList.toggle('bg-white/[0.06]', on);
      if (on) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView && el.scrollIntoView({ block: 'nearest' }); }
    });
    if (i < 0) input.removeAttribute('aria-activedescendant');
  }

  function render(items) {
    results = items;
    if (!items.length) { note('No riders found'); return; }
    list.innerHTML = '';
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.id = `riderOption${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.handle = r.handle;
      li.className = 'flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.06]';
      const avatar = document.createElement('span');
      avatar.className = 'w-8 h-8 shrink-0 rounded-lg overflow-hidden';
      const text = document.createElement('span');
      text.className = 'min-w-0';
      const name = document.createElement('span');
      name.className = 'block text-sm font-semibold text-slate-100 truncate';
      name.textContent = r.name;
      const handle = document.createElement('span');
      handle.className = 'block text-[11px] text-gold truncate';
      handle.textContent = `@${r.handle}`;
      text.append(name, handle);
      li.append(avatar, text);
      list.appendChild(li);
      // The shared avatar (js/main.js): photo, else initials.
      if (typeof CCC !== 'undefined' && CCC.renderAvatar) CCC.renderAvatar(avatar, { url: r.avatar_url || null, name: r.name, size: 128 });
      else avatar.innerHTML = `<span class="w-full h-full flex items-center justify-center bg-panel text-slate-500">${PERSON_ICON}</span>`;
    });
    open();
    highlight(-1);
  }

  async function search(q) {
    const mine = ++seq;
    let data = null, status = 0;
    try {
      const resp = await fetch(`/api/rider-search?q=${encodeURIComponent(q)}`);
      status = resp.status;
      data = resp.ok ? await resp.json() : null;
    } catch (e) { data = null; }
    if (mine !== seq || input.value.trim() !== q) return;   // a newer search is under way
    if (status === 429) { note('Too many searches — try again in a minute.'); return; }
    if (!data || !Array.isArray(data.results)) { note("Search isn't available right now."); return; }
    render(data.results);
  }

  function go(i) {
    const r = results[i];
    if (r && r.handle) api.navigate(`/rider/${encodeURIComponent(r.handle)}`);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < MIN) { seq++; close(); list.innerHTML = ''; results = []; return; }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', e => {
    const n = results.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); if (list.classList.contains('hidden')) open(); highlight((active + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); highlight(active <= 0 ? n - 1 : active - 1); }
    else if (e.key === 'Enter') {
      if (!list.classList.contains('hidden') && n) { e.preventDefault(); go(active >= 0 ? active : 0); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('focus', () => { if (input.value.trim().length >= MIN && list.children.length) open(); });
  // mousedown (not click) so the input keeps focus until we navigate.
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('[role="option"]');
    if (!li) return;
    e.preventDefault();
    go([...list.querySelectorAll('[role="option"]')].indexOf(li));
  });
  document.addEventListener('mousedown', e => { if (!$('riderSearch').contains(e.target)) close(); });
  return api;
})();
