/* Homepage city rows (index.html #cityRows): Service area, Ride stats,
   Sightings activity, Camera watch, Fleet composition + newest additions,
   Top spotters. They follow the page's Austin / Dallas tabs
   (window.setHomeRowsCity, called by the tab code) and are drawn from one
   response, GET /api/homepage-stats?city= (worker/homepage-stats.js), shared
   with the stats bar through window.CCHHomeData (js/home-stats.js; kept five
   minutes, so switching back and forth doesn't refetch).
   Rules: a number is only ever one the server sent; where the server has no
   data the row says so ("—" or a short line), never a made-up 0. Every list
   item that has a page links to it. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ZONE = 'America/Chicago';
  const money = v => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');
  const int = v => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
  const one = v => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
  const plural = (n, a, b) => `${int(n)} ${n === 1 ? a : b}`;
  const date = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  const clock = hhmm => { if (!hhmm) return '—'; const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'AM' : 'PM'}`; };
  const hourLabel = h => `${((h + 11) % 12) + 1}${h < 12 ? 'AM' : 'PM'}`;
  const localHour = iso => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso))) % 24;
  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hr ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  const when = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz || ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  // ---- shared pieces ----
  const head = (eyebrow, title, link) => `
    <div class="flex items-end justify-between gap-3 mb-4 max-sm:mb-2.5">
      <div class="min-w-0">
        <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gold max-sm:text-[10px]">${esc(eyebrow)}</p>
        <h2 class="font-display font-bold text-2xl lg:text-3xl tracking-[-0.02em] text-white mt-1 max-sm:text-lg">${esc(title)}</h2>
      </div>
      ${link ? `<a href="${esc(link.href)}" class="shrink-0 inline-flex items-center gap-1 min-h-[44px] text-sm font-semibold text-gold hover:underline max-sm:text-xs">${esc(link.label)}<span aria-hidden="true">→</span></a>` : ''}
    </div>`;
  const tile = (label, value, sub = '') => `
    <div class="glass rounded-xl p-4 min-w-0 max-sm:px-2.5 max-sm:py-2.5">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 truncate max-sm:whitespace-normal max-sm:leading-tight max-sm:min-h-[2.5em] max-sm:text-[9px] max-sm:tracking-normal">${esc(label)}</div>
      <div class="stat-value font-semibold text-2xl text-white mt-1.5 truncate max-sm:text-base max-sm:mt-0.5">${value}</div>
      ${sub ? `<div class="text-[11px] text-slate-500 mt-1 truncate max-sm:whitespace-normal max-sm:leading-tight max-sm:text-[9px] max-sm:mt-0.5">${sub}</div>` : ''}
    </div>`;
  const tiles = (cls, inner) => `<div class="grid gap-3 ${cls} max-sm:gap-1.5">${inner}</div>`;
  const card = (inner, cls = '') => `<div class="glass rounded-2xl p-5 min-w-0 max-sm:p-3 ${cls}">${inner}</div>`;
  const cardTitle = t => `<div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 max-sm:text-[10px]">${esc(t)}</div>`;
  const empty = text => `<p class="text-sm text-slate-400 max-sm:text-xs">${esc(text)}</p>`;
  // Bars scaled to the largest value; a zero is a flat line, not a bar.
  function bars(values, titles) {
    const max = Math.max(0, ...values.filter(v => typeof v === 'number'));
    return `<div class="hr-bars" role="img" aria-label="${esc(titles.join('; '))}">${values.map((v, i) =>
      typeof v === 'number' && v > 0 && max > 0
        ? `<span style="height:${Math.max(4, Math.round((v / max) * 100))}%" title="${esc(titles[i])}"></span>`
        : `<span class="is-empty" title="${esc(titles[i])}"></span>`).join('')}</div>`;
  }

  // ---- the rows ----
  function rowArea(d) {
    const a = d.area || {};
    const hours = a.hours ? `${clock(a.hours.open)} – ${clock(a.hours.close)}` : '—';
    return head(d.name.toUpperCase(), 'Service area', { href: `/infrastructure${d.city === 'dallas' ? '?city=dallas' : ''}`, label: 'Zone map' }) +
      tiles('grid-cols-4 max-sm:grid-cols-2',
        tile('Coverage', typeof a.square_miles === 'number' ? `${int(a.square_miles)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">mi²</span>` : '—') +
        tile('In service since', esc(date(a.in_service_since))) +
        tile('Vehicles documented', int(a.vehicles), 'In the public registry') +
        tile('Service hours', esc(hours), 'Daily, Central')) +
      (a.description ? `<p class="mt-3 text-sm text-slate-400 leading-relaxed max-sm:mt-2 max-sm:text-xs max-sm:leading-snug">${esc(a.description)}</p>` : '');
  }

  function rowRides(d) {
    const r = d.rides || {};
    const has = r.rides > 0;
    const t = tiles('grid-cols-6 max-sm:grid-cols-3',
      tile('Rides', has ? int(r.rides) : '—', 'Counted') +
      tile('Miles', has && r.miles != null ? one(r.miles) : '—', 'Total') +
      tile('Avg fare', money(r.average_fare), r.fare_rides ? plural(r.fare_rides, 'ride', 'rides') : '') +
      tile('Per mile', money(r.per_mile)) +
      tile('Avg trip', r.average_miles != null ? `${one(r.average_miles)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">mi</span>` : '—') +
      tile('Avg duration', r.average_minutes != null ? `${one(r.average_minutes)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">min</span>` : '—'));
    // The last 13 weeks (Mondays), oldest first; weeks with no fares are flat.
    const byWeek = new Map((r.weekly_fares || []).map(w => [w.week, w]));
    const weeks = [];
    const now = new Date(); now.setUTCHours(0, 0, 0, 0); now.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    for (let i = 12; i >= 0; i--) { const w = new Date(now); w.setUTCDate(w.getUTCDate() - 7 * i); weeks.push(w.toISOString().slice(0, 10)); }
    const chart = (r.weekly_fares || []).length
      ? bars(weeks.map(w => (byWeek.get(w) || {}).average_fare), weeks.map(w => { const x = byWeek.get(w); return `Week of ${date(w)}: ${x ? `${money(x.average_fare)} avg, ${plural(x.rides, 'ride', 'rides')}` : 'no rides'}`; })) +
        `<div class="flex justify-between mt-1.5 text-[10px] text-slate-500 stat-value"><span>${esc(date(weeks[0]).replace(/, \d{4}$/, ''))}</span><span>This week</span></div>`
      : empty(`No fares from ${d.name} ride receipts in the last 90 days.`);
    return head(d.name.toUpperCase(), 'Ride stats') +
      (has ? '' : `<p class="mb-3 text-sm text-slate-400 max-sm:text-xs">No contributed ride receipts in ${esc(d.name)} yet.</p>`) + t +
      `<div class="mt-3 max-sm:mt-2">${card(`<div class="flex items-baseline justify-between gap-3 mb-3">${cardTitle('Weekly average fare · last 90 days')}</div>${chart}
        <p class="text-[11px] text-slate-500 mt-2.5 max-sm:text-[10px]">From contributed ride receipts.</p>`)}</div>`;
  }

  function rowSightings(d) {
    const s = d.sightings || {};
    const has = s.total > 0;
    const peak = s.peak_hour ? hourLabel(s.peak_hour.hour) : '—';
    const spots = (s.top_spots || []).length
      ? `<ol class="mt-2 space-y-1.5">${s.top_spots.map((p, i) => `<li class="flex items-center gap-2 text-sm max-sm:text-xs"><span class="w-5 text-slate-500 stat-value">${i + 1}</span><span class="flex-1 min-w-0 truncate text-slate-200">${esc(p.location)}</span><span class="stat-value text-slate-400">${int(p.count)}</span></li>`).join('')}</ol>`
      : `<div class="mt-2">${empty('No sighting locations yet.')}</div>`;
    const latest = (s.latest || []).length
      ? `<div class="hr-scroll mt-2 pb-1">${s.latest.map(x => `<a href="/sightings${d.city === 'dallas' ? '?city=dallas' : ''}" class="block w-40 max-sm:w-32 rounded-xl overflow-hidden border border-white/[0.08] bg-white/[0.02] hover:border-[rgba(212,175,55,0.45)]">
          <img src="${esc(x.image_url)}" alt="${esc(`Cybercab sighting${x.location ? ` at ${x.location}` : ''}`)}" loading="lazy" decoding="async" class="block w-full aspect-[4/3] object-cover bg-panel">
          <span class="block px-2 py-1.5"><span class="block text-xs text-slate-200 truncate">${esc(x.location || x.city || 'Location not given')}</span><span class="block text-[10px] text-slate-500 truncate">${esc(when(x.spotted_at, x.time_zone))}</span></span>
        </a>`).join('')}</div>`
      : `<div class="mt-2">${empty(`No approved sightings in ${d.name} yet.`)}</div>`;
    return head(d.name.toUpperCase(), 'Sightings activity', { href: `/sightings${d.city === 'dallas' ? '?city=dallas' : ''}`, label: 'All sightings' }) +
      tiles('grid-cols-4 max-sm:grid-cols-4',
        tile('Last 24 hours', has ? int(s.last_24h) : '—') +
        tile('Last 7 days', has ? int(s.last_7_days) : '—') +
        tile('Busiest hour', esc(peak), s.peak_hour ? plural(s.peak_hour.count, 'sighting', 'sightings') : (has ? 'Not enough data yet' : '')) +
        tile('All approved', has ? int(s.total) : '—')) +
      `<div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] max-sm:mt-2 max-sm:gap-2">
        ${card(cardTitle('Top spots') + spots)}
        ${card(cardTitle('Latest sightings') + latest)}
      </div>`;
  }

  function rowCameras(d) {
    const c = d.cameras || {};
    const hourly = c.hourly || [];
    const chart = hourly.length
      ? bars(hourly.map(h => h.count), hourly.map(h => `${hourLabel(localHour(h.hour))}: ${plural(h.count, 'detection', 'detections')}`)) +
        `<div class="flex justify-between mt-1.5 text-[10px] text-slate-500 stat-value"><span>${esc(hourLabel(localHour(hourly[0].hour)))}</span><span>${esc(hourLabel(localHour(hourly[12].hour)))}</span><span>Now</span></div>`
      : '';
    return head(d.name.toUpperCase(), 'Camera watch') +
      `<p class="mb-3 text-xs text-slate-400 max-sm:mb-2 max-sm:text-[11px]"><span class="inline-flex items-center mr-1.5 px-2 py-0.5 rounded-full border border-dashed border-white/20 text-[10px] font-semibold uppercase tracking-wide text-slate-300">Experimental</span>Automated traffic-camera detections — separate from the human sightings above.</p>` +
      tiles('grid-cols-3 max-sm:grid-cols-3',
        tile('Cameras monitored', int(c.monitored)) +
        tile('Detections · 24\u00a0h', typeof c.detections_24h === 'number' ? int(c.detections_24h) : '—') +
        tile('Last detection', c.last_detection_at ? esc(ago(c.last_detection_at)) : '—', c.last_detection_at ? esc(when(c.last_detection_at)) : 'None yet')) +
      `<div class="mt-3 max-sm:mt-2">${card(`<div class="mb-3">${cardTitle('Detections per hour · last 24 hours')}</div>${chart}${c.detections_24h ? '' : `<p class="text-[11px] text-slate-500 mt-2.5">No detections in the last 24 hours.</p>`}`)}</div>`;
  }

  function rowFleet(d) {
    const f = d.fleet || {};
    if (!f.vehicles) {
      return head(d.name.toUpperCase(), 'Fleet') + card(`<div class="py-4 text-center max-sm:py-2">
        <div class="font-display font-bold text-gold tracking-wide">No ${esc(d.name)} Cybercabs in the registry yet</div>
        <p class="text-xs text-slate-400 mt-1.5">Ride one and add your receipt, or submit a sighting, to put the first one on the map.</p></div>`);
    }
    const breakdown = (title, list) => card(cardTitle(title) + `<ul class="mt-2 space-y-2">${list.slice(0, 5).map(x => `
      <li class="text-sm max-sm:text-xs"><div class="flex justify-between gap-2"><span class="truncate text-slate-200">${esc(x.label)}</span><span class="stat-value text-slate-400">${int(x.count)}</span></div>
      <div class="h-1.5 mt-1 rounded-full bg-white/[0.06] overflow-hidden"><div class="h-full rounded-full bg-gold/70" style="width:${Math.round((x.count / f.vehicles) * 100)}%"></div></div></li>`).join('')}</ul>`);
    const newest = card(cardTitle('Newest additions') + `<ol class="mt-1">${(f.newest || []).map(v => `
      <li><a href="/vehicle/${encodeURIComponent(v.id)}" class="flex items-center gap-3 min-h-[44px] -mx-2 px-2 rounded-lg hover:bg-white/[0.03]">
        <span class="font-display font-bold tracking-[0.12em] text-sm text-white max-sm:text-xs">${esc(v.license_plate || 'No plate')}</span>
        <span class="flex-1 min-w-0 truncate text-xs text-slate-400">${esc([v.model, v.color].filter(Boolean).join(' · '))}</span>
        <span class="shrink-0 text-xs text-slate-500 stat-value">${esc(date(v.added_at))}</span>
      </a></li>`).join('')}</ol>`);
    return head(d.name.toUpperCase(), 'Fleet', { href: `/vehicles${d.city === 'dallas' ? '?city=dallas' : ''}`, label: 'All vehicles' }) +
      `<div class="grid gap-3 grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] max-sm:gap-2">
        ${breakdown('By model', f.models || [])}${breakdown('By color', f.colors || [])}
        <div class="col-span-2 lg:col-span-1 min-w-0">${newest}</div>
      </div>`;
  }

  function rowSpotters(d) {
    const list = d.spotters || [];
    const body = list.length
      ? `<ol class="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-1">${list.map(e => {
          const inner = `<span class="w-6 text-center stat-value font-semibold ${e.rank === 1 ? 'text-gold' : 'text-slate-400'}">${e.rank}</span>
            <span class="w-9 h-9 shrink-0 rounded-lg overflow-hidden"><span class="block w-full h-full" data-avatar-url="${esc(e.avatar_url || '')}" data-avatar-name="${esc(e.name)}"></span></span>
            <span class="flex-1 min-w-0"><span class="block text-sm font-semibold text-slate-100 truncate">${esc(e.name)}</span><span class="block text-xs ${e.handle ? 'text-gold' : 'text-slate-500'} truncate">${e.handle ? `@${esc(e.handle)}` : 'No public profile yet'}</span></span>
            <span class="shrink-0 text-right"><span class="block stat-value font-semibold text-white">${int(e.count)}</span><span class="block text-[10px] uppercase tracking-wide text-slate-500">${e.count === 1 ? 'vehicle' : 'vehicles'}</span></span>`;
          return `<li>${e.profile && e.handle
            ? `<a href="/rider/${encodeURIComponent(e.handle)}" class="flex items-center gap-3 min-h-[52px] -mx-2 px-2 rounded-xl hover:bg-white/[0.03]">${inner}</a>`
            : `<div class="flex items-center gap-3 min-h-[52px] -mx-2 px-2">${inner}</div>`}</li>`;
        }).join('')}</ol>`
      : empty(`No one has discovered a ${d.name} Cybercab yet.`);
    return head(d.name.toUpperCase(), 'Top spotters', { href: '/community', label: 'View all leaderboards' }) +
      card(`<p class="text-xs text-slate-500 mb-2">Most vehicles discovered in ${esc(d.name)}: the first to ride in one, or to spot it with an approved sighting.</p>${body}`);
  }

  const ROWS = { area: rowArea, rides: rowRides, sightings: rowSightings, cameras: rowCameras, fleet: rowFleet, spotters: rowSpotters };
  const skeleton = `<div class="h-6 w-40 rounded bg-white/[0.05] animate-pulse mb-4"></div><div class="h-24 rounded-2xl bg-white/[0.03] animate-pulse"></div>`;
  const rowEls = () => [...document.querySelectorAll('#cityRows [data-row]')];

  let seq = 0;
  function render(city) {
    const mine = ++seq;
    const els = rowEls();
    if (!els.length || !window.CCHHomeData) return;
    els.forEach(el => { el.innerHTML = skeleton; el.setAttribute('aria-busy', 'true'); });
    window.CCHHomeData.get(city).then(d => {
      if (mine !== seq) return;
      els.forEach(el => {
        el.removeAttribute('aria-busy');
        try { el.innerHTML = ROWS[el.dataset.row](d); } catch (e) { el.innerHTML = ''; }
      });
      document.querySelectorAll('#rowSpotters [data-avatar-name]').forEach(el => {
        if (window.CCC && CCC.renderAvatar) CCC.renderAvatar(el, { url: el.dataset.avatarUrl || null, name: el.dataset.avatarName, size: 128 });
      });
    }).catch(() => {
      if (mine !== seq) return;
      els.forEach(el => { el.removeAttribute('aria-busy'); el.innerHTML = ''; });
      els[0].innerHTML = card(`<div class="py-4 text-center"><div class="font-display font-bold tracking-wide">We couldn't load the city details</div><p class="text-xs text-slate-400 mt-1.5">Please try again in a moment.</p></div>`);
    });
  }

  window.setHomeRowsCity = city => render(city === 'dallas' ? 'dallas' : 'austin');
  render('austin');
})();
