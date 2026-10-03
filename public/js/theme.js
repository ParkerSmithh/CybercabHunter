/* Cybercab Hunter: the design system's runtime half (the tokens themselves
   live in css/style.css). Loaded in <head> right after the Tailwind CDN on
   every page, before anything paints:
     1. Theme: light or dark on <html data-theme>. Dark by default for
        everyone; the visitor can choose Light, or System to follow their
        device (localStorage 'cchTheme': dark | light | system). Set before
        first paint, so there is no flash.
     2. The ONE Tailwind config for the whole site. Every color is a CSS
        variable, so the same utility classes (text-white, text-slate-400,
        bg-panel, bg-white/5...) read correctly in both themes. 'white' is
        the ink color (near-white on dark, near-black on light); 'paper' is a
        literal off-white for text that always sits on a dark photo or scrim.
   Radius rule (Bevel): buttons are pills (css/style.css), inputs
   rounded-lg = 12px, tiles and images rounded-xl = 16px, cards rounded-2xl
   = 24px, large fields rounded-3xl = 32px, chips/avatars rounded-full. */
(function () {
  var KEY = 'cchTheme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var DEFAULT = 'dark';
  function stored() { try { return localStorage.getItem(KEY) || DEFAULT; } catch (e) { return DEFAULT; } }
  function resolve(pref) { return pref === 'light' || pref === 'dark' ? pref : (mq && mq.matches ? 'light' : 'dark'); }
  function apply(pref) { root.setAttribute('data-theme', resolve(pref)); root.setAttribute('data-theme-pref', pref); }
  apply(stored());
  // Motion details (js/main.js): with motion allowed, section headings start
  // hidden until SplitText plays them (css/style.css; a 2.5s CSS fallback
  // shows them if the script never runs).
  if (!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) root.classList.add('motion-ok');
  if (mq) {
    var onChange = function () { if (stored() === 'system') { apply('system'); document.dispatchEvent(new CustomEvent('cch:theme')); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  window.CCHTheme = {
    get: stored,
    current: function () { return root.getAttribute('data-theme'); },
    set: function (pref) {
      try { if (pref === DEFAULT) localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref); } catch (e) { /* this visit only */ }
      apply(pref);
      document.dispatchEvent(new CustomEvent('cch:theme'));
    }
  };

  // The footer's Appearance switch (System / Light / Dark). Maps draw their
  // basemap for one theme when they load, so a page with a map reloads.
  function wire() {
    var buttons = document.querySelectorAll('[data-theme-set]');
    var sync = function () { var p = stored(); buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === p)); }); };
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var before = root.getAttribute('data-theme');
        window.CCHTheme.set(b.getAttribute('data-theme-set'));
        sync();
        if (before !== root.getAttribute('data-theme') && document.querySelector('.maplibregl-map')) location.reload();
      });
    });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  if (typeof window.tailwind === 'undefined') return;
  var v = function (name) { return 'rgb(var(' + name + ') / <alpha-value>)'; };
  var steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
  var neutral = {};
  steps.forEach(function (s) { neutral[s] = v('--n-' + s); });
  window.tailwind.config = {
    theme: {
      extend: {
        colors: {
          void: v('--bg'), panel: v('--surface'), raised: v('--surface-2'), card: v('--card'), body: v('--body-gray'),
          white: v('--ink'), paper: '#F4F5F7',
          slate: neutral,
          gold: v('--gold'), goldsoft: v('--gold-soft'),
          // One accent: the old second/third accents (cyan, blue, silver) read as gold or neutral.
          cyan: v('--gold'), cyblue: v('--gold'), silver: v('--n-300'),
          crimson: v('--danger'),
          red: { 200: v('--danger-ink'), 300: v('--danger-ink'), 400: v('--danger-ink') },
          amber: { 200: v('--warn-ink'), 300: v('--warn-ink'), 400: v('--warn-ink') },
          emerald: { 200: v('--ok-ink'), 300: v('--ok-ink'), 400: v('--ok-ink') }
        },
        fontFamily: {
          // Bevel: the system SF stack; Geist (self-hosted) stands in off Apple devices.
          display: ['-apple-system', 'BlinkMacSystemFont', 'Geist', '"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
          body: ['-apple-system', 'BlinkMacSystemFont', 'Geist', '"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
          sans: ['-apple-system', 'BlinkMacSystemFont', 'Geist', '"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
          mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace']
        },
        borderRadius: { md: '10px', lg: '12px', xl: '16px', '2xl': '24px', '3xl': '32px' },
        transitionTimingFunction: { out: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
      }
    }
  };
})();
