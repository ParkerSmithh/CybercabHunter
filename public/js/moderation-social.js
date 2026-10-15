/* Moderation: Community Social reports and the pinned announcement
   (moderation.html #social-reports; worker/social.js). Lists open reports, one
   entry per reported post or comment, with the reasons, the reporters' notes,
   a preview of what was reported and the author's history (removals so far,
   posts in the last 24 hours), and Remove / Dismiss. Every call is
   moderator-gated server-side; a non-moderator just gets nothing and the
   section stays hidden. Text goes in through textContent. */
(function () {
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  if (!$('social-reports')) return;
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
    if (res.ok) { li.remove(); if (!$('modSocialList').children.length) status('No open reports.'); }
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

  async function load() {
    if (!sessionId) return;
    const res = await api('/api/moderation/social/reports');
    if (res.status === 401 || res.status === 403) return;
    $('social-reports').classList.remove('hidden');
    const list = $('modSocialList');
    list.textContent = '';
    if (!res.ok || !res.json) { status('Couldn\'t load reports.'); return; }
    const reports = res.json.reports || [];
    status(reports.length ? `${reports.length} reported ${reports.length === 1 ? 'item' : 'items'} (oldest first).` : 'No open reports.');
    for (const r of reports) list.append(item(r));
    if (location.hash === '#social-reports') $('social-reports').scrollIntoView();
  }

  $('modSocialAnnouncement').addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('modSocialAnnBody').value.trim();
    if (!body) { $('modSocialAnnStatus').textContent = 'Write the announcement first.'; return; }
    const res = await api('/api/moderation/social/announcement', { method: 'PUT', body: JSON.stringify({ body, link_url: $('modSocialAnnLink').value.trim() || null }) });
    $('modSocialAnnStatus').textContent = res.ok ? 'Published. It can take up to 2 minutes to show everywhere.' : (res.json && res.json.error === 'invalid_link' ? 'That link doesn\'t look right.' : 'Couldn\'t publish. Try again.');
  });
  $('modSocialAnnClear').addEventListener('click', async () => {
    if (!window.confirm('Remove the pinned announcement?')) return;
    const res = await api('/api/moderation/social/announcement', { method: 'DELETE' });
    if (res.ok) { $('modSocialAnnBody').value = ''; $('modSocialAnnLink').value = ''; }
    $('modSocialAnnStatus').textContent = res.ok ? 'Cleared.' : 'Couldn\'t clear. Try again.';
  });
  // Pre-fill the form with the current announcement (the public sidebar data).
  fetch(WORKER + '/api/social/sidebar').then(r => (r.ok ? r.json() : null)).then(d => {
    const a = d && d.announcement;
    if (a && !$('modSocialAnnBody').value) { $('modSocialAnnBody').value = a.body; $('modSocialAnnLink').value = a.link_url || ''; }
  }).catch(() => {});
  load();
})();
