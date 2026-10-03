/* Cybercab Hunter: the homepage hero animation (index.html #heroVideo).

   The <video> starts as its poster (the film's first frame) and loads
   nothing until it is played (preload="none"). It plays once, muted, while
   the hero is on screen: it pauses if the hero scrolls away or the tab is
   hidden, resumes when it is back, and stays on its last frame when it ends.
   With reduced motion or Save-Data it stays on the poster. */
(function () {
  var video = document.getElementById('heroVideo');
  if (!video) return;

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var saveData = !!(navigator.connection && navigator.connection.saveData);
  if (reduceMotion || saveData) return;

  var onScreen = true;
  function sync() {
    if (video.ended) return;                       // played once: keep the last frame
    if (onScreen && !document.hidden) {
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay refused: the poster stays */ });
    } else if (!video.paused) {
      video.pause();
    }
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      sync();
    }, { threshold: 0.15 }).observe(video);
  }
  document.addEventListener('visibilitychange', sync);
  sync();
})();
