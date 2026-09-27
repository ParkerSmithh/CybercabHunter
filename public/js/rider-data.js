/* Rider Data page. Everything shown here is the signed-in rider's own data,
   fetched with their bearer session. Four states are kept distinct:
     loading   — authenticated, requests in flight
     error     — a request failed (NOT the same as signed out)
     signedOut — no session, or the server says the session is invalid
     data      — includes the "no counted rides yet" sub-state
   Missing values render as an em dash, never as 0. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const SESSION_KEY = 'teslaSessionId';
  const PAGE_SIZE = 10;

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const sessionId = localStorage.getItem(SESSION_KEY);
  let ridesPage = 1;
  let currentRides = null;      // last rides payload, re-rendered when the confirm prompt toggles
  let pendingDeleteId = null;   // the ride whose inline "Remove this ride?" prompt is open

  // ---------- formatting ----------
  const fmtInt = n => (n == null ? '—' : Number(n).toLocaleString());
  const fmtMiles = mi => (mi == null ? '—' : Number(mi).toFixed(1) + ' mi');
  // Minutes for anything under an hour, "1h 18m" style beyond that — never
  // more precision than the underlying minute-granularity data actually has.
  function fmtDuration(minutes) {
    if (minutes == null) return '—';
    const total = Math.round(Number(minutes));
    if (!Number.isFinite(total) || total < 0) return '—';
    if (total < 60) return total + ' min';
    const h = Math.floor(total / 60), m = total % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(sqlTs) {
    if (!sqlTs) return '—';
    const dt = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
    return isNaN(dt) ? '—' : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtMoney(cents, currency) {
    if (cents == null) return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(cents / 100); }
    catch (e) { return (cents / 100).toFixed(2) + ' ' + (currency || ''); }
  }
  const initials = name => !name ? 'CH' : name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  // ---------- network ----------
  async function api(path, options = {}) {
    const resp = await fetch(WORKER + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + sessionId, ...(options.headers || {}) }
    });
    let json = null;
    try { json = await resp.json(); } catch (e) { /* non-JSON body */ }
    return { status: resp.status, ok: resp.ok, json };
  }

  // ---------- view state ----------
  function setView(view) {
    show('dataLoading', view === 'loading');
    show('dataError', view === 'error');
    show('dataSignedOut', view === 'signedOut');
    show('dataSignedIn', view === 'data');
  }

  // ---------- rendering ----------
  function renderHero(data) {
    const rs = data.rideSummary;
    const cov = data.coverage;
    const name = data.user.display_name || data.user.handle || 'Cybercab Hunter Rider';
    $('dataAvatar').textContent = initials(data.user.display_name || data.user.handle);
    $('dataName').textContent = name;
    $('dataJoined').textContent = 'Joined ' + fmtDate((data.user.joined_at || '').slice(0, 10));

    $('heroRideCount').textContent = fmtInt(rs.trip_count);
    $('statMiles').textContent = fmtMiles(rs.total_distance);
    // Vehicles RIDDEN (unique vehicles across counted rides) — not the
    // crowdsourced "vehicles discovered" figure.
    $('statVehiclesRidden').textContent = fmtInt(rs.unique_vehicles);
    $('statCitiesCount').textContent = fmtInt(data.cities.length);
    $('statContributions').textContent = fmtInt(data.contributions);

    const first = $('heroFirstRide');
    if (rs.first_ride_date) {
      $('heroFirstRideText').textContent = `${data.firstVehicleModel ? `First ${data.firstVehicleModel} ride` : 'First ride'} · ${fmtDate(rs.first_ride_date)}`;
      first.classList.remove('hidden'); first.classList.add('flex');
    } else {
      first.classList.add('hidden'); first.classList.remove('flex');
    }

    const notes = [];
    if (cov.rides > 0 && cov.withDistance < cov.rides) notes.push(`Distance recorded for ${cov.withDistance} of ${plural(cov.rides, 'ride')}.`);
    if (cov.rides > 0 && cov.withVehicle < cov.rides) notes.push(`Vehicle identified for ${cov.withVehicle} of ${cov.rides}.`);
    if (data.underReview > 0) notes.push(`${plural(data.underReview, 'ride')} under review ${data.underReview === 1 ? 'is' : 'are'} not counted yet.`);
    $('heroNote').textContent = notes.join(' ');
  }

  function renderSummary(data) {
    const rs = data.rideSummary, cov = data.coverage;
    if (rs.trip_count === 0) { show('rideSummaryEmpty', true); show('rideSummaryGrid', false); return; }
    show('rideSummaryEmpty', false); show('rideSummaryGrid', true);
    $('rsTotalRides').textContent = fmtInt(rs.trip_count);
    $('rsAvgDistance').textContent = fmtMiles(rs.avg_distance);
    $('rsLongest').textContent = fmtMiles(rs.longest_ride_distance);
    $('rsTotalDuration').textContent = fmtDuration(rs.total_duration_minutes);
    $('rsAvgDuration').textContent = fmtDuration(rs.avg_duration_minutes);
    $('rsUniqueVehicles').textContent = fmtInt(rs.unique_vehicles);
    $('rsFirstRide').textContent = fmtDate(rs.first_ride_date);
    $('rsLatestRide').textContent = fmtDate(rs.last_ride_date);

    const parts = [];
    if (cov.withDistance < cov.rides) parts.push(`Distance recorded for ${cov.withDistance} of ${plural(cov.rides, 'ride')} — average and longest use only those.`);
    if (cov.withDuration < cov.rides) parts.push(`Duration recorded for ${cov.withDuration} of ${cov.rides} — time on board uses only those.`);
    if (rs.rides_with_derived_duration > 0) parts.push(`${plural(rs.rides_with_derived_duration, 'duration')} calculated from pickup and dropoff times rather than stated on the receipt.`);
    if (cov.withDate < cov.rides) parts.push(`Date recorded for ${cov.withDate} of ${cov.rides}.`);
    if (cov.withCity < cov.rides) parts.push(`City recorded for ${cov.withCity} of ${cov.rides}.`);
    $('rsCoverage').textContent = parts.join(' ');
  }

  function renderSpending(data) {
    const list = data.spending, cov = data.coverage;
    $('spendingCoverage').textContent = '';
    if (!list.length) { show('spendingEmpty', true); $('spendingList').innerHTML = ''; return; }
    show('spendingEmpty', false);

    $('spendingList').innerHTML = list.map(s => `
      <div>
        <div class="text-xs text-slate-500 uppercase tracking-wider mb-1">Total · ${esc(s.currency)}</div>
        <div class="font-display font-bold text-4xl mb-4">${esc(fmtMoney(s.totalCents, s.currency))}</div>
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div><div class="text-slate-500 text-xs uppercase tracking-wider mb-1">Median fare</div><div class="font-display font-bold text-lg">${esc(fmtMoney(s.medianCents, s.currency))}</div></div>
          <div><div class="text-slate-500 text-xs uppercase tracking-wider mb-1">Average fare</div><div class="font-display font-bold text-lg">${esc(fmtMoney(s.avgCents, s.currency))}</div></div>
          <div><div class="text-slate-500 text-xs uppercase tracking-wider mb-1">Free rides</div><div class="font-display font-bold text-lg">${esc(fmtInt(s.freeCount))}</div></div>
        </div>
      </div>`).join('<div class="border-t border-[rgba(212,175,55,0.1)]"></div>');

    const notes = [`Fares recorded for ${cov.withFare} of ${plural(cov.rides, 'ride')}.`];
    if (cov.withFare < cov.rides) notes.push('Rides with no fare on the receipt are left out — they are not counted as free.');
    if (list.some(s => s.currencySource !== 'extracted')) notes.push('Tesla receipts show only “$”, so US dollars are assumed.');
    $('spendingCoverage').textContent = notes.join(' ');
  }

  function renderMonthly(data) {
    const byMonth = new Map(data.monthlyActivity.map(m => [m.month, m]));
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
    }
    const inWindow = months.map(m => byMonth.get(m.key));
    const max = Math.max(0, ...inWindow.map(m => (m ? m.ride_count : 0)));
    const olderRides = data.monthlyActivity.filter(m => !months.some(w => w.key === m.month)).reduce((s, m) => s + m.ride_count, 0);
    const undated = data.coverage.rides - data.coverage.withDate;

    if (data.monthlyActivity.length === 0) {
      show('monthlyEmpty', true); show('monthlyChart', false);
    } else {
      show('monthlyEmpty', false); show('monthlyChart', true);
      $('monthlyBars').innerHTML = months.map((m, i) => {
        const row = inWindow[i];
        const n = row ? row.ride_count : 0;
        const pct = max ? Math.max(6, Math.round((n / max) * 100)) : 0;
        const dist = row && row.rides_with_distance > 0 ? ` · ${Number(row.total_distance).toFixed(1)} mi` : '';
        return `<div class="flex-1 flex flex-col items-center justify-end h-full" title="${esc(m.label)}: ${plural(n, 'ride')}${esc(dist)}">
          <span class="text-[11px] text-slate-400 mb-1 h-4">${n || ''}</span>
          <div class="w-full rounded-t-md ${n ? 'bg-gradient-to-t from-gold to-goldsoft' : 'bg-white/5'}" style="height:${n ? pct * 0.85 : 3}%"></div>
        </div>`;
      }).join('');
      $('monthlyLabels').innerHTML = months.map(m => `<div class="flex-1 text-center text-[10px] text-slate-500">${esc(m.label)}</div>`).join('');
    }
    const notes = [];
    if (olderRides > 0) notes.push(`${plural(olderRides, 'ride')} from before this window ${olderRides === 1 ? 'is' : 'are'} not shown here.`);
    if (undated > 0) notes.push(`${plural(undated, 'ride')} without a date can't be placed in a month.`);
    $('monthlyNote').textContent = notes.join(' ');
  }

  function renderCities(data) {
    if (!data.cities.length) { show('citiesEmpty', true); $('citiesList').innerHTML = ''; return; }
    show('citiesEmpty', false);
    $('citiesList').innerHTML = data.cities.map(c => {
      const dist = c.rides_with_distance > 0
        ? fmtMiles(c.total_distance) + (c.rides_with_distance < c.ride_count ? ` (${c.rides_with_distance} of ${c.ride_count} rides)` : '')
        : 'distance unknown';
      return `<div class="p-3 rounded-xl border border-[rgba(212,175,55,0.08)]">
        <div class="flex items-center justify-between">
          <span class="font-semibold">${esc(c.service_area)}</span>
          <span class="font-display font-bold text-slate-300">${esc(plural(c.ride_count, 'ride'))}</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">${esc(dist)} · first ride ${esc(fmtDate(c.first_ride_date))}</div>
      </div>`;
    }).join('');
  }

  function renderVehicles(data) {
    const vs = data.vehicleStats;
    if (!vs.length) { show('vehiclesEmpty', true); $('vehiclesList').innerHTML = ''; $('vehiclesModels').textContent = ''; return; }
    show('vehiclesEmpty', false);
    const shown = vs.slice(0, 8);
    $('vehiclesList').innerHTML = shown.map(v => {
      const dist = v.rides_with_distance > 0 ? ' · ' + fmtMiles(v.total_distance) : '';
      return `<div class="p-3 rounded-xl border border-[rgba(212,175,55,0.08)]">
        <div class="flex items-center justify-between">
          <span class="font-display font-bold">${esc(v.license_plate)}</span>
          <span class="font-display font-bold text-slate-300">${esc(plural(v.ride_count, 'ride'))}</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">${esc(v.model || 'Model not confirmed')}${esc(dist)}</div>
        ${publicVehicleLink(v.public_eligible, v.vehicle_id)}
      </div>`;
    }).join('') + (vs.length > shown.length ? `<div class="text-xs text-slate-500">+ ${vs.length - shown.length} more</div>` : '');

    const bits = [];
    if (data.modelBreakdown.length) bits.push(data.modelBreakdown.map(m => `${m.model}: ${plural(m.ride_count, 'ride')} in ${plural(m.vehicle_count, 'vehicle')}`).join(' · '));
    if (data.unknownModelVehicles > 0) bits.push(`Model isn't confirmed for ${plural(data.unknownModelVehicles, 'vehicle')} — receipts don't state it.`);
    $('vehiclesModels').textContent = bits.join(' ');
  }

  // A link to the public /vehicle/<id> page, shown only when the API says
  // this vehicle is currently public-eligible (worker/ride-status.js
  // publicVehicleEligibleSql — the SAME rule the registry/vehicle pages
  // enforce server-side; this is a navigation convenience only, never the
  // authority — the public page re-checks eligibility itself regardless of
  // what this link is or isn't shown). Never rendered for a private or
  // ineligible vehicle, and never implies ownership or that Tesla has
  // verified anything about the car.
  function publicVehicleLink(eligible, id) {
    if (!eligible || !id) return '';
    return `<div class="mt-1.5"><a href="/vehicle/${esc(encodeURIComponent(id))}" class="text-xs text-cyan hover:underline">View on Cars →</a></div>`;
  }

  // Vehicles this rider's OWN counted ride was the earliest on record for
  // (see the "Crowdsourced concept" comment on this query in
  // worker/db-rides.js) — a data-provenance credit, not a claim of
  // ownership or that the rider physically verified the car in person.
  function renderDiscovered(data) {
    const list = data.discoveredVehicles;
    if (!list.length) { show('discoveredEmpty', true); $('discoveredList').innerHTML = ''; return; }
    show('discoveredEmpty', false);
    $('discoveredList').innerHTML = list.map(v => `
      <div class="p-3 rounded-xl border border-[rgba(212,175,55,0.08)]">
        <div class="flex items-center justify-between">
          <span class="font-display font-bold">${esc(v.license_plate || 'Plate unknown')}</span>
          <span class="text-xs text-slate-500">${esc(fmtDate(v.discovered_ride_date))}</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">${esc(v.model || 'Model not confirmed')}${v.service_area ? ' · ' + esc(v.service_area) : ''}</div>
        ${publicVehicleLink(v.public_eligible, v.id)}
      </div>`).join('');
  }

  const SOURCE_LABELS = { receipt_email: 'Email receipt', receipt_import: 'Imported receipt' };

  // A ride is removed only after an inline confirmation. The id comes from the
  // server's own list for THIS rider; the server re-checks ownership regardless.
  function removeCell(id) {
    if (pendingDeleteId === id) {
      return `<span class="text-xs text-slate-300 mr-2">Remove this ride?</span>
        <button type="button" data-action="confirm-remove" data-id="${esc(id)}" class="text-xs px-2 py-1 rounded border border-crimson/50 text-crimson hover:bg-crimson/10">Remove</button>
        <button type="button" data-action="cancel-remove" class="text-xs px-2 py-1 ml-1 rounded border border-[rgba(212,175,55,0.2)] text-slate-400 hover:text-slate-200">Cancel</button>`;
    }
    return `<button type="button" data-action="ask-remove" data-id="${esc(id)}" aria-label="Remove this ride from your history" class="text-xs text-slate-500 hover:text-crimson underline-offset-2 hover:underline">Remove</button>`;
  }

  function renderRides(body) {
    currentRides = body;
    const { trips, pagination } = body;
    $('ridesTotal').textContent = pagination.total ? plural(pagination.total, 'ride') : '';
    show('ridesError', false);
    if (!pagination.total) { show('ridesEmpty', true); show('ridesTableWrap', false); show('ridesPager', false); return; }
    show('ridesEmpty', false); show('ridesTableWrap', true);

    $('ridesBody').innerHTML = trips.map(r => {
      const badges = [];
      if (r.status === 'under_review') badges.push('<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-amber-400/40 text-amber-300 uppercase tracking-wider" title="Kept, but not counted in your statistics until reviewed">Under review</span>');
      if (r.status === 'rejected') badges.push('<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-crimson/50 text-crimson uppercase tracking-wider">Rejected</span>');
      if (r.corrected) badges.push('<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-[rgba(212,175,55,0.3)] text-slate-400 uppercase tracking-wider" title="A later receipt changed the fare, distance, duration, or currency">Corrected</span>');
      const fare = r.fare_amount_cents == null ? '—' : (r.fare_amount_cents === 0 ? 'Free' : fmtMoney(r.fare_amount_cents, r.currency));
      return `<tr class="${r.status === 'counted' ? '' : 'opacity-70'}">
        <td class="py-3 pr-4 whitespace-nowrap">${esc(fmtDate(r.ride_date))}${badges.join('')}</td>
        <td class="py-3 pr-4">${esc(r.city || '—')}</td>
        <td class="py-3 pr-4 text-right whitespace-nowrap">${esc(fmtMiles(r.distance))}</td>
        <td class="py-3 pr-4 text-right whitespace-nowrap">${esc(fare)}</td>
        <td class="py-3 pr-4 font-display font-bold">${esc(r.vehicle_plate || '—')}</td>
        <td class="py-3 pr-4 text-slate-400 whitespace-nowrap">${esc(SOURCE_LABELS[r.source] || r.source)}</td>
        <td class="py-3 text-right whitespace-nowrap">${removeCell(r.id)}</td>
      </tr>`;
    }).join('');

    show('ridesPager', pagination.total_pages > 1);
    $('ridesPageLabel').textContent = `Page ${pagination.page} of ${pagination.total_pages}`;
    $('ridesPrev').disabled = pagination.page <= 1;
    $('ridesNext').disabled = pagination.page >= pagination.total_pages;
  }

  function showActionError(msg) {
    $('ridesActionError').textContent = msg;
    show('ridesActionError', !!msg);
  }

  async function removeRide(id, button) {
    button.disabled = true; button.textContent = 'Removing…';
    let resp;
    try {
      resp = await api('/api/trips/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (e) {
      pendingDeleteId = null; renderRides(currentRides);
      showActionError("Couldn't remove the ride — check your connection. Nothing was changed.");
      return;
    }
    pendingDeleteId = null;
    if (resp.ok || resp.status === 404) {
      // 404 = already gone (removed elsewhere): the goal is met either way.
      showActionError(resp.ok ? '' : 'That ride was already removed.');
      // Removing the last ride on a later page would leave that page empty.
      if (currentRides && currentRides.trips.length === 1 && ridesPage > 1) ridesPage -= 1;
      await refreshAll(false);
      return;
    }
    renderRides(currentRides);
    showActionError(resp.status === 401
      ? 'Your session has expired — sign in again to remove rides.'
      : "Couldn't remove the ride — nothing was changed. Try again in a moment.");
  }

  function setupRideActions() {
    $('ridesBody').addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'ask-remove') { pendingDeleteId = btn.dataset.id; showActionError(''); renderRides(currentRides); }
      else if (action === 'cancel-remove') { pendingDeleteId = null; renderRides(currentRides); }
      else if (action === 'confirm-remove') removeRide(btn.dataset.id, btn);
    });
  }

  async function loadRides(page) {
    try {
      const r = await api(`/api/trips?page=${page}&page_size=${PAGE_SIZE}`);
      if (!r.ok) throw new Error('rides');
      ridesPage = r.json.pagination.page;
      pendingDeleteId = null;
      renderRides(r.json);
    } catch (e) {
      show('ridesError', true);
    }
  }

  // ---------- Tesla unlink (vehicle-info connection only) ----------
  function setupUnlink() {
    const btn = $('teslaUnlinkBtn');
    btn.addEventListener('click', () => {
      btn.disabled = true; btn.textContent = 'Unlinking…';
      fetch(WORKER + '/api/tesla/disconnect', { method: 'POST', headers: { Authorization: 'Bearer ' + sessionId } })
        .then(() => location.reload())
        .catch(() => { btn.disabled = false; btn.textContent = 'Unlink Tesla Account'; });
    });
  }

  // ---------- receipt address ----------
  // The rider's OWN forwarding address. Both calls carry only the bearer
  // session; the server resolves the user from it, so there is no id here
  // for anyone to change. GET .../address issues the address on first use.
  let fwdSeq = 0;
  function fwdView(view) {
    show('fwdLoading', view === 'loading');
    show('fwdError', view === 'error');
    show('fwdRevoked', view === 'revoked');
    show('fwdReady', view === 'ready');
  }

  async function loadForwarding() {
    const seq = ++fwdSeq;
    fwdView('loading');
    let addr, sync;
    try {
      addr = await api('/api/receipt-ingestion/address');
      if (seq !== fwdSeq) return;
      if (addr.status === 401) { setView('signedOut'); return; }
      if (addr.status === 409 && addr.json && addr.json.error === 'address_revoked') { fwdView('revoked'); return; }
      if (!addr.ok || !addr.json) { fwdView('error'); return; }
      sync = await api('/api/rides/sync-status');
    } catch (e) {
      if (seq === fwdSeq) fwdView('error');
      return;
    }
    if (seq !== fwdSeq) return;

    const a = addr.json;
    const text = a.address || a.local_part || '';
    $('fwdAddress').textContent = text;
    show('fwdDomainNote', !a.domain_configured);

    // Status and the Gmail code are extras: if sync-status fails, the address still shows.
    const f = sync && sync.ok && sync.json && sync.json.forwarding;
    $('fwdReceiving').textContent = !f ? ''
      : f.receiving
        ? 'Receiving — last receipt arrived ' + fmtDateTime(f.last_received_at) + '.'
        : 'No receipt has arrived at this address yet.';
    show('fwdCodeBox', !!(f && f.confirmation_code));
    if (f && f.confirmation_code) {
      $('fwdCode').textContent = f.confirmation_code;
      $('fwdCodeAt').textContent = 'Received ' + fmtDateTime(f.confirmation_code_received_at);
    }
    fwdView('ready');
  }

  function setupForwarding() {
    $('fwdRetry').addEventListener('click', loadForwarding);
    $('fwdCopyBtn').addEventListener('click', async () => {
      const btn = $('fwdCopyBtn');
      const text = $('fwdAddress').textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch (e) {
        // No clipboard access: select the address so the rider can copy it by hand.
        const range = document.createRange();
        range.selectNodeContents($('fwdAddress'));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        btn.textContent = 'Selected — copy it';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    });
  }

  // ---------- automatic Gmail import ----------
  // The rider's own optional Gmail connection (worker/gmail.js). Every call
  // carries only the bearer session; tokens never reach the browser. The card
  // stays hidden unless the server says Gmail import is configured.
  const GMAIL_NOTICES = {
    connected: ['Gmail connected. Receipts from the last 90 days are being imported now.', 'ok'],
    cancelled: ['Gmail wasn\'t connected — the Google screen was cancelled.', 'info'],
    missing_permission: ['Gmail access wasn\'t granted, so nothing was connected.', 'info'],
    wrong_account: ['That Gmail isn\'t the Google account you signed in with. Connect that same account.', 'warn'],
    invalid_state: ['That connection attempt expired. Please try again.', 'warn'],
    expired_state: ['That connection attempt expired. Please try again.', 'warn'],
    google_signin_required: ['Gmail import needs an account that signs in with Google.', 'warn'],
    unavailable: ['Gmail import isn\'t available yet.', 'info'],
    error: ['Couldn\'t connect Gmail. Please try again.', 'warn']
  };
  const NOTICE_STYLE = {
    ok: 'border-emerald-400/40 text-emerald-200', info: 'border-slate-500/40 text-slate-300', warn: 'border-amber-400/40 text-amber-200'
  };
  let gmailPollsLeft = 0;
  let gmailDisconnectArmed = false;

  function gmailNotice(key) {
    const [text, kind] = GMAIL_NOTICES[key] || GMAIL_NOTICES.error;
    const el = $('gmailNotice');
    el.textContent = text;
    el.className = 'text-sm rounded-lg border px-4 py-3 mb-4 ' + NOTICE_STYLE[kind];
  }

  function renderGmail(st) {
    const dot = $('gmailDot');
    const views = {
      not_connected: ['Not connected', 'bg-slate-600'],
      syncing: [st.initial_import_complete ? 'Gmail connected — checking now…' : 'Gmail connected — importing existing receipts…', 'bg-cyan animate-pulse'],
      connected: ['✓ Gmail connected', 'bg-emerald-400'],
      error: ['Gmail connected — the last check didn\'t finish. It will retry automatically.', 'bg-amber-400'],
      reconnect_required: ['Gmail connection needs attention — Google no longer accepts it. Reconnect to resume importing.', 'bg-crimson']
    };
    const [label, dotClass] = views[st.state] || views.not_connected;
    $('gmailStatusText').textContent = label;
    dot.className = 'w-2 h-2 rounded-full shrink-0 ' + dotClass;
    const meta = [];
    if (st.email && st.state !== 'not_connected') meta.push(st.email);
    if (st.last_checked_at) meta.push('Last checked ' + fmtDateTime(st.last_checked_at));
    if (st.last_receipt_at) meta.push('Last receipt found ' + fmtDateTime(st.last_receipt_at));
    $('gmailMeta').textContent = meta.join(' · ');

    const connect = $('gmailConnectBtn');
    connect.textContent = st.state === 'reconnect_required' ? 'Reconnect Gmail' : 'Connect Gmail';
    show('gmailConnectBtn', st.state === 'not_connected' || st.state === 'reconnect_required');
    show('gmailDisconnectBtn', st.state !== 'not_connected');
    gmailDisconnectArmed = false;
    $('gmailDisconnectBtn').textContent = 'Disconnect Gmail';
  }

  async function loadGmail() {
    let resp;
    try { resp = await api('/api/gmail/status'); } catch (e) { return; }
    if (!resp.ok || !resp.json || !resp.json.configured) { show('gmailCard', false); return; }
    show('gmailCard', true);
    renderGmail(resp.json);
    if (resp.json.state === 'syncing' && gmailPollsLeft > 0) {
      gmailPollsLeft -= 1;
      setTimeout(loadGmail, 15000);
    }
  }

  function setupGmail() {
    $('gmailConnectBtn').addEventListener('click', async () => {
      const btn = $('gmailConnectBtn');
      btn.disabled = true;
      let resp;
      try { resp = await api('/api/gmail/connect', { method: 'POST' }); } catch (e) { resp = null; }
      const url = resp && resp.ok && resp.json && resp.json.authorize_url;
      // Only ever navigate to Google's own authorization page.
      if (url && /^https:\/\/accounts\.google\.com\//.test(url)) { location.assign(url); return; }
      btn.disabled = false;
      show('gmailNotice', true);
      gmailNotice(resp && resp.json && resp.json.error === 'google_signin_required' ? 'google_signin_required' : 'error');
    });
    $('gmailDisconnectBtn').addEventListener('click', async () => {
      const btn = $('gmailDisconnectBtn');
      if (!gmailDisconnectArmed) { gmailDisconnectArmed = true; btn.textContent = 'Confirm disconnect'; return; }
      btn.disabled = true;
      try { await api('/api/gmail/disconnect', { method: 'POST' }); } catch (e) { /* status reload shows the truth */ }
      btn.disabled = false;
      show('gmailNotice', false);
      await loadGmail();
    });
    // One-time result of the Google round trip (?gmail=…), then scrubbed.
    const params = new URLSearchParams(location.search);
    const result = params.get('gmail');
    if (result) {
      gmailNotice(result);
      show('gmailNotice', true);
      if (result === 'connected') gmailPollsLeft = 8;
      params.delete('gmail');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
    }
  }

  // ---------- load ----------
  async function refreshAll(showSkeleton) {
    if (showSkeleton) setView('loading');
    let profile, me, rides;
    try {
      [profile, me, rides] = await Promise.all([
        api('/api/profile'), api('/api/me'), api(`/api/trips?page=${ridesPage}&page_size=${PAGE_SIZE}`)
      ]);
    } catch (e) {
      // Network failure: the request never completed. That is an ERROR, not "signed out".
      setView('error'); return;
    }

    if (profile.status === 401) { setView('signedOut'); return; }
    if (!profile.ok || !rides.ok) {
      $('dataErrorDetail').textContent = `The server had a problem (code ${profile.ok ? rides.status : profile.status}). You're still signed in — your data is safe. Try again in a moment.`;
      setView('error'); return;
    }

    const data = profile.json;
    renderHero(data);
    renderSummary(data);
    renderSpending(data);
    renderMonthly(data);
    renderCities(data);
    renderVehicles(data);
    renderDiscovered(data);
    ridesPage = rides.json.pagination.page;
    renderRides(rides.json);
    show('dataUnlinkTeslaPrompt', !!(me.json && me.json.authenticated && me.json.tesla && me.json.tesla.connected));
    setView('data');
    // The address only on a full load (or Retry) — not on the quiet refresh
    // after removing a ride, which would flash the card back to loading.
    if (showSkeleton) { loadForwarding(); loadGmail(); }
  }

  function init() {
    if (!sessionId) { setView('signedOut'); return; }
    setupUnlink(); setupRideActions(); setupForwarding(); setupGmail();
    $('dataRetry').addEventListener('click', () => refreshAll(true));
    $('ridesPrev').addEventListener('click', () => loadRides(ridesPage - 1));
    $('ridesNext').addEventListener('click', () => loadRides(ridesPage + 1));
    refreshAll(true);
  }

  init();
})();
