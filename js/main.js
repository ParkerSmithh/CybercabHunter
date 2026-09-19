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
    ],
    leaderboard: [
      { name: 'atx_spotter', score: 1820 },
      { name: 'dfw_watcher', score: 1390 },
      { name: 'cabhunter22', score: 1204 },
      { name: 'sillicon_hills', score: 990 },
      { name: 'railyardryan', score: 812 }
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

    let activeLink = null;
    links.forEach(link => {
      if (link.dataset.nav === path) {
        link.classList.add('text-gold');
        activeLink = link;
      } else {
        link.classList.remove('text-gold');
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

  /* ---------------- Sighting drawer (shared across pages) ---------------- */
  function initSightingDrawer() {
    const drawer = document.getElementById('sightingDrawer');
    const backdrop = document.getElementById('sightingBackdrop');
    const form = document.getElementById('sightingForm');
    if (!drawer || !backdrop || !form) return;

    const openBtns = [document.getElementById('openSightingDrawer'), document.getElementById('heroSightingBtn')].filter(Boolean);
    const closeBtn = document.getElementById('closeSightingDrawer');

    function open() { drawer.classList.add('is-open'); backdrop.classList.add('is-open'); }
    function close() { drawer.classList.remove('is-open'); backdrop.classList.remove('is-open'); }

    openBtns.forEach(btn => btn.addEventListener('click', open));
    if (closeBtn) closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const type = document.getElementById('sightingType').value;
      const loc = document.getElementById('sightingLoc').value.trim();
      const vehicle = document.getElementById('sightingVehicle').value.trim() || 'Unlisted';
      if (!loc) return;
      const entry = { id: 'u' + Date.now(), vehicle, loc, time: 'Just now', type, verified: false };
      const stored = storage.get('sightings', []);
      stored.unshift(entry);
      storage.set('sightings', stored);
      close();
      form.reset();
      toast('Sighting logged — thanks for the intel.', 'success');
      document.dispatchEvent(new CustomEvent('ccc:sighting-added', { detail: entry }));
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
        error: ['Tesla linking failed — please try again.', 'error']
      };
      const [msg, type] = messages[result] || messages.error;
      toast(msg, type);
      params.delete('tesla');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }

    const btn = document.getElementById('teslaLinkBtn');
    if (!btn) return;

    function render(linked) {
      btn.dataset.linked = linked ? '1' : '0';
      btn.classList.toggle('btn-magnetic', !linked);
      btn.style.pointerEvents = linked ? 'none' : '';
      btn.style.opacity = linked ? '0.7' : '';
      btn.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${TESLA_ICON_SVG}</svg>${linked ? 'Account Linked' : 'Link Tesla Account'}`;
    }

    const sessionId = localStorage.getItem(TESLA_SESSION_KEY);
    if (!sessionId) {
      render(false);
    } else {
      fetch(TESLA_WORKER_URL + '/oauth/tesla/status', {
        headers: { Authorization: 'Bearer ' + sessionId }
      })
        .then(r => r.json())
        .then(d => {
          render(!!d.linked);
          if (!d.linked) localStorage.removeItem(TESLA_SESSION_KEY);
        })
        .catch(() => render(false));
    }

    // pointer-events:none once linked (see render()) makes the button
    // unclickable, so this only ever fires for "start linking" — no
    // preventDefault, the browser follows href to /oauth/tesla/start.
    btn.addEventListener('click', () => {
      btn.textContent = 'Connecting…';
    });
  }

  /* ---------------- Account menu (Google/X sign-in placeholder) ----------------
     Purely a frontend mock for now — no backend call, no real OAuth yet.
     Stores only a provider tag under storage, never a fabricated name —
     this represents "completed the placeholder sign-in," not a real
     identity, so the UI shows a generic avatar rather than inventing a
     person. This is intentionally separate from the real Tesla session
     (TESLA_SESSION_KEY): connecting Tesla remains its own action from
     inside the Profile page's own signed-out prompt, unchanged. */
  const ACCOUNT_KEY = 'mockAccount';
  const PERSON_ICON_SVG = '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" />';

  function mockSignIn(provider) {
    storage.set(ACCOUNT_KEY, { provider });
  }

  function mockSignOut() {
    try { localStorage.removeItem(NS + ACCOUNT_KEY); } catch (e) {}
  }

  function initAccountMenu() {
    const signedOut = document.getElementById('accountSignedOut');
    const signedIn = document.getElementById('accountSignedIn');
    if (!signedOut || !signedIn) return;

    const account = storage.get(ACCOUNT_KEY, null);
    if (!account) {
      signedOut.classList.remove('hidden');
      signedIn.classList.add('hidden');
      return;
    }

    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');

    const avatarIcon = document.getElementById('accountAvatarIcon');
    if (avatarIcon) avatarIcon.innerHTML = PERSON_ICON_SVG;

    const trigger = document.getElementById('accountMenuTrigger');
    const dropdown = document.getElementById('accountMenuDropdown');
    if (trigger && dropdown) {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', () => dropdown.classList.add('hidden'));
      dropdown.addEventListener('click', (e) => e.stopPropagation());
    }

    const settingsLink = document.getElementById('accountMenuSettings');
    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        toast('Settings are coming soon.', 'info');
      });
    }

    const signOutBtn = document.getElementById('accountMenuSignOut');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', () => {
        mockSignOut();
        location.href = 'index.html';
      });
    }
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

  return { data, storage, merge, initNav, initReveal, animateCounter, spawnConfetti, toast, initParticles, initSightingDrawer, initRipple, initTeslaLink, mockSignIn, mockSignOut, initAccountMenu, init };
})();
