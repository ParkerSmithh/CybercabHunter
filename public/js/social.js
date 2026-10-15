/* Community Social (worker/social.js): the feed, the composer, likes,
   comments with one level of replies, reports, and a post's own page
   (/community?post=<id>). Anyone can read; signed-in riders post, like,
   comment and report — the server checks every write against the session,
   so the buttons here are only conveniences. Authors with a private account
   arrive as "Anonymous" with no name, handle, photo or rank. Every value from
   the API goes in escaped or through textContent; links in a post are built
   as DOM nodes, never as HTML. Nothing here is placeholder content: an empty
   feed says so. No XP is given for anything on this page. Same origin. */
(function () {
  const $ = id => document.getElementById(id);
  if (!$('communityPanelSocial')) return;
  const SESSION_KEY = 'teslaSessionId';
  const MAX_CHARS = 2000;
  const MAX_COMMENT = 1000;
  const MAX_PHOTOS = 4;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const PHOTO_EDGE = 2048;            // longest side after compression
  const PAGE = 10;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = (paths, cls = 'w-[18px] h-[18px]') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const PERSON = ICON('<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>', 'w-5 h-5');
  const BUBBLE = ICON('<path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12"/>');
  const SHARE = ICON('<path d="M9 15l6 -6"/><path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464"/><path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"/>');
  const DOTS = ICON('<path d="M5 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M17 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>');
  const CAR = ICON('<path d="M5 17h-2v-6l2 -5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6 -6h15m-6 0v-5"/><path d="M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/>', 'w-4 h-4');
  const BOOKMARK = ICON('<path d="M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"/>');
  const PIN = ICON('<path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4"/><path d="M9 15l-4.5 4.5"/><path d="M14.5 4l5.5 5.5"/>', 'w-3.5 h-3.5');
  const CHECK = ICON('<path d="M5 12l5 5l10 -10"/>', 'w-3.5 h-3.5');
  const HEART = '<span class="pulse-heart__heart" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g data-glyph><path vector-effect="non-scaling-stroke" d="M19.4626 3.99415C16.7809 2.34923 14.4404 3.01211 13.0344 4.06801C12.4578 4.50096 12.1696 4.71743 12 4.71743C11.8304 4.71743 11.5422 4.50096 10.9656 4.06801C9.55962 3.01211 7.21909 2.34923 4.53744 3.99415C1.01807 6.15294 0.221721 13.2749 8.33953 19.2834C9.88572 20.4278 10.6588 21 12 21C13.3412 21 14.1143 20.4278 15.6605 19.2834C23.7783 13.2749 22.9819 6.15294 19.4626 3.99415Z"/></g></svg></span>';
  const CATEGORY = { general: 'General', sighting: 'Sighting', question: 'Question', news: 'News', review: 'Review' };
  const REVIEW_VEHICLE = { cybercab: 'Cybercab', model_y: 'Model Y' };
  const ERRORS = {
    empty_post: 'Write something or add a photo.',
    duplicate_post: "You've already posted that.",
    text_too_long: 'That is too long.',
    missing_text: 'Write something first.',
    invalid_link: 'That link doesn\'t look right. Use a full https:// address.',
    invalid_category: 'Choose a post type.',
    unknown_vehicle: 'Choose a Cybercab from the registry list.',
    invalid_rating: 'Choose a rating from 1 to 5 stars.',
    invalid_vehicle_type: 'Choose Cybercab or Model Y.',
    invalid_fare: 'Fare must be between $1 and $250.',
    invalid_wait: 'Pickup wait must be 0 to 120 minutes.',
    invalid_ride_date: 'Choose a ride date that isn\'t in the future.',
    too_many_photos: 'Up to 4 photos per post.',
    unsupported_file_type: 'Photos must be JPEG, PNG or WebP.',
    file_too_large: 'Each photo must be 5 MB or smaller.',
    rate_limited: "You're going a bit fast. Try again in a few minutes.",
    already_reported: "You've already reported this. Moderators will take a look.",
    cannot_report_own: "You can't report your own post.",
    forbidden: "You can't change that.",
    not_found: 'That is no longer available.',
    post_unavailable: 'That post is no longer available.'
  };
  const errorText = code => ERRORS[code] || 'Something went wrong. Please try again.';

  function session() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }
  function api(path, opts = {}) {
    const s = session();
    const headers = Object.assign({}, opts.headers || {}, s ? { Authorization: 'Bearer ' + s } : {});
    return fetch(path, Object.assign({}, opts, { headers }));
  }
  const sendJson = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  async function json(resp) { try { return await resp.json(); } catch (e) { return null; } }
  const ccc = () => (typeof CCC !== 'undefined' ? CCC : null);
  const toast = (msg, type) => { const c = ccc(); if (c && c.toast) c.toast(msg, type); };
  const signIn = () => { location.href = 'signin.html?returnTo=' + encodeURIComponent(location.pathname + location.search); };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // "just now", "5m", "3h", "2d", then "Sep 30" / "Sep 30, 2025".
  function relative(sqlTime, now = Date.now()) {
    const ms = Date.parse(String(sqlTime || '').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    const d = new Date(ms);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
  }
  const fullTime = sqlTime => { const ms = Date.parse(String(sqlTime || '').replace(' ', 'T') + 'Z'); return Number.isFinite(ms) ? new Date(ms).toLocaleString('en-US') : ''; };
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);

  // Text with its web addresses as links (DOM nodes; nothing parsed as HTML).
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
  function setLinkedText(el, text) {
    el.textContent = '';
    let last = 0;
    String(text || '').replace(URL_RE, (m, at) => {
      const href = m.replace(/[.,;:!?)\]]+$/, '');
      if (at > last) el.appendChild(document.createTextNode(text.slice(last, at)));
      const a = document.createElement('a');
      a.href = href; a.textContent = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow ugc';
      el.appendChild(a);
      last = at + href.length;
      return m;
    });
    if (last < String(text || '').length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

  function avatarHtml(person, cls = 'social-avatar') {
    if (!person || person.anonymous) return `<span class="${cls} social-avatar-anon">${PERSON}</span>`;
    return `<span class="${cls}"><span class="block w-full h-full" data-avatar-url="${esc(person.avatar_url || '')}" data-avatar-name="${esc(person.name)}"></span></span>`;
  }
  function nameHtml(person) {
    const name = `<span class="social-name">${esc(person.name)}</span>`;
    return !person.anonymous && person.handle ? `<a href="/rider/${encodeURIComponent(person.handle)}" class="hover:underline">${name}</a>` : name;
  }
  function rankHtml(person) {
    if (!person || person.anonymous || !person.rank) return '';
    const key = String(person.rank.key || '').replace(/[^a-z]/g, '');
    return `<span class="social-rank spotter-rank rank-${key}">${esc(person.rank.name)}</span>${Number.isInteger(person.level) ? `<span class="social-level">Lv ${person.level}</span>` : ''}`;
  }
  function paintAvatars(root) {
    const c = ccc();
    if (!c || !c.renderAvatar) return;
    root.querySelectorAll('[data-avatar-name]').forEach(el => { if (!el.dataset.painted) { el.dataset.painted = '1'; c.renderAvatar(el, { url: el.dataset.avatarUrl || null, name: el.dataset.avatarName, size: 128 }); } });
  }

  // ---------- PulseHeart likes (css/style.css .pulse-heart) ----------
  const PH = { duration: 560, dotSize: 0.3, overshoot: 1.7, beat: 3, roll: 350, out: 0.4 };
  const phBack = (k, c) => { const u = k - 1; return 1 + (c + 1) * u ** 3 + c * u ** 2; };
  const phSwell = t => (t <= 0 ? 0 : t < PH.out ? 1 - (1 - t / PH.out) ** 3 : 1 - phBack((t - PH.out) / (1 - PH.out), PH.overshoot));
  function phCount(btn, from, to, roll) {
    const el = btn.querySelector('[data-like-count]');
    const a = String(from), b = String(to);
    clearTimeout(btn._phRoll);
    if (!roll || a === b) { el.textContent = b; return; }
    const up = to > from;
    el.innerHTML = `<span class="pulse-heart__slot"><span class="pulse-heart__roll"><span>${esc(up ? a : b)}</span><span>${esc(up ? b : a)}</span></span></span>`;
    const r = el.querySelector('.pulse-heart__roll');
    r.style.transition = 'none';
    r.style.transform = `translateY(${up ? '0' : '-1em'})`;
    r.getBoundingClientRect();
    r.style.transition = '';
    r.style.transform = `translateY(${up ? '-1em' : '0'})`;
    btn._phRoll = setTimeout(() => { el.textContent = b; }, PH.roll);
  }
  function phSet(btn, liked, count) {
    btn.dataset.instant = '';
    btn.dataset.liked = String(liked);
    btn.setAttribute('aria-pressed', String(liked));
    phCount(btn, count, count, false);
    btn.getBoundingClientRect();
    delete btn.dataset.instant;
  }
  function phRun(btn, liked, from, to) {
    const glyph = btn.querySelector('[data-glyph]');
    btn.dataset.running = '';
    let swapped = false;
    const t0 = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - t0) / PH.duration);
      const sw = phSwell(t);
      if (glyph) glyph.setAttribute('transform', `translate(12 12) scale(${1 - (1 - PH.dotSize) * sw}) translate(-12 -12)`);
      btn.style.transform = `scale(${1 - (PH.beat / 100) * sw})`;
      if (!swapped && t >= PH.out) { swapped = true; btn.dataset.liked = String(liked); phCount(btn, from, to, true); }
      if (t < 1) { requestAnimationFrame(tick); return; }
      if (glyph) glyph.removeAttribute('transform');
      btn.style.transform = '';
      delete btn.dataset.running;
      if (btn._phSettle) { const f = btn._phSettle; btn._phSettle = null; f(); }
    };
    requestAnimationFrame(tick);
  }

  // ---------- State ----------
  let viewer = { signed_in: !!session(), moderator: false };
  let me = null;                 // { name, avatar_url } for the composer
  let filter = 'foryou';
  // The chosen sort for Photos / Reviews / Saved, kept across those filters
  // and remembered in this browser (a convenience only).
  const SORT_KEY = 'cchSocialSort';
  let sort = (() => { try { return localStorage.getItem(SORT_KEY) === 'popular' ? 'popular' : 'new'; } catch (e) { return 'new'; } })();
  const SORTABLE = ['photos', 'reviews', 'saved'];
  const SORT_NOTE = { foryou: 'Ranked by recent likes and comments', latest: 'Newest posts first' };
  let cursor = null;
  let loading = false;
  let feedToken = 0;
  const posts = new Map();       // id -> post (feed and single view)

  // ---------- Post cards ----------
  function menuHtml(p) {
    const items = [];
    if (p.can_edit) items.push('<button type="button" role="menuitem" data-act="edit">Edit post</button>');
    if (p.mine) items.push('<button type="button" role="menuitem" data-act="delete" class="is-danger">Delete post</button>');
    items.push('<button type="button" role="menuitem" data-act="copy">Copy link</button>');
    if (!p.mine && !p.removed) items.push('<button type="button" role="menuitem" data-act="report">Report post</button>');
    if (p.can_pin) items.push(`<button type="button" role="menuitem" data-act="${p.pinned ? 'unpin' : 'pin'}">${p.pinned ? 'Unpin from top' : 'Pin to top of Social'}</button>`);
    if (viewer.moderator && !p.mine && !p.removed) items.push('<button type="button" role="menuitem" data-act="remove" class="is-danger">Remove (moderator)</button>');
    if (viewer.moderator) items.push('<a role="menuitem" href="moderation.html#social-reports">Review reports</a>');
    return `<div class="social-menu-wrap"><button type="button" class="social-icon-btn" data-menu aria-haspopup="menu" aria-expanded="false" aria-label="Post options">${DOTS}</button><div class="social-menu hidden" role="menu">${items.join('')}</div></div>`;
  }
  function reviewHtml(r) {
    if (!r) return '';
    const bits = [];
    if (r.vehicle_type) bits.push(`<span>${esc(REVIEW_VEHICLE[r.vehicle_type] || r.vehicle_type)}</span>`);
    if (r.quoted_fare != null) bits.push(`<span>$${esc(Number(r.quoted_fare).toFixed(2))} fare</span>`);
    if (r.pickup_wait_minutes != null) bits.push(`<span>${esc(r.pickup_wait_minutes)} min pickup wait</span>`);
    if (r.ride_date) bits.push(`<span>Rode ${esc(new Date(r.ride_date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))}</span>`);
    return `<div class="social-review"><div class="social-review-head"><span class="social-review-label">Ride review</span><span class="social-review-stars" role="img" aria-label="${r.rating} out of 5 stars">${stars(r.rating)}</span></div>${bits.length ? `<div class="social-review-facts">${bits.join('')}</div>` : ''}</div>`;
  }
  function photosHtml(p) {
    const ph = p.photos || [];
    if (!ph.length) return '';
    return `<div class="social-photos n-${ph.length}">${ph.map((x, i) => `<button type="button" data-photo="${i}" aria-label="Open photo ${i + 1} of ${ph.length}"><img src="${esc(x.url)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>`;
  }
  // An attached registry vehicle: only the fields on record. The image is the
  // site's generic Cybercab picture (approved Cybercabs only), not this car.
  function vehicleFacts(v) {
    const facts = [];
    if (v.vin) facts.push(`<span><span class="social-vfact-k">VIN</span> ${esc(v.vin)}</span>`);
    if (v.service_area) facts.push(`<span>${esc(v.service_area)}</span>`);
    facts.push(`<span><span class="social-vfact-k">ID</span> ${esc(v.short_id || String(v.id).slice(0, 8))}</span>`);
    return facts.join('');
  }
  function vehicleCardHtml(v, { tag = 'a' } = {}) {
    const inner = `${v.image ? `<img src="${esc(v.image)}" alt="" class="social-vcard-img" loading="lazy">` : `<span class="social-vcard-icon">${CAR}</span>`}
      <span class="min-w-0 flex-1"><span class="social-vcard-top"><span class="social-vcard-plate">${esc(v.license_plate || 'Plate unknown')}</span>${v.cybercab ? '<span class="social-vcard-kind">Cybercab</span>' : ''}<span class="social-verified">${CHECK}In the registry</span></span>
      <span class="social-vcard-facts">${vehicleFacts(v)}</span></span>`;
    return tag === 'a'
      ? `<a class="social-vcard" href="${esc(v.url || '/vehicle/' + encodeURIComponent(v.id))}" aria-label="Open Cybercab ${esc(v.license_plate || v.short_id || '')} in the registry">${inner}<span class="social-vcard-go" aria-hidden="true">&#8250;</span></a>`
      : `<div class="social-vcard is-static">${inner}</div>`;
  }
  function postHtml(p, { single = false } = {}) {
    const a = p.author || { anonymous: true, name: 'Anonymous' };
    const vehicle = p.vehicle ? vehicleCardHtml(p.vehicle) : '';
    const link = p.link_url ? `<a class="social-linkcard" href="${esc(p.link_url)}" target="_blank" rel="noopener noreferrer nofollow ugc">${SHARE}<span class="min-w-0"><span class="social-linkcard-host">${esc(hostOf(p.link_url))}</span><span class="social-linkcard-url">${esc(p.link_url)}</span></span></a>` : '';
    return `
      <article class="social-post${single ? ' is-single' : ''}${p.pinned ? ' is-pinned' : ''}" data-post="${esc(p.id)}">
        ${p.removed ? '<div class="social-removed-note">Removed by moderators. Only moderators can see this.</div>' : ''}
        ${p.pinned ? `<div class="social-pinned">${PIN}Pinned</div>` : ''}
        <div class="social-post-row">
          ${avatarHtml(a)}
          <div class="min-w-0 flex-1">
            <header class="social-post-head">
              <div class="social-post-who">${nameHtml(a)}${rankHtml(a)}<span class="social-dot" aria-hidden="true">·</span><a href="${esc(p.url)}" data-open-post class="social-time" title="${esc(fullTime(p.created_at))}"><time datetime="${esc(String(p.created_at).replace(' ', 'T') + 'Z')}">${esc(relative(p.created_at))}</time></a>${p.edited_at ? '<span class="social-time">· edited</span>' : ''}</div>
              <span class="social-cat cat-${esc(p.category)}">${esc(CATEGORY[p.category] || 'General')}</span>
              ${menuHtml(p)}
            </header>
            ${p.body ? '<p class="social-body" data-body></p>' : ''}
            ${reviewHtml(p.review)}
            ${photosHtml(p)}
            ${vehicle}${link}
            <footer class="social-actions">
              <button type="button" data-like aria-pressed="${p.liked}" data-liked="${p.liked}" class="social-action pulse-heart" aria-label="Like">${HEART}<span class="pulse-heart__count" data-like-count>${p.like_count}</span></button>
              <button type="button" data-comments aria-expanded="false" class="social-action" aria-label="Comments">${BUBBLE}<span data-comment-count>${p.comment_count}</span></button>
              <button type="button" data-act="share" class="social-action" aria-label="Share post">${SHARE}<span class="max-sm:sr-only">Share</span></button>
              <button type="button" data-save aria-pressed="${!!p.saved}" class="social-action social-save" aria-label="${p.saved ? 'Remove from saved' : 'Save post'}" title="${p.saved ? 'Saved' : 'Save'}">${BOOKMARK}</button>
            </footer>
            <div data-thread class="social-thread hidden"></div>
          </div>
        </div>
      </article>`;
  }
  function fillPost(el, p) {
    const b = el.querySelector('[data-body]');
    if (b) setLinkedText(b, p.body);
    paintAvatars(el);
  }
  function renderPostInto(container, p, where = 'beforeend', opts) {
    posts.set(p.id, p);
    container.insertAdjacentHTML(where, postHtml(p, opts));
    const el = where === 'afterbegin' ? container.firstElementChild : container.lastElementChild;
    fillPost(el, p);
    return el;
  }
  function replacePost(p) {
    posts.set(p.id, p);
    document.querySelectorAll(`[data-post="${CSS.escape(p.id)}"]`).forEach(old => {
      const wasOpen = !old.querySelector('[data-thread]').classList.contains('hidden');
      old.insertAdjacentHTML('afterend', postHtml(p, { single: old.classList.contains('is-single') }));
      const el = old.nextElementSibling;
      old.remove();
      fillPost(el, p);
      if (wasOpen) toggleThread(el, true);
    });
  }
  function removePostEls(id) {
    posts.delete(id);
    document.querySelectorAll(`[data-post="${CSS.escape(id)}"]`).forEach(el => el.remove());
    if (!$('socialFeed').children.length && !cursor) showFeedState('empty');
  }

  // ---------- Feed ----------
  const EMPTY = {
    foryou: 'Be the first to post about the Cybercab.',
    latest: 'Be the first to post about the Cybercab.',
    photos: 'No photo posts yet. Share a Cybercab photo.',
    reviews: 'No ride reviews yet. Rode in one? Add a ride review to a post.',
    saved: "You haven't saved any posts yet."
  };
  function showFeedState(state) {
    $('socialEmpty').classList.toggle('hidden', state !== 'empty' && state !== 'signin');
    $('socialError').classList.toggle('hidden', state !== 'error');
    $('socialEmptySignIn').classList.toggle('hidden', state !== 'signin');
    if (state === 'empty') $('socialEmptyText').textContent = EMPTY[filter];
    if (state === 'signin') { $('socialEmptyText').textContent = 'Sign in to save posts and see them here.'; $('socialEmptySignIn').href = 'signin.html?returnTo=' + encodeURIComponent('/community'); }
    document.querySelector('#socialEmpty .social-empty-title').textContent = filter === 'saved' ? 'Saved posts' : 'Nothing here yet';
  }
  async function loadFeed(reset) {
    if (loading && !reset) return;
    const token = ++feedToken;
    loading = true;
    const feed = $('socialFeed');
    if (reset) {
      cursor = null;
      feed.innerHTML = '<div class="social-skeleton"></div><div class="social-skeleton"></div>';
      feed.setAttribute('aria-busy', 'true');
      showFeedState(null);
      $('socialMore').classList.add('hidden');
    }
    if (filter === 'saved' && !session()) {
      loading = false; feed.innerHTML = ''; feed.setAttribute('aria-busy', 'false'); showFeedState('signin'); return;
    }
    $('socialMore').disabled = true;
    const q = new URLSearchParams({ filter, limit: String(PAGE) });
    if (SORTABLE.includes(filter)) q.set('sort', sort);
    if (!reset && cursor) q.set('cursor', cursor);
    let data = null;
    let status = 0;
    try { const r = await api('/api/social/feed?' + q); status = r.status; data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    if (token !== feedToken) return;
    if (status === 401 && filter === 'saved') { loading = false; feed.innerHTML = ''; feed.setAttribute('aria-busy', 'false'); showFeedState('signin'); return; }
    loading = false;
    $('socialMore').disabled = false;
    feed.setAttribute('aria-busy', 'false');
    if (reset) feed.innerHTML = '';
    if (!data || !Array.isArray(data.posts)) {
      if (reset) showFeedState('error'); else toast('More posts could not be loaded.', 'error');
      return;
    }
    setViewer(data.viewer);
    for (const p of data.posts) { if (!feed.querySelector(`[data-post="${CSS.escape(p.id)}"]`)) renderPostInto(feed, p); }
    cursor = data.next_cursor || null;
    $('socialMore').classList.toggle('hidden', !cursor);
    if (reset) showFeedState(feed.children.length ? null : 'empty');
  }
  function setViewer(v) {
    if (!v) return;
    const changed = v.signed_in !== viewer.signed_in || v.moderator !== viewer.moderator;
    viewer = { signed_in: !!v.signed_in, moderator: !!v.moderator };
    if (changed) { renderComposerAccess(); renderSortBar(); }
  }

  function setFilter(next) {
    filter = next;
    document.querySelectorAll('.social-filter[data-filter]').forEach(b => {
      const on = b.dataset.filter === filter;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    renderSortBar();
    loadFeed(true);
  }
  const filterBtns = () => [...document.querySelectorAll('.social-filter[data-filter]')];
  filterBtns().forEach(b => b.addEventListener('click', () => { if (b.dataset.filter !== filter) setFilter(b.dataset.filter); }));
  document.querySelector('.social-filter-tabs').addEventListener('keydown', e => {
    const list = filterBtns(); const i = list.findIndex(b => b.dataset.filter === filter);
    const n = list.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : -1;
    if (j < 0) return;
    e.preventDefault(); list[j].focus(); setFilter(list[j].dataset.filter);
  });
  // The sort row: a Newest / Most popular choice where the filter supports it,
  // otherwise one line saying how that feed is ordered. Never hidden as a whole.
  function renderSortBar() {
    const sortable = SORTABLE.includes(filter) && !(filter === 'saved' && !viewer.signed_in && !session());
    $('socialSortWrap').classList.toggle('hidden', !sortable);
    $('socialSort').value = sort;
    $('socialSortNote').textContent = sortable ? '' : (SORT_NOTE[filter] || '');
    $('socialSortNote').classList.toggle('hidden', sortable);
  }
  $('socialSort').addEventListener('change', () => {
    sort = $('socialSort').value === 'popular' ? 'popular' : 'new';
    try { localStorage.setItem(SORT_KEY, sort); } catch (e) { /* not essential */ }
    loadFeed(true);
  });
  $('socialMore').addEventListener('click', () => loadFeed(false));

  // ---------- Comments ----------
  function commentHtml(c, isReply) {
    if (c.removed) {
      return `<li class="social-comment is-removed" data-comment="${esc(c.id)}"><p class="social-muted">Comment removed by moderators.</p>${isReply ? '' : `<ul class="social-replies" data-replies>${(c.replies || []).map(r => commentHtml(r, true)).join('')}</ul>`}</li>`;
    }
    const a = c.author;
    const acts = [];
    if (!isReply && viewer.signed_in) acts.push('<button type="button" data-c-act="reply">Reply</button>');
    if (c.can_edit) acts.push('<button type="button" data-c-act="edit">Edit</button>');
    if (c.can_delete) acts.push(`<button type="button" data-c-act="delete">${c.mine ? 'Delete' : 'Remove'}</button>`);
    if (viewer.signed_in && !c.mine) acts.push('<button type="button" data-c-act="report">Report</button>');
    return `
      <li class="social-comment" data-comment="${esc(c.id)}" data-parent="${esc(c.parent_id || '')}">
        <div class="social-comment-row">
          ${avatarHtml(a, 'social-avatar is-small')}
          <div class="min-w-0 flex-1">
            <div class="social-comment-bubble">
              <div class="social-post-who">${nameHtml(a)}${rankHtml(a)}<span class="social-dot" aria-hidden="true">·</span><span class="social-time" title="${esc(fullTime(c.created_at))}">${esc(relative(c.created_at))}</span>${c.edited_at ? '<span class="social-time">· edited</span>' : ''}</div>
              <p class="social-comment-body" data-c-body></p>
            </div>
            ${acts.length ? `<div class="social-comment-actions">${acts.join('')}</div>` : ''}
            <div data-c-slot></div>
          </div>
        </div>
        ${isReply ? '' : `<ul class="social-replies" data-replies>${(c.replies || []).map(r => commentHtml(r, true)).join('')}</ul>`}
      </li>`;
  }
  // Bodies go in as text after the HTML lands (replies included).
  function fillComments(root, list) {
    for (const c of list) {
      const li = root.querySelector(`[data-comment="${CSS.escape(c.id)}"]`);
      if (li) { li._comment = c; const b = li.querySelector(':scope > .social-comment-row [data-c-body]'); if (b && !c.removed) setLinkedText(b, c.body); }
      if (c.replies) fillComments(root, c.replies);
    }
    paintAvatars(root);
  }
  function commentFormHtml(placeholder, value = '', submitLabel = 'Reply') {
    return `<form class="social-comment-form" data-c-form><label class="sr-only">${esc(placeholder)}</label><textarea rows="1" maxlength="${MAX_COMMENT}" placeholder="${esc(placeholder)}" class="social-input">${esc(value)}</textarea><button type="submit" class="social-publish-btn is-small">${esc(submitLabel)}</button></form><p class="hidden social-error" data-c-error role="alert"></p>`;
  }
  function threadSkeleton(postId) {
    return `<ul class="social-comments" data-comment-list><li class="social-muted">Loading comments…</li></ul>
      <button type="button" class="hidden social-linkbtn" data-c-more>Load more comments</button>
      ${viewer.signed_in ? `<div data-c-new>${commentFormHtml('Add a comment', '', 'Comment')}</div>` : `<p class="social-hint"><a href="signin.html?returnTo=${encodeURIComponent('/community?post=' + postId)}" class="text-gold hover:underline">Sign in</a> to comment.</p>`}`;
  }
  async function loadComments(postEl, more) {
    const p = posts.get(postEl.dataset.post);
    const list = postEl.querySelector('[data-comment-list]');
    const moreBtn = postEl.querySelector('[data-c-more]');
    const q = more && postEl._cCursor ? '?cursor=' + encodeURIComponent(postEl._cCursor) : '';
    moreBtn.disabled = true;
    let data = null;
    try { const r = await api(`/api/social/posts/${encodeURIComponent(p.id)}/comments${q}`); data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    moreBtn.disabled = false;
    if (!more) list.innerHTML = '';
    if (!data || !Array.isArray(data.comments)) { list.innerHTML = '<li class="social-muted">Comments could not be loaded.</li>'; return; }
    list.querySelector('[data-no-comments]')?.remove();
    list.insertAdjacentHTML('beforeend', data.comments.map(c => commentHtml(c, false)).join(''));
    fillComments(list, data.comments);
    if (!list.children.length) list.innerHTML = '<li class="social-muted" data-no-comments>No comments yet. Start the conversation.</li>';
    postEl._cCursor = data.next_cursor || null;
    moreBtn.classList.toggle('hidden', !postEl._cCursor);
  }
  function toggleThread(postEl, open) {
    const thread = postEl.querySelector('[data-thread]');
    const btn = postEl.querySelector('[data-comments]');
    const next = open == null ? thread.classList.contains('hidden') : open;
    thread.classList.toggle('hidden', !next);
    btn.setAttribute('aria-expanded', String(next));
    if (next) { thread.innerHTML = threadSkeleton(postEl.dataset.post); return loadComments(postEl, false); }
    return Promise.resolve();
  }
  function setCommentCount(postEl, n) {
    const p = posts.get(postEl.dataset.post);
    if (p && Number.isInteger(n)) p.comment_count = n;
    document.querySelectorAll(`[data-post="${CSS.escape(postEl.dataset.post)}"] [data-comment-count]`).forEach(el => { el.textContent = String(p ? p.comment_count : n); });
  }

  // ---------- Card actions ----------
  function closeMenus(except) {
    document.querySelectorAll('.social-menu:not(.hidden)').forEach(m => {
      if (m === except) return;
      m.classList.add('hidden');
      m.previousElementSibling.setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', e => { if (!e.target.closest('.social-menu-wrap')) closeMenus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

  async function copyLink(p) {
    const url = location.origin + p.url;
    try { await navigator.clipboard.writeText(url); toast('Link copied.', 'success'); }
    catch (e) { window.prompt('Copy this link:', url); }
  }
  // Share: the phone's share sheet where there is one, otherwise copy the link.
  async function sharePost(p) {
    const url = location.origin + p.url;
    if (navigator.share) {
      try { await navigator.share({ title: 'Cybercab Hunter Community', text: (p.body || '').slice(0, 100), url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    copyLink(p);
  }
  async function savePost(postEl, p) {
    if (!viewer.signed_in) return signIn();
    const want = !p.saved;
    const paint = on => document.querySelectorAll(`[data-post="${CSS.escape(p.id)}"] [data-save]`).forEach(b => {
      b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Remove from saved' : 'Save post'); b.title = on ? 'Saved' : 'Save';
    });
    p.saved = want; paint(want);
    const resp = await api(`/api/social/posts/${encodeURIComponent(p.id)}/save`, { method: want ? 'PUT' : 'DELETE' }).catch(() => null);
    if (!resp || !resp.ok) {
      p.saved = !want; paint(!want);
      if (resp && resp.status === 401) return signIn();
      return toast(errorText(null), 'error');
    }
    toast(want ? 'Saved. Find it under Saved.' : 'Removed from saved.', 'success');
    if (!want && filter === 'saved' && postEl.closest('#socialFeed')) removePostEls(p.id);
  }
  async function pinPost(p, on) {
    const resp = await api(`/api/social/posts/${encodeURIComponent(p.id)}/pin`, { method: on ? 'PUT' : 'DELETE' }).catch(() => null);
    const data = resp ? await json(resp) : null;
    if (!resp || !resp.ok) return toast(data && data.error === 'too_many_pins' ? `Up to ${data.max} pinned posts. Unpin one first.` : errorText(data && data.error), 'error');
    toast(on ? 'Pinned to the top of Social.' : 'Unpinned.', 'success');
    if (singleId) { p.pinned = on; replacePost(p); } else loadFeed(true);
  }
  async function likePost(postEl, p, evt) {
    if (!viewer.signed_in) return signIn();
    const btn = postEl.querySelector('[data-like]');
    if (btn.dataset.running !== undefined || btn.dataset.saving !== undefined) return;
    const was = { liked: !!p.liked, count: p.like_count };
    const want = !was.liked;
    const next = Math.max(0, was.count + (want ? 1 : -1));
    btn.setAttribute('aria-pressed', String(want));
    if (evt.detail !== 0 && !reduceMotion()) phRun(btn, want, was.count, next); else phSet(btn, want, next);
    p.liked = want; p.like_count = next;
    btn.dataset.saving = '';
    const resp = await api(`/api/social/posts/${encodeURIComponent(p.id)}/like`, { method: want ? 'PUT' : 'DELETE' }).catch(() => null);
    const data = resp ? await json(resp) : null;
    delete btn.dataset.saving;
    const settle = (liked, count) => {
      const f = () => { if (liked === want && count === next) btn.setAttribute('aria-pressed', String(liked)); else phSet(btn, liked, count); };
      if (btn.dataset.running !== undefined) btn._phSettle = f; else f();
    };
    if (!resp || !resp.ok || !data) {
      p.liked = was.liked; p.like_count = was.count;
      settle(was.liked, was.count);
      if (resp && resp.status === 401) return signIn();
      return toast(errorText(data && data.error), 'error');
    }
    p.liked = !!data.liked; p.like_count = Number(data.like_count) || 0;
    settle(p.liked, p.like_count);
  }
  async function deletePost(p, asModerator) {
    let reason = null;
    if (asModerator) {
      reason = window.prompt('Remove this post for everyone? Optional note for the moderation log:', '');
      if (reason === null) return;
    } else if (!window.confirm('Delete this post? Its photos, likes and comments go with it. This cannot be undone.')) return;
    const resp = await sendJson(`/api/social/posts/${encodeURIComponent(p.id)}`, 'DELETE', asModerator ? { reason } : {}).catch(() => null);
    const data = resp ? await json(resp) : null;
    if (!resp || !resp.ok) return toast(errorText(data && data.error), 'error');
    toast(asModerator ? 'Post removed.' : 'Post deleted.', 'success');
    if (editing && editing.id === p.id) resetComposer();
    if (singleId === p.id) showUnavailable(); else removePostEls(p.id);
    loadSidebar(true);
  }

  async function onPostClick(e) {
    const postEl = e.target.closest('[data-post]');
    if (!postEl) return;
    const p = posts.get(postEl.dataset.post);
    if (!p) return;
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) {
      const menu = menuBtn.nextElementSibling;
      const open = menu.classList.contains('hidden');
      closeMenus(menu);
      menu.classList.toggle('hidden', !open);
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('[role="menuitem"]')?.focus();
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      closeMenus();
      const a = act.dataset.act;
      if (a === 'copy') return copyLink(p);
      if (a === 'share') return sharePost(p);
      if (a === 'pin' || a === 'unpin') return pinPost(p, a === 'pin');
      if (a === 'edit') return startEdit(p);
      if (a === 'delete') return deletePost(p, false);
      if (a === 'remove') return deletePost(p, true);
      if (a === 'report') return openReport('post', p.id);
      return;
    }
    const open = e.target.closest('[data-open-post]');
    if (open && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); return openSingle(p.id, true); }
    const photo = e.target.closest('[data-photo]');
    if (photo) return openLightbox(p.photos || [], Number(photo.dataset.photo));
    if (e.target.closest('[data-like]')) return likePost(postEl, p, e);
    if (e.target.closest('[data-save]')) return savePost(postEl, p);
    if (e.target.closest('[data-comments]')) return toggleThread(postEl);
    if (e.target.closest('[data-c-more]')) return loadComments(postEl, true);
    const cAct = e.target.closest('[data-c-act]');
    if (cAct) return onCommentAction(postEl, cAct.closest('[data-comment]'), cAct.dataset.cAct);
  }
  async function onCommentAction(postEl, li, act) {
    const c = li._comment;
    if (!c) return;
    const slot = li.querySelector(':scope > .social-comment-row [data-c-slot]');
    if (act === 'reply') {
      if (slot.querySelector('[data-c-form]')) { slot.innerHTML = ''; return; }
      slot.innerHTML = commentFormHtml(`Reply to ${c.author.name}`);
      slot.querySelector('[data-c-form]').dataset.parent = c.id;
      slot.querySelector('textarea').focus();
      return;
    }
    if (act === 'edit') {
      if (slot.querySelector('[data-c-form]')) { slot.innerHTML = ''; return; }
      slot.innerHTML = commentFormHtml('Edit your comment', c.body, 'Save');
      slot.querySelector('[data-c-form]').dataset.edit = c.id;
      slot.querySelector('textarea').focus();
      return;
    }
    if (act === 'report') return openReport('comment', c.id);
    if (act === 'delete') {
      const mod = !c.mine;
      if (!window.confirm(mod ? 'Remove this comment for everyone?' : 'Delete your comment? Replies to it go too.')) return;
      const resp = await api(`/api/social/comments/${encodeURIComponent(c.id)}`, { method: 'DELETE' }).catch(() => null);
      const data = resp ? await json(resp) : null;
      if (!resp || !resp.ok || !data) return toast(errorText(data && data.error), 'error');
      if (mod) { li.querySelector(':scope > .social-comment-row').outerHTML = '<p class="social-muted">Comment removed by moderators.</p>'; li.classList.add('is-removed'); }
      else li.remove();
      setCommentCount(postEl, data.comment_count);
    }
  }
  async function onPostSubmit(e) {
    const form = e.target.closest('[data-c-form]');
    if (!form) return;
    e.preventDefault();
    const postEl = form.closest('[data-post]');
    const p = posts.get(postEl.dataset.post);
    const ta = form.querySelector('textarea');
    const err = form.nextElementSibling;
    const body = ta.value.trim();
    if (!body) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const editId = form.dataset.edit;
    const resp = await (editId
      ? sendJson(`/api/social/comments/${encodeURIComponent(editId)}`, 'PATCH', { body })
      : sendJson(`/api/social/posts/${encodeURIComponent(p.id)}/comments`, 'POST', { body, parent_id: form.dataset.parent || undefined })).catch(() => null);
    const data = resp ? await json(resp) : null;
    btn.disabled = false;
    if (!resp || !resp.ok || !data) {
      if (resp && resp.status === 401) return signIn();
      err.textContent = errorText(data && data.error); err.classList.remove('hidden'); return;
    }
    err.classList.add('hidden');
    if (editId) {
      const li = form.closest('[data-comment]');
      li._comment = Object.assign(li._comment, data.comment);
      setLinkedText(li.querySelector(':scope > .social-comment-row [data-c-body]'), data.comment.body);
      const who = li.querySelector(':scope > .social-comment-row .social-post-who');
      if (!who.textContent.includes('edited')) who.insertAdjacentHTML('beforeend', '<span class="social-time">· edited</span>');
      form.parentElement.innerHTML = '';
      return;
    }
    const c = data.comment;
    const list = postEl.querySelector('[data-comment-list]');
    list.querySelector('[data-no-comments]')?.remove();
    let target = list;
    if (c.parent_id) target = list.querySelector(`[data-comment="${CSS.escape(c.parent_id)}"] > [data-replies]`) || list;
    target.insertAdjacentHTML('beforeend', commentHtml(c, !!c.parent_id));
    fillComments(target, [c]);
    if (form.dataset.parent) form.parentElement.innerHTML = ''; else ta.value = '';
    setCommentCount(postEl, data.comment_count);
  }
  for (const root of [$('socialFeed'), $('socialSinglePost')]) {
    root.addEventListener('click', onPostClick);
    root.addEventListener('submit', onPostSubmit);
    root.addEventListener('keydown', e => {
      // Enter sends a comment; Shift+Enter is a new line.
      if (e.key === 'Enter' && !e.shiftKey && e.target.matches('[data-c-form] textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
    });
  }

  // ---------- Lightbox ----------
  let lbPhotos = [], lbIndex = 0;
  function showLightbox() {
    const img = $('socialLightboxImg');
    img.src = lbPhotos[lbIndex].url;
    img.alt = `Photo ${lbIndex + 1} of ${lbPhotos.length}`;
    $('socialLightbox').querySelectorAll('[data-step]').forEach(b => b.classList.toggle('hidden', lbPhotos.length < 2));
  }
  function openLightbox(photos, i) {
    if (!photos.length) return;
    lbPhotos = photos; lbIndex = Math.max(0, Math.min(i, photos.length - 1));
    showLightbox();
    const d = $('socialLightbox');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  $('socialLightbox').addEventListener('click', e => {
    const step = e.target.closest('[data-step]');
    if (step) { lbIndex = (lbIndex + Number(step.dataset.step) + lbPhotos.length) % lbPhotos.length; showLightbox(); return; }
    if (e.target.closest('[data-close]') || e.target === $('socialLightbox')) $('socialLightbox').close();
  });
  $('socialLightbox').addEventListener('keydown', e => {
    if (lbPhotos.length < 2) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { lbIndex = (lbIndex + (e.key === 'ArrowRight' ? 1 : -1) + lbPhotos.length) % lbPhotos.length; showLightbox(); }
  });
  $('socialLightbox').addEventListener('close', () => $('socialLightboxImg').removeAttribute('src'));

  // ---------- Report ----------
  let reportTarget = null;
  function openReport(type, id) {
    if (!viewer.signed_in) return signIn();
    reportTarget = { type, id };
    $('socialReportForm').reset();
    $('socialReportError').classList.add('hidden');
    $('socialReportTitle').textContent = type === 'post' ? 'Report post' : 'Report comment';
    $('socialReport').showModal();
  }
  $('socialReport').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('socialReport')) $('socialReport').close(); });
  $('socialReportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const reason = new FormData($('socialReportForm')).get('reason');
    const err = $('socialReportError');
    if (!reason) { err.textContent = 'Choose a reason.'; err.classList.remove('hidden'); return; }
    const resp = await sendJson('/api/social/reports', 'POST', { target_type: reportTarget.type, target_id: reportTarget.id, reason, details: $('socialReportDetails').value.trim() || undefined }).catch(() => null);
    const data = resp ? await json(resp) : null;
    if (!resp || !resp.ok) {
      if (resp && resp.status === 401) return signIn();
      err.textContent = errorText(data && data.error); err.classList.remove('hidden'); return;
    }
    $('socialReport').close();
    toast('Thanks. Moderators will review it.', 'success');
  });

  // ---------- Composer ----------
  let editing = null;            // the post being edited, or null
  let rating = 0;
  let keep = [];                 // existing photos kept while editing: [{ id, url }]
  let added = [];                // new, compressed photos: [{ blob, url }]
  const attachOpen = { review: false, vehicle: false, link: false };
  // peek-rating.js declares a top-level const (not a window property).
  const ratingInput = typeof PeekRating !== 'undefined' ? PeekRating.create($('socialStars'), {
    labels: ['Poor', 'Fair', 'Good', 'Great', 'Superb'],
    onChange: n => { rating = n; updateComposer(); }
  }) : null;
  function setRating(n) { rating = n; if (ratingInput) ratingInput.setValue(n, { silent: true }); }

  function composerError(msg) { $('socialComposerError').textContent = msg || ''; $('socialComposerError').classList.toggle('hidden', !msg); }
  function updateComposer() {
    // The same length the server counts (line breaks as one character).
    const len = $('socialBody').value.replace(/\r\n/g, '\n').length;
    const left = MAX_CHARS - len;
    const count = $('socialCount');
    count.textContent = `${len.toLocaleString('en-US')} / ${MAX_CHARS.toLocaleString('en-US')}`;
    const state = left < 0 ? 'over' : left === 0 ? 'full' : left <= 200 ? 'near' : '';
    count.classList.toggle('is-over', state === 'over');
    count.classList.toggle('is-near', state === 'near' || state === 'full');
    const msg = $('socialCountMsg');
    const text = state === 'over' ? `${(-left).toLocaleString('en-US')} ${left === -1 ? 'character' : 'characters'} over the ${MAX_CHARS.toLocaleString('en-US')}-character limit. Shorten your post to publish it.`
      : state === 'full' ? `You've reached the ${MAX_CHARS.toLocaleString('en-US')}-character limit.`
      : state === 'near' ? `${left.toLocaleString('en-US')} ${left === 1 ? 'character' : 'characters'} left.` : '';
    if (msg.textContent !== text) msg.textContent = text;   // announced only when it changes
    msg.classList.toggle('hidden', !text);
    msg.classList.toggle('is-over', state === 'over');
    const hasContent = $('socialBody').value.trim().length > 0 || keep.length + added.length > 0;
    $('socialPublish').disabled = !viewer.signed_in || !hasContent || left < 0 || (attachOpen.review && !rating) || $('socialPublish').dataset.busy === '1';
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 420) + 'px'; }
  $('socialBody').addEventListener('input', () => { autosize($('socialBody')); updateComposer(); });

  function setAttach(kind, open) {
    attachOpen[kind] = open;
    $({ review: 'socialReviewFields', vehicle: 'socialVehicleFields', link: 'socialLinkFields' }[kind]).classList.toggle('hidden', !open);
    document.querySelector(`[data-attach="${kind}"]`).setAttribute('aria-pressed', String(open));
    if (!open && kind === 'vehicle') setVehicle(null);
    if (open && kind === 'review' && $('socialCategory').value === 'general') $('socialCategory').value = 'review';
    if (!open && kind === 'review' && $('socialCategory').value === 'review' && !editing) $('socialCategory').value = 'general';
    updateComposer();
  }
  document.querySelectorAll('[data-attach]').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.attach;
    setAttach(kind, !attachOpen[kind]);
    if (attachOpen[kind]) { const f = { review: null, vehicle: 'socialVehicleSearch', link: 'socialLink' }[kind]; if (f) $(f).focus(); }
  }));
  document.querySelectorAll('[data-close-attach]').forEach(b => b.addEventListener('click', () => setAttach(b.dataset.closeAttach, false)));
  $('socialSubmitSighting').addEventListener('click', () => { const b = $('openSightingDrawer'); if (b) b.click(); });

  // ---------- Attach Cybercab: search the public registry ----------
  // Plate, VIN or vehicle id, partial and any case (GET /api/social/vehicles,
  // debounced). The chosen vehicle shows as a preview card with Change / Remove.
  let selectedVehicle = null;
  let vSearchTimer = 0, vSearchSeq = 0, vResults = [], vActive = -1;
  const vInput = () => $('socialVehicleSearch');
  function showVehicleResults(open) {
    $('socialVehicleResults').classList.toggle('hidden', !open);
    vInput().setAttribute('aria-expanded', String(open));
  }
  function renderVehicleResults(q) {
    const list = $('socialVehicleResults');
    vActive = vResults.length ? 0 : -1;
    if (!vResults.length) {
      list.innerHTML = `<li class="social-vempty">${q ? `No public Cybercab matches “${esc(q)}”. Check the plate or VIN, or <button type="button" class="social-linkbtn" data-submit-sighting>submit a sighting</button> of a new one.` : 'No public Cybercabs to show.'}</li>`;
    } else {
      list.innerHTML = vResults.map((v, i) => `<li role="option" id="socialVOpt${i}" data-vi="${i}" aria-selected="${i === vActive}" class="social-vopt">${vehicleCardHtml(v, { tag: 'div' })}</li>`).join('');
      vInput().setAttribute('aria-activedescendant', 'socialVOpt0');
    }
    showVehicleResults(true);
  }
  async function searchVehicles(q) {
    const seq = ++vSearchSeq;
    let data = null;
    try { const r = await fetch('/api/social/vehicles?q=' + encodeURIComponent(q)); data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    if (seq !== vSearchSeq) return;   // an older answer arriving late
    vResults = (data && data.vehicles) || [];
    if (!data) { $('socialVehicleResults').innerHTML = '<li class="social-vempty">Search is unavailable right now. Try again in a moment.</li>'; showVehicleResults(true); return; }
    renderVehicleResults(q);
  }
  function setVehicle(v) {
    selectedVehicle = v || null;
    const prev = $('socialVehiclePreview');
    $('socialVehiclePicker').classList.toggle('hidden', !!v);
    prev.classList.toggle('hidden', !v);
    prev.innerHTML = v ? `<div class="social-vpreview">${vehicleCardHtml(v, { tag: 'div' })}<div class="social-vpreview-actions"><button type="button" class="social-linkbtn" data-vchange>Change</button><button type="button" class="social-linkbtn" data-vremove>Remove</button></div></div>` : '';
    if (!v) { vInput().value = ''; showVehicleResults(false); }
    updateComposer();
  }
  function moveActive(d) {
    if (!vResults.length) return;
    vActive = (vActive + d + vResults.length) % vResults.length;
    $('socialVehicleResults').querySelectorAll('[data-vi]').forEach(li => li.setAttribute('aria-selected', String(Number(li.dataset.vi) === vActive)));
    vInput().setAttribute('aria-activedescendant', 'socialVOpt' + vActive);
    $('socialVOpt' + vActive)?.scrollIntoView({ block: 'nearest' });
  }
  vInput().addEventListener('input', () => {
    clearTimeout(vSearchTimer);
    const q = vInput().value.trim();
    vSearchTimer = setTimeout(() => searchVehicles(q), 200);
  });
  // Suggestions open when typing (or ↓), never on focus alone, so the list
  // never covers the composer's toolbar uninvited.
  vInput().addEventListener('focus', () => { if (vInput().value.trim() && vResults.length) showVehicleResults(true); });
  vInput().addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if ($('socialVehicleResults').classList.contains('hidden')) searchVehicles(vInput().value.trim()); else moveActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (vActive >= 0 && vResults[vActive]) setVehicle(vResults[vActive]); }
    else if (e.key === 'Escape') showVehicleResults(false);
  });
  $('socialVehicleResults').addEventListener('mousedown', e => e.preventDefault());   // keep focus while choosing
  $('socialVehicleResults').addEventListener('click', e => {
    if (e.target.closest('[data-submit-sighting]')) { const b = $('openSightingDrawer'); if (b) b.click(); return; }
    const li = e.target.closest('[data-vi]');
    if (li) setVehicle(vResults[Number(li.dataset.vi)]);
  });
  vInput().addEventListener('blur', () => setTimeout(() => showVehicleResults(false), 120));
  $('socialVehiclePreview').addEventListener('click', e => {
    if (e.target.closest('[data-vremove]')) { setVehicle(null); return; }
    if (e.target.closest('[data-vchange]')) { setVehicle(null); vInput().focus(); }
  });

  // Photos: re-drawn on a canvas, which keeps only the pixels — the camera's
  // location and other metadata never leave the device — and scaled to at
  // most 2048 px. The server strips metadata again and checks every file.
  async function compress(file) {
    let bitmap = null;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
      try { bitmap = await createImageBitmap(file); } catch (e2) { bitmap = null; }
    }
    if (!bitmap) return file.size <= MAX_PHOTO_BYTES ? file : null;
    const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    for (const q of [0.85, 0.72, 0.6]) {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= MAX_PHOTO_BYTES) return blob;
    }
    return null;
  }
  function renderPreviews() {
    const items = [...keep.map((p, i) => ({ url: p.url, key: 'keep:' + i })), ...added.map((p, i) => ({ url: p.url, key: 'added:' + i }))];
    const box = $('socialPhotoPreviews');
    box.innerHTML = items.map((p, i) => `<span class="social-preview"><img src="${esc(p.url)}" alt="Selected photo ${i + 1}"><button type="button" data-remove="${p.key}" aria-label="Remove photo ${i + 1}">&times;</button></span>`).join('');
    box.className = `social-previews n-${items.length}${items.length ? '' : ' hidden'}`;
    document.querySelector('label[for="socialPhotos"]').classList.toggle('is-disabled', items.length >= MAX_PHOTOS);
    $('socialPhotos').disabled = items.length >= MAX_PHOTOS;
    updateComposer();
  }
  $('socialPhotoPreviews').addEventListener('click', e => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const [kind, i] = b.dataset.remove.split(':');
    if (kind === 'keep') keep.splice(Number(i), 1);
    else { URL.revokeObjectURL(added[Number(i)].url); added.splice(Number(i), 1); }
    renderPreviews();
  });
  $('socialPhotos').addEventListener('change', async () => {
    composerError('');
    const files = [...$('socialPhotos').files];
    $('socialPhotos').value = '';
    for (const file of files) {
      if (keep.length + added.length >= MAX_PHOTOS) { composerError(errorText('too_many_photos')); break; }
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { composerError(errorText('unsupported_file_type')); continue; }
      if (file.size > 25 * 1024 * 1024) { composerError(errorText('file_too_large')); continue; }
      const blob = await compress(file);
      if (!blob) { composerError(errorText('file_too_large')); continue; }
      added.push({ blob, url: URL.createObjectURL(blob) });
      renderPreviews();
    }
  });

  function resetComposer() {
    editing = null;
    $('socialBody').value = '';
    autosize($('socialBody'));
    $('socialCategory').value = 'general';
    $('socialLink').value = '';
    setVehicle(null);
    $('socialReviewVehicleType').value = '';
    $('socialReviewFare').value = '';
    $('socialReviewWait').value = '';
    $('socialReviewDate').value = '';
    setRating(0);
    added.forEach(p => URL.revokeObjectURL(p.url));
    keep = []; added = [];
    ['review', 'vehicle', 'link'].forEach(k => setAttach(k, false));
    $('socialEditing').classList.add('hidden');
    $('socialPublish').textContent = 'Post';
    composerError('');
    renderPreviews();
  }
  $('socialEditCancel').addEventListener('click', resetComposer);

  async function startEdit(p) {
    resetComposer();
    editing = p;
    $('socialBody').value = p.body || '';
    $('socialCategory').value = p.category;
    if (p.link_url) { $('socialLink').value = p.link_url; setAttach('link', true); }
    if (p.vehicle) { setAttach('vehicle', true); setVehicle(p.vehicle); }
    if (p.review) {
      setAttach('review', true);
      setRating(p.review.rating);
      $('socialReviewVehicleType').value = p.review.vehicle_type || '';
      $('socialReviewFare').value = p.review.quoted_fare != null ? String(p.review.quoted_fare) : '';
      $('socialReviewWait').value = p.review.pickup_wait_minutes != null ? String(p.review.pickup_wait_minutes) : '';
      $('socialReviewDate').value = p.review.ride_date || '';
    }
    $('socialCategory').value = p.category;
    keep = (p.photos || []).slice();
    $('socialEditing').classList.remove('hidden');
    $('socialPublish').textContent = 'Save';
    renderPreviews();
    autosize($('socialBody'));
    if (singleId) closeSingle(true);
    $('socialComposer').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    $('socialBody').focus();
  }

  $('socialComposer').addEventListener('submit', async e => {
    e.preventDefault();
    if (!viewer.signed_in) return signIn();
    composerError('');
    const body = $('socialBody').value.trim();
    if (body.length > MAX_CHARS) return composerError(`Your post is over the ${MAX_CHARS.toLocaleString('en-US')}-character limit. Shorten it to publish.`);
    if (!body && !keep.length && !added.length) return composerError(errorText('empty_post'));
    if (attachOpen.review && !rating) return composerError(errorText('invalid_rating'));
    if (attachOpen.vehicle && !selectedVehicle) return composerError('Choose a Cybercab from the search results, or remove the attachment.');
    const fd = new FormData();
    fd.append('body', body);
    fd.append('category', $('socialCategory').value);
    if (attachOpen.link && $('socialLink').value.trim()) fd.append('link_url', $('socialLink').value.trim());
    if (attachOpen.vehicle && selectedVehicle) fd.append('vehicle_id', selectedVehicle.id);
    if (attachOpen.review) {
      fd.append('review', '1');
      fd.append('rating', String(rating));
      fd.append('vehicle_type', $('socialReviewVehicleType').value);
      fd.append('quoted_fare', $('socialReviewFare').value);
      fd.append('pickup_wait_minutes', $('socialReviewWait').value);
      fd.append('ride_date', $('socialReviewDate').value);
    } else if (editing) fd.append('remove_review', '1');
    keep.forEach(p => fd.append('keep_photos', p.id));
    added.forEach((p, i) => fd.append('photos', p.blob, `photo-${i + 1}.jpg`));
    const btn = $('socialPublish');
    btn.dataset.busy = '1'; btn.disabled = true;
    const was = editing;
    let resp = null, data = null;
    try {
      resp = await api(was ? `/api/social/posts/${encodeURIComponent(was.id)}` : '/api/social/posts', { method: was ? 'PATCH' : 'POST', body: fd });
      data = await json(resp);
    } catch (err) { resp = null; }
    delete btn.dataset.busy;
    updateComposer();
    if (!resp || !resp.ok || !data || !data.post) {
      if (resp && resp.status === 401) return signIn();
      return composerError(errorText(data && data.error));
    }
    resetComposer();
    if (was) { replacePost(data.post); toast('Post updated.', 'success'); }
    else {
      toast('Posted.', 'success');
      const fits = filter === 'latest' || filter === 'foryou' || (filter === 'photos' && data.post.photos.length) || (filter === 'reviews' && data.post.review);
      if (fits) { showFeedState(null); const el = renderPostInto($('socialFeed'), data.post, 'afterbegin'); el.classList.add('is-new'); }
    }
    loadSidebar(true);
  });

  function renderComposerAccess() {
    const signedIn = viewer.signed_in;
    document.querySelector('#socialComposer .social-composer-row').classList.toggle('hidden', !signedIn);
    $('socialSignIn').classList.toggle('hidden', signedIn);
    updateComposer();
  }
  async function loadMe() {
    if (!session()) { viewer.signed_in = false; renderComposerAccess(); return; }
    try {
      const r = await api('/api/me');
      const d = r.ok ? await json(r) : null;
      if (!d || d.authenticated !== true) { viewer.signed_in = false; renderComposerAccess(); return; }
      me = { name: d.user.display_name || 'You', avatar_url: d.user.avatar_url || null };
      $('socialMeName').textContent = me.name;
      const c = ccc();
      if (c && c.renderAvatar) c.renderAvatar($('socialMeAvatar'), { url: me.avatar_url, name: me.name, size: 128 });
    } catch (e) { /* keeps the plain composer */ }
    renderComposerAccess();
  }

  // ---------- A post's own page (/community?post=<id>) ----------
  let singleId = null;
  const mainParts = () => [$('socialComposer'), document.querySelector('.social-filters'), $('socialFeedbar'), $('socialFeed'), $('socialMore'), $('socialEmpty'), $('socialError')];
  let hiddenBefore = new Map();
  function enterSingle() {
    if (singleId) return;
    hiddenBefore = new Map(mainParts().map(el => [el, el.classList.contains('hidden')]));
    mainParts().forEach(el => el.classList.add('hidden'));
    $('socialSingle').classList.remove('hidden');
  }
  function showUnavailable() {
    $('socialSinglePost').innerHTML = '<div class="social-empty"><div class="social-empty-title">This post isn\'t available</div><p>It may have been deleted by its author or removed by moderators.</p></div>';
  }
  async function openSingle(id, push, commentId) {
    enterSingle();
    singleId = id;
    if (push) { try { const u = new URL(location.href); u.searchParams.delete('view'); u.searchParams.delete('comment'); u.searchParams.set('post', id); if (commentId) u.searchParams.set('comment', commentId); history.pushState({ post: id }, '', u); } catch (e) { /* not essential */ } }
    $('socialSinglePost').innerHTML = '<div class="social-skeleton"></div>';
    window.scrollTo({ top: Math.max(0, $('communityPanelSocial').getBoundingClientRect().top + window.scrollY - 90), behavior: reduceMotion() ? 'auto' : 'smooth' });
    let data = null, status = 0;
    try { const r = await api('/api/social/posts/' + encodeURIComponent(id)); status = r.status; data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    if (singleId !== id) return;
    if (!data || !data.post) {
      if (status === 404 || status === 400) showUnavailable();
      else $('socialSinglePost').innerHTML = '<div class="social-empty"><div class="social-empty-title">We couldn\'t load this post</div><p>Please try again in a moment.</p></div>';
      return;
    }
    setViewer(data.viewer);
    $('socialSinglePost').innerHTML = '';
    const el = renderPostInto($('socialSinglePost'), data.post, 'beforeend', { single: true });
    await toggleThread(el, true);
    // A notification's link (&comment=<id>): bring that comment into view.
    const cid = commentId || new URLSearchParams(location.search).get('comment');
    const li = cid && el.querySelector(`[data-comment="${CSS.escape(cid)}"]`);
    if (li) { li.classList.add('is-highlight'); li.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); }
  }
  function closeSingle(push) {
    if (!singleId) return;
    singleId = null;
    $('socialSingle').classList.add('hidden');
    $('socialSinglePost').innerHTML = '';
    for (const [el, wasHidden] of hiddenBefore) el.classList.toggle('hidden', wasHidden);
    if (push) { try { const u = new URL(location.href); u.searchParams.delete('post'); u.searchParams.delete('comment'); history.pushState({}, '', u); } catch (e) { /* not essential */ } }
    if (!feedStarted) startFeed();
  }
  $('socialBack').addEventListener('click', e => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); closeSingle(true); });
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('post');
    if (id) openSingle(id, false); else closeSingle(false);
  });

  // ---------- Sidebar and the at-a-glance tiles ----------
  let sidebarLoadedAt = 0;
  async function loadSidebar(force) {
    if (!force && Date.now() - sidebarLoadedAt < 60000) return;
    sidebarLoadedAt = Date.now();
    let data = null;
    try { const r = await fetch('/api/social/sidebar'); data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    const s = data && data.stats;
    const stat = window.CommunityStats;
    const set = (id, n, opts) => { if (stat) stat.set(id, n, opts); else if ($(id)) $(id).textContent = n == null ? '—' : opts && opts.decimals ? n.toFixed(opts.decimals) : n.toLocaleString('en-US'); };
    set('statSocialPosts', s ? s.posts : null);
    set('statSocialContributors', s ? s.contributors : null);
    set('statSocialWeek', s ? s.posts_this_week : null);
    const avg = s && s.reviews ? s.average_rating : null;
    set('statSocialRating', avg, { decimals: 1, note: s ? (s.reviews ? `Across ${s.reviews.toLocaleString('en-US')} ride ${s.reviews === 1 ? 'review' : 'reviews'}` : 'No ride reviews yet') : undefined });
    document.querySelector('[data-suffix="statSocialRating"]')?.classList.toggle('hidden', avg == null);

    const trend = $('socialTrending');
    if (!data) trend.innerHTML = '<li class="social-muted">Trending posts could not be loaded.</li>';
    else if (!data.trending.length) trend.innerHTML = '<li class="social-muted">Nothing trending yet this week. Likes and comments put posts here.</li>';
    else {
      trend.innerHTML = data.trending.map(t => `<li><a href="${esc(t.url)}" data-trend="${esc(t.id)}"><span class="social-cat cat-${esc(t.category)}">${esc(CATEGORY[t.category] || 'General')}</span><span class="social-trend-text" data-excerpt></span><span class="social-trend-meta">${t.like_count} ${t.like_count === 1 ? 'like' : 'likes'} · ${t.comment_count} ${t.comment_count === 1 ? 'comment' : 'comments'}</span></a></li>`).join('');
      [...trend.querySelectorAll('[data-excerpt]')].forEach((el, i) => { const x = data.trending[i].excerpt || 'Photo post'; el.textContent = x.length >= 120 ? x + '…' : x; });
    }
    const ann = data && data.announcement;
    const box = $('socialAnnouncement');
    box.classList.toggle('hidden', !ann);
    if (ann) {
      box.innerHTML = '<div class="social-card-title">Announcement</div><p data-ann></p>';
      setLinkedText(box.querySelector('[data-ann]'), ann.body);
      if (ann.link_url) { const a = document.createElement('a'); a.href = ann.link_url; a.textContent = 'Read more'; a.className = 'social-linkbtn'; a.target = '_blank'; a.rel = 'noopener noreferrer'; box.appendChild(a); }
    }
  }
  $('socialTrending').addEventListener('click', e => {
    const a = e.target.closest('[data-trend]');
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    openSingle(a.dataset.trend, true);
  });
  let topLoaded = false;
  async function loadTop() {
    topLoaded = true;
    const list = $('socialTop');
    let data = null;
    try { const r = await fetch('/api/community/leaderboard'); data = r.ok ? await json(r) : null; } catch (e) { data = null; }
    if (!data || !Array.isArray(data.entries)) { list.innerHTML = '<li class="social-muted">Could not be loaded.</li>'; return; }
    const top = data.entries.slice(0, 5);
    if (!top.length) { list.innerHTML = '<li class="social-muted">No ranked spotters yet.</li>'; return; }
    list.innerHTML = top.map((e, i) => {
      const name = `<span class="social-name">${esc(e.name)}</span>`;
      const rank = e.spotter_rank ? `<span class="social-top-rank"><span class="spotter-rank rank-${esc(String(e.spotter_rank_key || '').replace(/[^a-z]/g, ''))}">${esc(e.spotter_rank)}</span>${Number.isFinite(e.level) ? ` · Level ${esc(e.level)}` : ''}</span>` : '';
      return `<li><span class="social-top-n">${i + 1}</span>${avatarHtml({ name: e.name, avatar_url: e.avatar_url }, 'social-avatar is-small')}<span class="min-w-0 flex-1"><span class="block truncate">${e.handle ? `<a href="/rider/${encodeURIComponent(e.handle)}" class="hover:underline">${name}</a>` : name}</span>${rank}</span><span class="social-top-score" title="Top Overall points">${Number(e.score).toLocaleString('en-US')}</span></li>`;
    }).join('');
    paintAvatars(list);
  }
  document.querySelector('[data-to-leaderboard]').addEventListener('click', () => { const t = $('communityTabLeaderboard'); if (t) { t.click(); t.scrollIntoView({ block: 'nearest' }); } });

  // ---------- Notifications bell (any Community section; signed in only) ----------
  const NOTE_ICON = { like: HEART, comment: BUBBLE, reply: BUBBLE, mention: '<span class="social-note-at" aria-hidden="true">@</span>', announcement: PIN };
  let noteItems = [];
  let notePoll = 0;
  function setBellCount(n) {
    const c = $('socialBellCount');
    c.textContent = n > 99 ? '99+' : String(n);
    c.classList.toggle('hidden', !n);
    $('socialBell').setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  }
  async function refreshBell() {
    if (!session() || document.hidden) return;
    try {
      const r = await api('/api/social/notifications?count_only=1');
      if (r.status === 401) { $('socialBellWrap').classList.add('hidden'); clearInterval(notePoll); return; }
      const d = r.ok ? await json(r) : null;
      if (d && Number.isInteger(d.unread)) { $('socialBellWrap').classList.remove('hidden'); setBellCount(d.unread); }
    } catch (e) { /* try again on the next tick */ }
  }
  function noteHtml(n, i) {
    const who = n.actor && n.actor.official ? '<span class="social-name">Cybercab Hunter</span>' : `<span class="social-name">${esc(n.actor ? n.actor.name : 'Someone')}</span>`;
    return `<li><a href="${esc(n.url)}" data-note="${i}" class="social-note${n.read ? '' : ' is-unread'}">
      <span class="social-note-icon">${NOTE_ICON[n.type] || BUBBLE}</span>
      <span class="min-w-0 flex-1"><span class="social-note-text">${who} ${esc(n.text)}</span>${n.excerpt ? `<span class="social-note-excerpt" data-excerpt></span>` : ''}<span class="social-note-time">${esc(relative(n.created_at))}</span></span>
      ${n.read ? '' : '<span class="social-note-dot" aria-label="Unread"></span>'}</a></li>`;
  }
  async function loadNotes() {
    const list = $('socialNotifList');
    let d = null;
    try { const r = await api('/api/social/notifications'); d = r.ok ? await json(r) : null; } catch (e) { d = null; }
    if (!d) { list.innerHTML = '<li class="social-muted">Notifications could not be loaded.</li>'; return; }
    noteItems = d.notifications || [];
    setBellCount(d.unread);
    list.innerHTML = noteItems.length ? noteItems.map(noteHtml).join('') : '<li class="social-muted">No notifications yet. Likes, comments, replies and @mentions on your posts show up here.</li>';
    list.querySelectorAll('[data-excerpt]').forEach(el => { el.textContent = noteItems[Number(el.closest('[data-note]').dataset.note)].excerpt; });
    $('socialNotifAll').classList.toggle('hidden', !d.unread);
  }
  function toggleNotes(open) {
    const panel = $('socialNotifPanel');
    const next = open == null ? panel.classList.contains('hidden') : open;
    panel.classList.toggle('hidden', !next);
    $('socialBell').setAttribute('aria-expanded', String(next));
    if (next) loadNotes();
  }
  async function markRead(body) {
    await api('/api/social/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  }
  $('socialBell').addEventListener('click', e => { e.stopPropagation(); toggleNotes(); });
  document.addEventListener('click', e => { if (!e.target.closest('#socialBellWrap')) toggleNotes(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('socialNotifPanel').classList.contains('hidden')) { toggleNotes(false); $('socialBell').focus(); } });
  $('socialNotifAll').addEventListener('click', async () => { await markRead({ all: true }); loadNotes(); });
  $('socialNotifList').addEventListener('click', async e => {
    const a = e.target.closest('[data-note]');
    if (!a) return;
    const n = noteItems[Number(a.dataset.note)];
    if (!n) return;
    if (!n.read) { n.read = true; markRead({ ids: [n.id] }); a.classList.remove('is-unread'); a.querySelector('.social-note-dot')?.remove(); }
    const u = new URL(n.url, location.origin);
    const postId = u.pathname === '/community' && u.searchParams.get('post');
    if (!postId || e.metaKey || e.ctrlKey) return;   // an announcement link or a new tab: follow the link
    e.preventDefault();
    toggleNotes(false);
    const first = !started;
    started = true;   // the post view below replaces the Social tab's first load
    const tab = $('communityTabSocial');
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
    if (first) loadMe();
    loadSidebar(); if (!topLoaded) loadTop();
    openSingle(postId, true, u.searchParams.get('comment'));
    refreshBell();
  });
  if (session()) {
    refreshBell();
    notePoll = setInterval(refreshBell, 180000);   // every 3 minutes while the page is open and visible
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBell(); });
  }

  // ---------- Start when the Social tab is first shown ----------
  let started = false, feedStarted = false;
  function startFeed() { feedStarted = true; setFilter('foryou'); }
  function start() {
    if (started) return;
    started = true;
    loadMe();
    loadSidebar(true);
    loadTop();
    const id = new URLSearchParams(location.search).get('post');
    if (id) openSingle(id, false); else startFeed();
  }
  document.addEventListener('cch:community-view', e => { if (e.detail && e.detail.view === 'social') start(); });
  if (!$('communityPanelSocial').classList.contains('hidden') && document.readyState !== 'loading') start();
})();
