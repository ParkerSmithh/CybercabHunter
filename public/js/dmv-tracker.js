/* Texas DMV tracker (dmv.html). Data: worker/txdmv-activity.js —
     GET /api/dmv/overview         four cards, freshness, insights, milestones, recent updates
     GET /api/dmv/growth?range=    actual snapshots and the additions on each (bars)
     GET /api/dmv/activity?…       registration history (paged, filtered)
     GET /api/dmv/activity/:date   one update's VINs (added / missing)
     GET /api/dmv/vins?…           the VIN directory; /api/dmv/vins/:vin one vehicle
   Every number is one the server sent. "First detected" is when Cybercab
   Hunter first saw a VIN on TxDMV's roster — never a DMV registration date
   (TxDMV publishes none). The cumulative chart and its predictions are the
   shared panel (js/dmv-panel.js); this file never draws a prediction. */
(function () {
  const $ = id => document.getElementById(id);
  if (!$('dmvStats')) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = n => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
  const signed = n => (typeof n !== 'number' ? '—' : n > 0 ? `+${int(n)}` : n < 0 ? `−${int(-n)}` : '0');
  const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const central = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const GOLD = '#FAE030', RED = '#ef4444', GREY = '#64748b';
  const CLASS = { cybercab: ['Cybercab', GOLD], model_y: ['Model Y', RED], other_tesla: ['Other Tesla', '#94a3b8'], unknown: ['Unknown', GREY] };
  const DECODE = { verified: 'Verified (NHTSA vPIC and TxDMV agree)', vpic: 'NHTSA vPIC only', source_label: 'TxDMV label (not yet decoded)', conflict: 'Sources disagree: shown as unknown', unknown: 'Not decodable yet' };
  const FRESH = {
    current: ['Current', 'text-emerald-300 border-emerald-400/40'], update_pending: ['Update pending', 'text-slate-300 border-white/20'],
    import_failed: ['Import failed', 'text-amber-300 border-amber-400/40'], source_unavailable: ['Source unavailable', 'text-amber-300 border-amber-400/40'],
    stale: ['Stale', 'text-amber-300 border-amber-400/40'], historical_incomplete: ['Historical data incomplete', 'text-slate-300 border-white/20']
  };
  // One request per view of the data: no timers, no polling (DMV data changes once a day).
  // `signal` lets a newer search or filter cancel the one it replaces.
  const get = async (path, signal) => { try { const r = await fetch(path, { signal }); return r.ok ? await r.json() : null; } catch (e) { return null; } };
  const dot = cls => `<span class="w-2 h-2 rounded-full shrink-0" style="background:${(CLASS[cls] || CLASS.unknown)[1]}"></span>`;
  const breakdown = b => !b ? '' : ['cybercab', 'model_y', 'other_tesla', 'unknown'].filter(k => b[k]).map(k => `<span class="inline-flex items-center gap-1">${dot(k)}${int(b[k])} ${esc(CLASS[k][0])}</span>`).join('<span class="text-slate-600">·</span>');

  // ---------- overview ----------
  async function overview() {
    const o = await get('/api/dmv/overview');
    if (!o) { $('dmvStats').innerHTML = `<p class="col-span-4 text-sm text-slate-400">Couldn't load the DMV tracker right now.</p>`; return; }
    const [label, cls] = FRESH[o.freshness.status] || FRESH.current;
    $('dmvFresh').innerHTML = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${cls}"><span class="w-1.5 h-1.5 rounded-full bg-current"></span>${esc(label)}</span>`
      + (o.latest ? ` <span class="ml-1">Snapshot ${esc(longDate(o.latest.date))}</span>` : '');
    if (!o.latest) { $('dmvStats').innerHTML = `<p class="col-span-4 text-sm text-slate-400">The first daily TxDMV snapshot hasn't been taken yet.</p>`; return; }
    const t = o.totals, u = o.latest_update;
    const card = (label, value, sub, color = 'text-white', extra = '') => `<div class="glass rounded-2xl p-5 min-w-0 max-sm:p-3 ${extra}">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 max-sm:text-[10px]">${label}</div>
        <div class="stat-value font-semibold text-4xl leading-tight mt-1 ${color} max-sm:text-2xl">${value}</div>
        <div class="text-xs text-slate-500 mt-1 max-sm:text-[10px] max-sm:leading-tight">${sub}</div></div>`;
    $('dmvStats').innerHTML = [
      card('Total tracked vehicles', int(t.total), `on the roster · ${esc(shortDate(o.latest.date))}`, 'text-gold'),
      card('New in latest update', u ? `+${int(u.added)}` : o.processing_pending ? '—' : '0', u ? `first detected ${esc(shortDate(u.date))}` : o.processing_pending ? 'activity being processed' : 'none since tracking began', 'text-emerald-400'),
      card('Cybercabs', int(t.cybercab), `${t.total ? Math.round(t.cybercab / t.total * 100) : 0}% of the roster`),
      card('Model Ys', int(t.model_y), `${t.total ? Math.round(t.model_y / t.total * 100) : 0}% of the roster`)
    ].join('');
    const net = o.previous_snapshot ? `${signed(o.previous_snapshot.net)} since the previous snapshot (${esc(shortDate(o.previous_snapshot.date))})` : '';
    $('dmvStatsMore').innerHTML = [`Other Tesla ${int(t.other_tesla)}`, `Unknown ${int(t.unknown)}`, net, o.freshness.last_success ? `Last successful import ${esc(central(o.freshness.last_success))} CT` : ''].filter(Boolean).join(' <span class="text-slate-600">·</span> ');

    // Recent activity (the latest five updates that changed the roster).
    const list = o.recent_updates || [];
    $('dmvActivity').innerHTML = list.length ? list.map(e => `<li><button type="button" data-update="${esc(e.date)}" class="w-full text-left rounded-xl border border-white/[0.07] px-4 py-3 hover:border-[rgba(250,224,48,0.4)] transition-colors max-sm:px-3 max-sm:py-2.5">
        <div class="flex items-baseline justify-between gap-3"><span class="font-semibold text-sm text-white">${esc(longDate(e.date))}</span><span class="stat-value text-sm font-semibold ${e.added ? 'text-emerald-400' : 'text-slate-400'}">${e.added ? `+${int(e.added)} new` : `${int(e.missing)} missing`}</span></div>
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400">${breakdown(e.added_by_model)}${e.missing ? `<span class="text-amber-300">${int(e.missing)} missing</span>` : ''}</div>
        <div class="mt-1 text-[11px] text-slate-500">${int(e.total)} on the roster after · processed ${esc(central(e.processed_at))} CT</div></button></li>`).join('')
      : o.processing_pending ? `<li class="text-sm text-slate-400">Registration activity is being processed from the daily snapshots. It appears after the next daily import.</li>`
      : `<li class="text-sm text-slate-400">No changes since tracking began on ${esc(longDate(o.tracking_since))}. The first snapshot is the baseline: its vehicles aren't counted as new.</li>`;

    $('dmvInsights').innerHTML = (o.insights || []).map(i => `<li class="flex gap-2"><span class="text-gold">•</span><span>${esc(i.text)}</span></li>`).join('') || '<li class="text-slate-400">Not enough history yet.</li>';
    $('dmvMilestones').innerHTML = (o.milestones || []).map(m => `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[rgba(250,224,48,0.35)] text-[11px] text-slate-200"><span class="text-gold">★</span>${esc(m.label)} · ${esc(shortDate(m.date))}</span>`).join('');

    const row = (k, v) => `<dt class="text-slate-500">${k}</dt><dd class="text-slate-200 min-w-0">${v}</dd>`;
    $('dmvSource').innerHTML = [
      row('Provider', `<a href="${esc(o.source.url)}" target="_blank" rel="noopener" class="text-gold hover:underline">${esc(o.source.name)}</a>`),
      row('Company', `${esc(o.source.company)} · ${esc(o.source.authorization)} (${esc(o.source.law)})`),
      row('Dataset date', `${esc(longDate(o.latest.date))} <span class="text-slate-500">(the day Cybercab Hunter read it; TxDMV dates nothing)</span>`),
      row('Last import', o.freshness.last_success ? `${esc(central(o.freshness.last_success))} CT` : '—'),
      row('Status', esc(label)),
      row('Schedule', esc(o.source.schedule)),
      row('Records', `${int(t.total)} VINs · fields: ${esc(o.source.fields.join(', '))}`),
      row('Tracking since', `${esc(longDate(o.tracking_since))} (baseline)`),
      row('Decoding', `<a href="${esc(o.source.decoder.url)}" target="_blank" rel="noopener" class="text-gold hover:underline">${esc(o.source.decoder.name)}</a>, cross-checked with TxDMV's label`)
    ].join('');
  }

  // ---------- additions chart (actual only) ----------
  let addRange = 'all', addSeries = 'stack';
  const growthByRange = {};   // each range fetched once (the request itself, so overlapping draws share it); toggles and resizes only redraw
  async function additions() {
    const range = addRange;
    const g = await (growthByRange[range] || (growthByRange[range] = get(`/api/dmv/growth?range=${range}`)));
    if (!g) delete growthByRange[range];
    if (range !== addRange) return;
    const box = $('addChart');
    if (!g) { box.innerHTML = `<p class="text-sm text-slate-400">Couldn't load the chart.</p>`; return; }
    const pts = g.points.filter(p => !p.baseline);
    if (!g.enough_history || !pts.length) { box.innerHTML = `<p class="text-sm text-slate-400 py-6 text-center">Not enough snapshots in this range yet.</p>`; return; }
    const w = Math.max(280, box.clientWidth), h = 170, padL = 30, padB = 22, padT = 10;
    const val = p => !p.added ? 0 : addSeries === 'stack' ? Object.values(p.added).reduce((s, n) => s + n, 0) : (p.added[addSeries] || 0);
    const max = Math.max(1, ...pts.map(val));
    const bw = Math.max(3, Math.min(26, (w - padL - 8) / pts.length - 3));
    const x = i => padL + 4 + i * ((w - padL - 8) / pts.length);
    const y = v => padT + (h - padT - padB) * (1 - v / max);
    const keys = addSeries === 'stack' ? ['cybercab', 'model_y', 'other_tesla', 'unknown'] : [addSeries];
    let bars = '';
    pts.forEach((p, i) => {
      let acc = 0;
      for (const k of keys) {
        const n = p.added ? p.added[k] || 0 : 0;
        if (!n) continue;
        bars += `<rect x="${x(i).toFixed(1)}" y="${y(acc + n).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(acc) - y(acc + n)).toFixed(1)}" rx="2" fill="${CLASS[k][1]}"><title>${esc(shortDate(p.date))}: ${n} ${esc(CLASS[k][0])}</title></rect>`;
        acc += n;
      }
    });
    const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
    const labelEvery = Math.ceil(pts.length / 6);
    box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="w-full h-auto block" role="img" aria-label="New VINs first detected per daily snapshot">
      ${ticks.map(t => `<line x1="${padL}" x2="${w}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(255,255,255,0.06)"/><text x="${padL - 6}" y="${y(t) + 3}" text-anchor="end" font-size="10" fill="#7E838C">${t}</text>`).join('')}
      ${bars}
      ${pts.map((p, i) => ((i % labelEvery === 0 && pts.length - 1 - i >= labelEvery / 2) || i === pts.length - 1) ? `<text x="${(x(i) + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#7E838C">${esc(shortDate(p.date))}</text>` : '').join('')}
    </svg>
    <div class="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-400">${keys.map(k => `<span class="inline-flex items-center gap-1.5">${dot(k)}${esc(CLASS[k][0])}</span>`).join('')}<span class="ml-auto">Days with no new VINs show no bar.</span></div>`;
  }
  $('addRange').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (!b) return; addRange = b.dataset.range; $('addRange').querySelectorAll('[data-range]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); additions(); });
  $('addSeries').addEventListener('click', e => { const b = e.target.closest('[data-series]'); if (!b) return; addSeries = b.dataset.series; $('addSeries').querySelectorAll('[data-series]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); additions(); });
  if (window.ResizeObserver) { let last = 0; new ResizeObserver(() => { const w = $('addChart').clientWidth; if (Math.abs(w - last) > 20) { last = w; additions(); } }).observe($('addChart')); }

  // ---------- history ----------
  const HIST = 20;
  let histOffset = 0, histSeq = 0, histAbort = null;
  async function history() {
    const mine = ++histSeq;
    if (histAbort) histAbort.abort();
    histAbort = new AbortController();
    const f = new FormData($('histFilters'));
    const params = new URLSearchParams({ limit: String(HIST), offset: String(histOffset) });
    for (const k of ['from', 'to', 'model', 'kind']) if (f.get(k)) params.set(k, f.get(k));
    const h = await get(`/api/dmv/activity?${params}`, histAbort.signal);
    if (mine !== histSeq) return;
    if (!h) { $('histRows').innerHTML = `<tr><td colspan="7" class="px-4 py-6 text-slate-400">Couldn't load the history.</td></tr>`; return; }
    $('histRows').innerHTML = h.events.length ? h.events.map(e => `<tr class="border-t border-white/[0.05] hover:bg-white/[0.03] cursor-pointer" data-update="${esc(e.date)}" tabindex="0">
        <td class="px-4 py-2.5 max-sm:px-3"><span class="text-slate-100">${esc(longDate(e.date))}</span></td>
        <td class="px-3 py-2.5 text-right stat-value ${e.added ? 'text-emerald-400' : 'text-slate-500'}">${e.added ? `+${int(e.added)}` : '0'}</td>
        <td class="px-3 py-2.5 text-right stat-value text-slate-300 max-sm:hidden">${int((e.added_by_model || {}).cybercab || 0)}</td>
        <td class="px-3 py-2.5 text-right stat-value text-slate-300 max-sm:hidden">${int((e.added_by_model || {}).model_y || 0)}</td>
        <td class="px-3 py-2.5 text-right stat-value ${e.missing ? 'text-amber-300' : 'text-slate-500'}">${int(e.missing)}</td>
        <td class="px-3 py-2.5 text-right stat-value text-slate-300">${signed(e.net)}</td>
        <td class="px-4 py-2.5 text-right stat-value text-slate-100 max-sm:px-3">${int(e.total)}</td></tr>`).join('')
      : `<tr><td colspan="7" class="px-4 py-6 text-slate-400">No updates match.${h.baseline ? ` Tracking began ${esc(longDate(h.baseline.date))} with ${int(h.baseline.total)} vehicles (the baseline).` : ''}</td></tr>`;
    $('histCount').textContent = h.total ? `${histOffset + 1}–${histOffset + h.events.length} of ${h.total} updates${h.baseline ? ` · baseline ${longDate(h.baseline.date)}, ${h.baseline.total} vehicles` : ''}` : '';
    $('histPrev').disabled = histOffset === 0;
    $('histNext').disabled = histOffset + h.events.length >= h.total;
  }
  $('histFilters').addEventListener('change', () => { histOffset = 0; history(); });
  $('histPrev').addEventListener('click', () => { histOffset = Math.max(0, histOffset - HIST); history(); });
  $('histNext').addEventListener('click', () => { histOffset += HIST; history(); });

  // ---------- VIN directory ----------
  const PAGE = 50;
  let model = '', q = '', year = '', sort = 'first_seen', offset = 0, seq = 0, timer = 0, yearsLoaded = false, total = 0, vinAbort = null;
  async function vins(reset) {
    const mine = ++seq;
    if (vinAbort) vinAbort.abort();
    vinAbort = new AbortController();
    if (reset) { offset = 0; $('vinRows').innerHTML = ''; }
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
    if (model === 'recent') params.set('recent', '1'); else if (model) params.set('model', model);
    if (q) params.set('q', q);
    if (year) params.set('year', year);
    const body = await get(`/api/dmv/vins?${params}`, vinAbort.signal);
    if (mine !== seq) return;
    if (!body) { $('vinCount').textContent = "Couldn't load the roster right now."; return; }
    if (typeof body.total === 'number') total = body.total;   // the first page carries the total; later pages don't
    if (!yearsLoaded && body.years) { yearsLoaded = true; $('vinYear').insertAdjacentHTML('beforeend', body.years.map(y => `<option value="${esc(y)}">${esc(y)}</option>`).join('')); }
    $('vinRows').insertAdjacentHTML('beforeend', body.vehicles.map(v => `<tr class="border-t border-white/[0.05] hover:bg-white/[0.03] cursor-pointer" data-vin="${esc(v.vin)}" tabindex="0">
      <td class="px-4 py-2.5 font-mono tracking-wide text-slate-100 max-sm:px-3 max-sm:text-[11px]">${esc(v.vin)}${v.is_new ? ' <span class="ml-1 align-middle px-1.5 rounded bg-gold text-[#1a1204] text-[10px] font-sans font-bold">NEW</span>' : ''}</td>
      <td class="px-3 py-2.5"><span class="inline-flex items-center gap-1.5 text-slate-200">${dot(v.model_class)}${esc((CLASS[v.model_class] || CLASS.unknown)[0])}</span></td>
      <td class="px-3 py-2.5 text-right stat-value text-slate-400 max-sm:hidden">${esc(v.model_year ?? '—')}</td>
      <td class="px-4 py-2.5 text-right text-slate-400 max-sm:px-3">${v.baseline ? `<span title="On the roster when tracking began; its real date is unknown">by ${esc(shortDate(v.first_detected))}</span>` : esc(shortDate(v.first_detected))}</td></tr>`).join(''));
    offset += body.vehicles.length;
    $('vinCount').textContent = total ? `${offset.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} VINs` : (q ? 'No VIN matches that search.' : 'No VINs match.');
    $('vinMore').classList.toggle('hidden', offset >= total);
  }
  $('vinModel').addEventListener('click', e => { const b = e.target.closest('[data-model]'); if (!b) return; model = b.dataset.model; $('vinModel').querySelectorAll('[data-model]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); vins(true); });
  $('vinYear').addEventListener('change', () => { year = $('vinYear').value; vins(true); });
  $('vinSort').addEventListener('change', () => { sort = $('vinSort').value; vins(true); });
  $('vinSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = $('vinSearch').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); vins(true); }, 250); });
  $('vinMore').addEventListener('click', () => vins(false));

  // ---------- dialog: one update, one VIN ----------
  const dlg = $('dmvDialog');
  const open = () => { if (!dlg.open) dlg.showModal(); };
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  async function showUpdate(date, change = 'added') {
    $('dlgHead').innerHTML = `<p class="text-[11px] font-semibold uppercase tracking-wide text-gold">Registration activity</p><h3 class="font-display font-bold text-xl text-white">${esc(longDate(date))}</h3>`;
    $('dlgBody').innerHTML = '<div class="h-32 rounded-xl bg-white/[0.03] animate-pulse"></div>';
    open();
    const d = await get(`/api/dmv/activity/${encodeURIComponent(date)}?change=${change}&limit=200`);
    if (!d) { $('dlgBody').innerHTML = `<p class="text-sm text-slate-400">Couldn't load this update.</p>`; return; }
    const e = d.event;
    $('dlgHead').insertAdjacentHTML('beforeend', `<p class="text-xs text-slate-400 mt-1">${e.added ? `+${int(e.added)} newly detected` : 'No new VINs'}${e.missing ? ` · ${int(e.missing)} missing` : ''}${e.returned ? ` · ${int(e.returned)} returned` : ''} · ${int(e.total)} on the roster after (${signed(e.net)})</p>`);
    const tabs = ['added', 'missing', 'returned'].filter(k => e[k]).map(k => `<button type="button" data-change="${k}" aria-pressed="${k === change}" class="city-filter px-3 min-h-[34px] rounded-full border text-xs font-semibold">${k === 'added' ? 'New' : k === 'missing' ? 'Missing' : 'Returned'} (${int(e[k])})</button>`).join('');
    $('dlgBody').innerHTML = `<div class="flex flex-wrap gap-2 mb-3" data-date="${esc(date)}">${tabs}</div>
      <div class="flex flex-wrap gap-2 text-[11px] text-slate-400 mb-3">${breakdown(e.added_by_model)}</div>
      <p class="text-[11px] text-slate-500 mb-3">Compared VIN by VIN with the snapshot of ${esc(longDate(e.previous_date))}. "New" means first detected in this snapshot, not a DMV registration date.${change === 'missing' ? ' A missing VIN is not necessarily deregistered.' : ''}</p>
      <ul class="divide-y divide-white/[0.05]">${d.vehicles.map(v => `<li><button type="button" data-vin="${esc(v.vin)}" class="w-full flex items-center justify-between gap-3 py-2 text-left">
        <span class="font-mono text-sm text-slate-100 max-sm:text-xs">${esc(v.vin)}</span>
        <span class="inline-flex items-center gap-1.5 text-xs text-slate-300">${dot(v.model_class)}${esc((CLASS[v.model_class] || CLASS.unknown)[0])}${v.model_year ? ` · ${esc(v.model_year)}` : ''}</span></button></li>`).join('')}</ul>
      ${d.total > d.vehicles.length ? `<p class="mt-3 text-xs text-slate-500">Showing ${d.vehicles.length} of ${d.total}.</p>` : ''}`;
  }
  async function showVin(vin) {
    $('dlgHead').innerHTML = `<p class="text-[11px] font-semibold uppercase tracking-wide text-gold">Texas DMV · vehicle</p><h3 class="font-mono font-bold text-lg text-white break-all">${esc(vin)}</h3>`;
    $('dlgBody').innerHTML = '<div class="h-32 rounded-xl bg-white/[0.03] animate-pulse"></div>';
    open();
    const v = await get(`/api/dmv/vins/${encodeURIComponent(vin)}`);
    if (!v) { $('dlgBody').innerHTML = `<p class="text-sm text-slate-400">Couldn't load this VIN.</p>`; return; }
    const d = v.decode || {}, t = v.tracking;
    const row = (k, val) => `<dt class="text-slate-500">${k}</dt><dd class="text-slate-200 min-w-0">${val}</dd>`;
    const block = (title, rows) => `<section class="mb-4"><h4 class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">${title}</h4><dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm max-sm:text-xs">${rows.join('')}</dl></section>`;
    const changeLabel = { added: 'First detected', missing: 'Missing from the roster', returned: 'Back on the roster' };
    $('dlgBody').innerHTML = [
      block('From TxDMV', [row('Make', esc(v.source.make || '—')), row('Model', esc(v.source.model || '—')), row('Model year', esc(v.source.model_year ?? '—')), row('Registration date', '<span class="text-slate-500">Not published by TxDMV</span>')]),
      block('Decoded VIN (NHTSA vPIC)', d.model_class ? [
        row('Classification', `<span class="inline-flex items-center gap-1.5">${dot(d.model_class)}${esc((CLASS[d.model_class] || CLASS.unknown)[0])}</span> <span class="text-slate-500">· ${esc(DECODE[d.status] || d.status)}</span>`),
        row('Manufacturer', esc(d.manufacturer || '—')), row('Model', esc(d.model || '—')), row('Model year', esc(d.model_year ?? '—')),
        row('Built at', `${esc(d.plant || '—')} <span class="text-slate-500">(where it was built, not where it is)</span>`),
        row('Vehicle type', esc(d.vehicle_type || '—')), row('Check digit', d.check_digit_ok == null ? '—' : d.check_digit_ok ? 'Valid' : 'Invalid')
      ] : [row('Status', 'Not decoded yet')]),
      block('Tracking', [
        row('First detected', t.in_baseline ? `On the roster when tracking began (${esc(longDate(t.first_detected))}) — its real date is unknown` : esc(longDate(t.first_detected))),
        row('Last confirmed', esc(longDate(t.last_confirmed))),
        row('Status', t.listed ? '<span class="text-emerald-300">Listed in the latest snapshot</span>' : `<span class="text-amber-300">Not in the latest snapshot (${esc(longDate(t.latest_snapshot))})</span>`),
        ...(t.history || []).map(h => row(esc(shortDate(h.date)), esc(changeLabel[h.change] || h.change)))
      ]),
      block('Cybercab Hunter', v.registry ? [row('Registry', `<a href="/vehicle/${encodeURIComponent(v.registry.id)}" class="text-gold hover:underline">${esc(v.registry.plate || 'View vehicle')} →</a>`), row('Approved sightings', int(v.registry.approved_sightings))] : [row('Registry', '<span class="text-slate-500">No public registry vehicle with this VIN yet</span>')])
    ].join('');
  }
  document.addEventListener('click', e => {
    const u = e.target.closest('[data-update]'); if (u) { showUpdate(u.dataset.update); return; }
    const c = e.target.closest('[data-change]'); if (c) { showUpdate(c.parentElement.dataset.date, c.dataset.change); return; }
    const v = e.target.closest('[data-vin]'); if (v) showVin(v.dataset.vin);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-update], tr[data-vin]')) e.target.click(); });

  // The overview and chart load with the page; the history and the directory
  // when they are about to scroll into view (most visits never reach them).
  overview();
  additions();
  const whenNear = (el, fn) => {
    if (!('IntersectionObserver' in window)) { fn(); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: '600px 0px' });
    io.observe(el);
  };
  whenNear($('histRows'), history);
  whenNear($('vinRows'), () => vins(true));
})();
