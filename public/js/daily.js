/* Cybercab Daily refreshes its small, same-origin endpoint every five minutes.
   A local-date rollover fetches immediately; hidden tabs do not poll. */
(function () {
  'use strict';
  const card = document.getElementById('cybercabDaily');
  if (!card) return;
  const $ = id => document.getElementById(id);
  const keys = ['registry', 'dmv', 'sightings', 'cameras'];
  const labels = { registry: 'New Cybercabs Documented', dmv: 'New DMV Registrations', sightings: 'Cybercab Sightings', cameras: 'Camera Detections' };
  function today() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const readable = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const number = n => Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  function stats(day, categories = keys) {
    const dl = el('dl', undefined, 'activity-stats');
    for (const key of categories) {
      const item = el('div'), n = day?.[key];
      let detail;
      const shortLabels = { registry: 'New Cybercabs', dmv: 'DMV additions', sightings: 'Sightings', cameras: 'Detections' };
      const label = el('dt', card ? shortLabels[key] || labels[key] : labels[key]);
      if (card) {
        label.title = labels[key];
        const paths = { registry: '<path d="M3 15V9l2-4h10l4 4h2v6h-2m-4 0H9m-6-6h16"/><circle cx="6" cy="15" r="3"/><circle cx="18" cy="15" r="3"/>', dmv: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h3"/>', sightings: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>', cameras: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>' };
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [attr, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true', class: 'daily-metric-icon' })) icon.setAttribute(attr, value);
        icon.innerHTML = paths[key] || ''; label.prepend(icon);
        const previous = data?.previous;
        const change = n != null && previous?.[key] != null ? n - previous[key] : null;
        const descriptions = { registry: 'Registry entries', dmv: 'First observed', sightings: 'Approved photos', cameras: 'Camera captures' };
        const note = el('span', change === null ? descriptions[key] : `${change > 0 ? '+' : ''}${number(change)} vs yesterday`, 'daily-metric-detail');
        note.title = change === null ? descriptions[key] : 'Today’s activity so far compared with the previous full day';
        detail = note;
      }
      const value = el('dd', undefined, n == null ? 'activity-unavailable' : '');
      value.append(el('span', n == null ? 'Unavailable' : `${key === 'registry' || key === 'dmv' ? '+' : ''}${number(n)}`, 'daily-value'));
      if (detail) value.append(detail);
      item.append(label, value);
      dl.append(item);
    }
    return dl;
  }
  let data, lastDay = today(), fetched = 0, sequence = 0;
  async function load() {
    const token = ++sequence;
    fetched = Date.now();
    lastDay = today();
    $('dailyDate').textContent = readable(lastDay);
    if (!data || data.today !== lastDay) $('dailyStats').replaceChildren(stats(null));
    try {
      const response = await fetch('/api/daily');
      if (!response.ok) throw new Error('Daily unavailable');
      const body = await response.json();
      if (token !== sequence) return;
      if (body.today !== lastDay || !body.day) throw new Error('Daily date mismatch');
      data = body;
      fetched = Date.now();
      $('dailyStats').replaceChildren(stats(data.day));
      $('dailyUpdated').textContent = Object.keys(data.errors || {}).length ? 'Some data unavailable' : `Updated ${new Date(data.generated_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`;
    } catch {
      if (token !== sequence) return;
      data = null;
      $('dailyUpdated').textContent = 'Refresh pending';
      $('dailyStats').replaceChildren(stats(null), el('p', 'Activity could not be retrieved. Automatic refresh will retry.', 'activity-muted'));
      const retry = el('button', 'Retry', 'activity-retry');
      retry.type = 'button';
      retry.addEventListener('click', () => { retry.remove(); load(); });
      $('dailyStats').append(retry);
    }
  }
  function refresh() {
    if (document.hidden) return;
    if (today() !== lastDay || Date.now() - fetched >= 300000) load();
  }
  setInterval(refresh, 1000);
  document.addEventListener('visibilitychange', refresh);
  load();
})();
