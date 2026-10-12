/* Moderation: Fleet ETA rider reports (moderation.html #modFareReports;
   worker/fleet-eta.js). Lists the pending reports, oldest first, with
   Approve / Reject. Every call is moderator-gated server-side
   (requireModerator); a non-moderator just gets nothing. Text goes in through
   textContent. */
(function () {
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  if (!$('modFareReports')) return;
  let sessionId = null;
  try { sessionId = localStorage.getItem('teslaSessionId'); } catch (e) { sessionId = null; }
  const LABEL = { cybercab: 'Cybercab', model_y: 'Model Y', unknown: 'Vehicle not given' };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  async function api(path, options = {}) {
    const resp = await fetch(WORKER + path, { ...options, headers: { Authorization: 'Bearer ' + sessionId, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    let json = null;
    try { json = await resp.json(); } catch (e) { /* non-JSON */ }
    return { status: resp.status, ok: resp.ok, json };
  }

  function describe(r) {
    const parts = [`${r.city === 'dallas' ? 'Dallas' : 'Austin'}`, r.kind === 'quote' ? 'App quote' : 'Completed ride', LABEL[r.vehicle_type] || r.vehicle_type];
    if (r.pickup_area) parts.push(`from ${r.pickup_area}${r.dropoff_area ? ` to ${r.dropoff_area}` : ''}`);
    const vals = [];
    if (r.no_cars_available) vals.push('no cars available');
    if (r.quoted_fare_cents != null) vals.push(`$${(r.quoted_fare_cents / 100).toFixed(2)}`);
    if (r.distance_miles != null) vals.push(`${r.distance_miles} mi`);
    if (r.quoted_fare_cents != null && r.distance_miles) vals.push(`$${(r.quoted_fare_cents / 100 / r.distance_miles).toFixed(2)}/mi`);
    if (r.duration_minutes != null) vals.push(`${r.duration_minutes} min trip`);
    if (r.quoted_wait_minutes != null) vals.push(`${r.quoted_wait_minutes} min wait quoted`);
    if (r.actual_wait_minutes != null) vals.push(`${r.actual_wait_minutes} min actual wait`);
    return { head: parts.join(' · '), vals: vals.join(' · '), when: `Seen ${r.observed_hour_utc.replace('T', ' ').replace(':00:00Z', ':00 UTC')} · sent ${String(r.created_at).replace('T', ' ').replace('Z', ' UTC')}${r.reporter ? ` by ${r.reporter}` : ''}` };
  }

  async function act(id, action, li) {
    li.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const res = await api(`/api/moderation/fare-reports/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action }) });
    if (res.ok) { li.remove(); if (!$('modFareReportsList').children.length) $('modFareReportsStatus').textContent = 'No reports waiting for review.'; }
    else { li.querySelectorAll('button').forEach(b => { b.disabled = false; }); $('modFareReportsStatus').textContent = 'That action failed. Try again.'; }
  }

  async function load() {
    if (!sessionId) { $('modFareReports').classList.add('hidden'); return; }
    const res = await api('/api/moderation/fare-reports');
    if (res.status === 401 || res.status === 403) { $('modFareReports').classList.add('hidden'); return; }
    const list = $('modFareReportsList');
    list.textContent = '';
    if (!res.ok || !res.json) { $('modFareReportsStatus').textContent = 'Couldn\'t load reports.'; return; }
    const reports = res.json.reports || [];
    $('modFareReportsStatus').textContent = reports.length ? `${reports.length} waiting for review (oldest first).` : 'No reports waiting for review.';
    for (const r of reports) {
      const d = describe(r);
      const li = el('li', 'rounded-xl border border-white/10 p-4 flex flex-wrap items-center justify-between gap-3');
      const text = el('div', 'min-w-0');
      text.append(el('p', 'text-sm font-semibold text-slate-100', d.head), el('p', 'text-sm text-slate-300 mt-0.5', d.vals), el('p', 'text-xs text-slate-500 mt-1', d.when));
      const btns = el('div', 'flex gap-2');
      const ok = el('button', 'min-h-[44px] px-4 rounded-lg text-sm font-bold bg-gradient-to-r from-goldsoft to-gold text-[#1a1204]', 'Approve');
      const no = el('button', 'min-h-[44px] px-4 rounded-lg text-sm font-semibold border border-white/15 text-slate-100 hover:bg-white/5', 'Reject');
      ok.type = no.type = 'button';
      ok.addEventListener('click', () => act(r.id, 'approve', li));
      no.addEventListener('click', () => act(r.id, 'reject', li));
      btns.append(ok, no);
      li.append(text, btns);
      list.append(li);
    }
  }
  load();
})();
