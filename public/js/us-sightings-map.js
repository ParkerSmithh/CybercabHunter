/* "Cybercab sightings across the US" (index.html [data-us-map], below the
   Texas DMV panel). A fixed SVG picture of the US — no map service, no pan or
   zoom — from js/us-sightings-data.js: states with a reported Cybercab sighting
   are tinted gold, each city is a dot (larger where more sightings were
   logged; its name on hover / focus), and beside it the cities grouped by
   state, the busiest first. No sighting counts are shown. Community-reported
   data, credited. */
(function () {
  const els = [...document.querySelectorAll('[data-us-map]')];
  const D = window.CCH_US_MAP;
  if (!els.length || !D) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sighted = new Set(D.sighted);
  const byState = {};
  for (const c of D.cities) (byState[c.st] = byState[c.st] || []).push(c);
  const byCount = (a, b) => ((b.n || 0) - (a.n || 0)) || a.name.localeCompare(b.name);
  Object.values(byState).forEach(cs => cs.sort(byCount));
  const sumOf = cs => cs.reduce((t, c) => t + (c.n || 0), 0);
  // Cities listed per state before "+N more" (fewer on a phone), and on a
  // phone, the states listed before "Show all states".
  const phone = window.matchMedia && window.matchMedia('(max-width: 639px)').matches;
  const SHOWN = phone ? 4 : 8;
  const PHONE_STATES = 6;
  const radius = c => (c.n ? 2.6 + Math.sqrt(c.n) * 1.1 : 3.2);
  const label = c => `${c.name}, ${c.st}${c.note ? ` (${c.note})` : ''}`;
  const nameOf = Object.fromEntries(D.states.map(s => [s.id, s.name]));
  const stateCount = D.sighted.filter(id => id !== 'DC').length;
  // The list: states with a named city (most cities first); the states with
  // a report but no named city share one closing line.
  const withCities = D.sighted.filter(id => byState[id]).sort((a, b) => (sumOf(byState[b]) - sumOf(byState[a])) || (byState[b].length - byState[a].length) || nameOf[a].localeCompare(nameOf[b]));
  const others = D.sighted.filter(id => !byState[id]).sort((a, b) => nameOf[a].localeCompare(nameOf[b]));

  const map = `<svg viewBox="${D.viewBox}" class="us-map w-full h-auto block" role="img" aria-label="${esc(`Map of the United States: ${stateCount} states and DC with reported Cybercab sightings, ${D.cities.length} named cities`)}">
      <g class="us-states">${D.states.map(s => `<path d="${s.d}" class="${sighted.has(s.id) ? 'is-sighted' : ''}" data-state="${s.id}"><title>${esc(s.name)}${sighted.has(s.id) ? ' · sightings reported' : ''}</title></path>`).join('')}</g>
      <g class="us-cities">${D.cities.map((c, i) => [c, i]).sort((a, b) => radius(b[0]) - radius(a[0])).map(([c, i]) => `<g class="us-city" tabindex="0" data-city="${i}" transform="translate(${c.x} ${c.y})"><circle class="us-city-halo" r="${(radius(c) + 4).toFixed(1)}"></circle><circle class="us-city-dot" r="${radius(c).toFixed(1)}"></circle><title>${esc(label(c))}</title></g>`).join('')}</g>
    </svg>`;

  const list = withCities.map((id, k) => {
    const cs = byState[id];
    return `<li class="us-state-row${cs.length >= 2 ? ' us-row-wide' : ''}${k >= PHONE_STATES ? ' us-row-extra' : ''}" data-state-row="${id}">
        <div class="flex items-baseline justify-between gap-3"><span class="text-sm font-semibold text-slate-100 max-sm:text-[13px]">${esc(nameOf[id])}</span><span class="text-xs text-slate-500 tabular-nums max-sm:text-[11px]${cs.length === 1 ? ' max-sm:hidden' : ''}">${cs.length} ${cs.length === 1 ? 'city' : 'cities'}</span></div>
        <p class="mt-0.5 text-xs text-slate-400 leading-relaxed max-sm:text-[11px] max-sm:leading-snug">${cs.map((c, i) => `<span${i >= SHOWN ? ' class="hidden" data-more' : ''}>${i ? ' · ' : ''}${esc(c.name)}${c.note ? ` <span class="text-slate-500">(${esc(c.note)})</span>` : ''}</span>`).join('')}${cs.length > SHOWN ? ` <button type="button" data-more-btn class="text-gold hover:underline whitespace-nowrap">+${cs.length - SHOWN} more</button>` : ''}</p>
      </li>`;
  }).join('') + (others.length ? `<li class="us-state-row us-row-wide us-row-extra">
        <div class="text-sm font-semibold text-slate-100 max-sm:text-[13px]">Also reported in</div>
        <p class="mt-0.5 text-xs text-slate-400 leading-relaxed max-sm:text-[11px] max-sm:leading-snug">${others.map(id => `<span data-state-row="${id}" class="hover:text-slate-200">${esc(nameOf[id])}</span>`).join(' · ')}</p>
      </li>` : '');

  const html = `<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div class="min-w-0">
        <h2 class="font-display font-bold text-xl text-white uppercase tracking-wide max-sm:text-base">Cybercab sightings across the US</h2>
        <p class="text-xs text-slate-500 mt-0.5">Every state and city where a Cybercab has been reported</p>
      </div>
      <dl class="flex gap-6 max-sm:gap-4">
        <div><dt class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">States</dt><dd class="stat-value text-2xl font-semibold text-gold leading-tight">${stateCount}<span class="text-sm text-slate-500"> + DC</span></dd></div>
        <div><dt class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Cities</dt><dd class="stat-value text-2xl font-semibold text-white leading-tight">${D.cities.length}</dd></div>
      </dl>
    </div>
    <div class="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] max-sm:mt-4 max-sm:gap-4">
      <div class="min-w-0">
        ${map}
        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm us-key-sighted"></span>Sightings reported</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm us-key-none"></span>None reported</span>
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-gold"></span>City with a sighting (larger: more)</span>
        </div>
      </div>
      <ul data-us-list class="us-state-list min-w-0 divide-y divide-white/[0.06] max-sm:divide-y-0 lg:max-h-[440px] lg:overflow-y-auto lg:pr-2">${list}</ul>
      ${withCities.length > PHONE_STATES ? `<button type="button" data-all-states class="sm:hidden -mt-2 w-full min-h-[40px] rounded-lg border border-white/10 text-xs font-semibold text-slate-200 hover:bg-white/5">Show all ${withCities.length + (others.length ? others.length : 0)} states</button>` : ''}
    </div>
    <p class="mt-4 text-[11px] text-slate-500 leading-relaxed">Community-reported sightings from ${D.sources.map(src => `the <a href="${esc(src.url)}" target="_blank" rel="noopener" class="underline hover:text-slate-300">${esc(src.name)}</a> ${esc(src.what)} (${esc(src.date)})`).join(' and ')}. Not verified by Cybercab Hunter. Map: US Census state boundaries.</p>`;

  els.forEach(el => {
    el.innerHTML = html;
    // Hovering or focusing a state row lights that state and its cities on the map.
    const svg = el.querySelector('svg');
    const light = id => {
      svg.querySelectorAll('[data-state]').forEach(p => p.classList.toggle('is-lit', p.dataset.state === id));
      svg.querySelectorAll('.us-city').forEach(g => g.classList.toggle('is-lit', !!id && D.cities[g.dataset.city].st === id));
    };
    const all = el.querySelector('[data-all-states]');
    if (all) all.addEventListener('click', () => { el.querySelector('[data-us-list]').classList.add('is-expanded'); all.remove(); });
    // "+N more": show the rest of that state's cities.
    el.querySelectorAll('[data-more-btn]').forEach(btn => btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('[data-more]').forEach(x => x.classList.remove('hidden'));
      btn.remove();
    }));
    el.querySelectorAll('[data-state-row]').forEach(row => {
      row.addEventListener('mouseenter', () => light(row.dataset.stateRow));
      row.addEventListener('mouseleave', () => light(null));
    });
  });
})();
