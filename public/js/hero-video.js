/* Cybercab Hunter: the homepage hero animation (index.html #hero).

   1. On load the film (#heroVideo) plays once, muted, while the hero is on
      screen (it pauses if the hero scrolls away or the tab is hidden, and
      resumes when it is back).
   2. When it ends, the hero switches to scroll-driven frames: #heroFrames
      (a canvas in the video's place) draws one of FRAME_COUNT stills from
      the film's first 3 seconds (images/hero-frames/, 1600px wide on large
      screens, 960px on small ones). The hero is pinned under the header for
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

  var FRAME_COUNT = 37;
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
        img.onload = function () { frames[i] = img; if (scrollMode) requestDraw(); };
        img.src = 'images/hero-frames/' + dir + '/' + (i < 10 ? '0' : '') + i + '.jpg';
      })(i);
    }
  }

  var scrollMode = false;
  var shown = 0;          // frame position on screen (eases toward target)
  var drawn = -1;
  var raf = 0;

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

  function draw() {
    raf = 0;
    var t = target();
    shown += (t - shown) * 0.35;
    if (Math.abs(t - shown) < 0.02) shown = t;
    var i = Math.round(shown);
    var img = nearestLoaded(i);
    if (img && (i !== drawn || !canvas.dataset.ready)) {
      if (canvas.width !== img.naturalWidth) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; }
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      drawn = frames[i] ? i : -1;
      if (!canvas.dataset.ready) {
        canvas.dataset.ready = '1';
        canvas.classList.remove('hidden');
        video.classList.add('hidden');
      }
    }
    // Keep easing; or wait for the exact frame while frames are still arriving
    // (each arrival also asks for a redraw).
    if (shown !== t) raf = requestAnimationFrame(draw);
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
