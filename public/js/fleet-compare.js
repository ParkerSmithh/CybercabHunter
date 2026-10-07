/* Cybercab Hunter: the Fleet ETA view of the Simulation page (simulation.html, /simulation?view=eta).

   Live data: GET /api/fleet-stats?city=austin|dallas (worker/fleet-stats.js), the
   public Austin Cybercab count with the time it was taken (count_as_of) and
   the fare model from the site's own rides (recomputed daily). It is fetched
   on load and every 5 minutes while the page is visible.

   Honesty rules (docs/fleet-eta-live-data-research.md §4):
   - every measured fare shows its sample size; the reported rate card is
     labelled as reported, with its date
   - every live number shows its age; the fare model is "Stale" after 36 h
     and the count after 30 min
   - if the live data can't be loaded, the page says so and shows no number
     it doesn't have (an earlier good copy is kept, with its age)
   - the wait is a range from the model in js/calc.js, never a single figure
   All math lives in js/calc.js (CCC_CALC), which the tests run in node. */
(function () {
  const C = typeof CCC_CALC !== 'undefined' ? CCC_CALC : null;   // js/calc.js (a top-level const, not a window property)
  if (!C) return;
  const $ = id => document.getElementById(id);

  const POLL_MS = 5 * 60 * 1000;
  const COUNT_STALE_MIN = 30;
  const MODEL_Y_FLEET = 114;                 // static illustrative assumption: no live Model Y source
  const money = v => '$' + v.toFixed(2);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  let data = null;          // last good /api/fleet-stats response
  let failed = false;       // the latest request failed
  let scenario = 'typical';

  // "3 min ago", "2 h ago", "just now"
  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return 'just now';
    if (min < 90) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }
  const minutesOld = iso => (Date.now() - Date.parse(iso)) / 60000;
  const chicagoDate = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

  function setText(el, text) { if (el) el.textContent = text; }

  // ---- live fleet line + error notice
  function renderLive() {
    const line = $('fleetLive');
    if (data) {
      const age = ago(data.count_as_of);
      line.textContent = `${plural(data.cybercabs, 'public Cybercab')} · as of ${age || 'an unknown time'}`;
      if (!data.count_as_of || minutesOld(data.count_as_of) > COUNT_STALE_MIN) {
        const badge = document.createElement('span');
        badge.className = 'stale-badge ml-2';
        badge.textContent = 'Stale';
        line.appendChild(badge);
      }
    } else if (failed) {
      line.textContent = 'Live fleet count unavailable';
    }
    const err = $('liveError');
    err.classList.toggle('hidden', !failed);
    setText($('liveErrorText'), data
      ? `Live data unavailable. Showing data from ${ago(data.count_as_of) || 'earlier'}.`
      : 'Live data unavailable. The fleet count and measured fares can\'t be loaded right now, so they aren\'t shown.');
  }

  // ---- fares
  function renderFares() {
    const f = data && data.fares;
    const rides = f && typeof f.rides === 'number' ? f.rides : null;
    const measured = f && f.median_fare != null;
    const sample = rides != null ? `(${plural(rides, 'ride')})` : '';
    const fill = (id, value, cls) => {
      const el = $(id);
      if (measured && typeof value === 'number') { el.textContent = money(value); el.removeAttribute('title'); }
      else { el.textContent = data ? 'None yet' : 'Not available'; el.title = data ? 'No logged rides yet' : 'Live data unavailable'; }
      setText($(id + 'N'), measured ? sample : '');
    };
    fill('medianFare', f && f.median_fare);
    fill('avgFare', f && f.average_fare);
    fill('perMile', f && f.per_mile);
    setText($('faresSampleTag'), measured ? `Measured on ${plural(rides, 'ride')}` : 'No measured rides');

    const age = $('faresAge'), stale = $('faresStale');
    if (f && f.computed_at) {
      age.textContent = `Fare model updated ${chicagoDate(f.computed_at)} CT`;
      const isStale = C.faresStale(f.computed_at);
      stale.classList.toggle('hidden', !isStale);
      if (isStale) stale.textContent = `Stale, ${ago(f.computed_at)}`;
    } else {
      age.textContent = data ? 'Fare model not computed yet' : 'Fare model unavailable';
      stale.classList.add('hidden');
    }
    renderTripFare();
  }

  // ---- fare by distance
  const slider = $('tripMiles'), sliderLabel = $('tripMilesLabel');
  function renderTripFare() {
    const miles = Number(slider.value);
    const f = data && data.fares;
    const measured = C.measuredFare(miles, f);
    const reported = C.reportedFare(miles);
    setText($('fareReported'), reported == null ? 'Not available' : money(reported));
    if (measured != null) {
      setText($('fareMeasured'), money(measured));
      const avgMiles = C.measuredAverageMiles(f);
      const extrapolated = avgMiles && miles > avgMiles * 2.5;   // well past the measured trips
      setText($('fareMeasuredNote'), `${money(f.per_mile)}/mi times ${miles} mi, measured on ${plural(f.rides, 'ride')}`
        + (extrapolated ? `. Those rides averaged ${avgMiles} mi, so trips this long are an extrapolation.` : ''));
    } else {
      setText($('fareMeasured'), data ? 'None yet' : 'Not available');
      setText($('fareMeasuredNote'), data ? 'No logged Cybercab rides with a fare yet' : 'Live data unavailable');
    }
  }
  function syncMiles(v) {
    const miles = Math.min(20, Math.max(0.5, Math.round(Number(v) * 2) / 2 || 0.5));
    slider.value = miles;
    sliderLabel.value = miles;
    renderTripFare();
  }
  slider.addEventListener('input', () => syncMiles(slider.value));
  sliderLabel.addEventListener('change', () => syncMiles(sliderLabel.value));

  // Reported-rate figures come from the one constant in calc.js.
  document.querySelectorAll('[data-rate-base]').forEach(el => { el.textContent = money(C.REPORTED_RATE.base); });
  document.querySelectorAll('[data-rate-mile]').forEach(el => { el.textContent = money(C.REPORTED_RATE.perMile); });

  // ---- operating hours (always Central time, from the visitor's clock)
  const H = C.SERVICE_HOURS;
  const hoursText = `${C.clockLabel(H.openMinute)} - ${C.clockLabel(H.closeMinute)}`;
  document.querySelectorAll('[data-hours]').forEach(el => { el.textContent = hoursText; });
  $('hoursWindow').style.left = `${(H.openMinute / 1440) * 100}%`;
  $('hoursWindow').style.width = `${((H.closeMinute - H.openMinute) / 1440) * 100}%`;
  function renderHours() {
    const s = C.serviceStatus(new Date(), H);
    document.querySelectorAll('[data-service-status]').forEach(el => {
      el.textContent = s.label;
      el.classList.toggle('is-open', s.open);
    });
    $('hoursNow').style.left = `calc(${(s.minuteOfDay / 1440) * 100}% - 1px)`;
    setText($('hoursNowText'), `It's ${C.clockLabel(s.minuteOfDay)} in Austin now.`);
  }

  // ---- pickup wait estimate
  function etaMarkup(r) {
    if (r.state === 'few-cars') {
      return '<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Wait could be much longer</p>'
        + '<p class="text-sm text-slate-400 mt-2 max-sm:text-[11px] max-sm:leading-snug">Too few cars would be free in this scenario to estimate a wait.</p>';
    }
    if (r.state !== 'ok') {
      return '<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Not available</p>'
        + '<p class="text-sm text-slate-400 mt-2 max-sm:text-[11px] max-sm:leading-snug">The live fleet count is needed for this estimate.</p>';
    }
    const high = r.highCapped ? `${r.high}+` : String(r.high);
    const range = r.low === r.high && !r.highCapped ? `${r.low}` : `${r.low}-${high}`;
    // max-sm: phones show the two estimates side by side, so smaller type.
    return `<p class="stat-value font-semibold text-5xl text-white leading-none max-sm:text-2xl max-sm:whitespace-nowrap">${range}<span class="text-xl text-slate-400 font-medium ml-2 max-sm:text-sm max-sm:ml-1">min</span></p>`
      + `<p class="text-sm text-slate-300 mt-3 max-sm:text-xs max-sm:mt-2">Most likely about ${r.likely} min</p>`;
  }
  // The estimates are polite live regions: only write when the estimate itself
  // changed, so the 30-second tick doesn't make a screen reader repeat them.
  function setHTML(el, html) { if (el.innerHTML !== html) el.innerHTML = html; }
  function renderEta() {
    const cyber = C.etaRange({ fleetSize: data ? data.cybercabs : NaN, scenario });
    setHTML($('etaCybercab'), etaMarkup(cyber));
    setText($('etaCybercabBasis'), data
      ? `From ${plural(data.cybercabs, 'public Cybercab')}, as of ${ago(data.count_as_of) || 'an unknown time'}.`
      : 'Live fleet count unavailable.');
    setHTML($('etaModelY'), etaMarkup(C.etaRange({ fleetSize: MODEL_Y_FLEET, scenario })));
    const idle = C.ETA_SCENARIOS[scenario].idleShare;
    $('inputIdle').firstChild.textContent = `${Math.round(idle[0] * 100)}% to ${Math.round(idle[2] * 100)}% `;
    setText($('inputFleet'), data ? String(data.cybercabs) : 'Unavailable');
    renderDallasEta();
  }
  document.querySelectorAll('[data-modely-fleet]').forEach(el => { el.textContent = String(MODEL_Y_FLEET); });
  document.querySelectorAll('[data-scenario]').forEach(btn => {
    btn.addEventListener('click', () => {
      scenario = btn.dataset.scenario;
      // Austin's and Dallas's buttons share the scenario.
      document.querySelectorAll('[data-scenario]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === scenario)));
      renderEta();
    });
  });

  // ---- Dallas (launched Apr 18, 2026): its own live count and measured fares
  // (GET /api/fleet-stats?city=dallas), the reported hours and rate and the
  // fixed Model Y count (js/calc.js). The pickup wait is Austin's model over
  // the 81 mi² Dallas zone, from the live count and the fixed Model Y fleet.
  let dallasLoaded = false;
  let dallas = null;   // GET /api/fleet-stats?city=dallas, once loaded
  const DALLAS_ETA = Object.assign({}, C.ETA_ASSUMPTIONS, { areaSqMi: C.DALLAS_AREA_SQ_MI });
  function renderDallasEta() {
    if (!dallasLoaded) return;
    const cyber = $('dalEtaCybercab');
    if (!cyber) return;
    setHTML($('dalEtaModelY'), etaMarkup(C.etaRange({ fleetSize: C.DALLAS_MODEL_Y_FLEET, scenario, assumptions: DALLAS_ETA })));
    if (dallas === null) return;   // still loading: the skeleton stays
    const ok = dallas && typeof dallas.cybercabs === 'number';
    if (ok && dallas.cybercabs === 0) {
      setHTML(cyber, '<p class="font-display font-semibold text-2xl text-white max-sm:text-base">No Cybercabs yet</p>'
        + '<p class="text-sm text-slate-400 mt-2 max-sm:text-[11px] max-sm:leading-snug">No public Cybercabs are tracked in Dallas yet.</p>');
    } else {
      setHTML(cyber, etaMarkup(C.etaRange({ fleetSize: ok ? dallas.cybercabs : NaN, scenario, assumptions: DALLAS_ETA })));
    }
    setText($('dalEtaCybercabBasis'), ok
      ? `From ${plural(dallas.cybercabs, 'public Cybercab')} tracked in Dallas, as of ${ago(dallas.count_as_of) || 'an unknown time'}.`
      : 'Live fleet count unavailable.');
  }
  let dallasTimer = null;
  function renderDallasHours() {
    const st = C.serviceStatus(new Date(), C.DALLAS_SERVICE_HOURS);
    const badge = $('dalServiceStatus');
    if (badge) { badge.textContent = st.label; badge.classList.toggle('is-open', st.open); }
    const now = $('dalHoursNow');
    if (now) now.style.left = `${(st.minuteOfDay / 1440) * 100}%`;
  }
  async function loadDallas() {
    document.querySelectorAll('[data-dal-modely-fleet]').forEach(el => { el.textContent = String(C.DALLAS_MODEL_Y_FLEET); });
    setText($('dalFare5'), money(C.reportedFare(5, C.DALLAS_REPORTED_RATE)));
    renderDallasHours();
    renderDallasEta();
    let d = null;
    try {
      const r = await fetch('/api/fleet-stats?city=dallas');
      if (r.ok) d = await r.json();
    } catch (e) { d = null; }
    dallas = d && typeof d.cybercabs === 'number' ? d : false;
    renderDallasEta();
    if (dallas) {
      const f = d.fares || {};
      const has = typeof f.median_fare === 'number';
      setText($('dalMedianFare'), has ? money(f.median_fare) : '—');
      setText($('dalAvgFare'), has ? money(f.average_fare) : '—');
      setText($('dalPerMile'), has ? money(f.per_mile) : '—');
      setText($('dalFaresBasis'), has ? `Based on ${plural(f.rides, 'logged Dallas ride')}` : 'No logged Dallas rides with a fare yet');
    } else {
      setText($('dalFaresBasis'), 'Fare data unavailable');
    }
  }

  // ---- city
  document.querySelectorAll('[data-city]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dallas = btn.dataset.city === 'dallas';
      document.querySelectorAll('[data-city]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      $('austinContent').classList.toggle('hidden', dallas);
      $('dallasContent').classList.toggle('hidden', !dallas);
      $('fleetLive').classList.toggle('hidden', dallas);
      if (dallas) {
        if (!dallasLoaded) { dallasLoaded = true; loadDallas(); }
        renderDallasHours();
        if (!dallasTimer) dallasTimer = setInterval(() => { if (!document.hidden) renderDallasHours(); }, 60000);
      }
    });
  });

  function renderAll() { renderLive(); renderFares(); renderEta(); }

  // ---- load and refresh
  let inFlight = false;
  async function load() {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await fetch('/api/fleet-stats?city=austin');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (typeof json.cybercabs !== 'number') throw new Error('bad response');
      data = json;
      failed = false;
    } catch (e) {
      failed = true;
    } finally {
      inFlight = false;
      renderAll();
    }
  }

  // Poll every 5 minutes while visible (the sightings.js / austin-map.js pattern);
  // the "x min ago" ages and the open/closed state tick every 30 s.
  let pollTimer = null, tickTimer = null;
  function start() {
    if (!pollTimer) pollTimer = setInterval(load, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(() => { renderLive(); renderHours(); renderEta(); }, 30000);
  }
  function stop() {
    clearInterval(pollTimer); clearInterval(tickTimer);
    pollTimer = tickTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    renderHours();
    if (!data || minutesOld(data.count_as_of) >= 5) load(); else renderAll();
    start();
  });

  renderHours();
  renderTripFare();
  load();
  if (!document.hidden) start();
})();
