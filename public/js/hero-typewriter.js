/* Reveal the hero sentence once, keeping its full layout and accessible text. */
(function () {
  const el = document.getElementById('heroTypewriter');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!el || motion.matches) return;
  const sentence = el.textContent;
  const letters = Array.from(sentence);
  const measure = document.createElement('span');
  measure.className = 'typewriter-measure';
  measure.setAttribute('aria-hidden', 'true');
  measure.textContent = sentence;
  const accessible = document.createElement('span');
  accessible.className = 'sr-only';
  accessible.textContent = sentence;
  const ink = document.createElement('span');
  ink.className = 'typewriter-ink';
  ink.setAttribute('aria-hidden', 'true');
  el.replaceChildren(measure, accessible, ink);
  el.classList.add('is-typing');
  let frame, start;
  function finish() {
    cancelAnimationFrame(frame);
    el.textContent = sentence;
    el.classList.remove('is-typing');
    motion.removeEventListener('change', onMotion);
  }
  function onMotion(e) { if (e.matches) finish(); }
  motion.addEventListener('change', onMotion);
  function type(now) {
    if (start === undefined) start = now;
    const n = Math.max(0, Math.floor((now - start - 400) / 24));
    if (n >= letters.length) { finish(); return; }
    ink.textContent = letters.slice(0, n).join('');
    frame = requestAnimationFrame(type);
  }
  frame = requestAnimationFrame(type);
})();
