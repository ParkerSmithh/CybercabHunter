/* A public vehicle's timeline on /vehicle/<id> (GET /api/robotaxi-vehicles/:id/timeline,
   precomputed daily from public records: worker/vehicle-timeline.js).
   Newest first; filter All / Sightings / Rides / Status; 50 per page; previous /
   next vehicle in the same city; Copy link. Only what the records say: a date
   known only from the submission reads "submitted <date>", no invented events. */
(function () {
  const $ = id => document.getElementById(id);
  const WORKER = (typeof CCC !== 'undefined' && CCC.apiOrigin) || '';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const FILTERS = [['all', 'All'], ['sightings', 'Sightings'], ['rides', 'Rides'], ['status', 'Status']];
  let vehicleId = null, filter = 'all', page = 1, counts = null, generation = 0, loading = false;

  const dateLabel = e => (!e.date ? 'Date not recorded' : e.date_kind === 'submitted' ? `Submitted ${fmtDay(e.date)}` : fmtDay(e.date));
  function item(e) {
    const when = `<time class="vt-date">${esc(dateLabel(e))}</time>`;
    if (e.kind === 'sighting') {
      const where = [e.camera ? `Camera: ${e.camera}` : null, e.city].filter(Boolean).join(' · ');
      const thumb = e.photo
        ? `<a class="vt-thumb" href="${esc(e.photo.image_url)}" target="_blank" rel="noopener" aria-label="Open the sighting photo"><img src="${esc(e.photo.image_url)}" alt="Sighting photo" loading="lazy" decoding="async"></a>`
        : `<span class="vt-thumb vt-thumb-none" aria-hidden="true"></span>`;
      return `<li class="vt-item vt-sighting">${thumb}<div class="vt-body"><p class="vt-title">${e.type === 'image' ? 'Image sighting' : 'Vehicle sighting'}</p><p class="vt-meta">${when}${where ? ` · ${esc(where)}` : ''}</p>${e.type === 'image' && !e.photo ? '<p class="vt-sub">Photo no longer stored (photos are kept 30 days).</p>' : ''}</div></li>`;
    }
    if (e.kind === 'rides') {
      const dist = e.total_distance != null ? ` · ${Number(e.total_distance).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi total` : '';
      const span = e.first && e.last && e.first !== e.last ? `${fmtDay(e.first)} – ${fmtDay(e.last)}` : e.last ? fmtDay(e.last) : '';
      return `<li class="vt-item vt-rides"><span class="vt-icon" aria-hidden="true">R</span><div class="vt-body"><p class="vt-title">${e.count} recorded ride${e.count === 1 ? '' : 's'}</p><p class="vt-meta">${esc(span)}${dist}</p><p class="vt-sub">Ride totals only; individual rides are not published.</p></div></li>`;
    }
    const titles = { first_seen: 'First seen', added: 'Added to the registry', approved: e.basis === 'vin-verified' ? 'Approved as a Cybercab (VIN verified)' : 'Approved as a Cybercab (manual review)' };
    return `<li class="vt-item vt-status"><span class="vt-icon" aria-hidden="true">•</span><div class="vt-body"><p class="vt-title">${esc(titles[e.kind] || e.kind)}</p><p class="vt-meta">${when}</p></div></li>`;
  }
  const EMPTY = { all: 'Nothing recorded for this vehicle yet.', sightings: 'No sightings recorded yet.', rides: 'No rides recorded yet.', status: 'No status changes recorded.' };

  async function fetchPage(append) {
    const generationAtRequest = ++generation;
    loading = true;
    $('vtMore').disabled = true;
    let d = null;
    try {
      const r = await fetch(`${WORKER}/api/robotaxi-vehicles/${encodeURIComponent(vehicleId)}/timeline?filter=${filter}&page=${page}`);
      d = r.ok ? await r.json() : null;
    } catch {}
    if (generationAtRequest !== generation) return;
    loading = false;
    $('vtMore').disabled = false;
    if (!d) {
      if (append) page--;
      else { $('vtMore').classList.add('hidden'); $('vtList').textContent = 'The timeline is unavailable right now.'; }
      return;
    }
    renderPage(d, append);
  }

  function renderPage(d, append) {
    counts = d.counts || counts;
    renderFilters();
    const html = d.events.map(item).join('');
    if (append) $('vtList').insertAdjacentHTML('beforeend', html);
    else $('vtList').innerHTML = html || `<li class="vt-empty">${esc(EMPTY[filter])}</li>`;
    $('vtMore').classList.toggle('hidden', !d.has_more);
    $('vtNote').textContent = d.updated_on
      ? `Updated daily from approved, public records · last update ${fmtDay(d.updated_on)}. In- and out-of-service changes are not recorded by the site.`
      : 'The timeline is built once a day; this vehicle has not been included yet.';
    const link = (v, rel) => (v ? `<a href="/vehicle/${encodeURIComponent(v.id)}" rel="${rel}" class="vt-nav-link">${rel === 'prev' ? '← ' : ''}${esc(v.plate || 'Vehicle')}${rel === 'next' ? ' →' : ''}</a>` : '<span></span>');
    if (d.filter === 'all' && d.page === 1) $('vtNav').innerHTML = d.prev || d.next ? `${link(d.prev, 'prev')}${link(d.next, 'next')}` : '';
  }
  function renderFilters() {
    const n = k => (counts ? (k === 'all' ? counts.sightings + Number(counts.rides > 0) + counts.status : counts[k]) : null);
    $('vtFilters').innerHTML = FILTERS.map(([k, label]) => `<button type="button" data-vt="${k}" aria-pressed="${k === filter}">${label}${n(k) != null ? ` <span>${n(k)}</span>` : ''}</button>`).join('');
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('#vtFilters [data-vt]');
    if (b && b.dataset.vt !== filter) { filter = b.dataset.vt; page = 1; fetchPage(false); }
    if (!loading && e.target.closest('#vtMore')) { page++; fetchPage(true); }
    if (e.target.closest('#vtShare')) {
      const url = `https://cybercabhunter.com/vehicle/${encodeURIComponent(vehicleId)}`;
      const btn = $('vtShare');
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => { btn.textContent = 'Link copied'; }, () => { btn.textContent = url; }).finally(() => setTimeout(() => { btn.textContent = 'Copy link'; }, 2200));
    }
  });

  window.CCHVehicleTimeline = { load(id, data) { vehicleId = id; $('vTimeline').classList.remove('hidden'); renderPage(data, false); } };
})();
