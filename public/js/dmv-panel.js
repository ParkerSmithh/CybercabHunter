/* "Texas DMV registrations · Tesla" panel (any element with [data-dmv-panel]:
   the homepage and the Cars page). Data: GET /api/dmv-registrations
   (worker/txdmv.js) — the daily D1 snapshots of TxDMV's public automated-
   vehicle roster, never TxDMV itself.
     Registered AV fleet  the latest snapshot's VIN count, "polled Xm ago"
     Last 30 days         VINs first listed in the window after the first
                          snapshot (the source publishes no registration
                          dates, so the history starts when polling began)
     Matched to tracked plates  roster VINs equal to a public registry VIN
     Cybercab / Model Y   TxDMV's own model field, share, new in 30 days
     Chart                cumulative Cybercab + Model Y, stacked, one point
                          per daily snapshot, All / 90d / 30d / 7d
   A number is only ever one the server sent; no snapshot yet -> a short note. */
(function () {
  const els = [...document.querySelectorAll('[data-dmv-panel]')];
  if (!els.length) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GOLD = '#D4AF37', RED = '#ef4444';
  const RANGES = { All: Infinity, '90d': 90, '30d': 30, '7d': 7 };
  const int = n => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const centralTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function ago(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(m)) return '—';
    if (m < 60) return `${Math.max(1, m)}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  }
  let data = null, range = 'All';

  // Drawn at the box's real width (so the labels stay readable on phones).
  function chart(series, boxW) {
    const w = Math.max(280, Math.round(boxW || 640)), h = w < 480 ? 170 : 200, padL = 34, padR = 12, padT = 12, padB = 22;
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = RANGES[range] === Infinity ? null : new Date(Date.now() - RANGES[range] * 864e5).toISOString().slice(0, 10);
    // Points in the window, plus the last snapshot before it (the count held then).
    const before = cutoff ? series.filter(p => p.date < cutoff) : [];
    let pts = series.filter(p => !cutoff || p.date >= cutoff);
    if (before.length) pts = [{ ...before[before.length - 1], date: cutoff, held: true }, ...pts];
    if (!pts.length) return `<p class="text-xs text-slate-500 py-8 text-center">No snapshots in this window.</p>`;
    const start = Date.parse(`${pts[0].date}T00:00:00Z`), end = Math.max(Date.parse(`${today}T23:59:59Z`), start + 864e5);
    const maxY = Math.max(1, ...pts.map(p => p.cybercab + p.model_y));
    // A snapshot's step starts at the beginning of its day.
    const x = d => padL + ((Date.parse(`${d}T00:00:00Z`) - start) / (end - start)) * (w - padL - padR);
    const y = v => padT + (h - padT - padB) * (1 - v / maxY);
    const xEnd = w - padR, base = y(0);
    // Step paths: the value holds until the next snapshot, then steps.
    const step = key => { let d = `M ${x(pts[0].date)} ${y(key(pts[0]))}`; for (let i = 1; i < pts.length; i++) d += ` L ${x(pts[i].date)} ${y(key(pts[i - 1]))} L ${x(pts[i].date)} ${y(key(pts[i]))}`; return d + ` L ${xEnd} ${y(key(pts[pts.length - 1]))}`; };
    const area = (topKey, bottomKey) => {
      const top = step(topKey);
      let back = `L ${xEnd} ${y(bottomKey(pts[pts.length - 1]))}`;
      for (let i = pts.length - 1; i >= 1; i--) back += ` L ${x(pts[i].date)} ${y(bottomKey(pts[i]))} L ${x(pts[i].date)} ${y(bottomKey(pts[i - 1]))}`;
      return `${top} ${back} L ${x(pts[0].date)} ${y(bottomKey(pts[0]))} Z`;
    };
    const cyb = p => p.cybercab, tot = p => p.cybercab + p.model_y, zero = () => 0;
    const ticks = [0, Math.round(maxY / 2), maxY];
    const dots = pts.filter(p => !p.held).map(p => `<circle cx="${x(p.date).toFixed(1)}" cy="${y(tot(p)).toFixed(1)}" r="2.5" fill="${RED}"><title>${esc(longDate(p.date))}: ${int(p.cybercab + p.model_y)} (${int(p.cybercab)} Cybercab, ${int(p.model_y)} Model Y)</title></circle>`).join('');
    const label = (tx, ty, t, a = 'end') => `<text x="${tx}" y="${ty}" text-anchor="${a}" font-size="10" style="fill:rgb(var(--n-500));font-family:'Inter',sans-serif;font-variant-numeric:tabular-nums">${esc(t)}</text>`;
    return `<svg viewBox="0 0 ${w} ${h}" class="w-full h-auto block" role="img" aria-label="${esc(`Registered Tesla automated vehicles in Texas over time: ${int(tot(pts[pts.length - 1]))} on ${longDate(pts[pts.length - 1].date)}`)}">
      ${ticks.map(t => `<line x1="${padL}" x2="${xEnd}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" style="stroke:rgb(var(--ink) / 0.07)" ${t ? 'stroke-dasharray="2 4"' : ''}/>${label(padL - 6, y(t) + 3, int(t))}`).join('')}
      <path d="${area(tot, cyb)}" fill="${RED}" fill-opacity="0.28"/>
      <path d="${area(cyb, zero)}" fill="${GOLD}" fill-opacity="0.32"/>
      <path d="${step(tot)}" fill="none" stroke="${RED}" stroke-width="1.75"/>
      <path d="${step(cyb)}" fill="none" stroke="${GOLD}" stroke-width="1.75"/>
      ${dots}
      ${label(padL, h - 6, shortDate(pts[0].date), 'start')}${label(xEnd, h - 6, 'Today')}
    </svg>`;
  }

  function render() {
    els.forEach(el => {
      const d = data;
      const head = `<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div class="min-w-0"><h2 class="font-display font-bold text-xl text-white tracking-tight max-sm:text-lg">Texas DMV registrations · Tesla</h2>
          <p class="text-xs text-slate-500 mt-0.5">Every automated vehicle Tesla lists with the state</p></div>
          <div class="flex items-center gap-3 max-sm:w-full max-sm:justify-between">
            <div class="flex items-center gap-1" role="group" aria-label="Time range">${Object.keys(RANGES).map(r => `<button type="button" data-dmv-range="${r}" aria-pressed="${r === range}" class="text-xs font-semibold px-2 py-1 rounded-md max-sm:min-h-[44px] max-sm:min-w-[40px] ${r === range ? 'text-white bg-white/[0.08]' : 'text-slate-400 hover:text-slate-200'}">${r}</button>`).join('')}</div>
            <a href="/dmv" class="inline-flex items-center gap-1 min-h-[44px] text-sm font-semibold text-gold hover:underline max-sm:text-xs">Every VIN<span aria-hidden="true">→</span></a>
          </div>
        </div>`;
      if (!d) { el.innerHTML = head + `<div class="mt-4 h-40 rounded-xl bg-white/[0.03] animate-pulse"></div>`; return; }
      if (!d.snapshot) {
        el.innerHTML = head + `<p class="mt-4 text-sm text-slate-400">The first daily TxDMV snapshot hasn't been taken yet. It runs each morning (Central).</p>`;
        return;
      }
      const s = d.snapshot, n = d.new || {}, m = d.matched || {};
      const windowStart = new Date(Date.parse(`${s.date}T12:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);
      const partial = d.tracking_since > windowStart;   // fewer than 30 days of history
      const stat = (label, value, sub, color = 'text-white') => `<div class="min-w-0"><div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 max-sm:text-[10px]">${esc(label)}</div>
        <div class="stat-value font-semibold text-3xl leading-tight mt-1 ${color} max-sm:text-2xl">${value}</div><div class="text-[11px] text-slate-500 mt-0.5 max-sm:text-[10px]">${sub}</div></div>`;
      const row = (color, name, count, newN) => `<div class="flex items-center gap-2.5 text-sm py-1.5 border-t border-white/[0.06] max-sm:text-xs">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span><span class="font-semibold text-slate-100">${esc(name)}</span>
        <span class="stat-value text-white ml-auto">${int(count)}</span><span class="stat-value text-slate-400 w-10 text-right">${pct(count, s.total)}</span>
        <span class="stat-value text-emerald-400 w-28 text-right max-sm:w-24">+${int(newN)} ${partial ? 'since tracking' : 'in 30 days'}</span></div>`;
      const failed = d.last_attempt && !d.last_attempt.ok && Date.parse(d.last_attempt.at) > Date.parse(s.polled_at);
      el.innerHTML = head + `
        <div class="mt-4 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] max-sm:mt-3 max-sm:gap-3">
          <div class="min-w-0">
            <div class="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-4 max-sm:gap-2">
              ${stat('Registered AV fleet', int(s.total), `by VIN · polled ${esc(ago(s.polled_at))}`, 'text-sky-400')}
              ${stat(partial ? 'Since tracking began' : 'Last 30 days', `+${int(n.d30)}`, partial ? `Tracking since ${esc(shortDate(d.tracking_since))}` : `+${int(n.d7)} in the last 7 days`, 'text-emerald-400')}
              ${stat('Matched to tracked plates', int(m.count), `${int(m.spotted_30d)} spotted in the last 30 days`)}
            </div>
            <div class="mt-4 max-sm:mt-3">${row(GOLD, 'Cybercab', s.cybercab, n.cybercab_30d)}${row(RED, 'Model Y', s.model_y, n.model_y_30d)}</div>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-4 mb-1 text-[11px] text-slate-400"><span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${GOLD}"></span>Cybercab</span><span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${RED}"></span>Model Y</span><span class="ml-auto max-sm:hidden">Cumulative, one point per daily snapshot</span></div>
            <div data-dmv-chart></div>
          </div>
        </div>
        <p class="mt-4 text-[11px] text-slate-500 leading-relaxed max-sm:mt-3 max-sm:text-[10px]">Polled daily from the TxDMV Motor Carrier Credentialing System (TxMCCS): every VIN ${esc(d.source.company)} lists under its SB 2807 automated-vehicle authorization ${esc(d.source.authorization)}. Last polled ${esc(centralTime(s.polled_at))} CT. TxDMV publishes no registration dates, so “new” counts VINs that first appeared after Cybercab Hunter began polling on ${esc(longDate(d.tracking_since))}.${failed ? ` <span class="text-amber-300">The latest check (${esc(centralTime(d.last_attempt.at))} CT) couldn't reach TxDMV; showing the last good poll.</span>` : ''}</p>`;
      const box = el.querySelector('[data-dmv-chart]');
      if (box) box.innerHTML = chart(d.series, box.clientWidth);
    });
  }
  // Redraw at the new width when the panel is resized.
  if (window.ResizeObserver) {
    let queued = false;
    const ro = new ResizeObserver(() => { if (queued || !data || !data.snapshot) return; queued = true; requestAnimationFrame(() => { queued = false; els.forEach(el => { const box = el.querySelector('[data-dmv-chart]'); if (box && box.clientWidth) box.innerHTML = chart(data.series, box.clientWidth); }); }); });
    els.forEach(el => ro.observe(el));
  }

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-dmv-range]');
    if (!b || !data || !data.snapshot) return;
    range = b.dataset.dmvRange;
    render();
  });
  render();
  fetch('/api/dmv-registrations').then(r => (r.ok ? r.json() : null)).catch(() => null).then(d => {
    if (d) { data = d; render(); }
    else els.forEach(el => { el.innerHTML = `<p class="text-sm text-slate-400">Couldn't load the TxDMV registrations right now.</p>`; });
  });
  // "polled Xm ago" keeps counting.
  setInterval(() => { if (data && data.snapshot && !document.hidden) render(); }, 60 * 1000);
})();
