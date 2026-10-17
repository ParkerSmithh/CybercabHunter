/* Moderation: the Gmail Link tab's detail (moderation.html #modPanelGmail;
   GET /api/moderation/forwarding-detail, worker/moderation.js). Loaded when
   the tab first opens: the setup funnel, forwarded receipts by period and
   outcome, the last 14 days, and Gmail API connections. Aggregate counts
   only (the route never returns a rider, address or email). The headline
   counts above it are js/moderation.js's (forwarding-stats). */
(function () {
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  if (!$('modPanelGmail')) return;
  let sessionId = null;
  try { sessionId = localStorage.getItem('teslaSessionId'); } catch (e) { sessionId = null; }
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const num = v => Number(v || 0).toLocaleString('en-US');
  const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
  const when = iso => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : 'never');
  const OUTCOMES = { accepted: 'Accepted (ride recorded)', needs_review: 'Needs review', duplicate: 'Duplicate (already had it)', rejected: 'Rejected (not a Tesla Robotaxi receipt)', parse_error: 'Could not be read' };

  function stat(label, value, note) {
    const d = el('div', 'min-w-0');
    d.append(el('dt', 'text-xs text-slate-400', label), el('dd', 'mt-1 text-2xl font-semibold text-white tabular-nums', value));
    if (note) d.append(el('p', 'text-[11px] text-slate-500 mt-0.5', note));
    return d;
  }
  // A labelled bar: the gold share of the whole.
  function bar(label, value, whole) {
    const li = el('li');
    const row = el('div', 'flex items-baseline justify-between gap-3 text-sm');
    row.append(el('span', 'text-slate-300', label), el('span', 'tabular-nums text-white font-semibold', `${num(value)}`));
    const share = el('span', 'tabular-nums text-xs text-slate-500 w-10 text-right shrink-0', pct(value, whole));
    const track = el('div', 'mt-1.5 flex items-center gap-3');
    const t = el('div', 'h-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden');
    const fill = el('div', 'h-full rounded-full bg-gold/80');
    fill.style.width = whole ? `${Math.min(100, (value / whole) * 100)}%` : '0%';
    t.append(fill); track.append(t, share);
    li.append(row, track);
    return li;
  }

  function render(d) {
    const f = d.funnel;
    $('modGmailFunnel').replaceChildren(
      bar('Addresses issued', f.issued, f.issued),
      bar('Confirmation received', f.confirmation_received, f.issued),
      bar('Setup completed', f.setup_completed, f.issued),
      bar('Receiving receipts (ever)', f.receiving, f.issued),
      bar('Receiving in the last 7 days', f.receiving_7d, f.issued));
    $('modGmailRevoked').textContent = f.revoked ? `${num(f.revoked)} ${f.revoked === 1 ? 'address' : 'addresses'} revoked (not counted above).` : 'No revoked addresses.';

    const r = d.receipts;
    $('modGmailReceipts').replaceChildren(stat('Last 24 hours', num(r.last_24h)), stat('Last 7 days', num(r.last_7d)), stat('Last 30 days', num(r.last_30d)), stat('All time', num(r.total)));
    $('modGmailLastReceipt').textContent = `Last receipt received: ${when(r.last_received_at)}.`;
    $('modGmailOutcomes').replaceChildren(...Object.keys(OUTCOMES).map(k => bar(OUTCOMES[k], r.by_status[k] || 0, r.total)));

    const max = Math.max(1, ...r.daily.map(x => x.n));
    $('modGmailDaily').replaceChildren(...r.daily.map(x => {
      const col = el('div', 'flex-1 h-full flex flex-col justify-end items-center gap-1 min-w-0');
      const label = new Date(x.date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
      col.title = `${label}: ${x.n} ${x.n === 1 ? 'receipt' : 'receipts'}`;
      col.append(el('span', 'text-[10px] text-slate-400 tabular-nums', x.n ? String(x.n) : ''));
      const b = el('div', `w-full rounded-t ${x.n ? 'bg-gold/80' : 'bg-white/[0.06]'}`);
      b.style.height = x.n ? `${Math.max(6, (x.n / max) * 100)}%` : '2px';
      col.append(b);
      return col;
    }));
    const short = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
    $('modGmailDailyAxis').replaceChildren(el('span', '', short(r.daily[0].date)), el('span', '', short(r.daily[r.daily.length - 1].date)));

    const g = d.gmail_api;
    $('modGmailApi').replaceChildren(stat('Connected', num(g.active)), stat('Needs reconnecting', num(g.error)), stat('Disconnected', num(g.revoked)), stat('History imported', num(g.backfill_done), 'of the connected'));
    $('modGmailApiLast').textContent = `Last successful sync: ${when(g.last_success_at)}.`;
  }

  let loaded = false;
  async function load() {
    if (!sessionId) return;
    loaded = true;
    $('modGmailDetailError').classList.add('hidden');
    let resp = null, json = null;
    try {
      resp = await fetch(WORKER + '/api/moderation/forwarding-detail', { headers: { Authorization: 'Bearer ' + sessionId } });
      json = resp.ok ? await resp.json() : null;
    } catch (e) { json = null; }
    if (resp && (resp.status === 401 || resp.status === 403)) return;   // js/moderation.js shows signed-out / forbidden
    if (!json || !json.funnel || !json.receipts) { loaded = false; $('modGmailDetailError').classList.remove('hidden'); return; }
    render(json);
  }
  $('modGmailDetailRetry').addEventListener('click', load);
  document.addEventListener('cch:moderation-gmail', () => { if (!loaded) load(); });
  // js/moderation.js may have reopened this tab before this script loaded.
  if (!$('modPanelGmail').classList.contains('hidden')) load();
})();
