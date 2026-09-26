/* Moderator receipt import (moderation/import-receipt.html). Sends receipt
   files / pasted text to POST /api/moderation/receipt-import, which runs them
   through the SAME pipeline as every other receipt (worker/receipt-import.js)
   as the signed-in moderator. The server decides authorization on every
   request (requireModerator); GET /api/moderation/access here only picks
   which state to show. Every server value is rendered with .textContent. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const SESSION_KEY = 'teslaSessionId';
  const MAX_FILES = 25;
  const MAX_ITEM_CHARS = 2000000;   // mirrors worker/receipt-import.js

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  let sessionId = null;
  try { sessionId = localStorage.getItem(SESSION_KEY); } catch (e) { /* storage blocked */ }

  function setView(view) {
    show('impLoading', view === 'loading');
    show('impSignedOut', view === 'signedOut');
    show('impForbidden', view === 'forbidden');
    show('impError', view === 'error');
    show('impReady', view === 'ready');
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  async function checkAccess() {
    if (!sessionId) { setView('signedOut'); return; }
    setView('loading');
    let resp;
    try {
      resp = await fetch(WORKER + '/api/moderation/access', { headers: { Authorization: 'Bearer ' + sessionId } });
    } catch (e) { setView('error'); return; }
    if (resp.status === 401) { setView('signedOut'); return; }
    if (!resp.ok) { setView('error'); return; }
    let body = null;
    try { body = await resp.json(); } catch (e) { /* treated as an error below */ }
    if (!body) { setView('error'); return; }
    setView(body.moderator ? 'ready' : 'forbidden');
  }

  // ---- formatting ----
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    if (!m) return '—';
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    if (!m) return '—';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const fmtDistance = (d, unit) => (d == null ? '—' : `${Number(d).toFixed(1)} ${unit || 'mi'}`);
  function fmtFare(cents, currency) {
    if (cents == null) return '—';
    try { return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: currency || 'USD' }); }
    catch (e) { return (cents / 100).toFixed(2) + (currency ? ' ' + currency : ''); }
  }

  const OUTCOMES = {
    created: ['Imported', 'text-emerald-300 border-emerald-400/40'],
    updated: ['Updated an existing ride', 'text-cyan border-cyan/40'],
    duplicate: ['Already imported', 'text-slate-300 border-slate-500/40'],
    unidentified: ['Needs review — no ride created', 'text-amber-300 border-amber-400/40'],
    rejected: ['Not recognized as a Tesla receipt', 'text-crimson border-crimson/50'],
    error: ['Import failed', 'text-crimson border-crimson/50']
  };
  const REASONS = {
    missing_ride_identity: 'The receipt\'s ride date or pickup time couldn\'t be read, so it can\'t be matched to a ride.',
    not_recognized_as_tesla_receipt: 'This doesn\'t look like a Tesla Robotaxi receipt.',
    kept_existing_values: 'This copy disagreed with values already stored and couldn\'t be shown to be newer, so they were kept.',
    fare_mismatch: 'The fare lines on the receipt disagree, so the ride is held for review.',
    partial_match: 'Only part of the receipt could be read, so the ride is held for review.',
    import_failed: 'The server couldn\'t process this receipt.',
    extraction_failed: 'The server couldn\'t read this receipt.'
  };

  function row(label, value) {
    const d = el('div', 'min-w-0');
    d.appendChild(el('div', 'text-[11px] text-slate-500 uppercase tracking-wider mb-0.5', label));
    d.appendChild(el('div', 'text-sm font-semibold [overflow-wrap:anywhere]', value));
    return d;
  }

  function resultCard(r, label) {
    const li = el('li', 'glass rounded-2xl p-6 [overflow-wrap:anywhere]');
    li.dataset.outcome = r.outcome;
    const [outcomeText, outcomeClass] = OUTCOMES[r.outcome] || OUTCOMES.error;
    const head = el('div', 'flex items-start justify-between gap-3 flex-wrap mb-4');
    const title = el('div', 'min-w-0');
    title.appendChild(el('div', 'font-display font-bold text-xl', (r.vehicle && r.vehicle.license_plate) || 'No plate'));
    title.appendChild(el('div', 'text-xs text-slate-500 mt-1', label));
    head.appendChild(title);
    head.appendChild(el('span', `text-xs font-semibold px-2.5 py-1 rounded-full border uppercase tracking-wider ${outcomeClass}`, outcomeText));
    li.appendChild(head);

    if (r.reason && REASONS[r.reason]) li.appendChild(el('p', 'text-sm text-slate-400 mb-4', REASONS[r.reason]));

    const ride = r.ride;
    if (ride) {
      const grid = el('div', 'grid grid-cols-2 sm:grid-cols-4 gap-4');
      grid.appendChild(row('Ride date', fmtDate(ride.ride_date)));
      grid.appendChild(row('Pickup', fmtTime(ride.pickup_time)));
      grid.appendChild(row('Distance', fmtDistance(ride.distance, ride.distance_unit)));
      grid.appendChild(row('Fare', fmtFare(ride.fare_amount_cents, ride.currency)));
      li.appendChild(grid);
      if (ride.review_state === 'under_review') {
        li.appendChild(el('p', 'text-xs text-amber-300 mt-3', 'This ride is held for review, so it won\'t count toward public totals yet.'));
      }
    } else if (r.ride_date) {
      li.appendChild(row('Ride date', fmtDate(r.ride_date)));
    }

    const v = r.vehicle;
    if (v) {
      const box = el('div', 'mt-5 pt-4 border-t border-[rgba(212,175,55,0.12)] text-sm space-y-1');
      box.appendChild(el('p', 'text-slate-300', v.created ? 'New registry vehicle created.' : 'Matched an existing registry vehicle.'));
      if (v.publicly_eligible) {
        box.appendChild(el('p', 'text-emerald-300', 'This vehicle is public — the ride counts toward public totals.'));
      } else if (v.visibility === 'public') {
        box.appendChild(el('p', 'text-slate-400', 'This vehicle is public but has no counted ride yet, so it isn\'t shown publicly.'));
      } else {
        box.appendChild(el('p', 'text-slate-400', v.has_vin
          ? 'Private. A VIN is on file — review it and use Approve Cybercab to publish.'
          : 'Private. To publish it: verify it\'s a Cybercab, enter its VIN, then Approve Cybercab.'));
      }
      const link = el('a', 'inline-block mt-2 text-cyan hover:underline', 'Open in Registry Vehicles →');
      link.href = 'moderation?plate=' + encodeURIComponent(v.license_plate || '') + '#modVehicles';
      box.appendChild(link);
      li.appendChild(box);
    }
    return li;
  }

  // ---- import ----
  function formError(msg) {
    $('impFormError').textContent = msg || '';
    show('impFormError', !!msg);
  }

  const isEml = f => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';

  async function collectItems() {
    const files = [...($('impFiles').files || [])];
    const pasted = $('impText').value;
    const items = [], labels = [];
    if (files.length + (pasted.trim() ? 1 : 0) > MAX_FILES) throw new Error(`Import at most ${MAX_FILES} receipts at a time.`);
    for (const f of files) {
      const content = await f.text();
      if (!content.trim()) throw new Error(`${f.name} is empty.`);
      if (content.length > MAX_ITEM_CHARS) throw new Error(`${f.name} is too large.`);
      items.push({ kind: isEml(f) ? 'eml' : 'text', content });
      labels.push(f.name);
    }
    if (pasted.trim()) {
      if (pasted.length > MAX_ITEM_CHARS) throw new Error('The pasted text is too large.');
      items.push({ kind: 'text', content: pasted });
      labels.push('Pasted text');
    }
    return { items, labels };
  }

  async function onSubmit(e) {
    e.preventDefault();
    formError('');
    let collected;
    try { collected = await collectItems(); } catch (err) { formError(err.message); return; }
    if (!collected.items.length) { formError('Choose a receipt file or paste the receipt text.'); return; }

    const btn = $('impSubmit');
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      let resp;
      try {
        resp = await fetch(WORKER + '/api/moderation/receipt-import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + sessionId, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: collected.items })
        });
      } catch (err) { formError('Couldn\'t reach the server. Check your connection and try again.'); return; }
      if (resp.status === 401) { setView('signedOut'); return; }
      if (resp.status === 403) { setView('forbidden'); return; }
      let body = null;
      try { body = await resp.json(); } catch (err) { /* handled below */ }
      if (resp.status === 413) { formError('That upload is too large.'); return; }
      if (!resp.ok || !body || !Array.isArray(body.results)) {
        formError(`The import failed (code ${resp.status}). Try again in a moment.`);
        return;
      }
      renderResults(body, collected.labels);
      $('impForm').reset();
    } finally {
      btn.disabled = false; btn.textContent = 'Import';
    }
  }

  function renderResults(body, labels) {
    const list = $('impList');
    list.textContent = '';
    for (const r of body.results) list.appendChild(resultCard(r, labels[r.index] || `Receipt ${r.index + 1}`));
    const run = body.run || {};
    const parts = [`${run.processed || 0} processed`, `${run.added || 0} added`];
    if (run.updated) parts.push(`${run.updated} updated`);
    if (run.duplicates) parts.push(`${run.duplicates} already imported`);
    if (run.needs_review) parts.push(`${run.needs_review} need review`);
    if (run.rejected) parts.push(`${run.rejected} rejected`);
    if (run.errors) parts.push(`${run.errors} failed`);
    $('impSummary').textContent = parts.join(' · ');
    show('impResults', true);
  }

  $('impForm').addEventListener('submit', onSubmit);
  $('impRetry').addEventListener('click', checkAccess);
  checkAccess();
})();
