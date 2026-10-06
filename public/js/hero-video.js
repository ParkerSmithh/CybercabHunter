/* Cybercab Hunter: the homepage hero animation (index.html #hero).

   1. On load the film (#heroVideo) plays once, muted, while the hero is on
      screen (it pauses if the hero scrolls away or the tab is hidden, and
      resumes when it is back).
   2. When it ends, the hero switches to scroll-driven frames: #heroFrames
      (a canvas in the video's place) draws the film's first 3 seconds from
      FRAME_COUNT stills, every frame of the 24 fps film (images/hero-frames/,
      1600px wide on large screens, 960px on small ones). Between two stills
      it crossfades by the exact scroll position, and eases toward it on a
      clock rather than per frame, so motion is continuous at any refresh
      rate (60, 120 Hz) instead of stepping from still to still. The hero is pinned under the header for
      the height of #heroPinSpacer; scrolling down through it opens the
      doors, scrolling back up closes them. Frame 0 is the film's opening
      pose, which is also its closing pose, so the hand-off is seamless.
   With reduced motion or Save-Data nothing moves: the poster stays and the
   pin spacer is removed (CSS motion-reduce hides it for reduced motion). */
(function () {
  var video = document.getElementById('heroVideo');
  var canvas = document.getElementById('heroFrames');
  var pin = document.getElementById('heroPin');
  var spacer = document.getElementById('heroPinSpacer');
  if (!video || !canvas || !pin || !spacer) return;

  var FRAME_COUNT = 73;
  var EASE_MS = 45;      // time constant of the ease toward the scroll position
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  if (reduceMotion || saveData) { spacer.remove(); return; }

  // ---- 1. the film, once
  var onScreen = true;
  function syncVideo() {
    if (video.ended || scrollMode) return;
    if (onScreen && !document.hidden) {
      var p = video.play();
      if (p && p.catch) p.catch(function () { startScrollMode(); });   // autoplay refused: go straight to frames
    } else if (!video.paused) {
      video.pause();
    }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      syncVideo();
    }, { threshold: 0.15 }).observe(video);
  }
  document.addEventListener('visibilitychange', syncVideo);
  video.addEventListener('ended', function () { startScrollMode(); });
  video.addEventListener('error', function () { startScrollMode(); }, true);
  // Frames load once the film has buffered (or ended), so they never compete with it.
  video.addEventListener('canplaythrough', loadFrames, { once: true });

  // ---- 2. scroll-driven frames
  var frames = [];
  var loading = false;
  function loadFrames() {
    if (loading) return;
    loading = true;
    var dir = window.matchMedia('(min-width: 1024px)').matches ? 'd' : 'm';
    for (var i = 0; i < FRAME_COUNT; i++) {
      (function (i) {
        var img = new Image();
        img.decoding = 'async';
        // Decoded before first use, so drawing it never stalls a frame.
        img.onload = function () {
          var ready = function () { frames[i] = img; if (scrollMode) requestDraw(); };
          if (img.decode) img.decode().then(ready, ready); else ready();
        };
        img.src = 'images/hero-frames/' + dir + '/' + (i < 10 ? '0' : '') + i + '.jpg';
      })(i);
    }
  }

  var scrollMode = false;
  var shown = 0;          // frame position on screen, fractional (eases toward target)
  var drawn = -1;         // the position last painted (-1: repaint)
  var raf = 0;
  var lastTime = 0;

  function target() {
    var range = spacer.offsetHeight;
    if (!range) return 0;
    var header = document.querySelector('header');
    var top = header ? header.offsetHeight : 0;
    var passed = top - pin.getBoundingClientRect().top;      // px scrolled into the pin
    return Math.max(0, Math.min(1, passed / range)) * (FRAME_COUNT - 1);
  }

  // Nearest frame that has loaded (they arrive out of order).
  function nearestLoaded(i) {
    for (var d = 0; d < FRAME_COUNT; d++) {
      if (frames[i - d]) return frames[i - d];
      if (frames[i + d]) return frames[i + d];
    }
    return null;
  }

  function draw(now) {
    raf = 0;
    var t = target();
    // Exponential ease measured in milliseconds, so 60 Hz and 120 Hz screens
    // follow the scroll at the same speed (just with more steps).
    var dt = lastTime ? Math.min(64, now - lastTime) : 16.7;
    lastTime = now;
    shown += (t - shown) * (1 - Math.exp(-dt / EASE_MS));
    if (Math.abs(t - shown) < 0.002) shown = t;

    var a = Math.floor(shown), mix = shown - a;
    var imgA = nearestLoaded(a);
    var imgB = mix > 0.001 ? frames[a + 1] : null;
    var exact = !!frames[a] && (mix <= 0.001 || !!imgB);
    if (imgA && (Math.abs(shown - drawn) > 0.0005 || !canvas.dataset.ready)) {
      if (canvas.width !== imgA.naturalWidth) { canvas.width = imgA.naturalWidth; canvas.height = imgA.naturalHeight; }
      var ctx = canvas.getContext('2d');
      ctx.globalAlpha = 1;
      ctx.drawImage(imgA, 0, 0, canvas.width, canvas.height);
      if (imgB) {                       // crossfade into the next still
        ctx.globalAlpha = mix;
        ctx.drawImage(imgB, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      }
      drawn = exact ? shown : -1;
      if (!canvas.dataset.ready) {
        canvas.dataset.ready = '1';
        canvas.classList.remove('hidden');
        video.classList.add('hidden');
      }
    }
    // Keep easing; or wait for the exact frames while they are still arriving
    // (each arrival also asks for a redraw).
    if (shown !== t) raf = requestAnimationFrame(draw);
    else lastTime = 0;
  }
  function requestDraw() { if (!raf) raf = requestAnimationFrame(draw); }

  function startScrollMode() {
    if (scrollMode) return;
    scrollMode = true;
    loadFrames();
    shown = 0;                       // the film ended on the opening pose
    window.addEventListener('scroll', requestDraw, { passive: true });
    window.addEventListener('resize', requestDraw);
    requestDraw();
  }

  syncVideo();
})();
