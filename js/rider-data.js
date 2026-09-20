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

    const empty = rs.trip_count === 0;
    show('dataEmptyNotice', empty);
    if (empty && data.underReview > 0) {
      $('dataEmptyDetail').textContent = `${plural(data.underReview, 'ride')} ${data.underReview === 1 ? 'was' : 'were'} received but ${data.underReview === 1 ? 'is' : 'are'} not counted — the receipt didn't have enough detail to confirm ${data.underReview === 1 ? 'it' : 'them'}. You can remove ${data.underReview === 1 ? 'it' : 'them'} from Ride history below.`;
    }
  }

  function renderSummary(data) {
    const rs = data.rideSummary, cov = data.coverage;
    if (rs.trip_count === 0) { show('rideSummaryEmpty', true); show('rideSummaryGrid', false); return; }
    show('rideSummaryEmpty', false); show('rideSummaryGrid', true);
    $('rsTotalRides').textContent = fmtInt(rs.trip_count);
    $('rsAvgDistance').textContent = fmtMiles(rs.avg_distance);
    $('rsLongest').textContent = fmtMiles(rs.longest_ride_distance);
    $('rsUniqueVehicles').textContent = fmtInt(rs.unique_vehicles);
    $('rsFirstRide').textContent = fmtDate(rs.first_ride_date);
    $('rsLatestRide').textContent = fmtDate(rs.last_ride_date);

    const parts = [];
    if (cov.withDistance < cov.rides) parts.push(`Distance recorded for ${cov.withDistance} of ${plural(cov.rides, 'ride')} — average and longest use only those.`);
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
      </div>`;
    }).join('') + (vs.length > shown.length ? `<div class="text-xs text-slate-500">+ ${vs.length - shown.length} more</div>` : '');

    const bits = [];
    if (data.modelBreakdown.length) bits.push(data.modelBreakdown.map(m => `${m.model}: ${plural(m.ride_count, 'ride')} in ${plural(m.vehicle_count, 'vehicle')}`).join(' · '));
    if (data.unknownModelVehicles > 0) bits.push(`Model isn't confirmed for ${plural(data.unknownModelVehicles, 'vehicle')} — receipts don't state it.`);
    $('vehiclesModels').textContent = bits.join(' ');
  }

  function statusPill(dot, label, tone) {
    const colors = { on: 'bg-emerald-400', wait: 'bg-amber-400', off: 'bg-slate-600' };
    $(dot).className = 'w-2 h-2 rounded-full ' + colors[tone];
    $(label).textContent = '';
  }

  function renderSetup(sync, me) {
    const f = sync.forwarding, rs = sync.receipt_sync;

    // Pill 1 — the Tesla account link. Vehicle information only.
    const linked = !!(me && me.authenticated && me.tesla && me.tesla.connected);
    statusPill('pillTeslaDot', 'pillTeslaLabel', linked ? 'on' : 'off');
    $('pillTeslaLabel').textContent = linked ? 'Connected' : 'Not connected';

    // Pill 2 — forwarding. Never "active" until mail has actually arrived.
    if (!f.address_issued) {
      statusPill('pillFwdDot', 'pillFwdLabel', 'off');
      $('pillFwdLabel').textContent = 'Not set up';
      $('pillFwdNote').textContent = 'Create your address to get started.';
    } else if (!f.receiving) {
      statusPill('pillFwdDot', 'pillFwdLabel', 'wait');
      $('pillFwdLabel').textContent = 'Waiting for a receipt';
      $('pillFwdNote').textContent = 'Address ready — not confirmed until a receipt arrives.';
    } else {
      statusPill('pillFwdDot', 'pillFwdLabel', 'on');
      $('pillFwdLabel').textContent = 'Receiving receipts';
      $('pillFwdNote').textContent = f.last_received_at ? `Last receipt ${fmtDateTime(f.last_received_at)}` : '';
    }

    // Pill 3 — rides that have actually come in.
    const added = rs.totals.added;
    if (added > 0) {
      statusPill('pillRidesDot', 'pillRidesLabel', 'on');
      $('pillRidesLabel').textContent = plural(added, 'ride') + ' added';
      $('pillRidesNote').textContent = `${rs.rides_from_email} by email · ${rs.rides_from_import} imported${rs.totals.updated ? ` · ${rs.totals.updated} updated` : ''}`;
    } else {
      statusPill('pillRidesDot', 'pillRidesLabel', 'off');
      $('pillRidesLabel').textContent = 'None yet';
      $('pillRidesNote').textContent = 'Rides appear after your first receipt.';
    }

    // Address block
    show('fwdNoAddress', !f.address_issued);
    show('fwdAddressBlock', f.address_issued);
    if (f.address_issued) {
      $('fwdAddress').textContent = f.address || f.local_part;
      $('fwdAddress').title = f.address || f.local_part;
      show('fwdDomainNote', !f.domain_configured);
      show('fwdCodeBox', !!f.confirmation_code);
      if (f.confirmation_code) {
        $('fwdCode').textContent = f.confirmation_code;
        $('fwdCodeAt').textContent = 'Received ' + fmtDateTime(f.confirmation_code_received_at);
      }
    }

    // Receipt sync summary
    $('syncProcessed').textContent = fmtInt(rs.totals.processed);
    $('syncAdded').textContent = fmtInt(rs.totals.added);
    $('syncUpdated').textContent = fmtInt(rs.totals.updated);
    $('syncDuplicates').textContent = fmtInt(rs.totals.duplicates);
    $('syncReview').textContent = fmtInt(rs.under_review);
    $('syncErrors').textContent = fmtInt(rs.totals.errors);
    $('syncLastRun').textContent = rs.last_run
      ? `Last ${rs.last_run.source === 'receipt_email' ? 'email' : 'import'}: ${fmtDateTime(rs.last_run.finished_at || rs.last_run.started_at)}`
      : 'No receipts processed yet';
    const rejectedTotal = rs.totals.rejected;
    const noteParts = [];
    if (rs.under_review > 0) noteParts.push(`${plural(rs.under_review, 'ride')} ${rs.under_review === 1 ? 'needs' : 'need'} review (kept, but not counted in your stats). You can remove ${rs.under_review === 1 ? 'it' : 'them'} from Ride history below.`);
    const unreadable = rs.not_added_unreadable || 0;
    if (unreadable > 0) noteParts.push(`${plural(unreadable, 'receipt')} ${unreadable === 1 ? 'was' : 'were'} not added because ${unreadable === 1 ? 'its' : 'their'} date or pickup time could not be read.`);
    if (rejectedTotal > 0) noteParts.push(`${plural(rejectedTotal, 'message')} ${rejectedTotal === 1 ? "wasn't" : "weren't"} recognized as ${rejectedTotal === 1 ? 'a Tesla receipt' : 'Tesla receipts'} and ${rejectedTotal === 1 ? 'was' : 'were'} ignored.`);
    $('syncReviewNote').textContent = noteParts.join(' ');
    show('syncReviewNote', noteParts.length > 0);
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
      if (r.revision > 1) badges.push('<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-[rgba(212,175,55,0.3)] text-slate-400 uppercase tracking-wider" title="Updated by a corrected receipt">Corrected</span>');
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

  // ---------- the import panel ----------
  const OUTCOME_TEXT = {
    created: 'Added', updated: 'Updated an existing ride', duplicate: 'Already had it',
    rejected: "Didn't look like a Tesla receipt", error: 'Could not be read',
    unidentified: "Not added — the ride date or pickup time couldn't be read"
  };

  function setupImport() {
    const fileInput = $('importFiles');
    const button = $('importBtn');
    const resultBox = $('importResult');
    let files = [];

    fileInput.addEventListener('change', () => {
      files = Array.from(fileInput.files || []);
      $('importFileNames').textContent = files.length ? plural(files.length, 'file') + ' selected' : '';
    });

    button.addEventListener('click', async () => {
      const items = [];
      const pasted = $('importText').value;
      if (pasted.trim()) items.push({ kind: 'text', content: pasted });
      for (const f of files) {
        if (f.size > 2_000_000) { showImportError(`"${f.name}" is too large to import (limit about 2 MB).`); return; }
        items.push({ kind: 'eml', content: await f.text() });
      }
      if (!items.length) { showImportError('Paste a receipt or choose a .eml file first.'); return; }
      if (items.length > 25) { showImportError('Import up to 25 receipts at a time.'); return; }

      button.disabled = true; button.textContent = 'Importing…';
      try {
        const r = await api('/api/rides/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items })
        });
        if (!r.ok) throw new Error(r.json && r.json.error || 'import_failed');
        renderImportResult(r.json);
        $('importText').value = ''; fileInput.value = ''; files = []; $('importFileNames').textContent = '';
        await refreshAll(false);
      } catch (e) {
        showImportError("The import didn't go through. Check your connection and try again.");
      } finally {
        button.disabled = false; button.textContent = 'Import receipts';
      }
    });

    function showImportError(msg) {
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `<p class="text-crimson">${esc(msg)}</p>`;
    }

    function renderImportResult(res) {
      const r = res.run;
      const lines = res.results.map((it, i) => {
        const label = OUTCOME_TEXT[it.outcome] || it.outcome;
        let extra = it.review_status === 'needs_review' && (it.outcome === 'created' || it.outcome === 'updated') ? ' — needs review, not counted yet' : '';
        // The receipt matched a ride you already have but differed, and it couldn't be shown to be newer.
        if (it.outcome === 'duplicate' && it.reason === 'kept_existing_values') extra = " — differs from the ride you have, and it can't be confirmed as newer, so your existing values were kept";
        const when = it.ride_date ? ` (${fmtDate(it.ride_date)})` : '';
        return `<li class="text-slate-400">Receipt ${i + 1}: <span class="text-slate-200">${esc(label)}</span>${esc(when)}${esc(extra)}</li>`;
      }).join('');
      resultBox.classList.remove('hidden');
      resultBox.innerHTML = `<p class="mb-2 text-slate-200">Processed ${r.processed}: ${r.added} added, ${r.updated} updated, ${r.duplicates} already had, ${r.needs_review} need review, ${r.rejected} not recognized, ${r.errors} errors.</p><ul class="space-y-1 text-xs">${lines}</ul>`;
    }
  }

  // ---------- forwarding-address actions ----------
  function setupForwarding() {
    $('fwdCopyBtn').addEventListener('click', async () => {
      const text = $('fwdAddress').textContent;
      try { await navigator.clipboard.writeText(text); $('fwdCopyBtn').textContent = 'Copied'; }
      catch (e) { $('fwdCopyBtn').textContent = 'Select & copy'; }
      setTimeout(() => { $('fwdCopyBtn').textContent = 'Copy'; }, 1800);
    });
    $('fwdCreateBtn').addEventListener('click', async () => {
      const b = $('fwdCreateBtn'); b.disabled = true; b.textContent = 'Creating…';
      try {
        const r = await api('/api/receipt-ingestion/address');
        if (!r.ok) throw new Error('address');
        await refreshAll(false);
      } catch (e) {
        b.disabled = false; b.textContent = 'Create my forwarding address';
      }
    });
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

  // ---------- load ----------
  async function refreshAll(showSkeleton) {
    if (showSkeleton) setView('loading');
    let profile, me, sync, rides;
    try {
      [profile, me, sync, rides] = await Promise.all([
        api('/api/profile'), api('/api/me'), api('/api/rides/sync-status'), api(`/api/trips?page=${ridesPage}&page_size=${PAGE_SIZE}`)
      ]);
    } catch (e) {
      // Network failure: the request never completed. That is an ERROR, not "signed out".
      setView('error'); return;
    }

    if (profile.status === 401) { setView('signedOut'); return; }
    if (!profile.ok || !sync.ok || !rides.ok) {
      $('dataErrorDetail').textContent = `The server had a problem (code ${profile.ok ? (sync.ok ? rides.status : sync.status) : profile.status}). You're still signed in — your data is safe. Try again in a moment.`;
      setView('error'); return;
    }

    const data = profile.json;
    renderHero(data);
    renderSummary(data);
    renderSpending(data);
    renderMonthly(data);
    renderCities(data);
    renderVehicles(data);
    renderSetup(sync.json, me.json);
    ridesPage = rides.json.pagination.page;
    renderRides(rides.json);
    show('dataUnlinkTeslaPrompt', !!(me.json && me.json.authenticated && me.json.tesla && me.json.tesla.connected));
    setView('data');
  }

  function init() {
    if (!sessionId) { setView('signedOut'); return; }
    setupImport(); setupForwarding(); setupUnlink(); setupRideActions();
    $('dataRetry').addEventListener('click', () => refreshAll(true));
    $('ridesPrev').addEventListener('click', () => loadRides(ridesPage - 1));
    $('ridesNext').addEventListener('click', () => loadRides(ridesPage + 1));
    refreshAll(true);
  }

  init();
})();
