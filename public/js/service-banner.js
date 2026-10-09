/* Homepage service-status banner (index.html #serviceBanner), just below the
   stats bar. Pure client-side: no request.
   HOURS: js/calc.js SERVICE_HOURS — 6:00 AM to 11:00 PM, America/Chicago,
   every day, for Austin and Dallas alike (the one place to change them).
   STATE: from the visitor's clock read in America/Chicago (Intl), never the
   visitor's own time zone. Open from openMinute:00 (6:00:00 → live) up to
   but not including closeMinute:00 (23:00:00 → parked).
     live    green pulsing dot · "Cybercabs are on the road now" ·
             "Service ends in Xh Ym"
     parked  moon, cooler tone · "The fleet is parked for the night" ·
             "Back on the road at 6:00 AM" · "Back in Xh Ym" (on a phone the
             "All times Austin time (CT)" line folds into "6:00 AM CT", so the
             strip stays at two lines)
   COUNTDOWN: whole minutes, rounded UP (so it never shows 0m while running and
   never goes negative), "Xh Ym", or "Ym" under an hour. Measured in real time
   to the next opening / closing instant in Chicago, so a daylight-saving night
   counts its real 23 or 25 hours. Ticks on each minute boundary, and at once
   when the tab comes back. */
(function () {
  const el = document.getElementById('serviceBanner');
  const C = typeof CCC_CALC !== 'undefined' ? CCC_CALC : null;   // js/calc.js (a top-level const, not a window property)
  if (!el || !C || !C.SERVICE_HOURS) return;
  const H = C.SERVICE_HOURS;
  const ZONE = H.timeZone;

  // Wall-clock parts in the service zone.
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function parts(ms) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
    return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
  }
  // The zone's UTC offset at an instant, in ms (e.g. -5 h in CDT).
  function offset(ms) {
    const p = parts(ms);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }
  // The real instant of wall-clock minute `minuteOfDay` in the zone, `addDays`
  // days after the zone date of `ms`.
  function instantOf(ms, minuteOfDay, addDays) {
    const p = parts(ms);
    const wall = Date.UTC(p.y, p.mo - 1, p.d + addDays, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
    let t = wall - offset(ms);
    t = wall - offset(t);   // settle across a daylight-saving change
    return t;
  }

  // { live, ms (until the change), label } at instant `now`.
  function state(now) {
    const p = parts(now);
    const sec = (p.h * 60 + p.mi) * 60 + p.s;
    const open = H.openMinute * 60, close = H.closeMinute * 60;
    const live = sec >= open && sec < close;
    const target = live ? instantOf(now, H.closeMinute, 0) : instantOf(now, H.openMinute, sec >= close ? 1 : 0);
    return { live, ms: Math.max(0, target - now) };
  }
  // "Xh Ym" / "Ym", whole minutes rounded up; never negative.
  function countdown(ms) {
    const mins = Math.max(1, Math.ceil(ms / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  const clock = minute => `${((Math.floor(minute / 60) + 11) % 12) + 1}:${String(minute % 60).padStart(2, '0')} ${minute < 720 ? 'AM' : 'PM'}`;

  const MOON = '<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/></svg>';
  let shown = null;
  function render() {
    const s = state(Date.now());
    const cd = countdown(s.ms);
    if (shown && shown.live === s.live) {
      // Only the countdown changes: update it in place (no layout shift).
      el.querySelector('[data-countdown]').textContent = cd;
      return;
    }
    shown = s;
    el.dataset.state = s.live ? 'live' : 'parked';
    el.innerHTML = s.live
      ? `<span class="relative flex w-2.5 h-2.5 shrink-0" aria-hidden="true"><span class="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping motion-reduce:animate-none"></span><span class="relative w-2.5 h-2.5 rounded-full bg-emerald-400"></span></span>
         <span class="font-semibold text-white uppercase tracking-wide">Cybercabs are on the road now</span>
         <span class="sb-line text-gold font-semibold whitespace-nowrap">Service ends in <span data-countdown class="stat-value inline-block min-w-[6.5ch] tabular-nums">${cd}</span></span>
         <span class="sb-meta text-slate-500"><span class="max-sm:hidden">${clock(H.openMinute)} – ${clock(H.closeMinute)} · </span><span class="sb-all">All times </span>Austin time (CT)</span>`
      : `<span class="text-sky-300/80">${MOON}</span>
         <span class="font-semibold text-slate-300">The fleet is parked for the night</span>
         <span class="sb-line text-slate-400 whitespace-nowrap">Back on the road at ${clock(H.openMinute)}<span class="sm:hidden"> CT</span> · Back in <span data-countdown class="stat-value inline-block min-w-[6.5ch] tabular-nums text-sky-200">${cd}</span></span>
         <span class="sb-meta text-slate-500 max-sm:hidden">All times Austin time (CT)</span>`;
  }

  // Tick on each minute boundary (the countdown changes then), and on return.
  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { render(); schedule(); }, 60000 - (Date.now() % 60000) + 50);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); schedule(); } });
  render();
  schedule();
  window.CCHServiceBanner = { state, countdown };
})();
