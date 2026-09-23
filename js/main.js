/* Cybercab Hunter — shared runtime: seed data, storage, nav, Tesla-link,
   scroll reveal, counters, confetti, toasts. Loaded after js/calc.js on
   every page; each page's own inline <script> calls CCC.init() first. */

const CCC = (() => {
  const NS = 'cybercabCentral.';

  /* ---------------- Seed data ---------------- */
  const data = {
    cybercabs: [
      { id: 'CC-0412', lat: 30.2672, lng: -97.7431, battery: 82, status: 'Unsupervised', lastSeen: '2m ago' },
      { id: 'CC-0388', lat: 30.2849, lng: -97.7341, battery: 61, status: 'Unsupervised', lastSeen: '4m ago' },
      { id: 'CC-0455', lat: 30.2489, lng: -97.7622, battery: 94, status: 'Unsupervised', lastSeen: '6m ago' },
      { id: 'CC-0201', lat: 30.2711, lng: -97.7091, battery: 47, status: 'Charging', lastSeen: '1m ago' },
      { id: 'CC-0509', lat: 30.3005, lng: -97.7550, battery: 73, status: 'Unsupervised', lastSeen: '9m ago' }
    ],
    modelYs: [
      { id: 'MY-1187', lat: 32.7831, lng: -96.7994, battery: 58, status: 'Employee Test', lastSeen: '3m ago' },
      { id: 'MY-1042', lat: 32.7963, lng: -96.7691, battery: 88, status: 'Employee Test', lastSeen: '5m ago' },
      { id: 'MY-1299', lat: 30.2601, lng: -97.7519, battery: 65, status: 'Unsupervised', lastSeen: '2m ago' }
    ],
    deadZones: [
      { lat: 30.2950, lng: -97.7150, radius: 900, label: 'East Austin high-demand gap' },
      { lat: 32.8100, lng: -96.7500, radius: 800, label: 'North Dallas gap' }
    ],
    sightings: [
      { id: 's1', vehicle: 'CC-0412', loc: 'S Congress Ave, Austin, TX', time: 'Just now', type: 'Unsupervised', verified: true },
      { id: 's2', vehicle: 'MY-1187', loc: 'Uptown, Dallas, TX', time: '2m ago', type: 'Employee Test', verified: true },
      { id: 's3', vehicle: 'CC-0455', loc: 'Rainey St, Austin, TX', time: '5m ago', type: 'Unsupervised', verified: true },
      { id: 's4', vehicle: 'MY-1042', loc: 'Deep Ellum, Dallas, TX', time: '12m ago', type: 'Employee Test', verified: false }
    ],
    bounties: [
      { id: 'b1', title: 'First sighting in Zilker', reward: 250, progress: 3, goal: 5 },
      { id: 'b2', title: 'Night-time unsupervised clip', reward: 400, progress: 1, goal: 3 },
      { id: 'b3', title: 'Inductive pad in-use photo', reward: 150, progress: 4, goal: 4 }
    ]
  };

  /* ---------------- Storage ---------------- */
  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(NS + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) {}
    }
  };

  function merge(seedArray, storageKey) {
    return seedArray.concat(storage.get(storageKey, []));
  }

  /* ---------------- Nav ---------------- */
  function initNav() {
    const links = document.querySelectorAll('[data-nav]');
    const indicator = document.getElementById('navIndicator');
    let path = location.pathname.split('/').pop() || 'index.html';
    path = path.replace('.html', '') || 'index';

    // The mobile bottom nav (#mobileBottomNav) duplicates these same
    // [data-nav] links so both copies highlight together, but only the copy
    // inside the desktop <nav> (indicator's own parent) can host the sliding
    // gold indicator — the bottom nav's copy is a different element entirely
    // and has no indicator of its own.
    let activeLink = null;
    links.forEach(link => {
      if (link.dataset.nav === path) {
        link.classList.add('text-gold');
        link.setAttribute('aria-current', 'page');
        if (indicator && link.parentElement === indicator.parentElement) activeLink = link;
      } else {
        link.classList.remove('text-gold');
        link.removeAttribute('aria-current');
      }
    });

    if (activeLink && indicator) {
      const navRect = indicator.parentElement.getBoundingClientRect();
      const linkRect = activeLink.getBoundingClientRect();
      indicator.style.left = (linkRect.left - navRect.left) + 'px';
      indicator.style.width = linkRect.width + 'px';
      indicator.classList.add('is-active');
    }
  }

  /* ---------------- Reveal on scroll ---------------- */
  function initReveal() {
    const els = document.querySelectorAll('.reveal-on-scroll');
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          let delay = el.dataset.delay;
          if (delay === undefined) {
            const siblings = el.parentElement
              ? Array.from(el.parentElement.children).filter(c => c.classList.contains('reveal-on-scroll'))
              : [];
            const idx = siblings.indexOf(el);
            delay = idx > 0 ? Math.min(idx, 8) * 70 : 0;
          }
          el.style.transitionDelay = delay + 'ms';
          el.classList.add('is-visible');
          io.unobserve(el);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ---------------- Counter animation ---------------- */
  function animateCounter(el, from, to, duration = 1200, formatFn) {
    if (!el) return;
    const start = performance.now();
    const fmt = formatFn || (v => Math.round(v).toLocaleString());
    const isInput = el.tagName === 'INPUT';
    const set = v => { if (isInput) el.value = v; else el.textContent = v; };
    function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = easeOutExpo(t);
      set(fmt(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(tick);
      else set(fmt(to));
    }
    requestAnimationFrame(tick);
  }

  /* ---------------- Confetti ---------------- */
  function spawnConfetti(originEl) {
    const colors = ['#D4AF37', '#F3E5AB', '#00E5FF', '#CBD5E1'];
    const rect = originEl ? originEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < 28; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = originX + 'px';
      piece.style.top = originY + 'px';
      piece.style.background = colors[i % colors.length];
      const dx = (Math.random() - 0.5) * 360;
      const dy = (Math.random() * -260) - 40;
      const rot = (Math.random() - 0.5) * 720;
      piece.style.setProperty('--dx', dx + 'px');
      piece.style.setProperty('--dy', dy + 'px');
      piece.style.setProperty('--rot', rot + 'deg');
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 1700);
    }
  }

  /* ---------------- Toast ---------------- */
  function toast(message, type = 'info') {
    let root = document.getElementById('toastRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toastRoot';
      root.className = 'fixed bottom-6 right-6 z-[200] flex flex-col gap-2';
      document.body.appendChild(root);
    }
    const colors = { success: 'border-gold text-gold', info: 'border-cyan text-cyan', error: 'border-crimson text-crimson' };
    const el = document.createElement('div');
    el.className = 'toast glass px-4 py-3 rounded-xl text-sm font-medium border ' + (colors[type] || colors.info);
    el.textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 350);
    }, 3200);
  }

  /* ---------------- Sighting drawer (shared across pages) ----------------
     Real submission as of Phase 3D-B: POST /api/vehicle-sightings
     (worker/sightings.js), authenticated with the same bearer session
     Tesla/Google sign-in and the account menu already use (TESLA_SESSION_KEY).
     Nothing here is written to localStorage any more — the old
     cybercabCentral.sightings entries some browsers still have from before
     this change are simply never read or added to by this function again.
     Submitting a sighting only ever queues it for review; nothing about it
     is public, and no vehicle is created or changed by it (that trust
     boundary lives entirely in the backend — see worker/sightings.js). */
  const SIGHTING_ERROR_MESSAGES = {
    invalid_license_plate: "That doesn't look like a valid license plate.",
    invalid_service_area: 'Please enter a city or service area.',
    invalid_observed_at: "That doesn't look like a valid time.",
    invalid_body: "That sighting couldn't be submitted — check the fields and try again."
  };

  const SIGN_IN_PAGE = 'signin.html';   // relative on purpose: vehicle.html's <base href="/"> makes it resolve from the site root

  function initSightingDrawer() {
    const drawer = document.getElementById('sightingDrawer');
    const backdrop = document.getElementById('sightingBackdrop');
    const form = document.getElementById('sightingForm');
    const signInRequired = document.getElementById('sightingSignInRequired');
    if (!drawer || !backdrop || !form || !signInRequired) return;

    const openBtns = [document.getElementById('openSightingDrawer'), document.getElementById('heroSightingBtn')].filter(Boolean);
    const closeBtn = document.getElementById('closeSightingDrawer');
    const submitBtn = document.getElementById('sightingSubmitBtn');
    const serviceAreaField = document.getElementById('sightingServiceArea');
    const locationField = document.getElementById('sightingLoc');
    const plateField = document.getElementById('sightingVehicle');
    let inFlight = false;

    // Re-checked every time the drawer opens (not just once at page load) so
    // signing in/out between openings is reflected without a page reload.
    function refreshAuthGate() {
      const signedIn = !!localStorage.getItem(TESLA_SESSION_KEY);
      signInRequired.classList.toggle('hidden', signedIn);
      form.classList.toggle('hidden', !signedIn);
      return signedIn;
    }

    // Signed out: the drawer is never opened. The visitor goes straight to the
    // existing sign-in page (Google), so the submit form is only ever reachable
    // signed in. The in-drawer sign-in prompt above stays as the fallback for a
    // session that turns out to be rejected while the drawer is already open.
    function open() {
      if (!refreshAuthGate()) { window.location.href = SIGN_IN_PAGE; return; }
      drawer.classList.add('is-open'); backdrop.classList.add('is-open');
    }
    function close() { drawer.classList.remove('is-open'); backdrop.classList.remove('is-open'); }

    openBtns.forEach(btn => btn.addEventListener('click', open));
    if (closeBtn) closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    function setSubmitting(submitting) {
      inFlight = submitting;
      submitBtn.disabled = submitting;
      submitBtn.textContent = submitting ? 'Submitting…' : 'Log Sighting';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (inFlight) return; // guards a double-click/rapid-repeat submit

      // The authoritative check is always the sessionId read fresh right
      // here — refreshAuthGate() at open-time is just the honest UI state;
      // this covers a sign-out that happened while the drawer was open.
      const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
      if (!sessionId) { refreshAuthGate(); return; }

      const serviceArea = serviceAreaField.value.trim();
      if (!serviceArea) return; // required attribute already guards this; defensive backstop only

      const approxLocation = locationField.value.trim();
      const licensePlate = plateField.value.trim();

      const payload = { service_area: serviceArea };
      if (approxLocation) payload.approx_location = approxLocation;
      if (licensePlate) payload.license_plate = licensePlate; // never the old "Unlisted" fallback — missing stays missing

      setSubmitting(true);
      let resp;
      try {
        resp = await fetch(TESLA_WORKER_URL + '/api/vehicle-sightings', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sessionId, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        setSubmitting(false);
        toast("Couldn't submit the sighting. Please try again.", 'error');
        return; // entered fields are left exactly as typed
      }

      let json = null;
      try { json = await resp.json(); } catch (err) { /* non-JSON body */ }
      setSubmitting(false);

      if (resp.status === 401) {
        localStorage.removeItem(TESLA_SESSION_KEY);
        refreshAuthGate();
        return;
      }
      if (resp.status === 400) {
        const code = json && json.error;
        toast((code && SIGHTING_ERROR_MESSAGES[code]) || SIGHTING_ERROR_MESSAGES.invalid_body, 'error');
        return;
      }
      if (resp.status === 413) {
        toast("That sighting is too large to submit.", 'error');
        return;
      }
      if (!resp.ok) {
        toast("Couldn't submit the sighting. Please try again.", 'error');
        return;
      }

      if (json && json.duplicate) {
        toast('That sighting was already submitted.', 'info');
      } else {
        toast('Sighting submitted for review.', 'success');
      }
      close();
      form.reset();
    });
  }

  /* ---------------- Ambient particles ---------------- */
  function initParticles() {
    const mesh = document.querySelector('.bg-mesh');
    if (!mesh) return;
    for (let i = 0; i < 14; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      const size = 2 + Math.random() * 4;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 100 + '%';
      p.style.bottom = '-20px';
      p.style.animationDuration = (14 + Math.random() * 14) + 's';
      p.style.animationDelay = (Math.random() * 14) + 's';
      mesh.appendChild(p);
    }
  }

  /* ---------------- Button ripple ---------------- */
  function initRipple() {
    document.querySelectorAll('.btn-magnetic').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const rect = btn.getBoundingClientRect();
        const circle = document.createElement('span');
        const size = Math.max(rect.width, rect.height);
        circle.className = 'ripple-circle';
        circle.style.width = circle.style.height = size + 'px';
        circle.style.left = (e.clientX - rect.left - size / 2) + 'px';
        circle.style.top = (e.clientY - rect.top - size / 2) + 'px';
        btn.appendChild(circle);
        setTimeout(() => circle.remove(), 600);
      });
    });
  }

  /* ---------------- Tesla account link (real OAuth via Cloudflare Worker) ----------------
     The Worker holds the Tesla client secret and all tokens server-side; this
     script only ever learns a boolean "linked" state via a same-origin-safe
     cross-site fetch (credentials: 'include' + the Worker's own CORS allow-list). */
  const TESLA_WORKER_URL = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const TESLA_ICON_SVG = '<path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/>';

  const TESLA_SESSION_KEY = 'teslaSessionId';

  function initTeslaLink() {
    // The callback hands back a one-time session ID in the URL fragment
    // (never sent to any server) the first time the browser lands here after
    // linking. Capture it into localStorage, then scrub it from the URL.
    // This ID is not a Tesla token — it's an opaque pointer to the token
    // record the Worker keeps server-side; a cross-site cookie would have
    // worked the same way in principle, but Chrome/Safari both block
    // third-party cookies by default, so the Worker uses this instead and
    // the frontend sends it back explicitly as an Authorization header.
    const hashMatch = location.hash.match(/tesla_session=([^&]+)/);
    if (hashMatch) {
      localStorage.setItem(TESLA_SESSION_KEY, decodeURIComponent(hashMatch[1]));
      history.replaceState(null, '', location.pathname + location.search);
    }

    // Show a one-time result toast for a just-completed OAuth round trip,
    // then scrub the query param so it doesn't re-fire on refresh/share.
    const params = new URLSearchParams(location.search);
    const result = params.get('tesla');
    if (result) {
      const messages = {
        linked: ['TESLA ACCOUNT LINKED', 'success'],
        cancelled: ['Tesla linking was cancelled.', 'info'],
        invalid_state: ['Tesla linking failed — please try again.', 'error'],
        token_exchange_failed: ['Tesla linking failed — please try again.', 'error'],
        already_linked_elsewhere: ['That Tesla account is already linked to a different sign-in.', 'error'],
        error: ['Tesla linking failed — please try again.', 'error']
      };
      const [msg, type] = messages[result] || messages.error;
      toast(msg, type);
      params.delete('tesla');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    // Same one-time toast/scrub for the Google Sign-In round trip
    // (worker/google-auth.js's callback uses ?signin= instead of ?tesla=
    // since it's not Tesla-specific).
    const signinResult = params.get('signin');
    if (signinResult) {
      const messages = {
        success: ['SIGNED IN', 'success'],
        cancelled: ['Sign-in was cancelled.', 'info'],
        invalid_state: ['Sign-in failed — please try again.', 'error'],
        token_exchange_failed: ['Sign-in failed — please try again.', 'error'],
        error: ['Sign-in failed — please try again.', 'error']
      };
      const [msg, type] = messages[signinResult] || messages.error;
      toast(msg, type);
      params.delete('signin');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    const btn = document.getElementById('teslaLinkBtn');
    if (!btn) return;

    const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
    const startUrl = TESLA_WORKER_URL + '/oauth/tesla/start';

    // What connecting Tesla actually does: it gives Cybercab Hunter access to
    // the eligible vehicle information on the rider's Tesla account. It does
    // NOT import Robotaxi ride history — rides come from receipts.
    btn.href = startUrl;
    btn.title = 'Connect your Tesla account so Cybercab Hunter can see your eligible Tesla vehicle information. This does not import Robotaxi ride history.';
    btn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${TESLA_ICON_SVG}</svg>Link Tesla Account`;

    // Once linked, this button just disappears entirely (see render())
    // rather than showing a disabled "Account Linked" state — unlinking,
    // if the account is signed in, happens from rider-data.html instead.
    function render(linked) {
      btn.classList.toggle('hidden', linked);
    }

    if (!sessionId) {
      render(false);
    } else {
      fetch(TESLA_WORKER_URL + '/oauth/tesla/status', {
        headers: { Authorization: 'Bearer ' + sessionId }
      })
        .then(r => r.json())
        .then(d => render(!!d.linked))
        .catch(() => render(false));
    }

    // A signed-in browser must tell the Worker WHICH account is linking so
    // Tesla attaches to it instead of creating a separate account — but the
    // long-lived session id must never appear in a URL. So ask (over an
    // authenticated fetch) for a one-time, two-minute link token and put only
    // that in the URL. Signed out, this is just an ordinary link.
    btn.addEventListener('click', (e) => {
      if (!sessionId) { btn.textContent = 'Connecting…'; return; }
      e.preventDefault();
      const label = btn.innerHTML;
      btn.textContent = 'Connecting…';
      fetch(TESLA_WORKER_URL + '/oauth/tesla/link', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + sessionId }
      })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          // A rejected session means we aren't really signed in — the plain flow is right then.
          location.href = startUrl + (d && d.link_token ? '?link=' + encodeURIComponent(d.link_token) : '');
        })
        .catch(() => {
          // Never silently fall back to a plain link here: for a signed-in
          // rider that would create a second, separate account.
          btn.innerHTML = label;
          toast('Could not start Tesla linking — please try again.', 'error');
        });
    });
  }

  /* ---------------- Account menu (real session via /api/me) ----------------
     Signed-in state is driven by the same opaque bearer session Tesla
     linking uses (TESLA_SESSION_KEY) — Google Sign-In's OAuth callback hands
     one back through the identical #tesla_session= fragment (see
     worker/google-auth.js), so this reads whichever provider created it the
     same way. */
  const PERSON_ICON_SVG = '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" />';

  function initAccountMenu() {
    const signedOut = document.getElementById('accountSignedOut');
    const signedIn = document.getElementById('accountSignedIn');
    if (!signedOut || !signedIn) return;

    function showSignedOut() {
      signedOut.classList.remove('hidden');
      signedIn.classList.add('hidden');
    }

    function showSignedIn({ label, avatarUrl, onSignOut }) {
      signedOut.classList.add('hidden');
      signedIn.classList.remove('hidden');

      const avatarIcon = document.getElementById('accountAvatarIcon');
      const avatarImg = document.getElementById('accountAvatarImg');
      if (avatarUrl && avatarImg) {
        avatarImg.src = avatarUrl;
        avatarImg.classList.remove('hidden');
        if (avatarIcon) avatarIcon.classList.add('hidden');
      } else {
        if (avatarImg) avatarImg.classList.add('hidden');
        if (avatarIcon) { avatarIcon.classList.remove('hidden'); avatarIcon.innerHTML = PERSON_ICON_SVG; }
      }

      const providerLabel = document.getElementById('accountMenuProviderLabel');
      if (providerLabel) providerLabel.textContent = label;

      // Slides in from the right, same drawer/backdrop pattern as the
      // "Submit" sighting drawer — not a small anchored popover.
      const trigger = document.getElementById('accountMenuTrigger');
      const drawer = document.getElementById('accountDrawer');
      const backdrop = document.getElementById('accountBackdrop');
      const closeBtn = document.getElementById('closeAccountDrawer');
      if (trigger && drawer && backdrop) {
        function openDrawer() { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); }
        function closeDrawer() { drawer.classList.remove('is-open'); backdrop.classList.remove('is-open'); }
        trigger.addEventListener('click', openDrawer);
        if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
        backdrop.addEventListener('click', closeDrawer);
      }

      const signOutBtn = document.getElementById('accountMenuSignOut');
      if (signOutBtn) signOutBtn.addEventListener('click', onSignOut);
    }

    // A "Moderation" entry beside Profile / Rider Data, for moderators only.
    // It is a convenience and nothing more: whether the account is a moderator
    // comes from the server (GET /api/moderation/access, which answers only
    // about the caller's own account), and every moderation API call is
    // authorized again server-side. Anything unexpected leaves the link out.
    function showModerationLink(sessionId) {
      const anchor = document.querySelector('#accountDrawer a[href="rider-data.html"]');
      if (!anchor || document.getElementById('accountMenuModeration')) return;
      fetch(TESLA_WORKER_URL + '/api/moderation/access', { headers: { Authorization: 'Bearer ' + sessionId } })
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d || d.moderator !== true || document.getElementById('accountMenuModeration')) return;
          const link = anchor.cloneNode(false);
          link.id = 'accountMenuModeration';
          link.setAttribute('href', '/moderation');
          link.innerHTML = '<svg class="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>Moderation';
          anchor.insertAdjacentElement('afterend', link);
        })
        .catch(() => { /* no link on any failure */ });
    }

    const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
    if (!sessionId) {
      showSignedOut();
      return;
    }

    fetch(TESLA_WORKER_URL + '/api/me', {
      headers: { Authorization: 'Bearer ' + sessionId }
    })
      .then(r => r.ok ? r.json() : { authenticated: false })
      .then(d => {
        if (!d.authenticated) {
          localStorage.removeItem(TESLA_SESSION_KEY);
          showSignedOut();
          return;
        }
        showModerationLink(sessionId);
        showSignedIn({
          label: d.user.display_name || 'Signed in',
          avatarUrl: d.user.avatar_url,
          onSignOut: () => {
            fetch(TESLA_WORKER_URL + '/oauth/tesla/disconnect', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + sessionId }
            }).finally(() => {
              localStorage.removeItem(TESLA_SESSION_KEY);
              location.href = 'index.html';
            });
          }
        });
      })
      .catch(() => showSignedOut());
  }

  /* ---------------- Init ---------------- */
  function init() {
    initNav();
    initReveal();
    initParticles();
    initSightingDrawer();
    initRipple();
    initTeslaLink();
    initAccountMenu();
  }

  return { data, storage, merge, initNav, initReveal, animateCounter, spawnConfetti, toast, initParticles, initSightingDrawer, initRipple, initTeslaLink, initAccountMenu, init };
})();
