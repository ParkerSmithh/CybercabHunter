/* "Texas DMV registrations · Tesla" panel (any element with [data-dmv-panel]:
   the homepage and the Cars page). Data: GET /api/dmv-registrations
   (worker/txdmv.js) — the daily D1 snapshots of TxDMV's public automated-
   vehicle roster, never TxDMV itself. Before our first snapshot the series
   carries an imported, approximate history (worker/txdmv-history.js, credited
   to Robotaxi Tracker); those points come flagged `approx` and are drawn and
   labeled as such.
     Registered AV fleet  the latest snapshot's VIN count, "polled Xm ago"
     Last 30 days         new VINs (or, while the window reaches back before
                          tracking began, the change in the counts: approx.)
     Matched to tracked plates  roster VINs equal to a public registry VIN
     Chart                Cybercab and Model Y as their own step lines (not
                          stacked), the total dotted, daily additions as bars
                          below; All / 1W / 1M / 90D; hover for a day's counts
     Model cards          each model's count, share and 30-day additions, with
                          its picture (illustration only, never on the chart)
   A number is only ever one the server sent; no snapshot yet -> a short note. */
(function () {
  const els = [...document.querySelectorAll('[data-dmv-panel]')];
  if (!els.length) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GOLD = '#D4AF37', RED = '#ef4444';
  const RANGES = { All: Infinity, '1W': 7, '1M': 30, '90D': 90 };
  const DAY = 864e5;
  const int = n => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const centralTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
  function ago(iso) {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(m)) return '—';
    if (m < 60) return `${Math.max(1, m)}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  }
  let data = null, range = 'All';

  // The points in the selected window, plus the count that held at its start.
  function windowed(series) {
    const cutoff = RANGES[range] === Infinity ? null : isoDay(Date.now() - RANGES[range] * DAY);
    const before = cutoff ? series.filter(p => p.date < cutoff) : [];
    let pts = series.filter(p => !cutoff || p.date >= cutoff);
    if (before.length) pts = [{ ...before[before.length - 1], date: cutoff, held: true }, ...pts];
    return pts;
  }
  // A round step for the y axis (0, 250, 500, 750 for a fleet of ~700).
  function niceMax(v) {
    const raw = Math.max(4, v) / 3, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
    return { step, max: step * Math.ceil(v / step || 1) };
  }

  // Drawn at the box's real width (so the labels stay readable on phones).
  function chart(series, boxW, trackingSince) {
    const pts = windowed(series);
    if (!pts.length) return { svg: `<p class="text-xs text-slate-500 py-8 text-center">No snapshots in this window.</p>` };
    const w = Math.max(280, Math.round(boxW || 640)), narrow = w < 480;
    const padL = 34, padR = narrow ? 64 : 92, padT = 14, mainH = narrow ? 168 : 206, gap = 16, barsH = narrow ? 34 : 42, axisH = 20;
    const h = padT + mainH + gap + barsH + axisH;
    const today = isoDay(Date.now());
    const start = Date.parse(`${pts[0].date}T00:00:00Z`), end = Math.max(Date.parse(`${today}T23:59:59Z`), start + DAY);
    const plotW = w - padL - padR;
    const x = d => padL + ((Date.parse(`${d}T00:00:00Z`) - start) / (end - start)) * plotW;
    const xEnd = padL + plotW;
    const { step: yStep, max: maxY } = niceMax(Math.max(...pts.map(p => p.total)));
    const y = v => padT + mainH * (1 - v / maxY);
    const base = y(0);
    // Step lines: a count holds until the next snapshot changes it.
    const stepPath = key => { let d = `M ${x(pts[0].date).toFixed(1)} ${y(pts[0][key]).toFixed(1)}`; for (let i = 1; i < pts.length; i++) d += ` H ${x(pts[i].date).toFixed(1)} V ${y(pts[i][key]).toFixed(1)}`; return d + ` H ${xEnd.toFixed(1)}`; };
    const fillPath = key => `${stepPath(key)} V ${base.toFixed(1)} H ${x(pts[0].date).toFixed(1)} Z`;
    const label = (tx, ty, t, a = 'end', fill = 'rgb(var(--n-500))', weight = 400) => `<text x="${tx.toFixed ? tx.toFixed(1) : tx}" y="${ty.toFixed ? ty.toFixed(1) : ty}" text-anchor="${a}" font-size="10" font-weight="${weight}" style="fill:${fill};font-family:'Inter',sans-serif;font-variant-numeric:tabular-nums">${esc(t)}</text>`;
    // Grid.
    let grid = '';
    for (let v = 0; v <= maxY; v += yStep) grid += `<line x1="${padL}" x2="${xEnd.toFixed(1)}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" style="stroke:rgb(var(--ink) / ${v ? 0.06 : 0.14})"/>${label(padL - 6, y(v) + 3, int(v))}`;
    // Month ticks (or day ticks for a short window).
    let ticks = '';
    const spanDays = (end - start) / DAY;
    if (spanDays > 45) {
      const s = new Date(start); let m = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
      while (m.getTime() < end) { const tx = x(isoDay(m.getTime())); if (tx > padL + 14 && tx < xEnd - 34) ticks += `<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${padT}" y2="${h - axisH}" style="stroke:rgb(var(--ink) / 0.04)"/>${label(tx, h - 6, m.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), 'middle')}`; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)); }
    } else {
      ticks += label(padL, h - 6, shortDate(pts[0].date), 'start');
    }
    ticks += label(xEnd, h - 6, 'Today');
    // The imported stretch: hatched, with the start of our own polling marked.
    let imported = '';
    const firstOwn = pts.find(p => !p.approx);
    if (pts.some(p => p.approx)) {
      const x1 = firstOwn ? x(firstOwn.date) : xEnd;
      imported = `<rect x="${padL}" y="${padT}" width="${Math.max(0, x1 - padL).toFixed(1)}" height="${mainH}" fill="url(#dmvHatch)"/>`;
      if (firstOwn) imported += `<line x1="${x1.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${padT - 4}" y2="${(base).toFixed(1)}" stroke="${GOLD}" stroke-opacity="0.55" stroke-dasharray="3 3"/>`;
      if (!narrow && x1 - padL > 150) imported += label(padL + 8, padT + 12, 'Approx. history · Robotaxi Tracker', 'start', 'rgb(var(--n-500))');
    }
    if (firstOwn && x(firstOwn.date) < xEnd - 4) { const mx = x(firstOwn.date), right = mx + 100 < xEnd; imported += label(right ? mx + 5 : mx - 5, padT + 4, narrow ? 'TxDMV daily' : 'Daily TxDMV polls', right ? 'start' : 'end', GOLD, 600); }
    // Daily additions, as bars under the lines (Model Y below, Cybercab on top).
    const adds = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].held) continue;
      const c = Math.max(0, pts[i].cybercab - pts[i - 1].cybercab), m = Math.max(0, pts[i].model_y - pts[i - 1].model_y);
      if (c + m) adds.push({ date: pts[i].date, c, m });
    }
    const barsTop = padT + mainH + gap, maxAdd = Math.max(1, ...adds.map(a => a.c + a.m));
    const bw = Math.max(2, Math.min(10, (plotW / Math.max(1, spanDays)) * 0.7));
    const bh = v => (v / maxAdd) * barsH;
    const bars = adds.map(a => {
      const bx = x(a.date) - bw / 2, hm = bh(a.m), hc = bh(a.c);
      return `<rect x="${bx.toFixed(1)}" y="${(barsTop + barsH - hm).toFixed(1)}" width="${bw.toFixed(1)}" height="${hm.toFixed(1)}" rx="1" fill="${RED}" fill-opacity="0.85"/>`
        + (hc ? `<rect x="${bx.toFixed(1)}" y="${(barsTop + barsH - hm - hc).toFixed(1)}" width="${bw.toFixed(1)}" height="${hc.toFixed(1)}" rx="1" fill="${GOLD}" fill-opacity="0.9"/>` : '');
    }).join('');
    const barsAxis = `<line x1="${padL}" x2="${xEnd.toFixed(1)}" y1="${(barsTop + barsH).toFixed(1)}" y2="${(barsTop + barsH).toFixed(1)}" style="stroke:rgb(var(--ink) / 0.14)"/>${label(padL - 6, barsTop + 8, `+${int(maxAdd)}`)}${label(xEnd + 8, barsTop + barsH - 2, 'new / day', 'start')}`;
    // End labels, nudged apart so they never overlap.
    const last = pts[pts.length - 1];
    const ends = [{ v: last.total, t: `${int(last.total)} total`, c: 'rgb(var(--n-300))' }, { v: last.model_y, t: `${int(last.model_y)} Model Y`, c: RED }, { v: last.cybercab, t: `${int(last.cybercab)} Cybercab`, c: GOLD }]
      .map(e => ({ ...e, y: y(e.v) + 3.5 })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    const endLabels = ends.map(e => label(xEnd + 6, e.y, narrow ? int(e.v) : e.t, 'start', e.c, 600)).join('');
    const svg = `<svg viewBox="0 0 ${w} ${h}" class="w-full h-auto block select-none" role="img" aria-label="${esc(`Registered Tesla automated vehicles in Texas: ${int(last.total)} (${int(last.cybercab)} Cybercab, ${int(last.model_y)} Model Y) on ${longDate(last.date)}`)}">
      <defs>
        <pattern id="dmvHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" style="stroke:rgb(var(--ink) / 0.05)" stroke-width="2"/></pattern>
        <linearGradient id="dmvRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${RED}" stop-opacity="0.30"/><stop offset="1" stop-color="${RED}" stop-opacity="0.02"/></linearGradient>
        <linearGradient id="dmvGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GOLD}" stop-opacity="0.38"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0.04"/></linearGradient>
      </defs>
      ${grid}${ticks}${imported}
      <path d="${fillPath('model_y')}" fill="url(#dmvRed)"/>
      <path d="${fillPath('cybercab')}" fill="url(#dmvGold)"/>
      <path d="${stepPath('total')}" fill="none" style="stroke:rgb(var(--n-300))" stroke-opacity="0.7" stroke-width="1.25" stroke-dasharray="1.5 3.5" stroke-linecap="round"/>
      <path d="${stepPath('model_y')}" fill="none" stroke="${RED}" stroke-width="2" stroke-linejoin="round"/>
      <path d="${stepPath('cybercab')}" fill="none" stroke="${GOLD}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${xEnd.toFixed(1)}" cy="${y(last.model_y).toFixed(1)}" r="3" fill="${RED}"/><circle cx="${xEnd.toFixed(1)}" cy="${y(last.cybercab).toFixed(1)}" r="3" fill="${GOLD}"/>
      ${endLabels}${bars}${barsAxis}
      <line data-dmv-cross x1="0" x2="0" y1="${padT}" y2="${barsTop + barsH}" style="stroke:rgb(var(--ink) / 0.35);display:none"/>
    </svg>`;
    // For the hover readout: the count that held on a given day.
    const geo = { w, padL, xEnd, start, end, pts };
    return { svg, geo };
  }

  function attachHover(box, geo) {
    if (!geo) return;
    const svg = box.querySelector('svg'), cross = box.querySelector('[data-dmv-cross]'), tip = box.querySelector('[data-dmv-tip]');
    if (!svg || !cross || !tip) return;
    const hide = () => { cross.style.display = 'none'; tip.classList.add('hidden'); };
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointermove', e => {
      const r = svg.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * geo.w;
      if (vx < geo.padL || vx > geo.xEnd) return hide();
      const day = isoDay(geo.start + ((vx - geo.padL) / (geo.xEnd - geo.padL)) * (geo.end - geo.start));
      let p = null; for (const q of geo.pts) { if (q.date <= day) p = q; else break; }
      if (!p) return hide();
      cross.setAttribute('x1', vx.toFixed(1)); cross.setAttribute('x2', vx.toFixed(1)); cross.style.display = '';
      tip.innerHTML = `<div class="font-semibold text-slate-100">${esc(longDate(day))}${p.approx ? ' <span class="font-normal text-slate-500">· approx.</span>' : ''}</div>
        <div class="flex justify-between gap-4"><span style="color:${GOLD}">Cybercab</span><span class="stat-value text-white">${int(p.cybercab)}</span></div>
        <div class="flex justify-between gap-4"><span style="color:${RED}">Model Y</span><span class="stat-value text-white">${int(p.model_y)}</span></div>
        <div class="flex justify-between gap-4 border-t border-white/[0.08] mt-1 pt-1"><span class="text-slate-400">Total</span><span class="stat-value text-white">${int(p.total)}</span></div>`;
      tip.classList.remove('hidden');
      const px = (vx / geo.w) * r.width, tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(0, px + 12 + tw > r.width ? px - tw - 12 : px + 12), r.width - tw)}px`;
    });
  }

  function draw(el) {
    const box = el.querySelector('[data-dmv-chart]');
    if (!box || !box.clientWidth || !data || !data.snapshot) return;
    const { svg, geo } = chart(data.series, box.clientWidth, data.tracking_since);
    box.innerHTML = svg + `<div data-dmv-tip class="hidden pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-lg border border-white/[0.1] bg-[rgb(var(--surface))]/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur"></div>`;
    attachHover(box, geo);
  }

  function render() {
    els.forEach(el => {
      const d = data;
      const head = `<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div class="min-w-0"><h2 class="font-display font-bold text-xl text-white uppercase tracking-wide max-sm:text-base">Texas DMV registrations · Tesla</h2>
          <p class="text-xs text-slate-500 mt-0.5">Every automated vehicle Tesla lists with the state</p></div>
          <div class="flex items-center gap-1" role="group" aria-label="Time range">${Object.keys(RANGES).map(r => `<button type="button" data-dmv-range="${r}" aria-pressed="${r === range}" class="text-xs font-semibold px-2 py-1 rounded-md max-sm:min-h-[44px] max-sm:min-w-[40px] ${r === range ? 'text-white bg-white/[0.08]' : 'text-slate-400 hover:text-slate-200'}">${r}</button>`).join('')}</div>
        </div>`;
      if (!d) { el.innerHTML = head + `<div class="mt-4 h-40 rounded-xl bg-white/[0.03] animate-pulse"></div>`; return; }
      if (!d.snapshot) {
        el.innerHTML = head + `<p class="mt-4 text-sm text-slate-400">The first daily TxDMV snapshot hasn't been taken yet. It runs each morning (Central).</p>`;
        return;
      }
      const s = d.snapshot, n = d.new || {}, m = d.matched || {}, hist = d.history_source;
      const windowStart = new Date(Date.parse(`${s.date}T12:00:00Z`) - 30 * DAY).toISOString().slice(0, 10);
      const partial = !hist && d.tracking_since > windowStart;   // under 30 days of history and nothing imported
      const stat = (label, value, sub, color = 'text-white') => `<div class="min-w-0"><div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 max-sm:text-[10px]">${esc(label)}</div>
        <div class="stat-value font-semibold text-3xl leading-tight mt-1 ${color} max-sm:text-2xl">${value}</div><div class="text-[11px] text-slate-500 mt-0.5 max-sm:text-[10px]">${sub}</div></div>`;
      // The React Bits BorderGlow (js/main.js initBorderGlow, [data-glow]): gold
      // for Cybercab, red for Model Y; the picture is clipped in its own layer
      // so the glow can spill past the card's edge.
      const card = (color, rgb, name, img, count, newN, glow) => `<div data-glow${glow ? `="${glow}"` : ''} class="dmv-card relative rounded-xl border px-4 py-3.5 min-h-[112px] max-sm:px-3 max-sm:py-3 max-sm:min-h-[96px]" style="--c:${rgb};border-color:${color}59;background:linear-gradient(120deg, ${color}1f, transparent 70%)">
          <div class="absolute inset-0 overflow-hidden rounded-[inherit] pointer-events-none" aria-hidden="true"><img src="${img}" alt="" loading="lazy" decoding="async" class="absolute right-[-6%] bottom-[-4%] w-[58%] max-w-[230px] opacity-90 max-sm:w-[54%]"></div>
          <div class="relative max-w-[52%]">
            <div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide max-sm:text-[10px]" style="color:${color}"><span class="w-2 h-2 rounded-full" style="background:${color}"></span>${esc(name)}</div>
            <div class="dmv-card-num stat-value font-semibold text-3xl text-white leading-tight mt-1 max-sm:text-2xl">${int(count)}</div>
            <div class="text-[11px] text-slate-400 max-sm:text-[10px]">${pct(count, s.total)}% of the fleet</div>
            <div class="mt-1.5 h-1 rounded-full bg-white/[0.08] overflow-hidden"><div class="h-full rounded-full" style="width:${pct(count, s.total)}%;background:${color}"></div></div>
            <div class="stat-value text-[11px] text-emerald-400 mt-1.5 max-sm:text-[10px]">+${int(newN)} ${partial ? 'since tracking' : 'in 30 days'}${n.approx ? ' <span class="text-slate-500">(approx.)</span>' : ''}</div>
          </div>
        </div>`;
      const failed = d.last_attempt && !d.last_attempt.ok && Date.parse(d.last_attempt.at) > Date.parse(s.polled_at);
      el.innerHTML = head + `
        <div class="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] max-sm:mt-3 max-sm:gap-4">
          <div class="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-5 lg:content-start max-sm:gap-2">
            ${stat('Registered AV fleet', int(s.total), `by VIN · polled ${esc(ago(s.polled_at))}`, 'text-gold')}
            ${stat(partial ? 'Since tracking began' : 'Last 30 days', `+${int(n.d30)}`, partial ? `Tracking since ${esc(shortDate(d.tracking_since))}` : `+${int(n.d7)} in the last 7 days${n.approx ? ' · approx.' : ''}`, 'text-emerald-400')}
            ${stat('Matched to tracked plates', int(m.count), `${int(m.spotted_30d)} spotted in the last 30 days`)}
          </div>
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-[11px] text-slate-400">
              <span class="flex items-center gap-1.5"><span class="w-3 h-0.5 rounded" style="background:${GOLD}"></span>Cybercab</span>
              <span class="flex items-center gap-1.5"><span class="w-3 h-0.5 rounded" style="background:${RED}"></span>Model Y</span>
              <span class="flex items-center gap-1.5"><span class="w-3 border-t border-dotted border-slate-300"></span>Total</span>
              <span class="ml-auto max-sm:hidden">Registered by date · bars: new per day</span>
            </div>
            <div data-dmv-chart class="relative"></div>
          </div>
        </div>
        <div class="mt-5 grid grid-cols-2 gap-3 max-sm:grid-cols-1 max-sm:mt-4 max-sm:gap-2">
          ${card(GOLD, '212 175 55', 'Cybercab', '/images/dmv-cybercab.webp', s.cybercab, n.cybercab_30d)}
          ${card(RED, '239 68 68', 'Model Y', '/images/dmv-model-y.webp', s.model_y, n.model_y_30d, 'red')}
        </div>
        <div class="mt-5 flex items-center gap-6 max-sm:mt-4 max-sm:flex-col-reverse max-sm:items-stretch max-sm:gap-3">
        <p class="flex-1 min-w-0 text-[11px] text-slate-500 leading-relaxed max-sm:text-[10px]">Polled daily from the TxDMV Motor Carrier Credentialing System (TxMCCS): every VIN ${esc(d.source.company)} lists under its SB 2807 automated-vehicle authorization ${esc(d.source.authorization)}. Last polled ${esc(centralTime(s.polled_at))} CT.${hist
          ? ` Before ${esc(longDate(hist.until))}, counts are approximate.`
          : ` TxDMV publishes no registration dates, so “new” counts VINs that first appeared after Cybercab Hunter began polling on ${esc(longDate(d.tracking_since))}.`}${failed ? ` <span class="text-amber-300">The latest check (${esc(centralTime(d.last_attempt.at))} CT) couldn't reach TxDMV; showing the last good poll.</span>` : ''}</p>
        <a href="/dmv" data-magnet class="dmv-registry-btn btn-magnetic group shrink-0 inline-flex items-center gap-3.5 pl-3.5 pr-4 py-3 rounded-xl text-[#1a1204] bg-gradient-to-r from-goldsoft to-gold shadow-[0_10px_24px_-14px_rgba(212,175,55,0.75)] max-sm:justify-between">
          <span class="flex items-center gap-3">
            <span class="grid place-items-center w-10 h-10 rounded-lg bg-black/[0.12]" aria-hidden="true"><svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>
            <span class="text-left leading-tight"><span class="block text-base font-bold tracking-tight">View Registry</span><span class="block text-xs font-semibold opacity-70 stat-value">${int(s.total)} VINs · <span class="max-sm:hidden">straight </span>from TxDMV</span></span>
          </span>
          <span class="grid place-items-center w-8 h-8 rounded-full bg-black/[0.14] transition-transform duration-200 group-hover:translate-x-1" aria-hidden="true"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
        </a>
        </div>`;
      draw(el);
    });
  }
  // Redraw at the new width when the panel is resized.
  if (window.ResizeObserver) {
    let queued = false, lastW = new WeakMap();
    const ro = new ResizeObserver(() => {
      if (queued || !data || !data.snapshot) return; queued = true;
      requestAnimationFrame(() => { queued = false; els.forEach(el => { const box = el.querySelector('[data-dmv-chart]'); if (box && box.clientWidth && lastW.get(el) !== box.clientWidth) { lastW.set(el, box.clientWidth); draw(el); } }); });
    });
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
