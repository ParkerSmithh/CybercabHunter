/* Interactive Cybercab: click/tap the car (or its "Open doors" button) and
   the butterfly doors swing up; again and they close. Used in place of the
   car image on Fleet ROI and Fleet ETA (simulation.html [data-cc-doors]).

   Frames: images/cybercab-doors/{d,m}/000-107.webp. 108 real frames of the
   door swing from docs/cybercab-doors-source/CybercabOpening.mp4 (video
   frames 9-145: closed, matching CybercabClosed.png, to both doors at their
   highest, the pose in CybercabOpen.png; sources kept out of public/),
   picked evenly by how much the picture changes so the doors move at a
   steady pace. Stabilized: the source camera drifts down ~13px and zooms
   out ~1% while the doors rise, which read as the car bobbing, so each
   frame is shifted and scaled back onto frame 0 (measured on the wheels
   and bumper; ~1-3px of perspective remains). The studio is the page's
   dark background, rgb(8, 9, 10), baked into the pixels, so the frames sit
   on the page seamlessly in any browser with no CSS blending. d = 800px wide, m = 480px; the set is chosen
   from the rendered width x pixel density.

   Playback: 108 frames in DURATION_MS (1.5 s, ~72 distinct frames per
   second; slowed from 0.85 s on owner review), and
   between two frames the canvas crossfades by the exact position, so every
   display refresh (60-120 Hz) shows a new picture. The clock is in
   milliseconds, so 120 Hz screens play at the same speed, just smoother.
   Clicking mid-swing reverses from where the doors are.

   Weight: nothing loads until someone shows intent (hover, focus, touch or
   press); the first frame is a normal <img>, so the page renders the car
   without the sequence. Reduced motion: the doors jump straight to open or
   closed.

   Autoplay ([data-cc-autoplay], the homepage showcase only): while at least
   40% on screen the doors open, hold, close and hold, on a loop; off screen
   the loop stops (an IntersectionObserver), and the frames load the first
   time it comes into view. Reduced motion: no loop. A tap or a key takes over
   (the loop stops for good). Without the attribute nothing changes. */
