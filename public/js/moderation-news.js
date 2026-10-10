/* Moderation: News (moderation.html #modPanelNews; worker/news.js). Loads the
   first time the News tab opens (js/moderation.js fires cch:moderation-news).
   Lists every collected story, hidden ones too, with Hide / Unhide and
   Feature / Unfeature; edits the allow / block lists; runs the ingest now.
   Every call is moderator-gated server-side (requireModerator); this page only
   shows what the API returned. Story text goes in through textContent. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  if (!$('modPanelNews')) return;
  const sessionId = localStorage.getItem('teslaSessionId');
  let loaded = false, cursor = null;

  async function api(path, options = {}) {
    const resp = await fetch(WORKER + path, { ...options, headers: { Authorization: 'Bearer ' + sessionId, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    let json = null;
    try { json = await resp.json(); } catch (e) { /* non-JSON */ }
    return { status: resp.status, ok: resp.ok, json };
  }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const when = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';

  function row(s) {
    const box = el('div', `glass rounded-xl p-3 flex flex-wrap items-start gap-3 ${s.hidden ? 'opacity-50' : ''}`);
    box.dataset.newsId = s.id;
    const main = el('div', 'min-w-0 flex-1');
    const meta = el('div', 'flex flex-wrap items-center gap-2 text-[11px] text-slate-400');
    meta.append(el('span', 'font-semibold text-slate-200', s.source), el('span', '', s.source_type), el('span', '', when(s.published_at)));
    if (s.importance === 2) meta.append(el('span', 'px-1.5 rounded bg-gold text-[#1a1204] font-bold', s.featured ? 'Major · featured' : 'Major'));
    else if (s.importance === 1) meta.append(el('span', 'px-1.5 rounded border border-white/15', 'Notable'));
    if (s.source_count > 1) meta.append(el('span', '', `${s.source_count} outlets`));
    if (s.hidden) meta.append(el('span', 'px-1.5 rounded border border-crimson/50 text-red-300', 'Hidden'));
    const a = el('a', 'block mt-1 text-sm font-semibold text-slate-100 hover:underline', s.title);
    a.href = /^https:\/\//.test(s.url) ? s.url : '#';
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    main.append(meta, a);
    const acts = el('div', 'flex gap-2 shrink-0');
    const btn = (label, action) => { const b = el('button', 'text-xs font-semibold px-3 py-1.5 rounded-lg border border-white/10 text-slate-200 hover:bg-white/5', label); b.type = 'button'; b.dataset.newsAction = action; return b; };
    acts.append(btn(s.hidden ? 'Unhide' : 'Hide', s.hidden ? 'unhide' : 'hide'), btn(s.featured ? 'Unfeature' : 'Feature', s.featured ? 'unfeature' : 'feature'));
    box.append(main, acts);
    return box;
  }

  async function load(more) {
    const r = await api('/api/moderation/news?limit=50' + (more && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!r.ok || !r.json) { $('modNewsRun').textContent = r.status === 403 ? 'Not authorized.' : 'Couldn\'t load the news.'; return; }
    const d = r.json;
    if (!more) {
      $('modNewsList').textContent = '';
      const lr = d.last_run;
      $('modNewsRun').textContent = lr
        ? `Last run ${when(lr.at)}: ${lr.fetched} fetched, ${lr.kept} kept, ${lr.dropped} dropped, ${lr.new} new${lr.not_modified ? `, ${lr.not_modified} feeds unchanged` : ''}${lr.errors && lr.errors.length ? ` · ${lr.errors.length} feed errors` : ''}.`
        : 'The ingest has not run yet.';
      $('modNewsAllow').value = d.config.allow;
      $('modNewsBlock').value = d.config.block;
    }
    d.stories.forEach(s => $('modNewsList').append(row(s)));
    if (!d.stories.length && !more) $('modNewsList').append(el('p', 'text-sm text-slate-400', 'No stories collected yet.'));
    cursor = d.next_cursor;
    $('modNewsMore').classList.toggle('hidden', !cursor);
  }

  $('modNewsList').addEventListener('click', async e => {
    const b = e.target.closest('button[data-news-action]');
    if (!b) return;
    const id = b.closest('[data-news-id]').dataset.newsId;
    b.disabled = true;
    const r = await api(`/api/moderation/news/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action: b.dataset.newsAction }) });
    b.disabled = false;
    if (r.ok) load(false);
  });
  $('modNewsMore').addEventListener('click', () => load(true));
  $('modNewsRunNow').addEventListener('click', async () => {
    const b = $('modNewsRunNow');
    b.disabled = true; b.textContent = 'Running…';
    await api('/api/moderation/news/run', { method: 'POST' });
    b.disabled = false; b.textContent = 'Run the ingest now';
    load(false);
  });
  $('modNewsConfig').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('/api/moderation/news-config', { method: 'PUT', body: JSON.stringify({ allow: $('modNewsAllow').value, block: $('modNewsBlock').value }) });
    $('modNewsConfigNote').textContent = r.ok ? 'Saved. The next run uses these lists.' : (r.json && r.json.error === 'empty_allowlist' ? 'The allowlist needs at least one rule.' : 'Couldn\'t save.');
  });
  const open = () => { if (!loaded) { loaded = true; load(false); } };
  document.addEventListener('cch:moderation-news', open);
  // The page may have reopened on the News tab before this script loaded
  // (js/moderation.js restores the last tab first): load if it is showing.
  if (!$('modPanelNews').classList.contains('hidden')) open();
})();
