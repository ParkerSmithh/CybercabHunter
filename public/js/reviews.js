/* Cybercab reviews on the Community page (worker/reviews.js). Anyone can read;
   signed-in riders write, like and comment — the server checks every write
   against the session, so the buttons here are only conveniences. Authors and
   commenters with a private account arrive as "Anonymous" with no name, handle
   or photo; this page never has anything else about them to show. Every value
   from the API goes in escaped or through textContent. Same origin. */
(function () {
  const $ = id => document.getElementById(id);
  if (!$('reviews')) return;
  const SESSION_KEY = 'teslaSessionId';
  const MAX_PHOTOS = 3;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const PAGE = 20;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PERSON_ICON = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"/></svg>';
  const HEART = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.2 5 6.6 5c2 0 3.6 1.1 4.4 2.6h2C13.8 6.1 15.4 5 17.4 5 20.8 5 23 8.3 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
  const BUBBLE = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  const ERRORS = {
    already_reviewed: "You've already reviewed this Cybercab — use Edit on your review below.",
    unknown_vehicle: 'Choose a Cybercab from the list.',
    invalid_rating: 'Choose a rating from 1 to 5 stars.',
    missing_text: 'Write a few words about the ride.',
    text_too_long: 'That is too long.',
    too_many_photos: 'Up to 3 photos per review.',
    file_too_large: 'Each photo must be 5 MB or smaller.',
    unsupported_file_type: 'Photos must be JPEG, PNG or WebP.',
    rate_limited: "You're going a bit fast — try again in a minute.",
    forbidden: "You can't change that.",
    not_found: 'That review is no longer available.'
  };
  const errorText = code => ERRORS[code] || 'Something went wrong — please try again.';

  function session() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }
  function api(path, opts = {}) {
    const s = session();
    const headers = Object.assign({}, opts.headers || {}, s ? { Authorization: 'Bearer ' + s } : {});
    return fetch(path, Object.assign({}, opts, { headers }));
  }
  // main.js's CCC is a top-level const, not a window property.
  const ccc = () => (typeof CCC !== 'undefined' ? CCC : null);
  const toast = (msg, type) => { const c = ccc(); if (c && c.toast) c.toast(msg, type); };
  async function json(resp) { try { return await resp.json(); } catch (e) { return null; } }

  // "just now", "5m ago", "3h ago", "2d ago", then "Sep 30" / "Sep 30, 2025".
  function relative(sqlTime, now = Date.now()) {
    const ms = Date.parse(String(sqlTime || '').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    const d = new Date(ms);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
  }
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

  function avatarHtml(person, size = 'w-10 h-10') {
    if (person.anonymous) return `<span class="${size} shrink-0 rounded-xl overflow-hidden flex items-center justify-center bg-panel text-slate-500">${PERSON_ICON}</span>`;
    return `<span class="${size} shrink-0 rounded-xl overflow-hidden"><span class="block w-full h-full" data-avatar-url="${esc(person.avatar_url || '')}" data-avatar-name="${esc(person.name)}"></span></span>`;
  }
  function nameHtml(person) {
    const name = `<span class="font-semibold text-sm text-slate-100">${esc(person.name)}</span>`;
    return !person.anonymous && person.handle ? `<a href="/rider/${encodeURIComponent(person.handle)}" class="hover:underline">${name}</a>` : name;
  }
  function paintAvatars(root) {
    const c = ccc();
    if (!c || !c.renderAvatar) return;
    root.querySelectorAll('[data-avatar-name]').forEach(el => c.renderAvatar(el, { url: el.dataset.avatarUrl || null, name: el.dataset.avatarName, size: 128 }));
  }

  // ---------- State ----------
  let sort = 'recent';
  let offset = 0;
  let viewer = { signed_in: false, moderator: false };
  const byId = new Map();

  function show(state) {
    ['reviewLoading', 'reviewList', 'reviewEmpty', 'reviewError'].forEach(id => $(id).classList.toggle('hidden', id !== state));
  }

  function renderSummary(summary) {
    const count = summary && Number.isInteger(summary.count) ? summary.count : null;
    const avg = summary && typeof summary.average === 'number' ? summary.average : null;
    $('reviewAverage').textContent = avg == null ? '—' : avg.toFixed(1);
    $('reviewAverageStars').textContent = avg == null ? '' : stars(Math.round(avg));
    $('reviewCount').textContent = count == null ? '' : count === 0 ? 'No reviews yet' : `${count.toLocaleString('en-US')} ${count === 1 ? 'review' : 'reviews'}`;
    // The 5★ → 1★ breakdown: each bar is that rating's share of all reviews.
    const dist = summary && summary.distribution;
    document.querySelectorAll('#reviewBreakdown [data-stars]').forEach(li => {
      const n = dist && Number.isInteger(dist[li.dataset.stars]) ? dist[li.dataset.stars] : null;
      li.querySelector('[data-n]').textContent = n == null ? '—' : n.toLocaleString('en-US');
      li.querySelector('[data-bar]').style.width = n && count ? `${Math.round((n / count) * 100)}%` : '0%';
    });
    // The page's at-a-glance tiles.
    if ($('statReviews')) $('statReviews').textContent = count == null ? '—' : count.toLocaleString('en-US');
    if ($('statRating')) $('statRating').textContent = avg == null ? '—' : avg.toFixed(1);
  }

  function cardHtml(r) {
    const plate = r.vehicle && r.vehicle.license_plate ? esc(r.vehicle.license_plate) : 'Cybercab';
    const vehicle = r.vehicle && r.vehicle.id ? `<a href="/vehicle/${encodeURIComponent(r.vehicle.id)}" class="text-gold hover:underline">${plate}</a>` : plate;
    const photos = (r.photos || []).map((p, i) => `<button type="button" data-photo="${esc(p.url)}" class="block aspect-square rounded-lg overflow-hidden bg-panel border border-white/[0.06]" aria-label="Enlarge photo ${i + 1}"><img src="${esc(p.url)}" alt="" loading="lazy" class="w-full h-full object-cover"></button>`).join('');
    const edited = r.updated_at && r.updated_at !== r.created_at ? ' · edited' : '';
    return `
      <article class="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4" data-review="${esc(r.id)}">
        <header class="flex items-start gap-3">
          ${avatarHtml(r.author)}
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2 flex-wrap">${nameHtml(r.author)}<span class="text-[11px] text-slate-500">${esc(relative(r.created_at))}${edited}</span></div>
            <div class="mt-1"><span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[rgba(212,175,55,0.2)] bg-[rgba(212,175,55,0.06)] text-[11px] text-slate-400"><svg class="w-3 h-3 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 11l1.3-3.9A2 2 0 0 1 8.2 5.7h7.6a2 2 0 0 1 1.9 1.4L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/></svg>Cybercab ${vehicle}</span></div>
          </div>
          <span class="shrink-0 text-gold text-base tracking-wider" role="img" aria-label="${r.rating} out of 5 stars">${stars(r.rating)}</span>
        </header>
        <p class="mt-3 text-sm text-slate-200 leading-relaxed whitespace-pre-line break-words" data-body></p>
        ${photos ? `<div class="mt-3 grid grid-cols-3 gap-2 max-w-sm">${photos}</div>` : ''}
        <footer class="mt-3 flex items-center gap-2 flex-wrap">
          <button type="button" data-like aria-pressed="${r.liked}" class="review-like inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] text-xs font-semibold text-slate-300 hover:bg-white/5">${HEART}<span data-like-count>${r.like_count}</span><span class="sr-only"> likes</span></button>
          <button type="button" data-comments aria-expanded="false" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.1] text-xs font-semibold text-slate-300 hover:bg-white/5">${BUBBLE}<span data-comment-count>${r.comment_count}</span><span class="sr-only"> comments</span></button>
          <span class="flex-1"></span>
          ${r.mine ? '<button type="button" data-edit class="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white">Edit</button>' : ''}
          ${r.can_delete ? '<button type="button" data-delete class="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-white">Delete</button>' : ''}
        </footer>
        <div data-thread class="hidden mt-3 pt-3 border-t border-white/[0.06]">
          <ul data-comment-list class="space-y-3"></ul>
          ${viewer.signed_in
            ? `<form data-comment-form class="mt-3 flex gap-2"><label class="sr-only" for="c-${esc(r.id)}">Add a comment</label><input id="c-${esc(r.id)}" maxlength="500" placeholder="Add a comment" class="flex-1 min-w-0 bg-panel border border-[rgba(212,175,55,0.25)] rounded-lg px-3 py-2 text-sm placeholder:text-slate-600"><button type="submit" class="shrink-0 px-3 py-2 rounded-lg text-xs font-bold bg-gradient-to-r from-goldsoft to-gold text-[#1a1204]">Post</button></form><p data-comment-error class="hidden text-[11px] text-red-300 mt-1.5" role="alert"></p>`
            : '<p class="mt-3 text-xs text-slate-500"><a href="signin.html?returnTo=%2Fcommunity" class="text-gold hover:underline">Sign in</a> to comment.</p>'}
        </div>
      </article>`;
  }

  function addCards(reviews) {
    const list = $('reviewList');
    for (const r of reviews) {
      byId.set(r.id, r);
      list.insertAdjacentHTML('beforeend', cardHtml(r));
      list.lastElementChild.querySelector('[data-body]').textContent = r.body;
    }
    paintAvatars(list);
  }

  async function load(reset = true) {
    if (reset) { offset = 0; byId.clear(); show('reviewLoading'); }
    let data = null;
    try { data = await json(await api(`/api/reviews?sort=${sort}&offset=${offset}&limit=${PAGE}`)); } catch (e) { data = null; }
    if (!data || !Array.isArray(data.reviews)) { if (reset) { renderSummary(null); show('reviewError'); } return; }
    viewer = data.viewer || viewer;
    $('reviewSignInNote').classList.toggle('hidden', viewer.signed_in);
    renderSummary(data.summary);
    if (reset) $('reviewList').innerHTML = '';
    addCards(data.reviews);
    offset += data.reviews.length;
    $('reviewMore').classList.toggle('hidden', offset >= data.total);
    show(byId.size ? 'reviewList' : 'reviewEmpty');
  }

  function setSort(next) {
    sort = next;
    document.querySelectorAll('#reviewSort [data-sort]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === sort)));
  }
  $('reviewSort').addEventListener('click', e => {
    const b = e.target.closest('[data-sort]');
    if (b && b.dataset.sort !== sort) { setSort(b.dataset.sort); load(true); }
  });
  $('reviewMore').addEventListener('click', () => load(false));

  // ---------- Write / edit ----------
  let editing = null;        // the review being edited, or null for a new one
  let rating = 0;
  let keep = [];             // existing photos kept while editing: [{ id, url }]
  let added = [];            // new files: [{ file, url }]
  let vehiclesLoaded = false;

  function setRating(n) {
    rating = n;
    document.querySelectorAll('#reviewStars [data-star]').forEach(b => {
      const v = Number(b.dataset.star);
      b.classList.toggle('is-on', v <= n);
      b.setAttribute('aria-checked', String(v === n));
    });
  }
  $('reviewStars').addEventListener('click', e => { const b = e.target.closest('[data-star]'); if (b) setRating(Number(b.dataset.star)); });
  $('reviewStars').addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setRating(Math.min(5, rating + 1)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setRating(Math.max(1, rating - 1)); }
  });
  $('reviewBody').addEventListener('input', () => { $('reviewBodyCount').textContent = String($('reviewBody').value.length); });

  function formError(msg) { $('reviewFormError').textContent = msg || ''; $('reviewFormError').classList.toggle('hidden', !msg); }

  function renderPhotoList() {
    const items = [...keep.map((p, i) => ({ url: p.url, kind: 'keep', i })), ...added.map((p, i) => ({ url: p.url, kind: 'added', i }))];
    $('reviewPhotoList').innerHTML = items.map(p => `
      <span class="relative w-20 h-20 rounded-lg overflow-hidden border border-white/[0.1] bg-panel">
        <img src="${esc(p.url)}" alt="" class="w-full h-full object-cover">
        <button type="button" data-remove="${p.kind}:${p.i}" aria-label="Remove photo" class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-sm leading-none">&times;</button>
      </span>`).join('');
    $('reviewPhotoAdd').classList.toggle('hidden', items.length >= MAX_PHOTOS);
  }
  $('reviewPhotoList').addEventListener('click', e => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const [kind, i] = b.dataset.remove.split(':');
    if (kind === 'keep') keep.splice(Number(i), 1);
    else { URL.revokeObjectURL(added[Number(i)].url); added.splice(Number(i), 1); }
    renderPhotoList();
  });
  $('reviewPhotos').addEventListener('change', () => {
    formError('');
    for (const file of $('reviewPhotos').files) {
      if (keep.length + added.length >= MAX_PHOTOS) { formError(errorText('too_many_photos')); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { formError(errorText('unsupported_file_type')); continue; }
      if (file.size > MAX_PHOTO_BYTES) { formError(errorText('file_too_large')); continue; }
      added.push({ file, url: URL.createObjectURL(file) });
    }
    $('reviewPhotos').value = '';
    renderPhotoList();
  });

  async function loadVehicles() {
    if (vehiclesLoaded) return;
    try {
      const data = await json(await fetch('/api/robotaxi-vehicles?limit=100'));
      const sel = $('reviewVehicle');
      const vehicles = ((data && data.vehicles) || []).filter(v => v.license_plate).sort((x, y) => x.license_plate.localeCompare(y.license_plate));
      for (const v of vehicles) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.license_plate + (v.service_area ? ` · ${v.service_area}` : '');
        sel.appendChild(o);
      }
      vehiclesLoaded = true;
    } catch (e) { /* the select stays with its placeholder */ }
  }

  async function openForm(review) {
    if (!viewer.signed_in) { location.href = 'signin.html?returnTo=%2Fcommunity'; return; }
    editing = review || null;
    await loadVehicles();
    const sel = $('reviewVehicle');
    if (editing) {
      if (![...sel.options].some(o => o.value === editing.vehicle.id)) {
        const o = document.createElement('option');
        o.value = editing.vehicle.id; o.textContent = editing.vehicle.license_plate || 'Cybercab';
        sel.appendChild(o);
      }
      sel.value = editing.vehicle.id;
    } else sel.value = '';
    sel.disabled = !!editing;
    $('reviewFormTitle').textContent = editing ? 'EDIT YOUR REVIEW' : 'WRITE A REVIEW';
    $('reviewSubmit').textContent = editing ? 'Save changes' : 'Post review';
    setRating(editing ? editing.rating : 0);
    $('reviewBody').value = editing ? editing.body : '';
    $('reviewBodyCount').textContent = String($('reviewBody').value.length);
    added.forEach(p => URL.revokeObjectURL(p.url));
    keep = editing ? (editing.photos || []).slice() : [];
    added = [];
    renderPhotoList();
    formError('');
    $('reviewForm').classList.remove('hidden');
    $('reviewForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    (editing ? $('reviewBody') : sel).focus();
  }
  function closeForm() { $('reviewForm').classList.add('hidden'); editing = null; }
  $('reviewWriteBtn').addEventListener('click', () => openForm(null));
  $('reviewCancel').addEventListener('click', closeForm);

  $('reviewForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('reviewBody').value.trim();
    if (!editing && !$('reviewVehicle').value) return formError(errorText('unknown_vehicle'));
    if (!rating) return formError(errorText('invalid_rating'));
    if (!body) return formError(errorText('missing_text'));
    const fd = new FormData();
    if (!editing) fd.append('vehicle_id', $('reviewVehicle').value);
    fd.append('rating', String(rating));
    fd.append('body', body);
    keep.forEach(p => fd.append('keep_photos', p.id));
    added.forEach(p => fd.append('photos', p.file));
    $('reviewSubmit').disabled = true;
    let resp = null, data = null;
    try {
      resp = await api(editing ? `/api/reviews/${encodeURIComponent(editing.id)}` : '/api/reviews', { method: editing ? 'PATCH' : 'POST', body: fd });
      data = await json(resp);
    } catch (err) { resp = null; }
    $('reviewSubmit').disabled = false;
    if (!resp || !resp.ok) {
      if (resp && resp.status === 401) { location.href = 'signin.html?returnTo=%2Fcommunity'; return; }
      return formError(errorText(data && data.error));
    }
    toast(editing ? 'Review updated.' : 'Review posted.', 'success');
    closeForm();
    load(true);
  });

  // ---------- Card actions ----------
  function failToast(data) {
    if (data && data.authenticated === false) { location.href = 'signin.html?returnTo=%2Fcommunity'; return; }
    toast(errorText(data && data.error), 'error');
  }
  function card(el) { const a = el.closest('[data-review]'); return a ? { el: a, review: byId.get(a.dataset.review) } : null; }

  function commentHtml(c) {
    return `
      <li class="flex items-start gap-2.5" data-comment="${esc(c.id)}">
        ${avatarHtml(c.author, 'w-7 h-7')}
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2 flex-wrap">${nameHtml(c.author)}<span class="text-[11px] text-slate-500">${esc(relative(c.created_at))}</span>
            ${c.can_delete ? '<button type="button" data-delete-comment class="ml-auto text-[11px] text-slate-500 hover:text-white">Delete</button>' : ''}</div>
          <p class="text-sm text-slate-300 whitespace-pre-line break-words" data-comment-body></p>
        </div>
      </li>`;
  }
  async function loadThread(c) {
    const list = c.el.querySelector('[data-comment-list]');
    list.innerHTML = '<li class="text-xs text-slate-500">Loading comments…</li>';
    const data = await json(await api(`/api/reviews/${encodeURIComponent(c.review.id)}/comments`)).catch(() => null);
    if (!data || !Array.isArray(data.comments)) { list.innerHTML = '<li class="text-xs text-slate-500">Comments could not be loaded.</li>'; return; }
    list.innerHTML = data.comments.length ? '' : '<li class="text-xs text-slate-500" data-no-comments>No comments yet.</li>';
    for (const cm of data.comments) {
      list.insertAdjacentHTML('beforeend', commentHtml(cm));
      list.lastElementChild.querySelector('[data-comment-body]').textContent = cm.body;
    }
    paintAvatars(list);
    setCommentCount(c, data.comment_count);
  }
  function setCommentCount(c, n) { c.review.comment_count = n; c.el.querySelector('[data-comment-count]').textContent = String(n); }

  $('reviewList').addEventListener('click', async e => {
    const c = card(e.target);
    if (!c || !c.review) return;
    const photo = e.target.closest('[data-photo]');
    if (photo) return openViewer(photo.dataset.photo);
    if (e.target.closest('[data-like]')) {
      if (!viewer.signed_in) { location.href = 'signin.html?returnTo=%2Fcommunity'; return; }
      const btn = c.el.querySelector('[data-like]');
      const want = btn.getAttribute('aria-pressed') !== 'true';
      const resp = await api(`/api/reviews/${encodeURIComponent(c.review.id)}/like`, { method: want ? 'PUT' : 'DELETE' }).catch(() => null);
      const data = resp ? await json(resp) : null;
      if (!resp || !resp.ok || !data) return failToast(data);
      c.review.liked = data.liked; c.review.like_count = data.like_count;
      btn.setAttribute('aria-pressed', String(data.liked));
      btn.querySelector('[data-like-count]').textContent = String(data.like_count);
      return;
    }
    if (e.target.closest('[data-comments]')) {
      const btn = c.el.querySelector('[data-comments]');
      const thread = c.el.querySelector('[data-thread]');
      const open = thread.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', String(open));
      if (open) loadThread(c);
      return;
    }
    if (e.target.closest('[data-edit]')) return openForm(c.review);
    if (e.target.closest('[data-delete]')) {
      if (!window.confirm('Delete this review? This cannot be undone.')) return;
      const resp = await api(`/api/reviews/${encodeURIComponent(c.review.id)}`, { method: 'DELETE' }).catch(() => null);
      if (!resp || !resp.ok) return failToast(resp ? await json(resp) : null);
      toast('Review deleted.', 'success');
      load(true);
      return;
    }
    const delComment = e.target.closest('[data-delete-comment]');
    if (delComment) {
      const li = delComment.closest('[data-comment]');
      const resp = await api(`/api/review-comments/${encodeURIComponent(li.dataset.comment)}`, { method: 'DELETE' }).catch(() => null);
      const data = resp ? await json(resp) : null;
      if (!resp || !resp.ok || !data) return failToast(data);
      li.remove();
      setCommentCount(c, data.comment_count);
    }
  });

  $('reviewList').addEventListener('submit', async e => {
    const form = e.target.closest('[data-comment-form]');
    if (!form) return;
    e.preventDefault();
    const c = card(form);
    const input = form.querySelector('input');
    const err = c.el.querySelector('[data-comment-error]');
    const body = input.value.trim();
    if (!body) return;
    const resp = await api(`/api/reviews/${encodeURIComponent(c.review.id)}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).catch(() => null);
    const data = resp ? await json(resp) : null;
    if (!resp || !resp.ok || !data) { err.textContent = errorText(data && data.error); err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    input.value = '';
    const list = c.el.querySelector('[data-comment-list]');
    const empty = list.querySelector('[data-no-comments]');
    if (empty) empty.remove();
    list.insertAdjacentHTML('beforeend', commentHtml(data.comment));
    list.lastElementChild.querySelector('[data-comment-body]').textContent = data.comment.body;
    paintAvatars(list);
    setCommentCount(c, data.comment_count);
  });

  // ---------- Photo viewer (the page's #sightingViewer dialog) ----------
  let returnFocus = null;
  function openViewer(url) {
    const v = $('sightingViewer');
    if (!v) return;
    returnFocus = document.activeElement;
    $('sightingViewerImg').src = url;
    $('sightingViewerCaption').textContent = '';
    v.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('sightingViewerClose').focus();
  }
  function closeViewer() {
    const v = $('sightingViewer');
    if (!v || v.classList.contains('hidden')) return;
    v.classList.add('hidden');
    document.body.style.overflow = '';
    $('sightingViewerImg').removeAttribute('src');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  if ($('sightingViewer')) {
    $('sightingViewerClose').addEventListener('click', closeViewer);
    $('sightingViewer').addEventListener('click', e => { if (e.target === $('sightingViewer')) closeViewer(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });
  }

  setSort('recent');
  load(true);
})();
