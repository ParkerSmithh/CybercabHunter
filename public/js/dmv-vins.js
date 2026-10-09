/* "Every VIN" page (dmv.html): today's TxDMV automated-vehicle roster for
   Tesla Robotaxi, LLC, from GET /api/dmv-registrations/vins (worker/txdmv.js).
   Shows exactly the source's fields (VIN, make, model, model year); filter by
   model, search by VIN, 100 at a time. */
(function () {
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PAGE = 100;
  let model = '', q = '', offset = 0, seq = 0, timer = 0;
  const dot = m => (/cybercab/i.test(m) ? '#D4AF37' : /model y/i.test(m) ? '#ef4444' : '#64748b');
  async function load(reset) {
    const mine = ++seq;
    if (reset) { offset = 0; $('vinRows').innerHTML = ''; }
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (model) params.set('model', model);
    if (q) params.set('q', q);
    let body = null;
    try { const r = await fetch(`/api/dmv-registrations/vins?${params}`); body = r.ok ? await r.json() : null; } catch (e) { body = null; }
    if (mine !== seq) return;
    if (!body) { $('vinCount').textContent = "Couldn't load the roster right now."; return; }
    $('vinRows').insertAdjacentHTML('beforeend', body.vehicles.map(v => `<tr class="border-t border-white/[0.05]">
      <td class="px-4 py-2.5 font-mono tracking-wide text-slate-100 max-sm:px-3">${esc(v.vin)}</td>
      <td class="px-4 py-2.5 text-slate-400 max-sm:hidden">${esc(v.make)}</td>
      <td class="px-4 py-2.5 max-sm:px-2"><span class="inline-flex items-center gap-1.5 text-slate-200"><span class="w-2 h-2 rounded-full" style="background:${dot(v.model)}"></span>${esc(v.model)}</span></td>
      <td class="px-4 py-2.5 text-right stat-value text-slate-400 max-sm:px-3">${esc(v.model_year)}</td></tr>`).join(''));
    offset += body.vehicles.length;
    $('vinCount').textContent = body.total ? `${offset.toLocaleString('en-US')} of ${body.total.toLocaleString('en-US')} VINs` : (q ? 'No VIN matches that search.' : 'No roster snapshot yet.');
    $('vinMore').classList.toggle('hidden', offset >= body.total);
  }
  $('vinModel').addEventListener('click', e => {
    const b = e.target.closest('[data-model]');
    if (!b) return;
    model = b.dataset.model;
    $('vinModel').querySelectorAll('[data-model]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    load(true);
  });
  $('vinSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { q = $('vinSearch').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''); load(true); }, 250);
  });
  $('vinMore').addEventListener('click', () => load(false));
  load(true);
})();
