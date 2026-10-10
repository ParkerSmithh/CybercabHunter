/* "Cybercab sightings across the US" (index.html [data-us-map], below the
   Texas DMV panel). A fixed SVG picture of the US — no map service, no pan or
   zoom — from js/us-sightings-data.js: states with a reported Cybercab sighting
   are tinted gold, each named city is a dot (its name on hover / focus), and
   beside it the cities grouped by state. Community-reported data, credited. */
(function () {
  const els = [...document.querySelectorAll('[data-us-map]')];
  const D = window.CCH_US_MAP;
  if (!els.length || !D) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sighted = new Set(D.sighted);
  const byState = {};
  for (const c of D.cities) (byState[c.st] = byState[c.st] || []).push(c);
  const nameOf = Object.fromEntries(D.states.map(s => [s.id, s.name]));
  const stateCount = D.sighted.filter(id => id !== 'DC').length;
  // The list: states with a named city (most cities first); the states with
  // a report but no named city share one closing line.
  const withCities = D.sighted.filter(id => byState[id]).sort((a, b) => (byState[b].length - byState[a].length) || nameOf[a].localeCompare(nameOf[b]));
  const others = D.sighted.filter(id => !byState[id]).sort((a, b) => nameOf[a].localeCompare(nameOf[b]));

  const map = `<svg viewBox="${D.viewBox}" class="us-map w-full h-auto block" role="img" aria-label="${esc(`Map of the United States: ${stateCount} states and DC with reported Cybercab sightings, ${D.cities.length} named cities`)}">
      <g class="us-states">${D.states.map(s => `<path d="${s.d}" class="${sighted.has(s.id) ? 'is-sighted' : ''}" data-state="${s.id}"><title>${esc(s.name)}${sighted.has(s.id) ? ' · sightings reported' : ''}</title></path>`).join('')}</g>
      <g class="us-cities">${D.cities.map((c, i) => `<g class="us-city" tabindex="0" data-city="${i}" transform="translate(${c.x} ${c.y})"><circle class="us-city-halo" r="9"></circle><circle class="us-city-dot" r="4"></circle><title>${esc(c.name)}, ${esc(c.st)}${c.note ? ` (${esc(c.note)})` : ''}</title></g>`).join('')}</g>
    </svg>`;

  const list = withCities.map(id => {
    const cs = byState[id];
    return `<li class="us-state-row${cs.length >= 3 ? ' us-row-wide' : ''}" data-state-row="${id}">
        <div class="flex items-baseline justify-between gap-3"><span class="text-sm font-semibold text-slate-100 max-sm:text-[13px]">${esc(nameOf[id])}</span><span class="text-xs text-slate-500 tabular-nums max-sm:text-[11px]${cs.length === 1 ? ' max-sm:hidden' : ''}">${cs.length} ${cs.length === 1 ? 'city' : 'cities'}</span></div>
        <p class="mt-0.5 text-xs text-slate-400 leading-relaxed max-sm:text-[11px] max-sm:leading-snug">${cs.map(c => esc(c.name) + (c.note ? ` <span class="text-slate-500">(${esc(c.note)})</span>` : '')).join(' · ')}</p>
      </li>`;
  }).join('') + (others.length ? `<li class="us-state-row us-row-wide">
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
          <span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-gold"></span>City with a sighting</span>
        </div>
      </div>
      <ul class="us-state-list min-w-0 divide-y divide-white/[0.06] max-sm:divide-y-0 lg:max-h-[440px] lg:overflow-y-auto lg:pr-2">${list}</ul>
    </div>
    <p class="mt-4 text-[11px] text-slate-500 leading-relaxed">Community-reported sightings compiled by <a href="${esc(D.source.url)}" target="_blank" rel="noopener" class="underline hover:text-slate-300">${esc(D.source.name)}</a> (${esc(D.source.date)}); not verified by Cybercab Hunter. Map: US Census state boundaries.</p>`;

  els.forEach(el => {
    el.innerHTML = html;
    // Hovering or focusing a state row lights that state and its cities on the map.
    const svg = el.querySelector('svg');
    const light = id => {
      svg.querySelectorAll('[data-state]').forEach(p => p.classList.toggle('is-lit', p.dataset.state === id));
      svg.querySelectorAll('.us-city').forEach(g => g.classList.toggle('is-lit', !!id && D.cities[g.dataset.city].st === id));
    };
    el.querySelectorAll('[data-state-row]').forEach(row => {
      row.addEventListener('mouseenter', () => light(row.dataset.stateRow));
      row.addEventListener('mouseleave', () => light(null));
    });
  });
})();
