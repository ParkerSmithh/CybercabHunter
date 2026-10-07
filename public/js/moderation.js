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

  // Approve / Add to registry / Reject (with its inline reason box) — the
  // same controls on a vehicle sighting card and on a compact image card.
  function actionsHtml(s) {
    const rejecting = pendingReject.has(s.submission_id);
    const isBusy = busy.has(s.submission_id);
    // Only a sighting with a plate and no registry vehicle yet can become one.
    const canPromote = !!s.license_plate && !s.robotaxi_vehicle_id;
    return `<div class="flex items-center gap-2 flex-wrap pt-3 border-t border-[rgba(212,175,55,0.1)]">
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
          ${canPromote ? `<button type="button" data-action="promote" ${isBusy ? 'disabled' : ''} title="Creates a private registry vehicle from this sighting and approves the sighting. No ride is created." class="text-xs font-bold px-4 py-2.5 rounded-lg border border-cyan/50 text-cyan hover:bg-cyan/10 disabled:opacity-50">Add to registry</button>` : ''}
          <button type="button" data-action="ask-reject" ${isBusy ? 'disabled' : ''} class="text-xs font-bold px-4 py-2.5 rounded-lg border border-crimson/50 text-crimson hover:bg-crimson/10 disabled:opacity-50">Reject</button>
        `}
      </div>`;
  }

  function sightingCard(s) {
    const details = [];
    if (s.model) details.push(`Model: ${esc(s.model)}`);
    if (s.color) details.push(`Color: ${esc(s.color)}`);
    if (s.approx_location) details.push(`Near: ${esc(s.approx_location)}`);
    const vehicleLine = s.robotaxi_vehicle_id
      ? `<a href="vehicle/${esc(s.robotaxi_vehicle_id)}" class="text-cyan hover:underline" target="_blank" rel="noopener">Linked to an existing registry vehicle →</a>`
      : '<span class="text-slate-500">No matching vehicle in the registry. Plate is unrecognized</span>';

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
      ${actionsHtml(s)}
    </div>`;
  }

  // A photo sighting in the Images grid: a small thumbnail (tap it to open
  // the full photo) with the key facts and the same actions. The photo is
  // loaded with the moderator's session by loadPhotos() below (an <img>
  // can't send the Authorization header).
  function imageCard(s) {
    const facts = [s.service_area || 'Area unknown', fmtDateTime(s.observed_at)];
    return `<div class="glass rounded-xl p-3 flex flex-col gap-2 [overflow-wrap:anywhere]" data-submission-id="${esc(s.submission_id)}">
      <div class="mod-photo relative rounded-lg overflow-hidden">
        <a data-sighting-photo-link target="_blank" rel="noopener" title="Open the full photo" class="block aspect-[4/3] bg-black/30">
          <img data-sighting-photo="${esc(s.submission_id)}" alt="Submitted sighting photo" class="hidden w-full h-full object-cover">
        </a>
        <div class="mod-photo-shade absolute inset-0 bg-black/55"></div>
        <button type="button" data-action="delete-photo" ${busy.has(s.submission_id) ? 'disabled' : ''} aria-label="Delete this photo" class="mod-photo-delete whitespace-nowrap absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-4 py-2 rounded-lg text-sm font-bold bg-crimson text-paper shadow-lg hover:brightness-110 disabled:opacity-50">Delete</button>
      </div>
      <div class="font-display font-bold text-sm leading-tight">${esc(s.license_plate || 'Plate not given')}</div>
      <div class="text-xs text-slate-500 leading-snug">${facts.map(esc).join(' · ')}</div>
      ${s.approx_location ? `<div class="text-xs text-slate-400 leading-snug">Near: ${esc(s.approx_location)}</div>` : ''}
      ${cameraLine(s)}
      ${s.notes ? `<div class="text-xs text-slate-300 bg-white/5 rounded-md px-2 py-1.5 leading-snug">${esc(s.notes)}</div>` : ''}
      <div class="mt-auto [&>div]:pt-2 [&>div]:gap-1.5">${actionsHtml(s)}</div>
    </div>`;
  }

  // The traffic camera a photo came from (approving it puts it on the Zones map).
  function cameraLine(s) {
    return s.camera_name ? `<div class="text-xs text-gold leading-snug">Traffic camera: ${esc(s.camera_name)}</div>` : '';
  }

  // ---------- Recently approved images: on the Zones map, or "Add to map" ----------
  let approved = [];
  const mapBusy = new Set();   // submission_ids with an Add to map request in flight

  function approvedCard(a) {
    const facts = [a.service_area || 'Area unknown', fmtDateTime(a.observed_at)];
    // "On the Zones map ✓" only while the map actually shows it: the public
    // feed keeps a capture for 24 hours (visible_on_map; 2026-10-06).
    const status = a.on_map && a.visible_on_map !== false
      ? '<div class="text-xs font-semibold text-gold" data-on-map>On the Zones map ✓</div>'
      : a.on_map
      ? '<div class="text-xs text-slate-400 leading-snug" data-off-map>Off the Zones map: the map shows the last 24 hours</div>'
      : `<button type="button" data-approved-action="add-to-map" ${mapBusy.has(a.submission_id) ? 'disabled' : ''} class="self-start text-xs font-bold px-3 py-2 rounded-lg border border-[rgba(212,175,55,0.45)] text-gold hover:bg-[rgba(212,175,55,0.08)] disabled:opacity-50">${mapBusy.has(a.submission_id) ? 'Adding…' : 'Add to map'}</button>`;
    return `<div class="glass rounded-xl p-3 flex flex-col gap-2 [overflow-wrap:anywhere]" data-approved-id="${esc(a.submission_id)}">
      <div class="mod-photo relative rounded-lg overflow-hidden">
        <a data-sighting-photo-link target="_blank" rel="noopener" title="Open the full photo" class="block aspect-[4/3] bg-black/30">
          <img data-sighting-photo="${esc(a.submission_id)}" alt="Approved sighting photo" class="hidden w-full h-full object-cover">
        </a>
        <div class="mod-photo-shade absolute inset-0 bg-black/55"></div>
        <button type="button" data-approved-action="delete-photo" ${busy.has(a.submission_id) ? 'disabled' : ''} aria-label="Delete this approved photo" class="mod-photo-delete whitespace-nowrap absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-4 py-2 rounded-lg text-sm font-bold bg-crimson text-paper shadow-lg hover:brightness-110 disabled:opacity-50">Delete</button>
      </div>
      <div class="font-display font-bold text-sm leading-tight">${esc(a.license_plate || 'Plate not given')}</div>
      <div class="text-xs text-slate-500 leading-snug">${facts.map(esc).join(' · ')}</div>
      ${cameraLine(a)}
      <div class="mt-auto pt-2 border-t border-[rgba(212,175,55,0.1)] flex">${status}</div>
    </div>`;
  }

  function renderApproved() {
    $('modApprovedList').innerHTML = approved.map(approvedCard).join('');
    show('modApproved', approved.length > 0);
    loadPhotos();
  }

  async function loadApproved() {
    let resp;
    try { resp = await api('/api/moderation/approved-photo-sightings'); } catch (e) { return; }
    if (!resp.ok) return;   // the review queue above still works without this list
    approved = (resp.json && resp.json.sightings) || [];
    renderApproved();
  }

  // The camera list for the Add to map dialog (the same file the Submit form uses).
  let camerasLoaded = null;
  function loadCameras() {
    if (!camerasLoaded) {
      camerasLoaded = fetch('data/traffic-cameras.json').then(r => (r.ok ? r.json() : [])).then(cameras => {
        const select = $('modMapCamera');
        (Array.isArray(cameras) ? cameras : []).slice().sort((a, b) => a.name.localeCompare(b.name) || a.camera_id.localeCompare(b.camera_id, undefined, { numeric: true })).forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.camera_id;
          opt.textContent = `${c.name} (#${c.camera_id})`;
          select.appendChild(opt);
        });
      }).catch(() => { camerasLoaded = null; });
    }
    return camerasLoaded;
  }

  let mapTarget = null;   // the approved sighting the dialog is for
  async function openMapDialog(submissionId) {
    const a = approved.find(x => x.submission_id === submissionId);
    if (!a) return;
    mapTarget = submissionId;
    await loadCameras();
    $('modMapCamera').value = a.camera_id || '';
    const dialog = $('modMapDialog');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeMapDialog() {
    const dialog = $('modMapDialog');
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    mapTarget = null;
  }

  async function addToMap(submissionId, cameraId) {
    mapBusy.add(submissionId);
    renderApproved();
    let resp;
    try {
      resp = await api(`/api/moderation/vehicle-sightings/${encodeURIComponent(submissionId)}/map`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera_id: cameraId })
      });
    } catch (e) { resp = null; }
    mapBusy.delete(submissionId);
    if (resp && resp.status === 401) { setView('signedOut'); return; }
    if (resp && resp.status === 403) { setView('forbidden'); return; }
    if (resp && resp.ok) {
      const visible = !(resp.json && resp.json.visible_on_map === false);
      approved = approved.map(a => (a.submission_id === submissionId ? { ...a, on_map: true, visible_on_map: visible } : a));
      renderApproved();
      if (!visible) CCC.toast("Recorded, but this capture is over 24 hours old, so it won't show on the Zones map.", 'info');
      else CCC.toast(resp.json && resp.json.already_on_map ? 'Already on the Zones map.' : 'Added to the Zones map ✓', 'success');
      loadApproved();   // picks up the recorded camera name
      return;
    }
    renderApproved();
    const error = resp && resp.json && resp.json.error;
    CCC.toast(error === 'photo_missing' || error === 'not_found' ? "This photo is no longer stored, so it can't go on the map." : "Couldn't add it to the map. Please try again.", 'error');
  }

  function renderQueue() {
    const images = queue.filter(s => s.evidence_ref);
    const vehicles = queue.filter(s => !s.evidence_ref);
    $('modList').innerHTML = vehicles.map(sightingCard).join('');
    $('modImageList').innerHTML = images.map(imageCard).join('');
    show('modListEmpty', vehicles.length === 0);
    show('modImagesEmpty', images.length === 0);
    $('modCountVehicles').textContent = vehicles.length ? String(vehicles.length) : '';
    $('modCountImages').textContent = images.length ? String(images.length) : '';
    loadPhotos();
  }

  // Vehicles | Images section buttons. The choice is remembered per browser.
  let activeTab = 'vehicles';
  try { if (localStorage.getItem('moderationTab') === 'images') activeTab = 'images'; } catch (e) { /* default */ }
  function setTab(tab) {
    activeTab = tab === 'images' ? 'images' : 'vehicles';
    $('modTabVehicles').setAttribute('aria-selected', String(activeTab === 'vehicles'));
    $('modTabImages').setAttribute('aria-selected', String(activeTab === 'images'));
    show('modPanelVehicles', activeTab === 'vehicles');
    show('modPanelImages', activeTab === 'images');
    try { localStorage.setItem('moderationTab', activeTab); } catch (e) { /* not essential */ }
  }

  // Photo blobs are fetched once per sighting and reused across re-renders.
  const photoUrls = new Map();
  function loadPhotos() {
    document.querySelectorAll('img[data-sighting-photo]').forEach(async img => {
      const id = img.dataset.sightingPhoto;
      try {
        if (!photoUrls.has(id)) {
          photoUrls.set(id, (async () => {
            const resp = await fetch(`${WORKER}/api/moderation/vehicle-sightings/${encodeURIComponent(id)}/photo`, { headers: { Authorization: 'Bearer ' + sessionId } });
            return resp.ok ? URL.createObjectURL(await resp.blob()) : null;
          })());
        }
        const url = await photoUrls.get(id);
        if (url) {
          img.src = url;
          img.classList.remove('hidden');
          const link = img.closest('a[data-sighting-photo-link]');
          if (link) link.href = url;
        }
      } catch (e) { /* the card still works without its photo */ }
    });
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
    loadApproved();
  }

  // Permanently deletes a sighting's photo (a pending one is also closed as
  // rejected — nothing is left to review). See worker/sightings-public.js.
  // Works the same from the review queue and the Approved Images list: an
  // approved photo is removed from the public Sightings gallery and the Zones
  // map (the sighting itself stays approved).
  async function deletePhoto(submissionId) {
    if (!window.confirm('Delete this photo? It is removed permanently and can’t be undone.')) return;
    busy.add(submissionId);
    renderQueue();
    renderApproved();
    let resp;
    try {
      resp = await api(`/api/moderation/vehicle-sightings/${encodeURIComponent(submissionId)}/photo`, { method: 'DELETE' });
    } catch (e) {
      resp = null;
    }
    busy.delete(submissionId);
    if (resp && resp.ok) {
      queue = queue.filter(s => s.submission_id !== submissionId);
      approved = approved.filter(a => a.submission_id !== submissionId);
      CCC.toast('Photo deleted.', 'success');
    } else {
      CCC.toast("Couldn't delete the photo. Please try again.", 'error');
    }
    renderQueue();
    renderApproved();
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
      CCC.toast('That sighting was already reviewed. Removed from the queue.', 'info');
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
    CCC.toast(action === 'approve' ? approvedMessage(resp.json, 'Sighting approved') : 'Sighting rejected.', 'success');
    if (action === 'approve') loadApproved();
  }

  // Approving a traffic-camera photo also puts it on the Zones map (server-side).
  function approvedMessage(json, base) {
    const map = json && json.map;
    if (!map) return base + '.';
    if (!map.on_map) return `${base}. It couldn't be placed on the Zones map. Use Add to map below.`;
    return map.visible_on_map === false
      ? `${base}. Recorded for the map, but it's over 24 hours old, so it won't show on the Zones map.`
      : `${base}. On the Zones map ✓`;
  }

  async function promote(submissionId) {
    busy.add(submissionId);
    renderQueue();
    let resp;
    try {
      resp = await api(`/api/moderation/vehicle-sightings/${encodeURIComponent(submissionId)}/promote`, { method: 'POST' });
    } catch (e) {
      busy.delete(submissionId);
      renderQueue();
      CCC.toast("Couldn't reach the server. Please try again.", 'error');
      return;
    }
    busy.delete(submissionId);

    if (resp.status === 401) { setView('signedOut'); return; }
    if (resp.status === 403) { setView('forbidden'); return; }
    const error = resp.json && resp.json.error;
    if (resp.status === 409 && error === 'already_reviewed') {
      queue = queue.filter(s => s.submission_id !== submissionId);
      renderQueue();
      CCC.toast('That sighting was already reviewed. Removed from the queue.', 'info');
      return;
    }
    if (resp.status === 409 && error === 'vehicle_exists') {
      renderQueue();
      CCC.toast('A registry vehicle with that plate already exists. Approve the sighting instead.', 'error');
      loadQueue(false);
      return;
    }
    if (resp.status === 400 && error === 'plate_required') {
      renderQueue();
      CCC.toast('This sighting has no usable plate, so it cannot become a vehicle.', 'error');
      return;
    }
    if (!resp.ok) {
      renderQueue();
      CCC.toast("Couldn't add it to the registry. Please try again.", 'error');
      return;
    }

    queue = queue.filter(s => s.submission_id !== submissionId);
    renderQueue();
    CCC.toast(approvedMessage(resp.json, 'Added to the registry as a private vehicle. Find it under Registry Vehicles'), 'success');
    loadVehicles();
    loadApproved();
  }

  function setupActions() {
    ['modTabVehicles', 'modTabImages'].forEach(id => $(id).addEventListener('click', () => setTab($(id).dataset.tab)));
    setTab(activeTab);
    const onQueueClick = e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const card = btn.closest('[data-submission-id]');
      const submissionId = card.dataset.submissionId;
      const action = btn.dataset.action;

      if (action === 'approve') {
        review(submissionId, 'approve');
      } else if (action === 'promote') {
        promote(submissionId);
      } else if (action === 'ask-reject') {
        pendingReject.add(submissionId);
        renderQueue();
      } else if (action === 'cancel-reject') {
        pendingReject.delete(submissionId);
        renderQueue();
      } else if (action === 'delete-photo') {
        deletePhoto(submissionId);
      } else if (action === 'confirm-reject') {
        const textarea = card.querySelector('[data-reject-reason]');
        const reason = textarea.value.trim();
        if (!reason) { CCC.toast('A rejection reason is required.', 'error'); return; }
        review(submissionId, 'reject', reason);
      }
    };
    $('modList').addEventListener('click', onQueueClick);
    $('modImageList').addEventListener('click', onQueueClick);
    $('modApprovedList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-approved-action]');
      if (!btn) return;
      const id = btn.closest('[data-approved-id]').dataset.approvedId;
      if (btn.dataset.approvedAction === 'add-to-map') openMapDialog(id);
      else if (btn.dataset.approvedAction === 'delete-photo') deletePhoto(id);
    });
    $('modMapCancel').addEventListener('click', closeMapDialog);
    $('modMapForm').addEventListener('submit', e => {
      e.preventDefault();
      const cameraId = $('modMapCamera').value;
      if (!cameraId) { CCC.toast('Choose the traffic camera first.', 'error'); return; }
      const target = mapTarget;
      closeMapDialog();
      if (target) addToMap(target, cameraId);
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
    no_rides_on_record: 'No rides on record (orphaned)',
    added_from_sighting: 'Added from a community sighting'
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
      return { badge: 'Approved: Not Visible', line: 'Not Eligible: approved, but hidden from the public while the reasons below apply.', cls: 'text-amber-400' };
    }
    if (state === 'eligible_for_approval') {
      return { badge: 'Private: Needs Review', line: 'Eligible for Approval', cls: 'text-cyan' };
    }
    return { badge: 'Private: Needs Review', line: 'Not Eligible', cls: 'text-amber-400' };
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

  // The VIN / approval panel of the moderator card (shown for private AND
  // public vehicles, never mid delete-confirmation — see vehicleCard).
  //  - The VIN is optional and editable any time: Save VIN records, edits or
  //    (with an empty box / Clear VIN) clears it. Saving a VIN never approves
  //    or upgrades anything by itself.
  //  - Private: one Approve button, enabled whenever the server says the
  //    vehicle can be approved (v.approval.can_approve — never VIN-based).
  //    With a VIN on file it sends approve_cybercab (approved as VIN
  //    verified); without one, approve_manual (approved as Manual).
  //  - Public: shows the approval basis. On a Manual vehicle, Save VIN also
  //    marks it VIN verified in the same click (see submitSetVin); there is
  //    no separate Mark VIN Verified button.
  const BASIS_LABELS = { 'vin-verified': 'VIN verified', manual: 'Manual (approved without a verified VIN)' };
  function cybercabPanel(v) {
    const busy = vehicleBusy.has(v.id);
    const isPublic = v.visibility === 'public';
    const vinRow = `<div class="text-xs text-slate-300 mt-2">${v.vin ? `VIN on file: <span class="font-mono">${esc(v.vin)}</span>` : 'No VIN on file (optional).'}</div>
         <div class="flex items-center gap-2 mt-1 flex-wrap">
           <input type="text" data-vehicle-vin-input="${esc(v.id)}" value="${esc(v.vin || '')}" placeholder="17-character VIN" maxlength="17" autocomplete="off"
             class="bg-black/30 border border-[rgba(212,175,55,0.25)] rounded-lg px-3 py-2 text-xs font-mono uppercase w-48 disabled:opacity-50" ${busy ? 'disabled' : ''}>
           <button type="button" data-vehicle-action="save-vin" ${busy ? 'disabled' : ''} class="text-xs font-bold px-3 py-2 rounded-lg border border-[rgba(212,175,55,0.3)] text-slate-200 hover:bg-white/5 disabled:opacity-50">${busy ? 'Working…' : 'Save VIN'}</button>
           ${v.vin ? `<button type="button" data-vehicle-action="clear-vin" ${busy ? 'disabled' : ''} class="text-xs px-3 py-2 rounded-lg border border-slate-500/40 text-slate-400 hover:bg-white/5 disabled:opacity-50">Clear VIN</button>` : ''}
         </div>`;
    let decision;
    if (isPublic) {
      const basis = v.approval_basis ? label(BASIS_LABELS, v.approval_basis) : 'Not recorded';
      decision = `<div class="text-xs text-slate-300 mt-3">Approval basis: <span class="font-semibold">${esc(basis)}</span></div>
        ${v.approval_basis !== 'vin-verified' ? `<div class="text-xs text-slate-500 mt-1">Save VIN marks it VIN verified (public badge). Only save a VIN Robotaxi Tracker shows for this Cybercab.</div>` : ''}`;
    } else {
      const canApprove = !!(v.approval && v.approval.can_approve);
      decision = `<button type="button" data-vehicle-action="approve-cybercab" ${busy || !canApprove ? 'disabled' : ''} class="mt-2 btn-magnetic bg-gradient-to-r from-goldsoft to-gold text-[#1a1204] text-xs font-bold px-4 py-2.5 rounded-lg disabled:opacity-50">${busy ? 'Working…' : 'Approve Cybercab'}</button>
        <div class="text-xs text-slate-500 mt-1">${v.vin
          ? 'Approves it as VIN verified (public VIN verified badge).'
          : 'No VIN: approves it as Manual, with no VIN verified badge. You can add a VIN and verify it later.'}</div>`;
    }
    return `<div class="mt-3 pt-3 border-t border-[rgba(212,175,55,0.1)]">
      <div class="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Cybercab verification</div>
      <a href="${esc(ROBOTAXI_TRACKER_URL)}" target="_blank" rel="noopener" class="text-xs text-cyan hover:underline">Check Robotaxi Tracker →</a>
      <div class="text-xs text-slate-500 mt-1">Look up ${esc(v.license_plate || 'this plate')} there. If it's shown as a Cybercab, copy its VIN and enter it below. The VIN is optional: you can approve without one and add it later. If it's shown as a Model Y (or anything else), use Delete Vehicle instead. There is no separate rejection step.</div>
      ${vinRow}
      ${decision}
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
      ? `<div class="flex flex-wrap gap-1.5 mt-2">${ap.notes.map(c => `<span class="text-xs px-2 py-0.5 rounded-full bg-white/5 text-slate-300">${esc(label(NOTE_LABELS, c))}</span>`).join('')}</div>` : '';
    const dupe = v.plate_vehicle_count > 1
      ? `<div class="text-xs text-amber-400 mt-2">Duplicate plate: ${esc(v.plate_vehicle_count)} registry vehicles share this plate, so it cannot be approved and its sightings are not matched publicly.</div>` : '';
    // Provenance: how the counted rides ENTERED the system. Descriptive only.
    const fromSighting = v.origin === 'sighting';
    const rideProvenance = v.counted_ride_count > 0
      ? `<div class="text-xs text-slate-400 mt-3">
           <div class="font-semibold text-slate-300 mb-0.5">How the counted rides entered</div>
           <div>Forwarded email: ${esc(src.receipt_email || 0)} · Import (pasted text or .eml file): ${esc(src.receipt_import || 0)} · Other: ${esc(src.other || 0)}</div>
           <div class="mt-1">First counted ride: ${esc(fmtDay(v.first_counted_ride_date))} · Latest counted ride: ${esc(fmtDay(v.last_counted_ride_date))}</div>
         </div>`
      : '';
    // A vehicle added from a sighting says so, even after a real receipt later
    // attaches rides to it — the ride provenance above is then shown as well.
    const sightingProvenance = fromSighting
      ? `<div class="text-xs text-slate-400 mt-3">
           <div class="font-semibold text-slate-300 mb-0.5">How this vehicle was added</div>
           <div>From a community sighting, added to the registry without a receipt.${v.counted_ride_count > 0 ? '' : ' It has no receipt and no rides; your approval stands in for a counted ride (a VIN is optional).'}</div>
         </div>`
      : '';
    const provenance = (rideProvenance || sightingProvenance)
      ? rideProvenance + sightingProvenance
      : '<div class="text-xs text-slate-500 mt-3">No counted rides yet, so there is no ride provenance to show.</div>';
    const attached = `<div class="text-xs text-slate-400 mt-2">Rides attached: ${esc(v.counted_ride_count)} counted · ${esc(v.needs_review_ride_count || 0)} needs review · ${esc(v.rejected_ride_count || 0)} rejected · ${esc(v.total_trip_count || 0)} total trips on record</div>`;
    const record = `<div class="text-xs text-slate-500 mt-2">Vehicle record created ${esc(fmtDateTime(v.created_at))} · First seen ${esc(fmtDateTime(v.first_seen_at))} · Last ${fromSighting ? 'sighting' : 'receipt'} activity ${esc(fmtDateTime(v.last_seen_at))}</div>
      <div class="text-xs text-slate-500 mt-1" title="An existing field on the vehicle record. Moderation does not change it.">Record field verification_status: ${esc(v.verification_status || '—')}</div>`;

    // A private vehicle's path to public visibility is the Approve button in
    // the Cybercab verification panel below (cybercabPanel) — a VIN is
    // optional there.
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
      ${mode !== 'delete' ? cybercabPanel(v) : ''}
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
    // Arriving via a #modVehicles link: the section was hidden while the page
    // loaded, so the browser couldn't scroll to it. Do it once, now.
    if (!scrolledToVehicles && location.hash === '#modVehicles') {
      scrolledToVehicles = true;
      const section = $('modVehicles');
      if (section && section.scrollIntoView) section.scrollIntoView();
    }
  }
  let scrolledToVehicles = false;

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
      CCC.toast('That vehicle no longer exists. Removed from the list.', 'info');
      return;
    }
    if (resp.status === 409) {
      // Someone else changed it, or its rides changed. Show the CURRENT facts.
      pendingReview.delete(vehicleId);
      if (json.vehicle) replaceVehicle(json.vehicle);
      renderVehicles();
      if (json.error === 'not_eligible') {
        const why = (json.blocking_reasons || []).map(c => label(REASON_LABELS, c)).join(', ');
        CCC.toast(`Not approved. Not eligible${why ? ': ' + why : ''}.`, 'error');
      } else if (action === 'verify_vin') {
        CCC.toast(json.error === 'already_vin_verified' ? 'That vehicle is already VIN verified.'
          : json.error === 'no_vin' ? 'Save a VIN first.' : 'Only a public vehicle can be marked VIN verified.', 'info');
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
    CCC.toast(action === 'verify_vin' ? 'VIN saved. Vehicle is now VIN verified.'
      : action === 'return_private' ? 'Vehicle returned to private.'
      : json.vehicle.approval_basis === 'vin-verified' ? 'Vehicle approved for the public registry (VIN verified).'
      : 'Vehicle approved for the public registry (manual, no VIN).', 'success');
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

  // POST .../vin — saves, edits or clears the VIN a moderator manually read
  // off Robotaxi Tracker. Always a request separate from approval
  // (submitReview): saving a VIN here never changes visibility or upgrades
  // anything by itself, matching the server (worker/moderation.js's
  // apiSetRegistryVehicleVin). An empty VIN clears it (unknown is valid).
  async function submitSetVin(vehicleId, rawVin) {
    const vin = (rawVin || '').trim().toUpperCase();
    const current = vehicles.find(v => v.id === vehicleId);
    if (!vin && !(current && current.vin)) { CCC.toast('Enter a VIN first.', 'error'); return; }
    vehicleBusy.add(vehicleId);
    renderVehicles();
    let resp;
    try {
      resp = await api(`/api/moderation/robotaxi-vehicles/${encodeURIComponent(vehicleId)}/vin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vin: vin || null })
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
      CCC.toast('That vehicle no longer exists. Removed from the list.', 'info');
      return;
    }
    if (!resp.ok || !json.vehicle) {
      renderVehicles();
      CCC.toast(json.error === 'invalid_vin' ? "That doesn't look like a valid VIN. Check it and try again." : "Couldn't save that VIN. Please try again.", 'error');
      return;
    }
    replaceVehicle(json.vehicle);
    // A public Manual vehicle: saving its VIN is the moderator's confirmation,
    // so it is marked VIN verified in the same click (owner request
    // 2026-10-05). The server still checks it (public, VIN on file, not
    // already verified) and the separate verify_vin action stays the record.
    if (json.vehicle.vin && json.vehicle.can_verify_vin) { await submitReview(vehicleId, 'verify_vin'); return; }
    renderVehicles();
    CCC.toast(json.vehicle.vin ? 'VIN saved.' : 'VIN cleared.', 'success');
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
      CCC.toast('That vehicle no longer exists. Removed from the list.', 'info');
      return;
    }
    if (!resp.ok) {
      renderVehicles();
      CCC.toast("Couldn't delete that vehicle. Please try again.", 'error');
      return;
    }
    vehicles = vehicles.filter(v => v.id !== vehicleId);
    renderVehicles();
    CCC.toast('Vehicle and its ride history removed. The receipt can be resent.', 'success');
  }

  function setupVehicleActions() {
    $('modVehicleList').addEventListener('click', e => {
      const btn = e.target.closest('button[data-vehicle-action]');
      if (!btn) return;
      const card = btn.closest('[data-vehicle-id]');
      const id = card.dataset.vehicleId;
      const act = btn.dataset.vehicleAction;
      if (act === 'return') { submitReview(id, 'return_private'); }
      else if (act === 'approve-cybercab') {
        // With a VIN on file: the VIN-gated approve_cybercab (VIN verified).
        // Without one: approve_manual (approved as Manual).
        const v = vehicles.find(x => x.id === id);
        submitReview(id, v && v.vin ? 'approve_cybercab' : 'approve_manual');
      }
      else if (act === 'verify-vin') { submitReview(id, 'verify_vin'); }
      else if (act === 'clear-vin') { submitSetVin(id, ''); }
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
    // ?plate=XYZ (the receipt-import page's "Open in Registry Vehicles" link)
    // pre-fills the registry plate search, so that vehicle is listed first.
    const plate = new URLSearchParams(location.search).get('plate');
    if (plate) $('modVehiclePlate').value = plate.slice(0, 40);
    loadQueue(true);
  }

  init();
})();
