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
   when the tab comes back.
   LAYOUT: the status and countdown | the service day on a 24-hour track
   (window, the part already run, now, the Austin clock) | the Cybercab. */
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
  // The service day on a 24-hour track: the open window, the part already
  // run (live only), and now. Positions are % of the day in Chicago.
  const pctOf = minute => `${((minute / 1440) * 100).toFixed(3)}%`;
  function day(now) {
    const p = parts(now), minute = p.h * 60 + p.mi;
    return { minute, label: clock(minute) };
  }
  function paintDay(s, d) {
    const run = el.querySelector('[data-sb-run]'), mark = el.querySelector('[data-sb-now]'), lab = el.querySelector('[data-sb-clock]');
    // The run is a share of the open window (the element it sits in).
    if (run) run.style.width = s.live ? `${(Math.min(1, Math.max(0, (d.minute - H.openMinute) / (H.closeMinute - H.openMinute))) * 100).toFixed(2)}%` : '0%';
    if (mark) mark.style.left = pctOf(d.minute);
    if (lab) lab.textContent = d.label;
  }
  let shown = null;
  function render() {
    const now = Date.now(), s = state(now), d = day(now);
    const cd = countdown(s.ms);
    if (shown && shown.live === s.live) {
      // Only the countdown, the clock and the marker change: in place (no layout shift).
      el.querySelector('[data-countdown]').textContent = cd;
      paintDay(s, d);
      return;
    }
    shown = s;
    el.dataset.state = s.live ? 'live' : 'parked';
    const main = s.live
      ? `<p class="sb-eyebrow text-emerald-300"><span class="relative flex w-2.5 h-2.5 shrink-0" aria-hidden="true"><span class="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping motion-reduce:animate-none"></span><span class="relative w-2.5 h-2.5 rounded-full bg-emerald-400"></span></span>Live now<span class="max-sm:hidden"> · Austin &amp; Dallas</span></p>
         <p class="sb-headline font-display font-bold text-white uppercase tracking-wide">Cybercabs are on the road now</p>
         <p class="sb-line text-gold font-semibold whitespace-nowrap">Service ends in <span data-countdown class="stat-value inline-block min-w-[6.5ch] tabular-nums">${cd}</span></p>`
      : `<p class="sb-eyebrow text-sky-300/80">${MOON}Parked<span class="max-sm:hidden"> · Austin &amp; Dallas</span></p>
         <p class="sb-headline font-display font-bold text-slate-200">The fleet is parked for the night</p>
         <p class="sb-line text-slate-400">Back on the road at ${clock(H.openMinute)} · Back in <span data-countdown class="stat-value inline-block min-w-[6.5ch] tabular-nums text-sky-200">${cd}</span></p>`;
    el.innerHTML = `<div class="sb-main">${main}</div>
      <div class="sb-day">
        <div class="flex items-baseline justify-between gap-3 text-xs"><span class="text-slate-400">Service day · <span class="stat-value text-slate-200">${clock(H.openMinute)} – ${clock(H.closeMinute)}</span></span><span class="text-slate-500">Now <span data-sb-clock class="stat-value text-slate-200">${d.label}</span></span></div>
        <div class="sb-track" aria-hidden="true">
          <span class="sb-window" style="left:${pctOf(H.openMinute)};width:${pctOf(H.closeMinute - H.openMinute)}"><span data-sb-run class="sb-run"></span></span>
          <span data-sb-now class="sb-now"></span>
        </div>
        <div class="flex justify-between text-[10px] text-slate-500 stat-value" aria-hidden="true"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
        <p class="sb-meta text-[11px] text-slate-500">All times Austin time (CT) · every day</p>
      </div>
      <div class="sb-car" aria-hidden="true"><span class="sb-road"></span><img src="images/dmv-cybercab.webp" alt="" decoding="async"></div>`;
    paintDay(s, d);
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
