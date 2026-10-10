/* /news (news.html): Cybercab and robotaxi headlines from GET /api/news
   (worker/news.js), newest first, grouped by day in Austin time. Each card
   links OUT to the original publisher (new tab): thumbnail from the feed or
   the outlet's initial, headline, the feed's own excerpt, the outlet, a
   Press / Official / Social label, how long ago, topic tags, and an "Also:"
   list when other outlets ran the same story. Major stories (importance 2)
   are pinned in "Top stories". Filters: All / Major only, and a search. */
(function () {
  const $ = id => document.getElementById(id);
  const list = $('newsList');
  if (!list) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'America/Chicago';
  const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? String(u) : null);
  const dayKey = iso => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  function dayLabel(iso) {
    const k = dayKey(iso), today = dayKey(new Date().toISOString()), yest = dayKey(new Date(Date.now() - 864e5).toISOString());
    if (k === today) return 'Today';
    if (k === yest) return 'Yesterday';
    return new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' });
  }
  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT';
  }
  const LABEL = { official: 'Official', social: 'Social', press: 'Press' };

  function thumb(s, big) {
    const img = safeUrl(s.image_url);
    if (img) return `<span class="news-thumb${big ? ' is-big' : ''}" data-initial="${esc((s.source || '?').trim().charAt(0).toUpperCase())}"><img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>`;
    return `<span class="news-thumb is-initial${big ? ' is-big' : ''}" aria-hidden="true">${esc((s.source || '?').trim().charAt(0).toUpperCase())}</span>`;
  }
  // A thumbnail that fails to load becomes the outlet's initial.
  function wireThumbs(root) {
    root.querySelectorAll('.news-thumb > img:not([data-wired])').forEach(img => {
      img.dataset.wired = '1';
      img.addEventListener('error', () => { const box = img.parentNode; box.classList.add('is-initial'); box.textContent = box.dataset.initial || '?'; });
    });
  }
  function card(s, { top = false } = {}) {
    const url = safeUrl(s.url);
    if (!url) return '';
    const major = s.importance === 2;
    const also = (s.also || []).filter(o => safeUrl(o.url));
    return `<article class="news-card${major ? ' is-major' : ''}${top ? ' is-top' : ''}">
      ${thumb(s, top)}
      <div class="min-w-0 flex-1">
        <div class="news-meta">
          ${major ? '<span class="news-badge-major">Major</span>' : ''}
          <span class="news-source">${esc(s.source)}</span>
          <span class="news-type news-type-${esc(s.source_type)}">${esc(LABEL[s.source_type] || 'Press')}</span>
          <span class="news-time"><time datetime="${esc(s.published_at)}">${esc(ago(s.published_at))}</time></span>
        </div>
        <h3 class="news-title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}<span class="sr-only"> (opens ${esc(s.source)} in a new tab)</span></a></h3>
        ${s.excerpt ? `<p class="news-excerpt">${esc(s.excerpt)}</p>` : ''}
        <div class="news-foot">
          ${(s.tags || []).map(t => `<span class="news-tag">${esc(t)}</span>`).join('')}
          ${also.length ? `<details class="news-also"><summary>Also: ${also.length} more ${also.length === 1 ? 'outlet' : 'outlets'}</summary><ul>${also.map(o => `<li><a href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">${esc(o.source)}</a><span class="news-type news-type-${esc(o.source_type)}">${esc(LABEL[o.source_type] || 'Press')}</span><span class="text-slate-500"> · ${esc(ago(o.published_at))}</span></li>`).join('')}</ul></details>` : ''}
        </div>
      </div>
    </article>`;
  }

  // ---- state
  let filter = 'all', query = '', cursor = null, lastDay = null, loading = false, generation = 0;
  const filterBtns = [...document.querySelectorAll('[data-news-filter]')];
  const show = (id, on) => $(id).classList.toggle('hidden', !on);

  async function fetchPage(more) {
    const gen = ++generation;
    loading = true;
    $('newsMore').disabled = true;
    if (!more) { list.innerHTML = ''; lastDay = null; cursor = null; show('newsLoading', true); show('newsEmpty', false); show('newsError', false); show('newsMore', false); }
    const p = new URLSearchParams({ limit: '20' });
    if (filter === 'major') p.set('importance', '2');
    if (query) p.set('q', query);
    if (more && cursor) p.set('cursor', cursor);
    let body = null;
    try { const r = await fetch('/api/news?' + p.toString()); body = r.ok ? await r.json() : null; } catch (e) { body = null; }
    if (gen !== generation) return;   // a newer search replaced this one
    loading = false;
    $('newsMore').disabled = false;
    show('newsLoading', false);
    if (!body || !Array.isArray(body.stories)) { if (!more) show('newsError', true); return; }
    let html = '';
    for (const s of body.stories) {
      const d = dayLabel(s.published_at);
      if (d !== lastDay) { html += `<h2 class="news-day">${esc(d)}</h2>`; lastDay = d; }
      html += card(s);
    }
    list.insertAdjacentHTML('beforeend', html);
    wireThumbs(list);
    cursor = body.next_cursor;
    show('newsMore', !!cursor);
    show('newsEmpty', !more && !body.stories.length);
  }

  async function loadTop() {
    let body = null;
    try { const r = await fetch('/api/news?importance=2&limit=6'); body = r.ok ? await r.json() : null; } catch (e) { body = null; }
    const stories = body && Array.isArray(body.stories) ? body.stories.slice(0, 4) : [];
    $('newsTopList').innerHTML = stories.map(s => card(s, { top: true })).join('');
    wireThumbs($('newsTopList'));
    show('newsTop', stories.length > 0);
  }

  filterBtns.forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.newsFilter;
    filterBtns.forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    fetchPage(false);
  }));
  let timer = 0;
  $('newsSearch').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { query = e.target.value.trim(); fetchPage(false); }, 300);
  });
  $('newsMore').addEventListener('click', () => { if (!loading) fetchPage(true); });

  loadTop();
  fetchPage(false);
})();