(function () {
  const FRAMES = 108;
  const DURATION_MS = 1500;
  const DIR = 'images/cybercab-doors/';
  const FRAMES_VERSION = 4;   // bump when the frames are regenerated (same names, new pixels)
  const sets = {};   // 'd' | 'm' -> { frames: [], ready: Promise }
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const pad = n => String(n).padStart(3, '0');

  // Every frame of one size, decoded before use, so drawing never stalls.
  function loadSet(key) {
    if (sets[key]) return sets[key];
    const frames = new Array(FRAMES);
    const ready = Promise.all(Array.from({ length: FRAMES }, (_, i) => new Promise(resolve => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const done = () => { frames[i] = img; resolve(); };
        if (img.decode) img.decode().then(done, done); else done();
      };
      img.onerror = () => resolve();   // a missing frame falls back to its neighbour
      img.src = `${DIR}${key}/${pad(i)}.webp?v=${FRAMES_VERSION}`;
    })));
    sets[key] = { frames, ready };
    return sets[key];
  }

  // The nearest decoded frame to i (frames can fail to load).
  function nearest(frames, i) {
    for (let d = 0; d < FRAMES; d++) {
      if (frames[i - d]) return frames[i - d];
      if (frames[i + d]) return frames[i + d];
    }
    return null;
  }

  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // easeInOutCubic

  function attach(root) {
    const stage = root.querySelector('[data-cc-stage]');
    const canvas = root.querySelector('canvas');
    const button = root.querySelector('[data-cc-button]');
    const label = root.querySelector('[data-cc-label]');
    if (!stage || !canvas) return;
    const ctx = canvas.getContext('2d');

    let open = false;      // the state the doors are heading to
    let t = 0;             // 0 = closed .. 1 = open, linear in time
    let raf = 0, last = 0;
    let set = null;

    const pickSet = () => (stage.getBoundingClientRect().width * (window.devicePixelRatio || 1) > 520 ? 'd' : 'm');
    function prepare() { if (!set) set = loadSet(pickSet()); return set; }

    function setUi() {
      const text = open ? 'Close doors' : 'Open doors';
      const aria = open ? "Close the Cybercab's doors" : "Open the Cybercab's doors";
      for (const el of [stage, button]) {
        if (!el) continue;
        el.setAttribute('aria-expanded', String(open));
        el.setAttribute('aria-label', aria);
      }
      if (label) label.textContent = text;
      root.classList.toggle('is-open', open);
    }

    function draw() {
      const frames = set && set.frames;
      if (!frames) return;
      const pos = ease(t) * (FRAMES - 1);
      const a = Math.floor(pos), mix = pos - a;
      const imgA = nearest(frames, a);
      if (!imgA) return;
      if (canvas.width !== imgA.naturalWidth) { canvas.width = imgA.naturalWidth; canvas.height = imgA.naturalHeight; }
      ctx.globalAlpha = 1;
      ctx.drawImage(imgA, 0, 0, canvas.width, canvas.height);
      const imgB = mix > 0.001 ? frames[a + 1] : null;
      if (imgB) { ctx.globalAlpha = mix; ctx.drawImage(imgB, 0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; }
      root.classList.add('is-live');   // the canvas now covers the still image
    }

    function step(now) {
      raf = 0;
      const dt = last ? Math.min(64, now - last) : 16.7;
      last = now;
      const goal = open ? 1 : 0;
      t = goal > t ? Math.min(goal, t + dt / DURATION_MS) : Math.max(goal, t - dt / DURATION_MS);
      draw();
      if (t !== goal) raf = requestAnimationFrame(step);
      else { last = 0; root.classList.remove('is-moving'); }
    }

    async function toggle() {
      open = !open;
      setUi();
      const s = prepare();
      if (reduce.matches) {          // no animation: straight to the end frame
        await s.ready;
        t = open ? 1 : 0;
        draw();
        return;
      }
      root.classList.add('is-moving');
      if (!s.frames.every(Boolean)) {
        root.classList.add('is-loading');
        await s.ready;
        root.classList.remove('is-loading');
      }
      if (!raf) { last = 0; raf = requestAnimationFrame(step); }
    }

    // Preload on the first sign of intent, so the first click plays at once.
    const intent = () => prepare();
    for (const ev of ['pointerenter', 'focusin', 'touchstart', 'pointerdown']) root.addEventListener(ev, intent, { once: true, passive: true });

    // A person's tap or key: stops the autoplay loop, then toggles.
    let manual = false;
    const userToggle = () => { manual = true; toggle(); };
    stage.addEventListener('click', userToggle);
    stage.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); userToggle(); }
    });
    if (button) button.addEventListener('click', userToggle);
    setUi();

    if (root.hasAttribute('data-cc-autoplay') && 'IntersectionObserver' in window) {
      const HOLD_MS = 1800;
      let visible = false, timer = 0;
      const schedule = () => {
        clearTimeout(timer);
        if (!visible || manual || reduce.matches) return;
        timer = setTimeout(async () => {
          if (!visible || manual || reduce.matches) return;
          await prepare().ready;
          if (!visible || manual) return;
          await toggle();
          timer = setTimeout(schedule, DURATION_MS);   // hold after the swing ends
        }, HOLD_MS);
      };
      new IntersectionObserver(entries => {
        visible = entries.some(e => e.isIntersecting && e.intersectionRatio >= 0.4);
        if (visible) { prepare(); schedule(); } else clearTimeout(timer);
      }, { threshold: [0, 0.4] }).observe(stage);
    }
  }

  document.querySelectorAll('[data-cc-doors]').forEach(attach);
  window.CCCCybercabDoors = { FRAMES, DURATION_MS };
})();
