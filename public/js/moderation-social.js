/* Moderation: the Social tab (moderation.html #modPanelSocial; worker/social.js).
   - Overview: posts, comments, pending reports, pinned posts (loaded when the
     tab opens; refreshed after every action here).
   - Reports: open reports, one entry per reported post or comment, with the
     reasons, the reporters' notes, a preview of what was reported and the
     author's history (removals so far, posts in the last 24 hours), and
     Remove / Dismiss. Loaded with the page, for the tab's count.
   - Pinned announcement: the current one, publish, clear.
   - Pinned posts: the feed's pins (the same pin route Social uses), Open, Unpin.
   Every call is moderator-gated server-side; the page itself only shows to
   moderators. Text goes in through textContent. */
(function () {
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  if (!$('modPanelSocial')) return;
  let sessionId = null;
  try { sessionId = localStorage.getItem('teslaSessionId'); } catch (e) { sessionId = null; }
  const REASON = { spam: 'Spam', harassment: 'Harassment', off_topic: 'Off-topic', misleading: 'Misleading', privacy: 'Privacy', other: 'Other' };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const when = t => String(t || '').replace('T', ' ').replace(/(\.\d+)?Z$/, '') + ' UTC';

  async function api(path, options = {}) {
    const resp = await fetch(WORKER + path, { ...options, headers: { Authorization: 'Bearer ' + sessionId, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    let json = null;
    try { json = await resp.json(); } catch (e) { /* non-JSON */ }
    return { status: resp.status, ok: resp.ok, json };
  }
  const status = text => { $('modSocialStatus').textContent = text; };

  async function act(r, action, li) {
    let reason = null;
    if (action === 'remove') {
      reason = window.prompt(`Remove this ${r.target_type} for everyone? Optional note for the log:`, r.reasons.map(x => REASON[x] || x).join(', '));
      if (reason === null) return;
    }
    li.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const res = await api('/api/moderation/social/resolve', { method: 'POST', body: JSON.stringify({ target_type: r.target_type, target_id: r.target_id, action, reason }) });
    if (res.ok) { li.remove(); setCount($('modSocialList').children.length); if (!$('modSocialList').children.length) status('No open reports.'); loadOverview(); }
    else { li.querySelectorAll('button').forEach(b => { b.disabled = false; }); status('That action failed. Try again.'); }
  }

  function item(r) {
    const li = el('li', 'rounded-xl border border-white/10 p-4');
    const head = el('div', 'flex flex-wrap items-baseline justify-between gap-2');
    const who = r.author ? (r.author.name || 'Unnamed') + (r.author.handle ? ` (@${r.author.handle})` : '') : 'Deleted account';
    head.append(el('p', 'text-sm font-semibold text-slate-100', `${r.target_type === 'post' ? 'Post' : 'Comment'} by ${who}`),
      el('span', 'text-xs font-semibold text-red-300', `${r.report_count} ${r.report_count === 1 ? 'report' : 'reports'}: ${r.reasons.map(x => REASON[x] || x).join(', ')}`));
    li.append(head);
    if (r.author_history) {
      const h = r.author_history;
      li.append(el('p', `text-xs mt-1 ${h.removals ? 'text-amber-300' : 'text-slate-500'}`, `Author history: ${h.removals} earlier ${h.removals === 1 ? 'removal' : 'removals'} · ${h.posts_24h} ${h.posts_24h === 1 ? 'post' : 'posts'} in the last 24 h${h.removals >= 3 ? ' · repeat offender' : ''}`));
    }
    const box = el('div', 'mt-3 rounded-lg bg-white/[0.03] border border-white/[0.06] p-3');
    if (r.target_missing) box.append(el('p', 'text-sm text-slate-500 italic', 'Already deleted.'));
    else {
      const t = r.target;
      if (t.body) box.append(el('p', 'text-sm text-slate-200 whitespace-pre-wrap break-words', t.body));
      if (t.review) box.append(el('p', 'text-xs text-slate-400 mt-1', `Ride review: ${t.review.rating}/5`));
      if (t.link_url) box.append(el('p', 'text-xs text-slate-400 mt-1 break-all', `Link: ${t.link_url}`));
      if (t.photos && t.photos.length) {
        const g = el('div', 'mt-2 flex gap-2 flex-wrap');
        for (const p of t.photos) {
          const a = el('a'); a.href = WORKER + p.url; a.target = '_blank'; a.rel = 'noopener';
          const img = el('img', 'w-20 h-20 object-cover rounded-md'); img.alt = 'Reported photo'; img.loading = 'lazy';
          // Photos of a removed post need the moderator's session, so load them with it.
          fetch(WORKER + p.url, { headers: { Authorization: 'Bearer ' + sessionId } }).then(x => (x.ok ? x.blob() : null)).then(b => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
          a.append(img); g.append(a);
        }
        box.append(g);
      }
      const meta = el('p', 'text-xs text-slate-500 mt-2', `Posted ${when(t.created_at)} · `);
      const open = el('a', 'text-gold hover:underline', 'Open on Social'); open.href = t.url; open.target = '_blank'; open.rel = 'noopener';
      meta.append(open);
      box.append(meta);
    }
    li.append(box);
    if (r.details && r.details.some(d => d.details)) {
      const notes = el('ul', 'mt-3 space-y-1');
      for (const d of r.details) if (d.details) notes.append(el('li', 'text-xs text-slate-300', `${REASON[d.reason] || d.reason}: “${d.details}”`));
      li.append(notes);
    }
    const btns = el('div', 'mt-3 flex gap-2 flex-wrap');
    const rm = el('button', 'min-h-[44px] px-4 rounded-lg text-sm font-bold bg-crimson text-white', r.target_missing ? 'Close reports' : 'Remove');
    const no = el('button', 'min-h-[44px] px-4 rounded-lg text-sm font-semibold border border-white/15 text-slate-100 hover:bg-white/5', 'Dismiss');
    rm.type = no.type = 'button';
    rm.addEventListener('click', () => (r.target_missing ? act(r, 'dismiss', li) : act(r, 'remove', li)));
    no.addEventListener('click', () => act(r, 'dismiss', li));
    btns.append(rm, no);
    li.append(btns);
    return li;
  }

  const setCount = n => { if ($('modCountSocial')) $('modCountSocial').textContent = n ? String(n) : ''; };

  async function load() {
    if (!sessionId) return;
    const res = await api('/api/moderation/social/reports');
    if (res.status === 401 || res.status === 403) return;
    const list = $('modSocialList');
    list.textContent = '';
    if (!res.ok || !res.json) { status('Couldn\'t load reports.'); return; }
    const reports = res.json.reports || [];
    setCount(reports.length);
    status(reports.length ? `${reports.length} reported ${reports.length === 1 ? 'item' : 'items'} (oldest first).` : 'No open reports.');
    for (const r of reports) list.append(item(r));
    if (location.hash === '#social-reports') $('social-reports').scrollIntoView();
  }

  // ---- Overview and pinned posts (GET /api/moderation/social/overview) ----
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  function pinItem(p) {
    const li = el('li', 'rounded-xl border border-white/10 p-4 flex flex-wrap items-start justify-between gap-3');
    const text = el('div', 'min-w-0 flex-1');
    const who = (p.author.name || 'Unnamed') + (p.author.handle ? ` (@${p.author.handle})` : '');
    text.append(el('p', 'text-sm font-semibold text-slate-100', who));
    const body = p.body.length > 200 ? p.body.slice(0, 199).trimEnd() + '…' : p.body;
    text.append(el('p', 'text-sm text-slate-300 mt-1 whitespace-pre-wrap break-words', body || (p.has_review ? 'Ride review' : p.has_photos ? 'Photo post' : '')));
    text.append(el('p', 'text-xs text-slate-500 mt-1', `Pinned ${when(p.pinned_at)}`));
    const btns = el('div', 'flex gap-2 flex-wrap');
    const open = el('a', 'min-h-[44px] inline-flex items-center px-4 rounded-lg text-sm font-semibold border border-white/15 text-slate-100 hover:bg-white/5', 'Open');
    open.href = p.url; open.target = '_blank'; open.rel = 'noopener';
    const unpin = el('button', 'min-h-[44px] px-4 rounded-lg text-sm font-semibold border border-[rgba(250,224,48,0.35)] text-gold hover:bg-white/5', 'Unpin');
    unpin.type = 'button';
    unpin.addEventListener('click', async () => {
      unpin.disabled = true;
      const res = await api(`/api/social/posts/${encodeURIComponent(p.id)}/pin`, { method: 'DELETE' });
      if (res.ok) loadOverview();
      else { unpin.disabled = false; $('modSocialPinsStatus').textContent = 'Couldn\'t unpin. Try again.'; }
    });
    btns.append(open, unpin);
    li.append(text, btns);
    return li;
  }
  let overviewLoaded = false;
  async function loadOverview() {
    if (!sessionId) return;
    overviewLoaded = true;
    const res = await api('/api/moderation/social/overview');
    if (res.status === 401 || res.status === 403) return;
    if (!res.ok || !res.json) { $('modSocialStatsNote').textContent = 'Couldn\'t load the overview.'; $('modSocialPinsStatus').textContent = 'Couldn\'t load pinned posts.'; return; }
    const { stats, pinned, max_pins: maxPins } = res.json;
    document.querySelectorAll('[data-social-stat]').forEach(dd => { dd.textContent = Number(stats[dd.dataset.socialStat] || 0).toLocaleString('en-US'); });
    $('modSocialReportDetail').textContent = stats.open_reports !== stats.open_report_items ? `${plural(stats.open_reports, 'report', 'reports')} in all` : '';
    $('modSocialStatsNote').textContent = 'Posts and comments as the public sees them (removed ones are not counted).';
    const list = $('modSocialPins');
    list.textContent = '';
    $('modSocialPinsStatus').textContent = pinned.length ? `${pinned.length} of ${maxPins} pins in use.` : 'No pinned posts.';
    for (const p of pinned) list.append(pinItem(p));
  }
  document.addEventListener('cch:moderation-social', () => { if (!overviewLoaded) loadOverview(); });

  $('modSocialAnnouncement').addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('modSocialAnnBody').value.trim();
    if (!body) { $('modSocialAnnStatus').textContent = 'Write the announcement first.'; return; }
    const res = await api('/api/moderation/social/announcement', { method: 'PUT', body: JSON.stringify({ body, link_url: $('modSocialAnnLink').value.trim() || null, notify: $('modSocialAnnNotify').checked }) });
    $('modSocialAnnStatus').textContent = res.ok ? 'Published. It can take up to 2 minutes to show everywhere.' : (res.json && res.json.error === 'invalid_link' ? 'That link doesn\'t look right.' : 'Couldn\'t publish. Try again.');
    if (res.ok) showCurrent({ body, link_url: $('modSocialAnnLink').value.trim() || null });
  });
  $('modSocialAnnClear').addEventListener('click', async () => {
    if (!window.confirm('Remove the pinned announcement?')) return;
    const res = await api('/api/moderation/social/announcement', { method: 'DELETE' });
    if (res.ok) { $('modSocialAnnBody').value = ''; $('modSocialAnnLink').value = ''; showCurrent(null); }
    $('modSocialAnnStatus').textContent = res.ok ? 'Cleared.' : 'Couldn\'t clear. Try again.';
  });
  function showCurrent(a) {
    $('modSocialAnnCurrent').textContent = a ? `Current: “${a.body}”${a.link_url ? ` (${a.link_url})` : ''}` : 'Current: none';
  }
  // Pre-fill the form with the current announcement (the public sidebar data).
  fetch(WORKER + '/api/social/sidebar').then(r => (r.ok ? r.json() : null)).then(d => {
    const a = d && d.announcement;
    showCurrent(a || null);
    if (a && !$('modSocialAnnBody').value) { $('modSocialAnnBody').value = a.body; $('modSocialAnnLink').value = a.link_url || ''; }
  }).catch(() => { $('modSocialAnnCurrent').textContent = 'Current: couldn\'t load'; });
  load();
  // js/moderation.js may have reopened the Social tab before this script loaded.
  if (!$('modPanelSocial').classList.contains('hidden')) loadOverview();
})();
