/* Cybercab Hunter: the Fleet ETA view of the Simulation page (simulation.html, /simulation?view=eta).

   One source: GET /api/fleet-eta?city=austin|dallas (worker/fleet-eta.js),
   precomputed once a day (one stored row per city, edge-cached for an hour):
   the fare and wait ESTIMATES and the fleet layers, including the documented
   Cybercab count used for the fleet mix. Fetched once per city, again only if
   an hour old. (The page no longer polls /api/fleet-stats: its live count is
   an aggregate over the registry on every edge-cache miss, and the D1 budget
   allows no such query on a page's request path.)

   Honesty rules:
   - every estimate is a range, with its demand scenario, its basis (observed
     on N rides / modeled from published reports) and a computed confidence;
     "Insufficient data" when there is no basis at all
   - Quiet / Typical / Busy are Cybercab Hunter's scenarios, never Tesla's
   - nothing is presented as a live Tesla quote
   - Austin and Dallas never borrow each other's numbers
   - if data can't be loaded the page says so and shows no number it doesn't have
   All math lives in js/calc.js (CCC_CALC), which the tests run in node. */
(function () {
  const C = typeof CCC_CALC !== 'undefined' ? CCC_CALC : null;   // js/calc.js (a top-level const, not a window property)
  if (!C) return;
  const $ = id => document.getElementById(id);
  const q = sel => document.querySelector(sel);
  const qa = sel => [...document.querySelectorAll(sel)];

  const ETA_REFRESH_MS = 60 * 60 * 1000;
  const MODEL_Y_FLEET = 114;                 // static illustrative assumption: no live Model Y source
  const CITY_NAME = { austin: 'Austin', dallas: 'Dallas' };
  const TIER_LABEL = { quiet: 'Quiet', typical: 'Typical', busy: 'Busy' };
  const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', insufficient: 'Insufficient data' };
  const VEHICLE_LABEL = { cybercab: 'Cybercab', model_y: 'Model Y', unknown: 'Robotaxi' };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const money = v => '$' + Number(v).toFixed(2);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const eta = { austin: null, dallas: null };      // /api/fleet-eta payloads (false = failed)
  const etaAt = { austin: 0, dallas: 0 };
  const area = { austin: '', dallas: '' };
  let userScenario = null;  // the visitor's pick; null = the assumed scenario
  let currentCity = 'austin';

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
  const chicagoDate = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  const chicagoDay = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  function setText(el, text) { if (el) el.textContent = text; }
  // Live regions: only write when the content changed, so the 30-second tick
  // doesn't make a screen reader repeat the estimates.
  function setHTML(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }
  const confPill = level => `<span class="conf conf-${esc(level)}">${esc(CONF_LABEL[level] || level)}</span>`;

  // The Cybercab count for a city's fleet mix, and when it was counted (the
  // daily summary), or null. Austin: every vehicle on the public registry, any
  // city (the Cars page's list). Dallas: only vehicles documented in Dallas,
  // so the whole registry is never shown as Dallas's fleet.
  function countOf(city) {
    const p = eta[city];
    const f = p && p.fleet;
    if (!f) return null;
    const n = city === 'austin' && f.registry ? f.registry.total : f.documented ? f.documented.cybercab : null;
    return typeof n === 'number' ? { cybercabs: n, count_as_of: p.computed_at } : null;
  }

  // ---- fleet count line + error notice
  function renderLive() {
    const line = $('fleetLive');
    const data = countOf('austin'), failed = eta.austin === false;
    if (data) {
      line.textContent = `${plural(data.cybercabs, 'Cybercab')} on the registry · counted ${ago(data.count_as_of) || 'at an unknown time'}`;
      if (C.faresStale(data.count_as_of)) {
        const badge = document.createElement('span');
        badge.className = 'stale-badge ml-2';
        badge.textContent = 'Stale';
        line.appendChild(badge);
      }
    } else if (failed) {
      line.textContent = 'Fleet count unavailable';
    } else if (eta.austin && eta.austin.pending_first_run) {
      line.textContent = 'Fleet count pending the first daily update';
    }
    const err = $('liveError');
    err.classList.toggle('hidden', !failed);
    setText($('liveErrorText'), 'Fleet ETA data unavailable. The estimates can\'t be loaded right now, so no numbers are shown.');
  }

  // ---- Cybercab vs Model Y: the fleet mix. `cy` is the live public count
  // (null = unavailable: no number, no share); `my` the fixed Model Y figure.
  function renderMix(pre, cy, my, note) {
    const ok = typeof cy === 'number' && cy >= 0, total = ok ? cy + my : null;
    const share = ok && total ? Math.round((cy / total) * 100) : null;
    setText($(pre + 'MixCy'), ok ? String(cy) : '—');
    setText($(pre + 'MixMy'), String(my));
    setText($(pre + 'MixTotal'), ok ? String(total) : '—');
    for (const [id, v] of [['MixCyPct', share], ['MixCyPctBar', share], ['MixMyPct', share === null ? null : 100 - share], ['MixMyPctBar', share === null ? null : 100 - share]]) setText($(pre + id), v === null ? '—' : `${v}%`);
    const bar = $(pre + 'MixBar');
    if (bar) bar.style.width = share === null ? '0%' : `${share}%`;
    setText($(pre + 'MixCyNote'), note);
  }

  // ---- operating hours (always Central time, from the visitor's clock)
  const H = C.SERVICE_HOURS;
  const hoursText = `${C.clockLabel(H.openMinute)} - ${C.clockLabel(H.closeMinute)}`;
  qa('[data-hours]').forEach(el => { el.textContent = hoursText; });
  $('hoursWindow').style.left = `${(H.openMinute / 1440) * 100}%`;
  $('hoursWindow').style.width = `${((H.closeMinute - H.openMinute) / 1440) * 100}%`;
  function renderHours() {
    const s = C.serviceStatus(new Date(), H);
    qa('[data-service-status]').forEach(el => {
      el.textContent = s.label;
      el.classList.toggle('is-open', s.open);
    });
    $('hoursNow').style.left = `calc(${(s.minuteOfDay / 1440) * 100}% - 1px)`;
    setText($('hoursNowText'), `It's ${C.clockLabel(s.minuteOfDay)} in Austin now.`);
  }
  function renderDallasHours() {
    const st = C.serviceStatus(new Date(), C.DALLAS_SERVICE_HOURS);
    const badge = $('dalServiceStatus');
    if (badge) { badge.textContent = st.label; badge.classList.toggle('is-open', st.open); }
    const now = $('dalHoursNow');
    if (now) now.style.left = `${(st.minuteOfDay / 1440) * 100}%`;
  }

  // ---- the estimates -----------------------------------------------------------

  const milesOf = city => {
    const el = q(`[data-eta-miles="${city}"]`);
    return el ? Number(el.value) : 5;
  };
  function scenarioFor(city) {
    if (userScenario) return userScenario;
    const p = eta[city];
    return p ? C.assumedTier(p).tier : 'typical';
  }
  function areaLabel(city, key) {
    const p = eta[city];
    const a = p && p.areas && p.areas.find(x => x.key === key);
    return a ? a.label : null;
  }

  function renderAssumed(city) {
    const el = q(`[data-eta-assumed="${city}"]`);
    if (!el) return;
    const p = eta[city];
    if (!p) { el.textContent = p === false ? '' : 'Loading the demand scenario'; return; }
    const a = C.assumedTier(p);
    const when = `${a.slot.day}-${a.slot.part}`;
    const slot = p.slot_tiers && p.slot_tiers[a.slot.key];
    const validated = slot && (slot.fare_n || slot.wait_n || slot.reasons.length);
    let text = `Assumed now: ${TIER_LABEL[a.tier]} ${when} demand`;
    if (a.reasons.length) text += ` (${a.reasons.join('; ')})`;
    else if (!validated) text += ' (time-of-day differences not yet shown to improve accuracy)';
    if (userScenario && userScenario !== a.tier) text = `Showing ${TIER_LABEL[userScenario]} (your pick). ${text}`;
    el.textContent = `${text}. Cybercab Hunter's scenario, not a Tesla label.`;
  }

  function renderFare(city, vt) {
    const el = q(`[data-eta-fare="${city}:${vt}"]`);
    const tag = q(`[data-eta-basis="${city}:${vt}"]`);
    const p = eta[city];
    if (!el) return;
    if (p === false) {
      setHTML(el, '<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Not available</p><p class="text-sm text-slate-400 mt-2 max-sm:text-xs">The estimates can\'t be loaded right now.</p>');
      setText(tag, 'Unavailable');
      return;
    }
    if (!p) return;
    const bv = p.fares.by_vehicle[vt];
    const model = bv.use === 'none' ? null : p.fares.models[bv.use];
    const conf = bv.confidence.level;
    if (!model) {
      setHTML(el, `<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Insufficient data</p>`
        + `<p class="mt-2">${confPill('insufficient')}</p>`
        + `<p class="text-xs text-slate-400 mt-2 leading-relaxed">${esc(bv.note || 'Not enough data for an estimate.')}</p>`);
      setText(tag, 'Insufficient data');
      return;
    }
    const miles = milesOf(city), tier = scenarioFor(city), ar = area[city] || null;
    const r = C.etaFareRange(model, miles, tier, ar);
    const typeName = bv.use === 'all' ? 'All robotaxis' : bv.use === 'external' ? 'All vehicle types' : VEHICLE_LABEL[vt];
    const basis = model.basis === 'external' ? 'Modeled from published reports' : `Observed · ${plural(model.n, 'ride')}`;
    setText(tag, model.basis === 'external' ? 'Modeled' : bv.use === 'all' ? `All robotaxis · ${model.n}` : `Observed · ${model.n}`);
    const areaName = ar ? areaLabel(city, ar) : null;
    const areaNote = ar && !(model.area_mult && model.area_mult[ar]) ? ` Not enough fares from ${areaName || 'this area'} to adjust for it, so this is the ${CITY_NAME[city]}-wide estimate.` : '';
    const stats = model.basis === 'observed' && model.stats ? model.stats : null;
    const extrapolated = stats && stats.median_miles && miles > stats.median_miles * 3;
    const lines = [];
    if (bv.note) lines.push(esc(bv.note));
    if (stats) lines.push(`Logged ${bv.use === 'all' ? '' : esc(VEHICLE_LABEL[vt]) + ' '}rides: median ${money(stats.median_fare)}, ${money(stats.per_mile)}/mi, typical trip ${stats.median_miles} mi.`);
    if (extrapolated) lines.push(`Longer than most logged trips (typical ${stats.median_miles} mi), so this is an extrapolation.`);
    if (areaNote) lines.push(esc(areaNote.trim()));
    setHTML(el, `<p class="stat-value font-semibold text-5xl text-white leading-none max-sm:text-3xl max-sm:whitespace-nowrap">${esc(C.dollarRange(r))}</p>`
      + `<p class="text-sm text-slate-300 mt-3 max-sm:text-xs max-sm:mt-2">${miles} mi · ${TIER_LABEL[tier]} demand${areaName ? ' · ' + esc(areaName) : ''} · ${esc(typeName)}</p>`
      + `<p class="mt-2 flex flex-wrap items-center gap-2">${confPill(conf)}<span class="text-xs text-slate-400">${esc(basis)}</span></p>`
      + (lines.length ? `<p class="text-xs text-slate-500 mt-2 leading-relaxed">${lines.join(' ')}</p>` : ''));
  }

  function renderWait(city, vt) {
    const id = (city === 'dallas' ? 'dalEta' : 'eta') + (vt === 'cybercab' ? 'Cybercab' : 'ModelY');
    const el = $(id), basisEl = $(id + 'Basis');
    const p = eta[city];
    if (!el) return;
    if (p === false) {
      setHTML(el, '<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Not available</p>');
      setText(basisEl, 'The estimates can\'t be loaded right now.');
      return;
    }
    if (!p) return;
    const w = p.waits;
    if (vt === 'cybercab' && !p.service.cybercab_service) {
      setHTML(el, `<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Insufficient data</p><p class="mt-2">${confPill('insufficient')}</p>`);
      setText(basisEl, `No evidence of Cybercabs in public service in ${CITY_NAME[city]} yet, so no Cybercab pickup estimate.`);
      return;
    }
    if (w.use === 'none' || !w.model) {
      setHTML(el, `<p class="font-display font-semibold text-2xl text-white max-sm:text-base">Insufficient data</p><p class="mt-2">${confPill('insufficient')}</p>`);
      setText(basisEl, w.note || 'Not enough data for an estimate.');
      return;
    }
    const tier = scenarioFor(city), ar = area[city] || null;
    const r = C.etaWaitRange(w.model, tier, ar);
    const areaName = ar ? areaLabel(city, ar) : null;
    setHTML(el, `<p class="stat-value font-semibold text-5xl text-white leading-none max-sm:text-3xl max-sm:whitespace-nowrap">${esc(C.minuteRange(r))}</p>`
      + `<p class="text-sm text-slate-300 mt-3 max-sm:text-xs max-sm:mt-2">${TIER_LABEL[tier]} demand${areaName ? ' · ' + esc(areaName) : ''} · any Tesla robotaxi</p>`
      + `<p class="mt-2">${confPill(w.confidence.level)}</p>`);
    const parts = [];
    if (w.use === 'observed') {
      parts.push(`Modeled from ${plural(w.model.n, 'pickup wait')} riders reported from the app (quoted ETAs), not separated by vehicle type.`);
      if (ar) parts.push(w.model.area_mult && w.model.area_mult[ar] ? `Adjusted for ${areaName}.` : `Not enough reports from ${areaName || 'this area'}, so ${CITY_NAME[city]}-wide.`);
    } else {
      parts.push(w.note || '');
      if (w.model.sources) parts.push(`Sources: ${w.model.sources.join('; ')}.`);
    }
    const avq = w.actual_vs_quoted;
    if (avq && avq.median_delay != null) parts.push(`Riders who timed their pickup: the car arrived a median ${Math.abs(avq.median_delay)} min ${avq.median_delay >= 0 ? 'after' : 'before'} the app's quote (${avq.n} rides).`);
    if (w.unavailability && w.unavailability.n >= 6 && w.unavailability.share > 0) parts.push(`The app showed no car available in ${Math.round(w.unavailability.share * 100)}% of ${w.unavailability.n} reports.`);
    setText(basisEl, parts.filter(Boolean).join(' '));
  }

  function renderFleet(city) {
    const el = q(`[data-eta-fleet="${city}"]`);
    const p = eta[city];
    if (!el || !p || !p.fleet) { if (el && p === false) setHTML(el, '<div class="input-row"><dt>Fleet data unavailable</dt><dd></dd></div>'); return; }
    const f = p.fleet;
    const row = (dt, dd, tag, tagCls = '') => `<div class="input-row"><dt>${dt}</dt><dd>${dd}${tag ? ` <span class="tag ${tagCls}">${tag}</span>` : ''}</dd></div>`;
    const d = f.documented;
    let html = row('Documented by Cybercab Hunter', `${d.cybercab} Cybercab${d.model_y ? ` · ${d.model_y} Model Y` : ''}${d.unknown ? ` · ${d.unknown} other` : ''}`, 'Registry');
    html += row('Different cars seen, last 7 days', String(f.observed_7d), 'Sightings + rides');
    html += row('Different cars seen, last 30 days', String(f.observed_30d), 'Sightings + rides');
    const u = f.unidentified_30d;
    if (u && (u.sightings || u.camera_detections)) html += row('Seen but not identifiable, 30 days', `${u.sightings} sightings · ${u.camera_detections} camera detections`, 'Not counted as cars', 'tag-assumed');
    if (f.dmv) html += row(`Registered with the Texas DMV (${esc(f.dmv.snapshot_date)})`, `${f.dmv.total} (${f.dmv.cybercab} Cybercab, ${f.dmv.model_y} Model Y)`, 'Statewide');
    if (f.external) html += row(`In service per ${esc(f.external.source.split(' (')[0])} (${esc(f.external.as_of)})`, `about ${f.external.total}${f.external.cybercab ? ` (${f.external.cybercab} Cybercab)` : ' (no Cybercab)'}`, 'External', 'tag-assumed');
    html += row('Free to pick you up right now', 'Not known', 'No public data', 'tag-assumed');
    setHTML(el, html);
  }

  function renderCalibration(city) {
    const el = q(`[data-eta-calibration="${city}"]`);
    const p = eta[city];
    if (!el) return;
    if (!p) { setText(el, p === false ? 'Accuracy check unavailable.' : 'Accuracy check loading.'); return; }
    const parts = [];
    const fc = p.fares.checks && p.fares.checks.all;
    if (fc) {
      let s = `Accuracy check, fares: on the newest ${fc.n_test} logged rides (held out from the fit), ${Math.round(fc.within_range * 100)}% fell inside the shown range; typical error ${money(fc.median_ae)} (${Math.round(fc.mape * 100)}% on average).`;
      const prev = fc.baselines && fc.baselines.previous_measured_rate;
      if (prev) s += ` The previous page's per-mile formula was off by ${money(prev.mae)} on average on the same rides, against ${money(fc.mae)} now.`;
      parts.push(s);
      const m = p.fares.models.all;
      if (m && m.widened_by > 1) parts.push(`Ranges were widened ${m.widened_by}x because fewer held-out rides than expected fell inside.`);
    } else {
      parts.push(`Accuracy check, fares: not enough logged ${CITY_NAME[city]} rides yet to test the estimate on rides it wasn't fitted to.`);
    }
    const wc = p.waits.check;
    if (wc) parts.push(`Waits: ${Math.round(wc.within_range * 100)}% of the newest ${wc.n_test} reported waits fell inside the range (typical error ${wc.median_ae} min).`);
    else parts.push('Waits: not enough rider-reported waits yet to check.');
    setText(el, parts.join(' '));
  }

  function renderRecent(city) {
    const el = q(`[data-eta-recent="${city}"]`);
    const p = eta[city];
    if (!el) return;
    const rs = p && p.recent_reports || [];
    el.classList.toggle('hidden', !rs.length);
    if (!rs.length) return;
    const items = rs.map(r => {
      const bits = [chicagoDay(r.day + 'T12:00:00Z'), r.area, VEHICLE_LABEL[r.vehicle] || 'Robotaxi'];
      let what = r.no_cars ? 'no cars available' : '';
      if (r.fare != null) what = `${r.kind === 'quote' ? 'quoted' : 'paid'} ${money(r.fare)}${r.miles != null ? ` for ${r.miles} mi` : ''}`;
      if (r.quoted_wait != null) what += `${what ? ', ' : ''}${r.quoted_wait} min wait quoted`;
      if (r.actual_wait != null) what += `${what ? ', ' : ''}${r.actual_wait} min actual wait`;
      return `<li>${esc(bits.filter(Boolean).join(' · '))}: ${esc(what)}</li>`;
    }).join('');
    setHTML(el, `<p class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Recent reviewed rider reports</p><ul class="mt-2 space-y-1 text-sm text-slate-300">${items}</ul>`);
  }

  function renderUpdated(city) {
    const el = q(`[data-eta-updated="${city}"]`), stale = q(`[data-eta-stale="${city}"]`);
    const p = eta[city];
    if (!el) return;
    if (p === false) { el.textContent = 'Estimates unavailable'; return; }
    if (!p) return;
    el.textContent = p.pending_first_run
      ? 'First daily update pending: published-report estimates for now'
      : `Estimates recomputed ${chicagoDate(p.computed_at)} CT (daily)`;
    const isStale = !p.pending_first_run && C.faresStale(p.computed_at);
    // Inline display: the page's .stale-badge display rule would beat .hidden.
    if (stale) { stale.classList.toggle('hidden', !isStale); stale.style.display = isStale ? '' : 'none'; if (isStale) stale.textContent = `Stale, ${ago(p.computed_at)}`; }
  }

  function renderAreaOptions(city) {
    const sel = q(`[data-eta-area="${city}"]`);
    const p = eta[city];
    if (!sel || !p || !p.areas || sel.dataset.filled) return;
    sel.dataset.filled = '1';
    for (const a of p.areas) {
      const o = document.createElement('option');
      o.value = a.key; o.textContent = a.label;
      sel.appendChild(o);
    }
  }

  // The fleet-geometry check in "How are these estimates calculated?" (the
  // previous page's model), for the city on screen.
  function renderGeometry() {
    const el = q('[data-eta-geometry]');
    const tier = scenarioFor(currentCity);
    const count = countOf(currentCity);
    const fleet = count ? count.cybercabs : NaN;
    const assumptions = currentCity === 'dallas' ? Object.assign({}, C.ETA_ASSUMPTIONS, { areaSqMi: C.DALLAS_AREA_SQ_MI }) : C.ETA_ASSUMPTIONS;
    const r = C.etaRange({ fleetSize: fleet, scenario: tier, assumptions });
    setText(el, r.state === 'ok' ? `${r.low}-${r.highCapped ? r.high + '+' : r.high} min (most likely ${r.likely}) for the ${CITY_NAME[currentCity]} Cybercabs under ${TIER_LABEL[tier]} demand` : r.state === 'few-cars' ? 'too few free cars to estimate' : 'not available (no fleet count)');
    setText($('inputFleet'), Number.isFinite(fleet) ? String(fleet) : 'Unavailable');
    const idle = C.ETA_SCENARIOS[tier].idleShare;
    const idleEl = $('inputIdle');
    if (idleEl) idleEl.firstChild.textContent = `${Math.round(idle[0] * 100)}% to ${Math.round(idle[2] * 100)}% `;
    const hist = q('[data-eta-history]');
    const p = eta[currentCity];
    if (hist && p && p.fares.external) {
      const e = p.fares.external;
      setHTML(hist, e.rate_history.map(h => `<li>${esc(h.as_of)}: ${esc(h.text)}</li>`).join('')
        + (e.tracker ? `<li>${esc(e.tracker.source)}, ${esc(e.tracker.window)} (${esc(e.tracker.as_of)}): median fare ${money(e.tracker.median_fare)}, ${money(e.tracker.per_mile)}/mi, ${e.tracker.avg_miles} mi average, ${e.tracker.rides.toLocaleString('en-US')} priced rides</li>` : '')
        + (e.obi ? `<li>${esc(e.obi.source)}: average price ${money(e.obi.low)} to ${money(e.obi.high)} depending on the day</li>` : ''));
    }
  }

  function renderCity(city) {
    renderUpdated(city); renderAssumed(city); renderAreaOptions(city);
    for (const vt of ['cybercab', 'model_y']) { renderFare(city, vt); renderWait(city, vt); }
    renderFleet(city); renderCalibration(city); renderRecent(city);
    const count = countOf(city), pre = city === 'dallas' ? 'dal' : 'austin';
    renderMix(pre, count ? count.cybercabs : null, city === 'dallas' ? C.DALLAS_MODEL_Y_FLEET : MODEL_Y_FLEET, count
      ? (city === 'austin' ? `Every Cybercab on the public registry, counted ${ago(count.count_as_of) || 'at an unknown time'}` : `Documented in Dallas by Cybercab Hunter, counted ${ago(count.count_as_of) || 'at an unknown time'}`)
      : (eta[city] === false ? 'Count unavailable' : eta[city] && eta[city].pending_first_run ? 'Count pending the first daily update' : 'Count loading'));
  }
  function renderScenarioButtons() {
    const tier = scenarioFor(currentCity);
    qa('[data-scenario]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === tier)));
  }
  function renderEstimates() {
    renderCity('austin');
    if (eta.dallas !== null || dallasLoaded) renderCity('dallas');
    renderScenarioButtons();
    renderGeometry();
  }

  async function loadEta(city) {
    try {
      const r = await fetch(`/api/fleet-eta?city=${city}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (!json || !json.fares || !json.waits) throw new Error('bad response');
      eta[city] = json;
      etaAt[city] = Date.now();
    } catch (e) {
      if (!eta[city]) eta[city] = false;   // keep an earlier good copy
    }
    renderEstimates();
    if (city === 'austin') renderLive();
    syncReportAreas();
  }

  // ---- controls
  qa('[data-scenario]').forEach(btn => {
    btn.addEventListener('click', () => {
      userScenario = btn.dataset.scenario;
      // Austin's and Dallas's buttons share the scenario.
      qa('[data-scenario]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scenario === userScenario)));
      renderEstimates();
    });
  });
  qa('[data-eta-miles]').forEach(slider => {
    const city = slider.dataset.etaMiles;
    const label = $(slider.id + 'Label');
    const sync = v => {
      const miles = Math.min(20, Math.max(0.5, Math.round(Number(v) * 2) / 2 || 0.5));
      slider.value = miles;
      if (label) label.value = miles;
      for (const vt of ['cybercab', 'model_y']) renderFare(city, vt);
    };
    slider.addEventListener('input', () => sync(slider.value));
    if (label) label.addEventListener('change', () => sync(label.value));
  });
  qa('[data-eta-area]').forEach(sel => {
    sel.addEventListener('change', () => { area[sel.dataset.etaArea] = sel.value; renderCity(sel.dataset.etaArea); });
  });

  // ---- Dallas (launched Apr 18, 2026): its own estimates and fleet layers
  // (never Austin's numbers), loaded the first time Dallas is shown.
  let dallasLoaded = false;
  let dallasTimer = null;
  function loadDallas() {
    qa('[data-dal-modely-fleet]').forEach(el => { el.textContent = String(C.DALLAS_MODEL_Y_FLEET); });
    renderMix('dal', null, C.DALLAS_MODEL_Y_FLEET, 'Count loading');
    renderDallasHours();
    loadEta('dallas');
  }

  // ---- city
  qa('[data-city]').forEach(btn => {
    btn.addEventListener('click', () => {
      const isDallas = btn.dataset.city === 'dallas';
      currentCity = isDallas ? 'dallas' : 'austin';
      qa('[data-city]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
      $('austinContent').classList.toggle('hidden', isDallas);
      $('dallasContent').classList.toggle('hidden', !isDallas);
      $('fleetLive').classList.toggle('hidden', isDallas);
      const form = $('fareReportForm');
      if (form) { form.elements.city.value = currentCity; syncReportAreas(); }
      if (isDallas) {
        if (!dallasLoaded) { dallasLoaded = true; loadDallas(); }
        renderDallasHours();
        if (!dallasTimer) dallasTimer = setInterval(() => { if (!document.hidden) renderDallasHours(); }, 60000);
      }
      renderScenarioButtons();
      renderGeometry();
    });
  });

  // ---- the rider report form (POST /api/fare-reports)
  const REPORT_ERRORS = {
    rate_limited: 'That is the daily limit of 10 reports. Thank you!',
    duplicate_report: 'You already sent this report.',
    distance_required_with_fare: 'Add the trip distance with the price.',
    implausible_fare_for_distance: 'That price and distance don\'t look right together. Please check them.',
    implausible_speed: 'That distance and trip time don\'t look right together.',
    no_cars_with_values: 'If no cars were available, leave the price and waits empty.',
    nothing_reported: 'Add a price, a wait, or tick "no cars available".',
    actual_wait_needs_completed_ride: 'The actual wait only applies to a ride you took.',
    observed_at_out_of_range: 'Reports must be from the last 30 days.',
    invalid_fare: 'The price must be between $1 and $250.',
    invalid_distance: 'The distance must be between 0.2 and 60 miles.',
    invalid_quoted_wait: 'The quoted wait must be a whole number of minutes, 0 to 90.',
    invalid_actual_wait: 'The actual wait must be a whole number of minutes, 0 to 120.'
  };
  const SESSION_KEY = 'teslaSessionId';
  function sessionId() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }
  function syncReportAreas() {
    const form = $('fareReportForm');
    if (!form) return;
    const city = form.elements.city.value;
    const p = eta[city];
    qa('[data-report-area]').forEach(sel => {
      if (sel.dataset.city === city && sel.options.length > 1) return;
      const keep = sel.value;
      sel.dataset.city = city;
      sel.innerHTML = '<option value="">Not sure</option>';
      for (const a of (p && p.areas) || []) { const o = document.createElement('option'); o.value = a.key; o.textContent = a.label; sel.appendChild(o); }
      const other = document.createElement('option'); other.value = 'other'; other.textContent = `Elsewhere in ${CITY_NAME[city]}`; sel.appendChild(other);
      if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
    });
  }
  function initReportForm() {
    const form = $('fareReportForm');
    if (!form) return;
    const status = $('fareReportStatus');
    const pad = n => String(n).padStart(2, '0');
    const now = new Date();
    form.elements.observed_at.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    $('fareReportSignIn').classList.toggle('hidden', !!sessionId());
    form.elements.city.addEventListener('change', () => { if (!eta[form.elements.city.value]) loadEta(form.elements.city.value); syncReportAreas(); });
    syncReportAreas();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const sid = sessionId();
      if (!sid) { $('fareReportSignIn').classList.remove('hidden'); setText(status, 'Sign in to send a report.'); return; }
      const f = form.elements;
      const local = f.observed_at.value ? new Date(f.observed_at.value) : new Date();
      const body = {
        city: f.city.value, kind: f.kind.value, vehicle_type: f.vehicle_type.value,
        pickup_area: f.pickup_area.value || null, dropoff_area: f.dropoff_area.value || null,
        quoted_fare: f.quoted_fare.value || null, distance_miles: f.distance_miles.value || null,
        duration_minutes: f.duration_minutes.value ? Number(f.duration_minutes.value) : null,
        quoted_wait_minutes: f.quoted_wait_minutes.value ? Number(f.quoted_wait_minutes.value) : null,
        actual_wait_minutes: f.actual_wait_minutes.value ? Number(f.actual_wait_minutes.value) : null,
        no_cars_available: f.no_cars_available.checked,
        observed_at: Number.isFinite(local.getTime()) ? local.toISOString() : null
      };
      setText(status, 'Sending...');
      try {
        const r = await fetch('/api/fare-reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sid }, body: JSON.stringify(body) });
        const json = await r.json().catch(() => ({}));
        if (r.status === 401) { $('fareReportSignIn').classList.remove('hidden'); setText(status, 'Sign in to send a report.'); return; }
        if (!r.ok) { setText(status, REPORT_ERRORS[json.error] || 'That report couldn\'t be saved. Please check the values.'); return; }
        setText(status, 'Thanks! Your report is waiting for review. Reviewed reports feed the next daily update.');
        ['quoted_fare', 'distance_miles', 'duration_minutes', 'quoted_wait_minutes', 'actual_wait_minutes'].forEach(n => { f[n].value = ''; });
        f.no_cars_available.checked = false;
      } catch (err) {
        setText(status, 'Couldn\'t reach the server. Please try again.');
      }
    });
  }

  // The estimates change once a day, so they are fetched again only when an
  // hour old. Ages, the open/closed state and the assumed scenario tick every 30 s.
  let tickTimer = null;
  function start() {
    if (!tickTimer) tickTimer = setInterval(() => { renderLive(); renderHours(); renderEstimates(); }, 30000);
  }
  function stop() {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    renderHours();
    for (const city of ['austin', 'dallas']) if (eta[city] && Date.now() - etaAt[city] > ETA_REFRESH_MS) loadEta(city);
    start();
  });

  qa('[data-modely-fleet]').forEach(el => { el.textContent = String(MODEL_Y_FLEET); });
  renderHours();
  initReportForm();
  renderMix('austin', null, MODEL_Y_FLEET, 'Count loading');
  loadEta('austin');
  if (!document.hidden) start();
})();
