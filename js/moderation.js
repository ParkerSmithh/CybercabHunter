/* Moderator review queue (Phase 3D-C2) and registry vehicle review
   (Phase 3E visibility, Phase 3H explicit approval). Calls four endpoints — the sighting queue/review pair and the
   registry-vehicle list / review pair (POST .../review is the only way this page grants
   or withdraws public visibility) — all moderator-gated server-side (worker/moderation.js's requireModerator) —
   this page never decides authorization itself, it only reflects what the
   API actually returned. Same session mechanism as every other page
   (teslaSessionId in localStorage); no second auth system, no client-side
   role check standing in for the real one. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const SESSION_KEY = 'teslaSessionId';

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const sessionId = localStorage.getItem(SESSION_KEY);
  let queue = [];
  let vehicles = [];
  const pendingReject = new Set();   // submission_ids whose inline "reject" reason box is open
  const busy = new Set();            // submission_ids with a request currently in flight

  function fmtDateTime(sqlTs) {
    if (!sqlTs) return '—';
    const dt = new Date(String(sqlTs).replace(' ', 'T') + 'Z');
    return isNaN(dt) ? '—' : dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // A calendar date ('YYYY-MM-DD') shown as a date, not an instant: no
  // timezone shift. Missing/unparseable -> an em dash.
  function fmtDay(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    if (!m) return '—';
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(dt) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  async function api(path, options = {}) {
    const resp = await fetch(WORKER + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + sessionId, ...(options.headers || {}) }
    });
    let json = null;
    try { json = await resp.json(); } catch (e) { /* non-JSON body */ }
    return { status: resp.status, ok: resp.ok, json };
  }

  function setView(view) {
    show('modLoading', view === 'loading');
    show('modSignedOut', view === 'signedOut');
    show('modForbidden', view === 'forbidden');
    show('modError', view === 'error');
    show('modQueue', view === 'queue');
  }

  function sightingCard(s) {
    const rejecting = pendingReject.has(s.submission_id);
    const isBusy = busy.has(s.submission_id);
    const details = [];
    if (s.model) details.push(`Model: ${esc(s.model)}`);
    if (s.color) details.push(`Color: ${esc(s.color)}`);
    if (s.approx_location) details.push(`Near: ${esc(s.approx_location)}`);
    if (s.evidence_ref) details.push('Evidence attached');
    const vehicleLine = s.robotaxi_vehicle_id
      ? `<a href="vehicle/${esc(s.robotaxi_vehicle_id)}" class="text-cyan hover:underline" target="_blank" rel="noopener">Linked to an existing registry vehicle →</a>`
      : '<span class="text-slate-500">No matching vehicle in the registry — plate is unrecognized</span>';

    return `<div class="glass rounded-2xl p-6 [overflow-wrap:anywhere]" data-submission-id="${esc(s.submission_id)}">
      <div class="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div class="min-w-0 max-w-full">
          <div class="font-display font-bold text-xl">${esc(s.license_plate || 'Plate not given')}</div>
          <div class="text-xs text-slate-500 mt-1">Submitted ${esc(fmtDateTime(s.submitted_at))} · Observed ${esc(fmtDateTime(s.observed_at))}</div>
        </div>
        <span class="max-w-full text-xs font-semibold px-2.5 py-1 rounded-full border border-[rgba(212,175,55,0.3)] text-slate-300 uppercase tracking-wider">${esc(s.service_area || 'Area unknown')}</span>
      </div>
      <div class="text-sm mb-3">${vehicleLine}</div>
      ${details.length ? `<div class="text-xs text-slate-400 space-y-1 mb-3">${details.map(d => `<div>${d}</div>`).join('')}</div>` : ''}
      ${s.notes ? `<div class="text-sm text-slate-300 bg-white/5 rounded-lg p-3 mb-4">${esc(s.notes)}</div>` : ''}
      <div class="flex items-center gap-2 flex-wrap pt-3 border-t border-[rgba(212,175,55,0.1)]">
        ${rejecting ? `
          <div class="w-full">
            <label class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Rejection reason</label>
            <textarea data-reject-reason rows="2" maxlength="280" placeholder="Why is this sighting being rejected?" class="mt-2 w-full bg-panel border border-[rgba(212,175,55,0.25)] rounded-lg px-3 py-2.5 text-sm placeholder:text-slate-600"></textarea>
            <div class="flex items-center gap-2 mt-2">
              <button type="button" data-action="confirm-reject" ${isBusy ? 'disabled' : ''} class="text-xs font-bold px-3 py-2 rounded-lg border border-crimson/50 text-crimson hover:bg-crimson/10 disabled:opacity-50">Confirm Reject</button>
              <button type="button" data-action="cancel-reject" class="text-xs px-3 py-2 rounded-lg border border-[rgba(212,175,55,0.2)] text-slate-400 hover:text-slate-200">Cancel</button>
            </div>
          </div>
        ` : `
          <button type="button" data-action="approve" ${isBusy ? 'disabled' : ''} class="btn-magnetic text-xs font-bold px-4 py-2.5 rounded-lg bg-gradient-to-r from-goldsoft to-gold text-[#1a1204] disabled:opacity-50">${isBusy ? 'Working…' : 'Approve'}</button>
          <button type="button" data-action="ask-reject" ${isBusy ? 'disabled' : ''} class="text-xs font-bold px-4 py-2.5 rounded-lg border border-crimson/50 text-crimson hover:bg-crimson/10 disabled:opacity-50">Reject</button>
        `}
      </div>
    </div>`;
  }

  function renderQueue() {
    $('modList').innerHTML = queue.map(sightingCard).join('');
  }

  async function loadQueue(showSkeleton) {
    if (showSkeleton) setView('loading');
    let resp;
    try {
      resp = await api('/api/moderation/vehicle-sightings');
    } catch (e) {
      $('modErrorDetail').textContent = 'Something went wrong reaching the server. Check your connection and try again.';
      setView('error');
      return;
    }
    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    if (!resp.ok) {
      $('modErrorDetail').textContent = `The server had a problem (code ${resp.status}). Try again in a moment.`;
      setView('error');
      return;
    }
    queue = (resp.json && resp.json.sightings) || [];
    renderQueue();
    setView('queue');
    loadVehicles();
  }

  async function review(submissionId, action, rejectionReason) {
    busy.add(submissionId);
    renderQueue();
    const body = action === 'approve' ? { action } : { action, rejection_reason: rejectionReason };
    let resp;
    try {
      resp = await api(`/api/moderation/vehicle-sightings/${encodeURIComponent(submissionId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
    } catch (e) {
      busy.delete(submissionId);
      renderQueue();
      CCC.toast("Couldn't reach the server. Please try again.", 'error');
      return;
    }
    busy.delete(submissionId);
    pendingReject.delete(submissionId);

    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    if (resp.status === 409) {
      // Someone else (or an earlier click) already reviewed this one —
      // drop it from the local queue rather than leaving a stale row the
      // moderator could try to act on again.
      queue = queue.filter(s => s.submission_id !== submissionId);
      renderQueue();
      CCC.toast('That sighting was already reviewed — removed from the queue.', 'info');
      return;
    }
    if (resp.status === 400) {
      renderQueue();
      CCC.toast(resp.json && resp.json.error === 'rejection_reason_required' ? 'A rejection reason is required.' : "That request wasn't valid.", 'error');
      return;
    }
    if (!resp.ok) {
      renderQueue();
      CCC.toast("Couldn't submit the review. Please try again.", 'error');
      return;
    }

    queue = queue.filter(s => s.submission_id !== submissionId);
    renderQueue();
    CCC.toast(action === 'approve' ? 'Sighting approved.' : 'Sighting rejected.', 'success');
  }

  function setupActions() {
    $('modList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const card = btn.closest('[data-submission-id]');
      const submissionId = card.dataset.submissionId;
      const action = btn.dataset.action;

      if (action === 'approve') {
        review(submissionId, 'approve');
      } else if (action === 'ask-reject') {
        pendingReject.add(submissionId);
        renderQueue();
      } else if (action === 'cancel-reject') {
        pendingReject.delete(submissionId);
        renderQueue();
      } else if (action === 'confirm-reject') {
        const textarea = card.querySelector('[data-reject-reason]');
        const reason = textarea.value.trim();
        if (!reason) { CCC.toast('A rejection reason is required.', 'error'); return; }
        review(submissionId, 'reject', reason);
      }
    });
  }

  // ---------- registry vehicle review (Phase 3E visibility, Phase 3H approval) ----------
  // Every rule shown here is computed by the server (vehicle.approval); this
  // code only labels it. Labels are plain facts — never a score or a ranking.
  const vehicleBusy = new Set();      // vehicle ids with a request in flight
  const pendingReview = new Map();    // vehicle id -> 'delete' (inline confirmation open; approve/return are instant)

  const REASON_LABELS = {
    no_counted_rides: 'No counted rides',
    duplicate_plate: 'Duplicate plate',
    no_plate: 'No plate recorded',
    no_vin: 'No VIN saved yet'
  };
  const NOTE_LABELS = {
    eligible_counted_ride_present: 'Eligible counted ride present',
    needs_review_ride_present: 'Needs review ride present',
    rejected_only_history: 'Rejected-only history',
    no_rides_on_record: 'No rides on record (orphaned)'
  };
  const label = (map, code) => map[code] || String(code);

  // The four moderator-facing states. The badge shows visibility; the line
  // under it shows approval readiness.
  function vehicleStateView(v) {
    const state = v.approval && v.approval.state;
    if (state === 'public') {
      return { badge: 'Public', line: 'Visible on the public registry.', cls: 'text-emerald-400' };
    }
    if (v.visibility === 'public') {
      return { badge: 'Approved — Not Visible', line: 'Not Eligible: approved, but hidden from the public while the reasons below apply.', cls: 'text-amber-400' };
    }
    if (state === 'eligible_for_approval') {
      return { badge: 'Private — Needs Review', line: 'Eligible for Approval', cls: 'text-cyan' };
    }
    return { badge: 'Private — Needs Review', line: 'Not Eligible', cls: 'text-amber-400' };
  }

  function reviewLine(v) {
    const r = v.latest_review;
    if (!r) return '<div class="text-xs text-slate-500 mt-2">No moderator review recorded for this vehicle yet.</div>';
    const what = r.action === 'approved_public' ? 'Approved for public' : 'Returned to private';
    const who = r.moderator_display_name || 'a moderator';
    return `<div class="text-xs text-slate-400 mt-2">Last review: ${esc(what)} by ${esc(who)} · ${esc(fmtDateTime(r.created_at))}</div>`;
  }

  function deletePanel(v) {
    const isBusy = vehicleBusy.has(v.id);
    return `<div class="w-full">
      <p class="text-xs text-slate-400 leading-relaxed">Permanently delete <span class="font-semibold text-slate-200">${esc(v.license_plate || 'this vehicle')}</span> from the registry? This cannot be undone. It disappears from the public site immediately, and the ride(s)/receipt(s) logged against it are deleted too.</p>
      <div class="flex items-center gap-2 mt-3 flex-wrap">
        <button type="button" data-vehicle-action="confirm-delete" ${isBusy ? 'disabled' : ''} class="border border-crimson/50 text-crimson hover:bg-crimson/10 text-xs font-bold px-4 py-2.5 rounded-lg disabled:opacity-50">${isBusy ? 'Working…' : 'Confirm Delete'}</button>
        <button type="button" data-vehicle-action="cancel-review" class="text-xs px-3 py-2.5 rounded-lg border border-[rgba(212,175,55,0.2)] text-slate-400 hover:text-slate-200">Cancel</button>
      </div>
    </div>`;
  }

  // Robotaxi Tracker is a manual, human-only reference: a plain external
  // link a moderator clicks and reads for themselves. Cybercab Hunter never
  // fetches, scrapes, or otherwise programmatically touches it — see the
  // workflow comment above worker/moderation.js's apiReviewRegistryVehicle.
  // Linking straight to a specific plate's page isn't done here since that
  // exact URL shape isn't something this app owns or can rely on; the
  // vehicles listing is a real, general page a moderator can search from.
  const ROBOTAXI_TRACKER_URL = 'https://robotaxitracker.com/vehicles';

  // The VIN/Approve-Cybercab panel of the moderator card. Only meaningful for
  // a vehicle a moderator might still approve (not already public, not mid
  // delete-confirmation) — see vehicleCard. Save VIN and Approve Cybercab are
  // always two separate clicks/requests: entering a VIN alone never approves
  // anything, and the Approve Cybercab button stays disabled
  // (v.can_approve_cybercab, computed server-side) until a vin is on file.
  function cybercabPanel(v) {
    const busy = vehicleBusy.has(v.id);
    const vinRow = v.vin
      ? `<div class="text-xs text-slate-300 mt-1">VIN on file: <span class="font-mono">${esc(v.vin)}</span></div>`
      : `<div class="flex items-center gap-2 mt-1 flex-wrap">
           <input type="text" data-vehicle-vin-input="${esc(v.id)}" placeholder="17-character VIN" maxlength="17" autocomplete="off"
             class="bg-black/30 border border-[rgba(212,175,55,0.25)] rounded-lg px-3 py-2 text-xs font-mono uppercase w-48 disabled:opacity-50" ${busy ? 'disabled' : ''}>
           <button type="button" data-vehicle-action="save-vin" ${busy ? 'disabled' : ''} class="text-xs font-bold px-3 py-2 rounded-lg border border-[rgba(212,175,55,0.3)] text-slate-200 hover:bg-white/5 disabled:opacity-50">${busy ? 'Working…' : 'Save VIN'}</button>
         </div>`;
    const approveDisabled = busy || !v.can_approve_cybercab;
    return `<div class="mt-3 pt-3 border-t border-[rgba(212,175,55,0.1)]">
      <div class="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Cybercab verification</div>
      <a href="${esc(ROBOTAXI_TRACKER_URL)}" target="_blank" rel="noopener" class="text-xs text-cyan hover:underline">Check Robotaxi Tracker →</a>
      <div class="text-xs text-slate-500 mt-1">Look up ${esc(v.license_plate || 'this plate')} there. If it's shown as a Cybercab, copy its VIN and enter it below, then approve. If it's shown as a Model Y (or anything else), use Delete Vehicle instead — there is no separate rejection step.</div>
      ${vinRow}
      <button type="button" data-vehicle-action="approve-cybercab" ${approveDisabled ? 'disabled' : ''} class="mt-2 btn-magnetic bg-gradient-to-r from-goldsoft to-gold text-[#1a1204] text-xs font-bold px-4 py-2.5 rounded-lg disabled:opacity-50">${busy ? 'Working…' : 'Approve Cybercab'}</button>
    </div>`;
  }

  function vehicleCard(v) {
    const view = vehicleStateView(v);
    const ap = v.approval || { blocking_reasons: [], notes: [], can_approve: false };
    const src = v.counted_rides_by_source || {};
    const mode = pendingReview.get(v.id);
    const reasons = ap.blocking_reasons.length
      ? `<div class="text-xs text-amber-400 mt-1">${ap.blocking_reasons.map(c => esc(label(REASON_LABELS, c))).join(' · ')}</div>` : '';
    const notes = ap.notes.length
      ? `<div class="flex flex-wrap gap-1.5 mt-2">${ap.notes.map(c => `<span class="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300">${esc(label(NOTE_LABELS, c))}</span>`).join('')}</div>` : '';
    const dupe = v.plate_vehicle_count > 1
      ? `<div class="text-xs text-amber-400 mt-2">Duplicate plate: ${esc(v.plate_vehicle_count)} registry vehicles share this plate, so it cannot be approved and its sightings are not matched publicly.</div>` : '';
    // Provenance: how the counted rides ENTERED the system. Descriptive only.
    const provenance = v.counted_ride_count > 0
      ? `<div class="text-xs text-slate-400 mt-3">
           <div class="font-semibold text-slate-300 mb-0.5">How the counted rides entered</div>
           <div>Forwarded email: ${esc(src.receipt_email || 0)} · Import (pasted text or .eml file): ${esc(src.receipt_import || 0)} · Other: ${esc(src.other || 0)}</div>
           <div class="mt-1">First counted ride: ${esc(fmtDay(v.first_counted_ride_date))} · Latest counted ride: ${esc(fmtDay(v.last_counted_ride_date))}</div>
         </div>`
      : '<div class="text-xs text-slate-500 mt-3">No counted rides yet, so there is no ride provenance to show.</div>';
    const attached = `<div class="text-xs text-slate-400 mt-2">Rides attached: ${esc(v.counted_ride_count)} counted · ${esc(v.needs_review_ride_count || 0)} needs review · ${esc(v.rejected_ride_count || 0)} rejected · ${esc(v.total_trip_count || 0)} total trips on record</div>`;
    const record = `<div class="text-xs text-slate-500 mt-2">Vehicle record created ${esc(fmtDateTime(v.created_at))} · First seen ${esc(fmtDateTime(v.first_seen_at))} · Last receipt activity ${esc(fmtDateTime(v.last_seen_at))}</div>
      <div class="text-xs text-slate-500 mt-1" title="An existing field on the vehicle record. Moderation does not change it.">Record field verification_status: ${esc(v.verification_status || '—')}</div>`;

    // No ordinary "Approve" action exists for registry vehicles — a private
    // vehicle's only path to public visibility is Approve Cybercab, in the
    // Cybercab verification panel below (cybercabPanel), which is vin-gated.
    // This card's own reasons/notes above already explain anything blocking
    // that (e.g. no counted ride, duplicate plate); Delete remains the only
    // action offered here for a private vehicle.
    let actions;
    if (mode === 'delete') {
      actions = deletePanel(v);
    } else {
      const busy = vehicleBusy.has(v.id);
      const deleteBtn = `<button type="button" data-vehicle-action="ask-delete" ${busy ? 'disabled' : ''} class="text-xs font-bold px-4 py-2.5 rounded-lg border border-slate-500/40 text-slate-400 hover:bg-white/5 disabled:opacity-50">Delete Vehicle</button>`;
      actions = v.visibility === 'public'
        ? `<button type="button" data-vehicle-action="return" ${busy ? 'disabled' : ''} class="border border-crimson/50 text-crimson hover:bg-crimson/10 text-xs font-bold px-4 py-2.5 rounded-lg disabled:opacity-50">${busy ? 'Working…' : 'Return to Private'}</button>${deleteBtn}`
        : deleteBtn;
    }

    return `<div class="glass rounded-2xl p-6 [overflow-wrap:anywhere]" data-vehicle-id="${esc(v.id)}" data-approval-state="${esc(ap.state || '')}">
      <div class="flex items-start justify-between gap-4 flex-wrap mb-2">
        <div class="min-w-0 max-w-full">
          <div class="font-display font-bold text-xl">${esc(v.license_plate || 'Plate unknown')}</div>
          <div class="text-xs text-slate-500 mt-1">${esc(v.counted_ride_count)} counted ${v.counted_ride_count === 1 ? 'ride' : 'rides'}</div>
        </div>
        <span class="max-w-full text-xs font-semibold px-2.5 py-1 rounded-full border border-[rgba(212,175,55,0.3)] text-slate-300 uppercase tracking-wider">${esc(view.badge)}</span>
      </div>
      <div class="text-sm font-semibold ${view.cls}">${esc(view.line)}</div>
      ${reasons}
      ${notes}
      ${attached}
      ${provenance}
      ${record}
      ${reviewLine(v)}
      ${dupe}
      <div class="flex items-center gap-2 flex-wrap pt-4 mt-4 border-t border-[rgba(212,175,55,0.1)]">
        ${actions}
        ${v.publicly_eligible && !mode ? `<a href="vehicle/${esc(v.id)}" target="_blank" rel="noopener" class="text-xs text-cyan hover:underline">View public page →</a>` : ''}
      </div>
      ${mode !== 'delete' && v.visibility !== 'public' ? cybercabPanel(v) : ''}
    </div>`;
  }

  function renderVehicles() {
    show('modVehiclesEmpty', vehicles.length === 0);
    $('modVehicleList').innerHTML = vehicles.map(vehicleCard).join('');
  }

  function setVehiclesView(view) {
    show('modVehiclesLoading', view === 'loading');
    show('modVehiclesError', view === 'error');
    if (view !== 'ready') { show('modVehiclesEmpty', false); }
    if (view === 'loading' || view === 'error') $('modVehicleList').innerHTML = '';
  }

  async function loadVehicles() {
    setVehiclesView('loading');
    pendingReview.clear();
    const plate = $('modVehiclePlate').value.trim();
    const params = new URLSearchParams();
    if (plate) params.set('plate', plate); else params.set('scope', $('modVehicleScope').value);
    let resp;
    try {
      resp = await api('/api/moderation/robotaxi-vehicles?' + params.toString());
    } catch (e) {
      setVehiclesView('error');
      return;
    }
    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    if (!resp.ok) { setVehiclesView('error'); return; }
    vehicles = (resp.json && resp.json.vehicles) || [];
    setVehiclesView('ready');
    renderVehicles();
  }

  const replaceVehicle = fresh => { vehicles = vehicles.map(v => (v.id === fresh.id ? fresh : v)); };

  // The one write path: POST .../review, sent the instant the moderator
  // clicks Approve or Return to Private — no confirmation step and no
  // reason field. The server re-checks eligibility atomically, so a stale
  // card can never approve something that no longer qualifies — it gets a
  // 409 with the current facts instead.
  async function submitReview(vehicleId, action) {
    vehicleBusy.add(vehicleId);
    renderVehicles();
    const payload = { action };
    let resp;
    try {
      resp = await api(`/api/moderation/robotaxi-vehicles/${encodeURIComponent(vehicleId)}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    } catch (e) {
      vehicleBusy.delete(vehicleId);
      renderVehicles();
      CCC.toast("Couldn't reach the server. Please try again.", 'error');
      return;
    }
    vehicleBusy.delete(vehicleId);

    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    const json = resp.json || {};
    if (resp.status === 404) {
      pendingReview.delete(vehicleId);
      vehicles = vehicles.filter(v => v.id !== vehicleId);
      renderVehicles();
      CCC.toast('That vehicle no longer exists — removed from the list.', 'info');
      return;
    }
    if (resp.status === 409) {
      // Someone else changed it, or its rides changed. Show the CURRENT facts.
      pendingReview.delete(vehicleId);
      if (json.vehicle) replaceVehicle(json.vehicle);
      renderVehicles();
      if (json.error === 'not_eligible') {
        const why = (json.blocking_reasons || []).map(c => label(REASON_LABELS, c)).join(', ');
        CCC.toast(`Not approved — not eligible${why ? ': ' + why : ''}.`, 'error');
      } else {
        CCC.toast(json.error === 'already_public' ? 'That vehicle is already public.' : 'That vehicle is already private.', 'info');
      }
      return;
    }
    if (!resp.ok || !json.vehicle) {
      renderVehicles();
      CCC.toast("Couldn't record that review. Please try again.", 'error');
      return;
    }
    pendingReview.delete(vehicleId);
    CCC.toast(action === 'approve_cybercab' ? 'Vehicle approved for the public registry.' : 'Vehicle returned to private.', 'success');
    // Visibility just changed, so this vehicle may no longer belong in the
    // currently selected scope (e.g. it must drop off "Public" the moment
    // it's returned to private, not sit there showing stale private info).
    // A plate search isn't scope-filtered at all, so it always stays and
    // just updates in place.
    const searching = !!$('modVehiclePlate').value.trim();
    if (!searching && json.vehicle.visibility !== $('modVehicleScope').value) {
      vehicles = vehicles.filter(v => v.id !== vehicleId);
    } else {
      replaceVehicle(json.vehicle);
    }
    renderVehicles();
  }

  // POST .../vin — saves the VIN a moderator manually read off Robotaxi
  // Tracker. Always a request separate from approval (submitReview,
  // action approve_cybercab): saving a VIN here never changes visibility by
  // itself, matching the server (worker/moderation.js's apiSetRegistryVehicleVin).
  async function submitSetVin(vehicleId, rawVin) {
    const vin = (rawVin || '').trim().toUpperCase();
    if (!vin) { CCC.toast('Enter a VIN first.', 'error'); return; }
    vehicleBusy.add(vehicleId);
    renderVehicles();
    let resp;
    try {
      resp = await api(`/api/moderation/robotaxi-vehicles/${encodeURIComponent(vehicleId)}/vin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin })
      });
    } catch (e) {
      vehicleBusy.delete(vehicleId);
      renderVehicles();
      CCC.toast("Couldn't reach the server. Please try again.", 'error');
      return;
    }
    vehicleBusy.delete(vehicleId);

    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    const json = resp.json || {};
    if (resp.status === 404) {
      vehicles = vehicles.filter(v => v.id !== vehicleId);
      renderVehicles();
      CCC.toast('That vehicle no longer exists — removed from the list.', 'info');
      return;
    }
    if (resp.status === 409) {
      // Someone (possibly this same moderator, twice) already saved a VIN —
      // never silently overwritten. Show the CURRENT vehicle, VIN and all.
      if (json.vehicle) replaceVehicle(json.vehicle);
      renderVehicles();
      CCC.toast('This vehicle already has a VIN on file.', 'info');
      return;
    }
    if (!resp.ok || !json.vehicle) {
      renderVehicles();
      CCC.toast(json.error === 'invalid_vin' ? "That doesn't look like a valid VIN — check it and try again." : "Couldn't save that VIN. Please try again.", 'error');
      return;
    }
    replaceVehicle(json.vehicle);
    renderVehicles();
    CCC.toast('VIN saved.', 'success');
  }

  // DELETE .../:id — removes the registry row AND every ride/receipt logged
  // against it (any rider's), freeing those receipts to be resent — see
  // worker/moderation.js's apiDeleteRegistryVehicle. Always drops the
  // vehicle from the local list on success; it can never belong in any scope.
  async function submitDelete(vehicleId) {
    vehicleBusy.add(vehicleId);
    renderVehicles();
    let resp;
    try {
      resp = await api(`/api/moderation/robotaxi-vehicles/${encodeURIComponent(vehicleId)}`, { method: 'DELETE' });
    } catch (e) {
      vehicleBusy.delete(vehicleId);
      renderVehicles();
      CCC.toast("Couldn't reach the server. Please try again.", 'error');
      return;
    }
    vehicleBusy.delete(vehicleId);
    pendingReview.delete(vehicleId);

    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    if (resp.status === 404) {
      vehicles = vehicles.filter(v => v.id !== vehicleId);
      renderVehicles();
      CCC.toast('That vehicle no longer exists — removed from the list.', 'info');
      return;
    }
    if (!resp.ok) {
      renderVehicles();
      CCC.toast("Couldn't delete that vehicle. Please try again.", 'error');
      return;
    }
    vehicles = vehicles.filter(v => v.id !== vehicleId);
    renderVehicles();
    CCC.toast('Vehicle and its ride history removed — the receipt can be resent.', 'success');
  }

  function setupVehicleActions() {
    $('modVehicleList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-vehicle-action]');
      if (!btn) return;
      const card = btn.closest('[data-vehicle-id]');
      const id = card.dataset.vehicleId;
      const act = btn.dataset.vehicleAction;
      if (act === 'return') { submitReview(id, 'return_private'); }
      else if (act === 'approve-cybercab') { submitReview(id, 'approve_cybercab'); }
      else if (act === 'save-vin') {
        const input = card.querySelector(`[data-vehicle-vin-input="${CSS.escape(id)}"]`);
        submitSetVin(id, input ? input.value : '');
      }
      else if (act === 'ask-delete') { pendingReview.set(id, 'delete'); renderVehicles(); }
      else if (act === 'cancel-review') { pendingReview.delete(id); renderVehicles(); }
      else if (act === 'confirm-delete') { submitDelete(id); }
    });
    $('modVehicleSearch').addEventListener('submit', e => { e.preventDefault(); loadVehicles(); });
    $('modVehicleScope').addEventListener('change', () => { $('modVehiclePlate').value = ''; loadVehicles(); });
    $('modVehiclesRetry').addEventListener('click', () => loadVehicles());
  }

  function init() {
    if (!sessionId) { setView('signedOut'); return; }
    setupActions();
    setupVehicleActions();
    $('modRetry').addEventListener('click', () => loadQueue(true));
    $('modRefresh').addEventListener('click', () => loadQueue(false));
    loadQueue(true);
  }

  init();
})();
