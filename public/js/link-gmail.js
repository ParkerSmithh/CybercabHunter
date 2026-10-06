/* Link Gmail page (/link-gmail): how a rider's Tesla receipt emails get into
   the site. Everything here is the signed-in rider's own: their forwarding
   address (GET /api/receipt-ingestion/address, which issues one if needed),
   a fresh one on request (POST .../address/rotate), and their sync status
   (GET /api/rides/sync-status: Gmail's forwarding confirmation code, whether
   receipts are arriving, and totals). Every call carries only the bearer
   session; nothing in a request can name another rider.
   Views: loading, error (a request failed, NOT signed out), signedOut, ready.
   While the page is open and visible, sync status is re-checked on a timer
   (faster while the rider waits for Gmail's code) and whenever the rider
   comes back to this tab, so finishing a step in Gmail shows up here without
   a reload. */
(function () {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const SESSION_KEY = 'teslaSessionId';
  // Re-check sync status: waiting for the code / waiting for a first receipt / receiving.
  const POLL_MS = { code: 8000, first: 20000, steady: 60000 };

  const $ = id => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const all = sel => [...document.querySelectorAll(sel)];

  let sessionId = null;
  try { sessionId = localStorage.getItem(SESSION_KEY); } catch (e) { /* storage blocked: treated as signed out */ }

  let address = null;        // the full address, only when the domain is configured
  let status = null;         // last sync-status payload
  let checkedAt = null;      // when status was last fetched
  let pollTimer = null;
  let inFlight = false;

  // ---------- formatting ----------
  const fmtInt = n => (n == null ? '-' : Number(n).toLocaleString());
  const sqlDate = ts => (ts ? new Date(String(ts).replace(' ', 'T') + 'Z') : null);
  function fmtWhen(ts) {
    const dt = sqlDate(ts);
    if (!dt || isNaN(dt)) return 'Never';
    const mins = Math.round((Date.now() - dt.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtChecked() {
    if (!checkedAt) return '';
    const secs = Math.round((Date.now() - checkedAt) / 1000);
    return secs < 10 ? 'Checked just now' : secs < 60 ? `Checked ${secs}s ago` : `Checked ${Math.round(secs / 60)} min ago`;
  }

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

  function setView(view) {
    show('lgLoading', view === 'loading');
    show('lgError', view === 'error');
    show('lgSignedOut', view === 'signedOut');
    show('lgReady', view === 'ready');
  }

  // ---------- copy ----------
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through to the selection fallback */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // Any [data-copy] button: "address" copies the rider's address, "code" the
  // confirmation code, anything else is copied literally (e.g. "tesla.com").
  function setupCopy() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      const what = btn.dataset.copy;
      const text = what === 'address' ? address : what === 'code' ? (status && status.forwarding.confirmation_code) : what;
      if (!text) return;
      const label = btn.querySelector('[data-copy-label]') || btn;
      if (!btn.dataset.idle) btn.dataset.idle = label.textContent;
      const ok = await copyText(text);
      label.textContent = ok ? 'Copied' : "Couldn't copy";
      $('lgCopyAnnounce').textContent = ok ? 'Copied to clipboard' : '';
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => { label.textContent = btn.dataset.idle; }, 1800);
    });
  }

  // ---------- address ----------
  // state: 'ready' | 'pending' (domain not configured) | 'revoked'
  function renderAddress(state) {
    show('lgAddressReady', state === 'ready');
    show('lgAddressPending', state === 'pending');
    show('lgAddressRevoked', state === 'revoked');
    if (state === 'ready') {
      // Allow a line break only before the "@", never inside the token or the domain.
      const at = address.indexOf('@'), el = $('lgAddress');
      el.textContent = '';
      el.append(address.slice(0, at), document.createElement('wbr'), address.slice(at));
    }
    all('[data-copy="address"]').forEach(b => { b.disabled = state !== 'ready'; });
    if (state !== 'ready') closeRotate();
  }

  function applyAddressResponse(resp) {
    if (resp.status === 409) { address = null; renderAddress('revoked'); return; }
    const json = resp.json || {};
    if (json.domain_configured && json.address) { address = json.address; renderAddress('ready'); }
    else { address = null; renderAddress('pending'); }
  }

  function closeRotate() {
    show('lgRotateConfirm', false);
    show('lgRotateOpen', true);
    $('lgRotateOpen').setAttribute('aria-expanded', 'false');
  }

  function setupRotate() {
    $('lgRotateOpen').addEventListener('click', () => {
      show('lgRotateConfirm', true);
      show('lgRotateOpen', false);
      $('lgRotateOpen').setAttribute('aria-expanded', 'true');
      show('lgRotateNotice', false);
      $('lgRotateCancel').focus();
    });
    $('lgRotateCancel').addEventListener('click', () => { closeRotate(); $('lgRotateOpen').focus(); });
    $('lgRotateConfirmBtn').addEventListener('click', async () => {
      const btn = $('lgRotateConfirmBtn');
      btn.disabled = true; btn.textContent = 'Getting a new address…';
      let resp = null;
      try { resp = await api('/api/receipt-ingestion/address/rotate', { method: 'POST' }); } catch (e) { resp = null; }
      btn.disabled = false; btn.textContent = 'Yes, get a new address';
      const notice = $('lgRotateNotice');
      if (resp && (resp.ok || resp.status === 409)) {
        applyAddressResponse(resp);
        closeRotate();
        notice.textContent = resp.ok
          ? 'New address ready. Your old one no longer works. If you set up automatic forwarding, add this address in Gmail and point your filter at it.'
          : 'Your forwarding address is turned off for this account.';
        notice.className = 'mt-4 text-sm rounded-lg border px-4 py-3 ' + (resp.ok ? 'border-emerald-400/40 text-emerald-200' : 'border-amber-400/40 text-amber-200');
        refreshStatus();
      } else {
        notice.textContent = resp && resp.status === 401
          ? 'Your session has expired. Sign in again to get a new address.'
          : "Couldn't get a new address. Your current one still works. Try again in a moment.";
        notice.className = 'mt-4 text-sm rounded-lg border px-4 py-3 border-amber-400/40 text-amber-200';
      }
      show('lgRotateNotice', true);
    });
  }

  // ---------- status ----------
  function renderStatus() {
    if (!status) return;
    const f = status.forwarding, totals = (status.receipt_sync && status.receipt_sync.totals) || {};

    // Live status card
    show('lgStateOn', f.receiving);
    show('lgStateOff', !f.receiving);
    $('lgLastReceived').textContent = fmtWhen(f.last_received_at);
    $('lgProcessed').textContent = fmtInt(totals.processed);
    $('lgAdded').textContent = fmtInt(totals.added);
    $('lgDuplicates').textContent = fmtInt(totals.duplicates);
    $('lgChecked').textContent = fmtChecked();

    // Step 3: Gmail's confirmation code. A received receipt clears the stored
    // code server-side, so "receiving" means this step is already behind them.
    const code = f.confirmation_code;
    show('lgCodeWaiting', !code && !f.receiving);
    show('lgCodeShown', !!code && !f.receiving);
    show('lgCodeDone', !!f.receiving);
    if (code) {
      $('lgCode').textContent = code;
      $('lgCodeWhen').textContent = 'Arrived ' + fmtWhen(f.confirmation_code_received_at).toLowerCase();
    }
  }

  async function refreshStatus() {
    if (inFlight) return;
    inFlight = true;
    $('lgRefresh').disabled = true;
    $('lgRefresh').classList.add('is-busy');
    try {
      const resp = await api('/api/rides/sync-status');
      if (resp.status === 401) { stopPolling(); setView('signedOut'); return; }
      if (resp.ok && resp.json && resp.json.forwarding) {
        status = resp.json; checkedAt = Date.now();
        show('lgStatusError', false);
        renderStatus();
      } else {
        show('lgStatusError', true);
      }
    } catch (e) {
      show('lgStatusError', true);
    } finally {
      inFlight = false;
      $('lgRefresh').disabled = false;
      $('lgRefresh').classList.remove('is-busy');
      schedulePoll();
    }
  }

  function pollDelay() {
    const f = status && status.forwarding;
    if (!f || f.receiving) return POLL_MS.steady;
    return f.confirmation_code ? POLL_MS.first : POLL_MS.code;
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;   // resumed by visibilitychange
    pollTimer = setTimeout(refreshStatus, pollDelay());
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function setupStatus() {
    $('lgRefresh').addEventListener('click', refreshStatus);
    // Coming back from the Gmail tab is exactly when something may have changed.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling(); else refreshStatus();
    });
    // Keep the "Checked …" line honest between polls.
    setInterval(() => { if (checkedAt) $('lgChecked').textContent = fmtChecked(); }, 5000);
  }

  // ---------- load ----------
  async function load() {
    setView('loading');
    let addr, sync;
    try {
      [addr, sync] = await Promise.all([api('/api/receipt-ingestion/address'), api('/api/rides/sync-status')]);
    } catch (e) {
      setView('error'); return;
    }
    if (addr.status === 401 || sync.status === 401) { setView('signedOut'); return; }
    if ((!addr.ok && addr.status !== 409) || !sync.ok || !sync.json || !sync.json.forwarding) {
      $('lgErrorDetail').textContent = `The server had a problem (code ${!sync.ok ? sync.status : addr.status}). You're still signed in. Try again in a moment.`;
      setView('error'); return;
    }
    applyAddressResponse(addr);
    status = sync.json; checkedAt = Date.now();
    renderStatus();
    setView('ready');
    schedulePoll();
  }

  function init() {
    if (!sessionId) { setView('signedOut'); return; }
    setupCopy(); setupRotate(); setupStatus();
    $('lgRetry').addEventListener('click', load);
    load();
  }

  init();
})();
