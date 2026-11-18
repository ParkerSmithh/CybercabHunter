/* Link Gmail page (/link-gmail): how a rider's Tesla receipt emails get into
   the site. Everything here is the signed-in rider's own: their forwarding
   address (GET /api/receipt-ingestion/address, which issues one if needed),
   a fresh one on request (POST .../address/rotate), and their sync status
   (GET /api/rides/sync-status: Gmail's forwarding confirmation code, whether
   receipts are arriving, and totals). Every call carries only the bearer
   session; nothing in a request can name another rider.
   Views: loading, error (a request failed, NOT signed out), signedOut, ready.
   Ready shows the automatic forwarding setup directly.
   While the page is open and visible, sync status is re-checked on a timer
   (faster while the rider waits for Gmail's code) and whenever the rider
   comes back to this tab, so finishing a step in Gmail shows up here without
   a reload. */
(function () {
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || 'https://cybercabhunter.contactjoeclos.workers.dev';
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
  let pollTimer = null;
  let codeKey;               // code + arrival time last rendered (undefined until the first render)
  let codeIsNew = false;
  let inFlight = false;
  let previousLinked = null;
  let autoCompletion = null;
  let countdownTimer = null;
  let completionRequest = null;

  // ---------- first-time Tesla Sync invitation (worker/onboarding.js) ----------
  // Sign-in sends a brand-new account here once with ?welcome=1&next=<page>.
  // The server decides whether it is due (its state is 'pending', or
  // 'presented' after a refresh); the URL alone never shows it.
  const PARAMS = new URLSearchParams(location.search);
  const samePath = p => typeof p === 'string' && p.charAt(0) === '/' && p.charAt(1) !== '/' && p.charAt(1) !== '\\' && !/^\/(signin(\.html)?|api\/|oauth\/|link-gmail)/.test(p);
  const welcomeAsked = PARAMS.get('welcome') === '1';
  const nextPage = samePath(PARAMS.get('next')) ? PARAMS.get('next') : '/';
  let welcome = null;        // null = not onboarding; 'invite' (the card) | 'setup' (the steps)

  // ---------- formatting ----------
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
    if (view === 'signedOut') {
      clearTimeout(countdownTimer);
      autoCompletion = null;
    }
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
    $('lgDone').disabled = state !== 'ready';
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
  // The rider's Gmail forwarding state, from the server's record for THIS
  // signed-in account (GET /api/rides/sync-status). The same rule as
  // js/rider-data.js and js/link-gmail.js (tests/gmail-signin.test.mjs keeps
  // them identical):
  //   linked     set up (completed, or receipts arriving) and nothing waiting in Gmail
  //   reconnect  it was receiving, and Gmail now asks to confirm forwarding again
  //   not_linked never set up, or set up on an address since replaced
  // "Checking" and "unavailable" are the pages' own states: a failed or
  // unfinished check is never read as "not linked".
  function gmailState(f) {
    if (f.confirmation_code || f.confirmation_link) return f.last_received_at ? 'reconnect' : 'not_linked';
    return f.setup_completed_at || f.last_received_at ? 'linked' : 'not_linked';
  }

  // Linked riders see "Gmail Linked" with the setup steps closed until they
  // choose Manage forwarding; a rider who needs to reconnect, or who hasn't
  // linked, sees the steps.
  let setupOpen = false;
  function renderGmailState() {
    if (!status) return;
    const f = status.forwarding;
    const state = gmailState(f);
    const card = $('lgStatus');
    card.dataset.gmailState = state;
    if (autoCompletion) { show('lgStatus', false); return; }   // the "GMAIL IS LINKED" success panel is showing
    if (welcome) {
      show('lgWelcome', welcome === 'invite');
      show('lgWelcomeBar', welcome === 'setup');
      show('lgStatus', false);
      show('lgSetup', welcome === 'setup');
      show('lgSameAccount', welcome === 'setup');
      return;
    }
    show('lgStatus', state !== 'not_linked');
    const linked = state === 'linked';
    show('lgStatusIconOk', linked);
    show('lgStatusIconWarn', !linked);
    $('lgStatusText').textContent = linked ? 'Gmail Linked' : 'Reconnect Gmail';
    $('lgStatusDetail').textContent = linked
      ? (f.last_received_at ? `Receipts are arriving. Last receipt ${fmtWhen(f.last_received_at).toLowerCase()}.` : 'Set up. Your next Tesla receipt will appear in Rider Data.')
      : 'Gmail is asking you to confirm forwarding again. Confirm it in step 3 below and receipts keep arriving. Your rides are safe.';
    const primary = $('lgStatusPrimary');
    primary.textContent = linked ? 'Go to Rider Data' : 'Reconnect Gmail';
    primary.setAttribute('href', linked ? '/rider-data' : '#lgCodeShown');
    show('lgStatusManage', linked);
    const open = !linked || setupOpen;
    show('lgSetup', open);
    show('lgSameAccount', open);   // its "every step below" goes with the steps
    $('lgStatusManage').setAttribute('aria-expanded', String(linked && setupOpen));
    $('lgStatusManage').textContent = setupOpen ? 'Hide forwarding setup' : 'Manage forwarding';
  }
  function setupGmailState() {
    $('lgStatusManage').addEventListener('click', () => {
      setupOpen = !setupOpen;
      renderGmailState();
      if (setupOpen) $('lgSetupTitle').focus();
    });
  }

  // Forwarding is linked when the CURRENT address has received mail and no
  // Gmail confirmation code is waiting to be typed in. The API's `receiving`
  // is historical (any emailed receipt, ever, on any address) and stays true
  // after a new address or a re-setup, so it must not drive the headline
  // (bug 2026-10-05). last_received_at is per address: a new address resets
  // it, and the worker clears the code when the next receipt arrives.
  const isLinked = f => !!f.last_received_at && !pendingConfirmation(f);
  // Gmail's confirmation: a confirm link (2026 format, no code) and/or a code.
  const pendingConfirmation = f => !!(f.confirmation_code || safeConfirmLink(f.confirmation_link));
  // The worker only stores https links on Google's mail-settings hosts; checked
  // again here so nothing else can ever become the button's href.
  function safeConfirmLink(link) {
    if (!link) return null;
    try {
      const u = new URL(link);
      return u.protocol === 'https:' && (u.hostname === 'mail-settings.google.com' || u.hostname === 'mail.google.com') ? u.href : null;
    } catch (e) { return null; }
  }

  function renderStatus() {
    if (!status) return;
    const f = status.forwarding;

    const linked = isLinked(f);

    // Step 3: Gmail's confirmation (link and/or code). A stored one is always
    // unused: the worker clears it when the next receipt arrives. So it is
    // shown no matter what happened before, so a rider re-adding the address
    // in Gmail always sees the fresh one (bug 2026-10-05).
    const code = f.confirmation_code;
    const link = safeConfirmLink(f.confirmation_link);
    const pending = !!(code || link);
    show('lgCodeShown', pending);
    show('lgCodeWaiting', !pending && !linked);
    show('lgCodeDone', !pending && linked);
    show('lgConfirmLinkWrap', !!link);
    show('lgCodeWrap', !!code);
    show('lgHowLink', !code || !!link);
    $('lgHowCode').firstChild.textContent = link || !code ? 'If Gmail gives you a code instead, type it into the ' : 'Type the code into Gmail\'s ';
    const key = pending ? `${code || ''}|${link || ''}|${f.confirmation_code_received_at || ''}` : null;
    if (key !== codeKey) {
      if (pending) {
        // New: it arrived while the page was open, or just before it was opened.
        const arrived = sqlDate(f.confirmation_code_received_at);
        const recent = arrived && !isNaN(arrived) && Date.now() - arrived.getTime() < 15 * 60000;
        codeIsNew = codeKey !== undefined || !!recent;
        if (codeKey !== undefined) $('lgCodeAnnounce').textContent = code
          ? `New Gmail confirmation code: ${code.split('').join(' ')}`
          : 'Gmail\'s confirmation arrived. Use the Confirm in Gmail button in step 3.';
      } else {
        codeIsNew = false;
      }
      codeKey = key;
    }
    show('lgCodeNew', pending && codeIsNew);
    if (code) $('lgCode').textContent = code;
    if (link) $('lgConfirmLink').href = link;
    const who = f.confirmation_requested_by;
    show('lgRequestedBy', !!(link && who));
    if (link && who) $('lgRequestedBy').textContent = `Requested by ${who}. Only confirm if that is your Gmail.`;
    if (pending) $('lgCodeWhen').textContent = 'Arrived ' + fmtWhen(f.confirmation_code_received_at).toLowerCase();

    const becameLinked = previousLinked === false && linked;
    previousLinked = linked;
    if (!linked && autoCompletion) {
      clearTimeout(countdownTimer);
      autoCompletion = null;
      show('lgSuccess', false);
      show('lgSetup', true);
    }
    if (becameLinked) startAutoCompletion();
    renderGmailState();
  }

  async function refreshStatus() {
    if (inFlight) return;
    inFlight = true;
    try {
      const resp = await api('/api/rides/sync-status');
      if (resp.status === 401) { stopPolling(); setView('signedOut'); return; }
      if (resp.ok && resp.json && resp.json.forwarding) {
        status = resp.json;
        renderStatus();
      }
    } catch (e) {
      // Keep the confirmation view; scheduled polling retries automatically.
    } finally {
      inFlight = false;
      schedulePoll();
    }
  }

  // Fastest while a code may be on its way: the automatic setup is open and no
  // code is showing (even if receipts arrived before), or nothing has arrived yet.
  function pollDelay() {
    const f = status && status.forwarding;
    if (!f) return POLL_MS.steady;
    if (pendingConfirmation(f)) return POLL_MS.first;
    return POLL_MS.code;
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;   // resumed by visibilitychange
    pollTimer = setTimeout(refreshStatus, pollDelay());
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }

  function setupStatus() {
    // Coming back from the Gmail tab is exactly when something may have changed.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopPolling(); else refreshStatus();
    });

  }

  // Share the existing authenticated completion write with the manual fallback.
  async function saveCompletion() {
    if (!completionRequest) {
      completionRequest = (async () => {
        const response = await api('/api/receipt-ingestion/setup/complete', { method: 'POST' });
        if (response.status === 401) { stopPolling(); setView('signedOut'); return false; }
        if (!response.ok || !response.json || !response.json.success) throw new Error('save failed');
        return true;
      })();
    }
    try { return await completionRequest; } finally { completionRequest = null; }
  }

  function navigateToRiderData() {
    clearTimeout(countdownTimer);
    stopPolling();
    if (welcome) { finishWelcome('complete'); return; }
    location.assign('/rider-data');
  }

  // Record the rider's choice (best effort, a few seconds at most), then go on
  // to the page they asked for. A failure never keeps them here: the invitation
  // was already shown, so it isn't offered automatically again.
  function onboarding(action) {
    const timeout = new Promise(resolve => setTimeout(resolve, 4000));
    return Promise.race([api('/api/onboarding/tesla-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }).catch(() => null), timeout]);
  }
  let leaving = false;
  async function finishWelcome(action) {
    if (leaving) return;
    leaving = true;
    stopPolling();
    await onboarding(action);
    location.assign(nextPage);
  }
  function setupWelcome() {
    $('lgWelcomeSetup').addEventListener('click', () => {
      welcome = 'setup';
      renderGmailState();
      $('lgSetupTitle').focus();
    });
    $('lgWelcomeSkip').addEventListener('click', () => finishWelcome('skip'));
    $('lgWelcomeLater').addEventListener('click', () => finishWelcome('skip'));
  }

  function showCompletionError() {
    $('lgSuccessError').textContent = "Couldn't save your setup. Choose Continue now to try again.";
    show('lgSuccessError', true);
    $('lgCountdown').textContent = 'You will stay on this page until your setup is saved.';
  }

  function startCountdown(completion) {
    let remaining = 4;
    function tick() {
      if (autoCompletion !== completion || completion.stay) return;
      if (remaining === 0) { navigateToRiderData(); return; }
      $('lgCountdown').textContent = `${welcome ? 'Continuing' : 'Opening Rider Data'} in ${remaining} ${remaining === 1 ? 'second' : 'seconds'}…`;
      remaining -= 1;
      countdownTimer = setTimeout(tick, 1000);
    }
    tick();
  }

  async function startAutoCompletion() {
    const completion = { stay: false, saved: false };
    autoCompletion = completion;
    show('lgSetup', false);
    show('lgSuccess', true);
    show('lgSuccessError', false);
    $('lgCountdown').textContent = 'Saving your setup…';
    $('lgContinueNow').disabled = false;
    $('lgSuccessTitle').focus();
    $('lgSuccess').scrollIntoView({ block: 'start' });
    try {
      completion.saved = await saveCompletion();
      if (autoCompletion === completion && completion.saved && !completion.stay) startCountdown(completion);
    } catch (e) {
      if (autoCompletion === completion) showCompletionError();
    }
  }

  function setupAutoCompletion() {
    $('lgStay').addEventListener('click', () => {
      if (!autoCompletion) return;
      autoCompletion.stay = true;
      clearTimeout(countdownTimer);
      $('lgCountdown').textContent = 'Gmail stays linked. You can continue to Rider Data whenever you are ready.';
    });
    $('lgContinueNow').addEventListener('click', async () => {
      const completion = autoCompletion;
      if (!completion) return;
      completion.stay = true;
      clearTimeout(countdownTimer);
      $('lgContinueNow').disabled = true;
      show('lgSuccessError', false);
      try {
        if (!completion.saved) completion.saved = await saveCompletion();
        if (autoCompletion === completion && completion.saved) navigateToRiderData();
      } catch (e) {
        if (autoCompletion === completion) showCompletionError();
      } finally { $('lgContinueNow').disabled = false; }
    });
  }

  function setupDone() {
    $('lgDone').addEventListener('click', async () => {
      const button = $('lgDone');
      button.disabled = true; button.textContent = 'Saving…';
      show('lgDoneError', false);
      try {
        if (await saveCompletion()) navigateToRiderData();
      } catch (e) {
        $('lgDoneError').textContent = "Couldn't save your setup. Please try again.";
        show('lgDoneError', true);
        button.disabled = !address;
        button.textContent = 'Done';
      }
    });
  }

  // ---------- load ----------
  async function load() {
    setView('loading');
    let addr, sync, me = null;
    try {
      [addr, sync, me] = await Promise.all([api('/api/receipt-ingestion/address'), api('/api/rides/sync-status'),
        welcomeAsked ? api('/api/me').catch(() => null) : null]);
    } catch (e) {
      setView('error'); return;
    }
    if (addr.status === 401 || sync.status === 401) { setView('signedOut'); return; }
    if ((!addr.ok && addr.status !== 409) || !sync.ok || !sync.json || !sync.json.forwarding) {
      $('lgErrorDetail').textContent = `The server had a problem (code ${!sync.ok ? sync.status : addr.status}). You're still signed in. Try again in a moment.`;
      setView('error'); return;
    }
    applyAddressResponse(addr);
    // Onboarding only when the server says this account's invitation is due.
    const invite = me && me.ok && me.json && me.json.onboarding ? me.json.onboarding.tesla_sync : null;
    if (welcomeAsked && (invite === 'pending' || invite === 'presented') && !welcome) {
      welcome = 'invite';
      if (invite === 'pending') onboarding('presented');   // shown now: not offered automatically again
    }
    status = sync.json;
    previousLinked = isLinked(status.forwarding);
    renderStatus();
    setView('ready');
    show('lgAuto', true);
    $('lgSetupTitle').textContent = 'FORWARD AUTOMATICALLY';
    $('lgSetupLede').textContent = 'Set this up once in Gmail and every new receipt forwards itself. Gmail only has these settings on its website, so do this on a computer.';
    schedulePoll();
  }

  function init() {
    if (!sessionId) { setView('signedOut'); return; }
    setupCopy(); setupRotate(); setupStatus(); setupDone(); setupAutoCompletion(); setupGmailState(); setupWelcome();
    $('lgRetry').addEventListener('click', load);
    load();
  }

  init();
})();
