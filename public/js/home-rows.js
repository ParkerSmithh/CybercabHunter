/* Homepage city rows: the service-area facts inside SERVICE ZONES
   (#rowArea), then RIDE STATS and SIGHTINGS ACTIVITY (which includes the
   automated Camera watch) in #cityRows. They follow the page's
   Austin / Dallas tabs (window.setHomeRowsCity, called by the tab code) and are
   drawn from one response, GET /api/homepage-stats?city= (worker/
   homepage-stats.js), shared with the stats bar through window.CCHHomeData
   (js/home-stats.js; kept five minutes, re-read every five while the tab is
   visible, so the LIVE badges stay honest).
   Every block follows the same pattern: a big number, a label and a
   sub-metric line (never a bare number); charts with time-range buttons; a
   footnote naming the source; an "About these numbers" note; a "See all"
   link. A number is only ever one the server sent; where there is no data
   the block says so ("—" or a short line), never a made-up 0. The small stat
   tiles carry the border glow ([data-glow], js/main.js). */
(function () {
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ZONE = 'America/Chicago';
  const REFRESH_MS = 5 * 60 * 1000;
  const money = v => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');
  const int = v => (typeof v === 'number' ? v.toLocaleString('en-US') : '—');
  const one = v => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
  const plural = (n, a, b) => `${int(n)} ${n === 1 ? a : b}`;
  const date = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  const shortDate = iso => date(iso).replace(/, \d{4}$/, '');
  const clock = hhmm => { if (!hhmm) return '—'; const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'AM' : 'PM'}`; };
  const hourLabel = h => `${((h + 11) % 12) + 1}${h < 12 ? 'AM' : 'PM'}`;
  const localHour = iso => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso))) % 24;
  const when = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz || ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  // "+3 vs previous 24 h" / "Same as …" / "Up from 0 …"
  function delta(cur, prev, label, pct = false) {
    if (typeof cur !== 'number' || typeof prev !== 'number') return '';
    if (cur === prev) return cur ? `Same as ${label}` : `None in ${label} either`;
    if (!prev) return `Up from 0 ${label}`;
    if (pct) { const p = Math.round(((cur - prev) / prev) * 100); return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}% vs ${label}`; }
    return `${cur > prev ? '+' : '−'}${int(Math.abs(cur - prev))} vs ${label}`;
  }

  // ---- shared pieces ----
  const seeAll = (href, label, title) => `<a href="${esc(href)}" aria-label="${esc(title)}" class="shrink-0 inline-flex items-center gap-1 min-h-[44px] text-sm font-semibold text-gold hover:underline max-sm:text-xs">${esc(label)}<span aria-hidden="true">→</span></a>`;
  const liveBadge = iso => `<span class="hr-live inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-[rgba(52,211,153,0.35)] bg-[rgba(52,211,153,0.08)] text-[10px] font-semibold uppercase tracking-wide text-emerald-300"><span class="relative flex w-1.5 h-1.5"><span class="absolute inset-0 rounded-full bg-emerald-400 opacity-75 animate-ping motion-reduce:animate-none"></span><span class="relative w-1.5 h-1.5 rounded-full bg-emerald-400"></span></span>Live · <span data-updated="${esc(iso || '')}">updated ${esc(iso ? ago(iso) : '—')}</span></span>`;
  const head = (city, title, badges, link) => `
    <div class="home-data-heading">
      <div class="min-w-0"><p class="home-data-city">${esc(city)}</p><div class="home-data-title-row"><h2 class="font-display font-bold">${esc(title)}</h2>${badges || ''}</div></div>
      ${link || ''}
    </div>`;
  const metric = (label, value, sub) => `<dl class="home-data-metric"><dt>${esc(label)}</dt>
<dd class="home-data-value stat-value">${value}</dd>
<dd class="home-data-note">${sub || '&nbsp;'}</dd></dl>`;
  const tile = (label, value, sub) => `
    <div data-glow class="glass rounded-xl p-4 min-w-0 max-sm:px-2.5 max-sm:py-2.5">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500 truncate max-sm:whitespace-normal max-sm:leading-tight max-sm:min-h-[2.5em] max-sm:text-[9px] max-sm:tracking-normal">${esc(label)}</div>
      <div class="stat-value font-semibold text-2xl text-white mt-1.5 truncate max-sm:text-base max-sm:mt-0.5">${value}</div>
      <div class="text-[11px] text-slate-500 mt-1 truncate max-sm:whitespace-normal max-sm:leading-tight max-sm:text-[9px] max-sm:mt-0.5">${sub || '&nbsp;'}</div>
    </div>`;
  const tiles = (cls, inner) => `<div class="grid gap-3 ${cls} max-sm:gap-1.5">${inner}</div>`;
  const card = (inner, cls = '') => `<div class="glass rounded-2xl p-5 min-w-0 max-sm:p-3 ${cls}">${inner}</div>`;
  const cardTitle = t => `<div class="text-[11px] font-semibold uppercase tracking-wide text-slate-400 max-sm:text-[10px]">${esc(t)}</div>`;
  const empty = text => `<p class="text-sm text-slate-400 max-sm:text-xs">${esc(text)}</p>`;
  const footnote = text => `<p class="mt-2.5 text-[11px] text-slate-500 max-sm:mt-2 max-sm:text-[10px]">${esc(text)}</p>`;
  const about = text => `<details class="hr-about mt-2 text-xs text-slate-400 max-sm:text-[11px]"><summary class="inline-flex items-center gap-1.5 min-h-[44px] cursor-pointer select-none font-semibold text-slate-300 hover:text-white">About these numbers<svg class="w-3.5 h-3.5 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></summary><p class="max-w-3xl pb-1 leading-relaxed">${esc(text)}</p></details>`;
  // Thin stems scaled to the largest value; zero values stay on the baseline.
  function bars(values, titles) {
    const max = Math.max(0, ...values.filter(v => typeof v === 'number'));
    return `<div class="hr-bars" role="img" aria-label="${esc(titles.filter((_, i) => values[i]).join('; ') || 'No data in this window')}">${values.map((v, i) =>
      typeof v === 'number' && v > 0 && max > 0
        ? `<span style="height:${Math.max(4, Math.round((v / max) * 100))}%;--pulse-delay:${(i % 7) * -0.24}s" title="${esc(titles[i])}"></span>`
        : `<span class="is-empty" title="${esc(titles[i])}"></span>`).join('')}</div>`;
  }
  // Which window each chart shows (kept across city switches).
  const state = { fares: '90D', sightings: '24H', detections: '30D' };
  const DAYS = { '7D': 7, '30D': 30, '90D': 90, '6M': 182, '1Y': 365 };
  // Range buttons for one chart (the Fleet Growth chart's look; 44px on phones).
  const rangeBtns = (chart, ranges) => `<div class="flex items-center gap-1 shrink-0" role="group" aria-label="Time range">${ranges.map(r =>
    `<button type="button" data-chart="${chart}" data-range="${r}" aria-pressed="${state[chart] === r}" class="hr-range text-xs font-semibold px-2 py-1 max-sm:min-h-[44px] max-sm:min-w-[40px]">${r}</button>`).join('')}</div>`;
  const chartCard = (chart, title, ranges, body, note) => card(`
    <div class="flex items-center justify-between gap-3 mb-3 max-sm:mb-2">${cardTitle(title)}${rangeBtns(chart, ranges)}</div>
    <div data-chart-body="${chart}">${body}</div>${note ? footnote(note) : ''}`);
  const axis = (l, m, r) => `<div class="flex justify-between mt-1.5 text-[10px] text-slate-500 stat-value"><span>${esc(l)}</span>${m != null ? `<span>${esc(m)}</span>` : ''}<span>${esc(r)}</span></div>`;

  // ---- charts ----
  function faresChart(d) {
    const weeks = (d.rides && d.rides.weekly_fares) || [];
    if (!weeks.length) return empty(`No fares from ${d.name} ride receipts yet.`);
    const byWeek = new Map(weeks.map(w => [w.week, w]));
    const monday = new Date(); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const first = state.fares === 'All' ? new Date(`${weeks[0].week}T00:00:00Z`) : new Date(monday.getTime() - (Math.ceil(DAYS[state.fares] / 7) - 1) * 7 * 864e5);
    const list = [];
    for (let t = first.getTime(); t <= monday.getTime(); t += 7 * 864e5) list.push(new Date(t).toISOString().slice(0, 10));
    if (!list.some(w => byWeek.has(w))) return empty('No fares in this window. Try a longer one.');
    return bars(list.map(w => (byWeek.get(w) || {}).average_fare), list.map(w => { const x = byWeek.get(w); return `Week of ${shortDate(w)}: ${x ? `${money(x.average_fare)} average, ${plural(x.rides, 'ride', 'rides')}` : 'no rides'}`; })) +
      axis(shortDate(list[0]), null, 'This week');
  }
  function sightingsChart(d) {
    const s = d.sightings || {};
    if (state.sightings === '24H') {
      const h = s.hourly || [];
      if (!h.length) return empty('No sightings data.');
      return bars(h.map(x => x.count), h.map(x => `${hourLabel(localHour(x.hour))}: ${plural(x.count, 'sighting', 'sightings')}`)) +
        axis(hourLabel(localHour(h[0].hour)), hourLabel(localHour(h[12].hour)), 'Now') + (h.some(x => x.count) ? '' : footnote('No sightings in the last 24 hours.'));
    }
    const days = (s.daily || []).slice(-DAYS[state.sightings]);
    if (!days.length) return empty('No sightings data.');
    return bars(days.map(x => x.count), days.map(x => `${shortDate(x.date)}: ${plural(x.count, 'sighting', 'sightings')}`)) +
      axis(shortDate(days[0].date), null, 'Today') + (days.some(x => x.count) ? '' : footnote('No sightings in this window.'));
  }
  function detectionsChart(d) {
    const c = d.cameras || {};
    if (state.detections === '24H') {
      const h = c.hourly || [];
      if (!h.length) return empty('No detection data.');
      return bars(h.map(x => x.count), h.map(x => `${hourLabel(localHour(x.hour))}: ${plural(x.count, 'detection', 'detections')}`)) +
        axis(hourLabel(localHour(h[0].hour)), hourLabel(localHour(h[12].hour)), 'Now') + (c.detections_24h ? '' : footnote('No detections in the last 24 hours.'));
    }
    const have = new Map((c.daily || []).map(x => [x.date, x.count]));
    if (!have.size) return empty(`No camera detections in ${d.name} yet.`);
    // Today's local date, then back day by day.
    const ymd = t => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
    const now = Date.now();
    const span = state.detections === 'All'
      ? Math.max(1, Math.round((Date.parse(`${ymd(now)}T12:00:00Z`) - Date.parse(`${c.daily[0].date}T12:00:00Z`)) / 864e5) + 1)
      : DAYS[state.detections];
    const list = [];
    for (let i = span - 1; i >= 0; i--) list.push(ymd(now - i * 864e5));
    return bars(list.map(x => have.get(x) || 0), list.map(x => `${shortDate(x)}: ${plural(have.get(x) || 0, 'detection', 'detections')}`)) +
      axis(shortDate(list[0]), null, 'Today') + (list.some(x => have.get(x)) ? '' : footnote('No detections in this window.'));
  }
  const CHARTS = { fares: faresChart, sightings: sightingsChart, detections: detectionsChart };

  // ---- the rows ----
  // Part of the SERVICE ZONES section (above the minimap and the fleet chart),
  // so it has no heading of its own and no map thumbnail; the minimap's "See
  // Map" opens the full map.
  function rowArea(d) {
    const a = d.area || {};
    const hours = a.hours ? `${clock(a.hours.open)} – ${clock(a.hours.close)}` : '—';
    const span = a.hours ? ((Number(a.hours.close.split(':')[0]) - Number(a.hours.open.split(':')[0]) + 24) % 24 || 24) : null;
    const days = a.in_service_since ? Math.max(0, Math.floor((Date.now() - Date.parse(`${a.in_service_since}T06:00:00Z`)) / 864e5)) : null;
    const density = a.vehicles && a.square_miles ? `≈ ${one(Math.round((a.vehicles / a.square_miles) * 100) / 10)} vehicles per 10 mi²` : 'No vehicles documented yet';
    const added = a.vehicles ? `+${int(a.vehicles_added_7d || 0)} this week · ${int(a.vehicles_added_prev_7d || 0)} the week before` : 'None in the registry yet';
    return `<p class="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400 max-sm:text-[10px]">Service area · <span class="text-gold">${esc(d.name.toUpperCase())}</span></p>` +
      tiles('grid-cols-4 max-sm:grid-cols-2',
        tile('Coverage', typeof a.square_miles === 'number' ? `${int(a.square_miles)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">mi²</span>` : '—', esc(density)) +
        tile('In service since', esc(date(a.in_service_since)), days != null ? `${int(days)} days of service` : '') +
        tile('Vehicles documented', int(a.vehicles), esc(added)) +
        tile('Service hours', esc(hours), span ? `${span} hours a day · Central` : '')) +
      (a.description ? `<p class="mt-3 text-sm text-slate-400 leading-relaxed max-sm:mt-2 max-sm:text-xs max-sm:leading-snug">${esc(a.description)}</p>` : '') +
      footnote('Zone facts as published for the service area; vehicles from the public registry.') +
      about('Coverage, launch date and hours are the published figures for the zone (the Zones page shows the same). Vehicles documented counts the public registry\'s Cybercabs in this city: its own city, or, with none set, where its counted rides were.');
  }

  function rowRides(d) {
    const r = d.rides || {};
    const tile = metric;
    const has = r.rides > 0;
    return `<div class="home-data-panel home-rides-panel">` + head(d.name.toUpperCase(), 'RIDE STATS', '', seeAll('/simulation?view=eta', 'See all', 'See fares and pickup waits on Fleet ETA')) +
      (has ? '' : `<p class="mb-3 text-sm text-slate-400 max-sm:text-xs">No contributed ride receipts in ${esc(d.name)} yet.</p>`) +
      `<div class="home-rides-layout"><div class="home-rides-summary">` + tiles('home-rides-metrics',
        tile('Rides', has ? int(r.rides) : '—', has ? `${int(r.rides_30d)} in the last 30 days` : 'No receipts yet') +
        tile('Miles', has && r.miles != null ? one(r.miles) : '—', has ? `Across ${plural(r.rides, 'ride', 'rides')}` : '') +
        tile('Avg fare', money(r.average_fare), r.median_fare != null ? `Median ${money(r.median_fare)} · ${plural(r.fare_rides, 'ride', 'rides')}` : '') +
        tile('Per mile', money(r.per_mile), r.per_mile != null ? 'Total fares ÷ total miles' : '') +
        tile('Avg trip', r.average_miles != null ? `${one(r.average_miles)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">mi</span>` : '—', r.longest_miles != null ? `Longest ${one(r.longest_miles)} mi` : '') +
        tile('Avg duration', r.average_minutes != null ? `${one(r.average_minutes)}<span class="text-base text-slate-400 ml-1 max-sm:text-[10px]">min</span>` : '—', r.minutes_rides ? `From ${plural(r.minutes_rides, 'ride', 'rides')} with a time` : (has ? 'No ride times on receipts yet' : ''))) +
      footnote('From contributed ride receipts.') + `</div>` +
      `<div class="home-fares-chart">${chartCard('fares', 'Weekly average fare', ['90D', '6M', '1Y', 'All'], faresChart(d), '')}</div></div>` +
      about('Counted rides only: accepted receipts (pending or approved), never ones under review or rejected, and a ride two riders shared counts once. Rides on a private vehicle are left out. The average fare is the mean per ride; per mile is all fares divided by all miles, so one short ride can\'t skew it.') + `</div>`;
  }

  // One section: human sightings, then the automated camera watch (labelled
  // Experimental, kept apart in its own tiles and chart, never added to the
  // sightings), under one heading, one LIVE badge and one note.
  function rowSightings(d) {
    const s = d.sightings || {}, c = d.cameras || {};
    const tile = metric;
    const has = s.total > 0;
    const city = d.city === 'dallas' ? '?city=dallas' : '';
    const spots = (s.top_spots || []).length
      ? `<ol class="mt-2 space-y-1.5">${s.top_spots.map((p, i) => `<li class="flex items-center gap-2 text-sm max-sm:text-xs"><span class="w-5 text-slate-500 stat-value">${i + 1}</span><span class="flex-1 min-w-0 truncate text-slate-200">${esc(p.location)}</span><span class="stat-value text-slate-400">${plural(p.count, 'sighting', 'sightings')}</span></li>`).join('')}</ol>`
      : `<div class="mt-2">${empty('No sighting locations yet.')}</div>`;
    const latest = (s.latest || []).length
      ? `<ol class="mt-1 divide-y divide-white/[0.06]">${s.latest.map(x => `<li><a href="/sightings${city}" class="flex items-center gap-3 min-h-[56px] py-1.5 -mx-2 px-2 rounded-lg hover:bg-white/[0.03]">
          <img src="${esc(x.image_url)}" alt="" loading="lazy" decoding="async" class="w-14 h-10 shrink-0 rounded-md object-cover bg-panel border border-white/[0.06]">
          <span class="flex-1 min-w-0"><span class="block text-sm text-slate-100 truncate max-sm:text-xs">Cybercab seen ${x.location ? `at ${esc(x.location)}` : `in ${esc(x.city || d.name)}`}</span><span class="block text-[11px] text-slate-500 truncate">${esc([x.plate, when(x.spotted_at, x.time_zone)].filter(Boolean).join(' · '))}</span></span>
          <span class="shrink-0 text-xs text-slate-400 stat-value">${esc(ago(x.spotted_at))}</span>
        </a></li>`).join('')}</ol>`
      : `<div class="mt-2">${empty(`No approved sightings in ${d.name} yet.`)}</div>`;
    const sub = (label, extra) => `<div class="mt-6 mb-2 flex flex-wrap items-center gap-2 max-sm:mt-4">${cardTitle(label)}${extra || ''}</div>`;
    return `<div class="home-data-panel home-activity-panel">` + head(d.name.toUpperCase(), 'SIGHTINGS ACTIVITY', liveBadge(d.generated_at), seeAll(`/sightings${city}`, 'See all', `See all ${d.name} sightings`)) +
      `<div class="home-activity-summary"><div class="home-human-metrics">` + sub('Approved sightings') +
      tiles('home-sighting-metrics',
        tile('Last 24 hours', has ? int(s.last_24h) : '—', has ? esc(delta(s.last_24h, s.prev_24h, 'previous 24 h')) : 'No sightings yet') +
        tile('Last 7 days', has ? int(s.last_7_days) : '—', has ? esc(delta(s.last_7_days, s.prev_7_days, 'prior 7 days', true)) : '') +
        tile('Busiest hour', s.peak_hour ? esc(hourLabel(s.peak_hour.hour)) : '—', s.peak_hour ? `${plural(s.peak_hour.count, 'sighting', 'sightings')} at that hour` : (has ? 'Not enough data yet' : '')) +
        tile('All approved', has ? int(s.total) : '—', s.first_day ? `Since ${esc(shortDate(s.first_day))}` : '')) +
      footnote('From approved sightings.') + `</div><div class="home-camera-metrics">` + sub('Camera detections') +
      tiles('home-camera-grid',
        tile('Cameras monitored', int(c.monitored), typeof c.reporting_24h === 'number' ? `${int(c.reporting_24h)} reported in the last 24 h` : '') +
        tile('Detections · 24 h', typeof c.detections_24h === 'number' ? int(c.detections_24h) : '—', esc(delta(c.detections_24h, c.prev_24h, 'previous 24 h'))) +
        tile('Last detection', c.last_detection_at ? esc(ago(c.last_detection_at)) : '—', c.last_detection_at ? esc([c.last_camera, when(c.last_detection_at)].filter(Boolean).join(' · ')) : 'None yet')) +
      footnote('From automated camera detections — separate from the human sightings above.') + `</div></div>` +
      `<div class="mt-4 grid gap-3 lg:grid-cols-2 max-sm:mt-3 max-sm:gap-2">
        ${chartCard('sightings', 'Sightings', ['24H', '7D', '30D', '90D'], sightingsChart(d), 'From approved sightings.')}
        ${chartCard('detections', 'Camera detections', ['24H', '30D', '90D', 'All'], detectionsChart(d), 'From automated camera detections.')}
      </div>
      <div class="mt-3 grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] max-sm:mt-2 max-sm:gap-2">
        ${card(cardTitle('Top spots') + spots + footnote('From approved sightings.'))}
        ${card(`<div class="flex items-center justify-between gap-3">${cardTitle('Latest sightings')}${seeAll(`/sightings${city}`, 'See all', `See all ${d.name} sightings`)}</div>${latest}${footnote('From approved sightings.')}`)}
      </div>` +
      about('Sightings are approved photo sightings only, by when the Cybercab was spotted; pending and rejected ones never count, and the busiest hour needs a clear peak (at least two sightings in that hour, no tie). The camera check is automated and experimental: it checks public traffic-camera images and records a detection when it spots a Cybercab, can miss a car or misread one, and is never added to the sightings.') + `</div>`;
  }

  const ROWS = { area: rowArea, rides: rowRides, sightings: rowSightings };
  const skeleton = `<div class="h-6 w-40 rounded bg-white/[0.05] animate-pulse mb-4"></div><div class="h-24 rounded-2xl bg-white/[0.03] animate-pulse"></div>`;
  const rowEls = () => [...document.querySelectorAll('[data-row]')];

  let seq = 0, current = null, city = 'austin';
  function draw(d) {
    current = d;
    rowEls().forEach(el => {
      el.removeAttribute('aria-busy');
      try { el.innerHTML = ROWS[el.dataset.row](d); } catch (e) { el.innerHTML = ''; }
    });
  }
  function render(next, { quiet = false } = {}) {
    city = next;
    const mine = ++seq;
    const els = rowEls();
    if (!els.length || !window.CCHHomeData) return;
    if (!quiet) els.forEach(el => { el.innerHTML = skeleton; el.setAttribute('aria-busy', 'true'); });
    window.CCHHomeData.get(next).then(d => { if (mine === seq) draw(d); }).catch(() => {
      if (mine !== seq || quiet) return;
      els.forEach(el => { el.removeAttribute('aria-busy'); el.innerHTML = ''; });
      els[0].innerHTML = card(`<div class="py-4 text-center"><div class="font-display font-bold tracking-wide">We couldn't load the city details</div><p class="text-xs text-slate-400 mt-1.5">Please try again in a moment.</p></div>`);
    });
  }

  // A range button redraws only its chart (and its buttons).
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#cityRows [data-chart][data-range]');
    if (!b || !current) return;
    state[b.dataset.chart] = b.dataset.range;
    const body = document.querySelector(`#cityRows [data-chart-body="${b.dataset.chart}"]`);
    if (body) body.innerHTML = CHARTS[b.dataset.chart](current);
    b.parentElement.querySelectorAll('[data-range]').forEach(x => {
      const on = x.dataset.range === state[b.dataset.chart];
      x.setAttribute('aria-pressed', String(on));
    });
  });
  // "updated Xm ago" keeps counting; the data itself is re-read every 5 minutes while visible.
  setInterval(() => document.querySelectorAll('#cityRows [data-updated]').forEach(el => { if (el.dataset.updated) el.textContent = `updated ${ago(el.dataset.updated)}`; }), 30 * 1000);
  setInterval(() => { if (!document.hidden) render(city, { quiet: true }); }, REFRESH_MS);

  window.setHomeRowsCity = c => render(c === 'dallas' ? 'dallas' : 'austin');
  render('austin');
})();
