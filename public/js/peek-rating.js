/* PeekRating: a vanilla port of React Bits' <PeekRating /> (the site has no
   React build). A radiogroup of glyphs: the glyph under the pointer lifts and
   magnifies, a tip follows the pointer with that glyph's label, and a
   committed glyph pops. Keyboard: arrows step, Home/End jump, Space/Enter
   commit the focused glyph, Backspace/Delete clear (allowClear).
   Motion is CSS only (css/style.css .peek-rating), so prefers-reduced-motion
   turns it off there.

     const r = PeekRating.create(el, { labels, onChange, allowClear: true });
     r.value; r.setValue(3); r.setValue(0, { silent: true });            */
const PeekRating = (() => {
  const SHAPES = {
    star: '<path d="M12 2.75l2.86 5.8 6.4.93-4.63 4.51 1.09 6.37L12 17.36l-5.72 3 1.09-6.37-4.63-4.51 6.4-.93L12 2.75z"/>',
    heart: '<path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.9 3.7 4.5 7.1 4.5c2 0 3.4 1.1 4.9 2.9 1.5-1.8 2.9-2.9 4.9-2.9 3.4 0 5.5 3.4 4.3 6.7-1.7 4.7-9.2 9.3-9.2 9.3z"/>',
    bolt: '<path d="M13.5 2.5L4.5 13.5h6.5l-1.5 8 9-11h-6.5l1.5-8z"/>'
  };

  const focusVisible = el => { try { return el.matches(':focus-visible'); } catch (e) { return false; } };

  function create(root, {
    value: initial, defaultValue = 0, onChange, onPreview,
    count = 5, shape = 'star', labels = null,
    activeColor, idleColor, tipColor, tipTextColor,
    size, lift, magnify, riseDuration, popScale,
    showTip = true, allowClear = true, readOnly = false, disabled = false,
    ariaLabel, className
  } = {}) {
    let value = clamp(initial != null ? initial : defaultValue);
    let preview = 0;
    const inert = readOnly || disabled;
    const labelOf = i => (labels && labels[i - 1]) || '';

    function clamp(n) { n = Math.round(Number(n) || 0); return Math.max(0, Math.min(count, n)); }

    root.classList.add('peek-rating');
    if (className) root.classList.add(...className.split(/\s+/).filter(Boolean));
    root.setAttribute('role', 'radiogroup');
    if (ariaLabel) root.setAttribute('aria-label', ariaLabel);
    if (readOnly) root.setAttribute('aria-readonly', 'true');
    if (disabled) root.setAttribute('aria-disabled', 'true');
    root.classList.toggle('is-readonly', readOnly);
    root.classList.toggle('is-disabled', disabled);
    const vars = {
      '--pr-active': activeColor, '--pr-idle': idleColor, '--pr-tip': tipColor, '--pr-tip-text': tipTextColor,
      '--pr-size': size != null ? `${size}px` : null, '--pr-lift': lift != null ? `${lift}px` : null,
      '--pr-magnify': magnify, '--pr-rise': riseDuration != null ? `${riseDuration}ms` : null, '--pr-pop': popScale
    };
    for (const [k, v] of Object.entries(vars)) if (v != null) root.style.setProperty(k, String(v));

    const svg = SHAPES[shape] || SHAPES.star;
    root.innerHTML = Array.from({ length: count }, (_, k) => {
      const i = k + 1, label = labelOf(i);
      const name = `${i} ${shape}${i === 1 ? '' : 's'}${label ? `, ${label}` : ''}`;
      return `<button type="button" role="radio" class="peek-rating__item" data-value="${i}" aria-label="${name}"${disabled ? ' disabled' : ''}>`
        + `<svg class="peek-rating__glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${svg}</svg></button>`;
    }).join('') + '<span class="peek-rating__tip" aria-hidden="true"></span>';
    const items = [...root.querySelectorAll('.peek-rating__item')];
    const tip = root.querySelector('.peek-rating__tip');

    function paint() {
      const shown = preview || value;
      items.forEach((b, k) => {
        const i = k + 1;
        b.classList.toggle('is-on', i <= shown);
        b.classList.toggle('is-peek', i === preview);
        b.setAttribute('aria-checked', String(i === value));
        // Roving tab stop: the checked glyph, or the first when nothing is.
        b.tabIndex = disabled ? -1 : (i === (value || 1) ? 0 : -1);
      });
    }

    // The tip sits at x (px from the group's left edge), kept inside the group.
    function showTipAt(i, x) {
      const text = labelOf(i);
      if (!showTip || !text || inert) { hideTip(); return; }
      tip.textContent = text;
      const half = tip.offsetWidth / 2, w = root.clientWidth;
      tip.style.left = `${w > half * 2 ? Math.max(half, Math.min(w - half, x)) : w / 2}px`;
      root.classList.add('is-tipping');
    }
    function hideTip() { root.classList.remove('is-tipping'); }
    const centerOf = b => b.offsetLeft + b.offsetWidth / 2;

    function setPreview(i) {
      if (i === preview) return;
      preview = i;
      paint();
      if (onPreview) onPreview(i);
    }

    function commit(i, { focus = false } = {}) {
      const next = clamp(i);
      if (focus && next) items[next - 1].focus();
      if (next === value) return;
      value = next;
      paint();
      if (next) {
        const b = items[next - 1];
        b.classList.remove('is-pop');
        void b.offsetWidth;                 // restart the pop when it runs twice in a row
        b.classList.add('is-pop');
      }
      if (onChange) onChange(value);
    }
    items.forEach(b => b.addEventListener('animationend', () => b.classList.remove('is-pop')));

    if (!inert) {
      root.addEventListener('pointermove', e => {
        const b = e.target.closest('.peek-rating__item');
        if (!b) return;
        setPreview(Number(b.dataset.value));
        showTipAt(preview, e.clientX - root.getBoundingClientRect().left);
      });
      root.addEventListener('pointerleave', () => { setPreview(0); hideTip(); });
      root.addEventListener('click', e => {
        const b = e.target.closest('.peek-rating__item');
        if (!b) return;
        const i = Number(b.dataset.value);
        // Clicking the current rating again clears it (allowClear).
        commit(allowClear && i === value ? 0 : i);
      });
      root.addEventListener('keydown', e => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(count, value + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, value - 1);
        else if (e.key === 'Home') next = 1;
        else if (e.key === 'End') next = count;
        else if ((e.key === 'Backspace' || e.key === 'Delete') && allowClear) next = 0;
        if (next == null) return;
        e.preventDefault();
        commit(next, { focus: true });
        if (next) showTipAt(next, centerOf(items[next - 1]));
        else hideTip();
      });
      // Keyboard focus shows the focused glyph's label; a pointer already has the tip.
      root.addEventListener('focusin', e => {
        const b = e.target.closest('.peek-rating__item');
        if (b && focusVisible(b)) showTipAt(Number(b.dataset.value), centerOf(b));
      });
      root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget) && !preview) hideTip(); });
    }

    paint();
    return {
      get value() { return value; },
      setValue(n, { silent = false } = {}) {
        const next = clamp(n);
        if (silent) { value = next; paint(); } else commit(next);
      }
    };
  }

  return { create, SHAPES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PeekRating;
