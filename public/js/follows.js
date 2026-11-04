/* Followers & Following on the website (worker/follows.js): the follow button,
   the clickable counts and the Followers / Following dialog, used by the rider
   page (js/rider.js) and the Profile page's Follow Requests. The server decides
   who may see what; this only mirrors it. A button changes at once and goes
   back, with a message, if the request fails. */
(function () {
  const SESSION_KEY = 'teslaSessionId';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const session = () => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } };
  const toast = (m, t) => { if (typeof CCC !== 'undefined' && CCC.toast) CCC.toast(m, t); };
  function api(path, opts = {}) {
    const s = session();
    return fetch(path, Object.assign({}, opts, { headers: Object.assign({}, opts.headers || {}, s ? { Authorization: 'Bearer ' + s } : {}) }));
  }
  const readJson = async r => { try { return await r.json(); } catch (e) { return null; } };
  const LABEL = { follow: 'Follow', following: 'Following', requested: 'Requested', follow_back: 'Follow Back', signed_out: 'Follow' };
  const ERRORS = { rate_limited: "You're doing that too often. Try again in a few minutes.", not_found: 'That account is no longer available.', cannot_follow_self: "You can't follow yourself." };
  const signIn = () => { location.href = 'signin.html?returnTo=' + encodeURIComponent(location.pathname + location.search); };

  function paint(btn, state, handle) {
    btn.dataset.state = state;
    btn.textContent = LABEL[state] || 'Follow';
    const who = '@' + handle;
    btn.setAttribute('aria-label', { following: `Following ${who}. Unfollow`, requested: `Follow requested from ${who}. Cancel request`, follow_back: `Follow back ${who}` }[state] || `Follow ${who}`);
    btn.setAttribute('aria-pressed', state === 'following' || state === 'requested' ? 'true' : 'false');
  }

  // One button. `isPrivate`: following is a request; unfollowing would need approval again.
  function makeButton({ handle, state, isPrivate, small, onChange }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'follow-btn' + (small ? ' is-small' : '');
    paint(btn, state, handle);
    btn.addEventListener('click', async () => {
      const was = btn.dataset.state;
      if (was === 'signed_out' || !session()) { signIn(); return; }
      if (btn.disabled) return;   // a repeated tap while one is on its way
      const undoing = was === 'following' || was === 'requested';
      if (was === 'following' && !window.confirm(isPrivate ? `Unfollow @${handle}? This account is private, so you'd need to be approved again.` : `Unfollow @${handle}?`)) return;
      paint(btn, undoing ? 'follow' : (isPrivate ? 'requested' : 'following'), handle);
      btn.disabled = true;
      let resp = null, data = null;
      try { resp = await api(`/api/follows/${encodeURIComponent(handle)}`, { method: undoing ? 'DELETE' : 'PUT' }); data = await readJson(resp); } catch (e) { resp = null; }
      btn.disabled = false;
      if (resp && resp.status === 401) { paint(btn, was, handle); signIn(); return; }
      if (!resp || !resp.ok || !data) {
        paint(btn, was, handle);
        toast(resp ? (ERRORS[data && data.error] || "That didn't go through. Please try again.") : "You're offline. Please try again.", 'error');
        return;
      }
      paint(btn, data.relationship, handle);
      if (onChange) onChange(data);
    });
    return btn;
  }

  // The Followers / Following dialog (one, reused).
  let dialog = null;
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'follow-dialog';
    dialog.setAttribute('aria-labelledby', 'followDialogTitle');
    dialog.innerHTML = `<div class="follow-dialog-head"><h2 id="followDialogTitle"></h2><button type="button" class="follow-dialog-close" aria-label="Close">&times;</button></div>
      <div class="follow-dialog-body"><div data-rows></div><p data-note class="follow-note" role="status"></p><button type="button" data-more class="settings-btn follow-more hidden">Load more</button></div>`;
    dialog.querySelector('.follow-dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    document.body.appendChild(dialog);
    return dialog;
  }

  function personRow(u) {
    const row = document.createElement('div');
    row.className = 'follow-row';
    const sub = [u.handle ? '@' + u.handle : null, u.rank ? u.rank.name : null].filter(Boolean).join(' · ');
    const body = `<div class="follow-row-name">${esc(u.name)}</div><div class="follow-row-sub">${esc(sub)}</div>`;
    row.innerHTML = `<div class="follow-row-avatar" data-avatar></div>${u.handle ? `<a class="follow-row-link" href="/rider/${encodeURIComponent(u.handle)}">${body}</a>` : `<div class="follow-row-link">${body}</div>`}<div class="follow-row-actions" data-actions></div>`;
    if (typeof CCC !== 'undefined' && CCC.renderAvatar) CCC.renderAvatar(row.querySelector('[data-avatar]'), { url: u.avatar_url, name: u.name, size: 128 });
    return row;
  }

  async function openList(handle, kind, { isPrivate } = {}) {
    const d = ensureDialog();
    d.querySelector('#followDialogTitle').textContent = kind === 'followers' ? 'Followers' : 'Following';
    const rows = d.querySelector('[data-rows]'), note = d.querySelector('[data-note]'), more = d.querySelector('[data-more]');
    rows.innerHTML = ''; note.textContent = 'Loading…'; more.classList.add('hidden');
    if (!d.open) d.showModal();
    let cursor = null, token = {};
    d._token = token;
    const load = async () => {
      more.disabled = true;
      let resp = null, data = null;
      try { resp = await api(`/api/follows/${encodeURIComponent(handle)}/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); data = await readJson(resp); } catch (e) { resp = null; }
      if (d._token !== token) return;
      more.disabled = false;
      if (!resp || !resp.ok || !data) {
        note.textContent = resp && resp.status === 403 ? 'This account is private.' : "We couldn't load this list. Please try again.";
        return;
      }
      for (const u of data.users) {
        const row = personRow(u);
        const actions = row.querySelector('[data-actions]');
        if (u.follow_id) {
          // The owner's own followers: Remove.
          const remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'follow-btn is-small'; remove.dataset.state = 'following'; remove.textContent = 'Remove';
          remove.setAttribute('aria-label', `Remove ${u.name} as a follower`);
          remove.addEventListener('click', async () => {
            if (!window.confirm(`Remove ${u.name} as a follower? They won't be told.`)) return;
            remove.disabled = true;
            let r = null; try { r = await api(`/api/followers/${encodeURIComponent(u.follow_id)}`, { method: 'DELETE' }); } catch (e) { r = null; }
            if (!r || !r.ok) { remove.disabled = false; toast("That didn't go through. Please try again.", 'error'); return; }
            row.remove();
            document.dispatchEvent(new CustomEvent('follows:changed'));
          });
          actions.appendChild(remove);
        }
        else if (u.handle && u.relationship && u.relationship !== 'self' && u.relationship !== 'signed_out') {
          actions.appendChild(makeButton({ handle: u.handle, state: u.relationship, small: true, isPrivate: false, onChange: () => document.dispatchEvent(new CustomEvent('follows:changed')) }));
        }
        rows.appendChild(row);
      }
      cursor = data.next_cursor || null;
      more.classList.toggle('hidden', !cursor);
      const hidden = Number(data.hidden_count) || 0;
      if (!rows.children.length && !hidden) note.textContent = kind === 'followers' ? 'No followers yet.' : 'Not following anyone yet.';
      else if (data.hidden_count !== undefined) note.textContent = hidden ? `${hidden.toLocaleString('en-US')} private ${hidden === 1 ? 'account' : 'accounts'} not shown.` : '';
    };
    more.onclick = load;
    await load();
  }

  // The two clickable counts. null counts: the viewer may not see them.
  function renderCounts(el, { handle, counts, isPrivate }) {
    if (!counts) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const label = (n, one, many) => `<b>${Number(n).toLocaleString('en-US')}</b> ${n === 1 ? one : many}`;
    el.innerHTML = `<button type="button" class="follow-count" data-kind="followers" aria-label="${counts.followers} followers, open list">${label(counts.followers, 'Follower', 'Followers')}</button>
      <button type="button" class="follow-count" data-kind="following" aria-label="Following ${counts.following}, open list"><b>${Number(counts.following).toLocaleString('en-US')}</b> Following</button>`;
    el.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => openList(handle, b.dataset.kind, { isPrivate })));
  }

  window.CCFollow = { api, session, readJson, makeButton, renderCounts, openList, personRow, toast };
})();
