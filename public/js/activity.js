/* Daily card and calendar share /api/activity, refreshed every five minutes.
   A local-date rollover fetches immediately; hidden tabs do not poll. */
(function () {
  'use strict';
  const card = document.getElementById('cybercabDaily'), calendar = document.getElementById('activityCalendar');
  if (!card && !calendar) return;
  const API = 'https://cybercabhunter.contactjoeclos.workers.dev';
  const $ = id => document.getElementById(id);
  const keys = ['registry', 'dmv', 'sightings', 'cameras'];
  const labels = { all: 'All Activity', registry: 'New Cybercabs Documented', dmv: 'New DMV Registrations', sightings: 'Cybercab Sightings', cameras: 'Camera Detections', cybercab: 'Cybercab registrations', model_y: 'Model Y registrations' };
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
      const shortLabels = { registry: 'New Cybercabs', dmv: 'DMV additions', sightings: 'Sightings', cameras: 'Detections' };
      const label = el('dt', card ? shortLabels[key] || labels[key] : labels[key]);
      if (card) label.title = labels[key];
      item.append(label, el('dd', n == null ? 'Unavailable' : `${key === 'registry' || key === 'dmv' ? '+' : ''}${number(n)}`, n == null ? 'activity-unavailable' : ''));
      dl.append(item);
    }
    return dl;
  }
  let data, lastDay = today(), fetched = 0, sequence = 0, detailSequence = 0, selectedDate = null;
  let selectedYear = Number(lastDay.slice(0, 4));
  let tooltip;
  const category = () => calendar ? $('activityCategory').value : 'all';
  function quantile(values, q) { if (!values.length) return 1; return values[Math.floor((values.length - 1) * q)]; }
  function valuesFor(categoryKey) {
    const baselines = Object.fromEntries(keys.map(key => [key, quantile(data.days.map(d => d[key]).filter(n => n > 0).sort((a, b) => a - b), .9)]));
    return data.days.map(day => {
      if (day.date > lastDay) return { day, value: null, future: true };
      if (categoryKey !== 'all') return { day, value: day[categoryKey], partial: false };
      const available = keys.filter(k => day[k] !== null);
      const value = available.length ? available.reduce((sum, k) => sum + Math.min(1, Math.log1p(day[k]) / Math.log1p(baselines[k])) * 100, 0) / available.length : null;
      return { day, value, partial: available.length > 0 && available.length < keys.length };
    });
  }
  function description(entry, cat) {
    return `${readable(entry.day.date)}\n${labels[cat]}: ${entry.future ? 'Future date' : entry.value === null ? 'Unavailable' : number(entry.value) + (cat === 'all' ? ' / 100' : '')}${entry.partial ? '\nPartial data — available categories only' : ''}`;
  }
  function showTooltip(button, entry, cat) {
    tooltip.textContent = description(entry, cat); tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    tooltip.style.left = Math.max(8, Math.min(window.innerWidth - 270, rect.left)) + 'px';
    tooltip.style.top = Math.max(8, rect.top - tooltip.offsetHeight - 8) + 'px';
  }
  function renderCalendar() {
    const cat = category(), entries = valuesFor(cat), valid = entries.filter(e => !e.future && e.value !== null);
    const positives = valid.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
    const thresholds = [.2, .4, .6, .8].map(q => quantile(positives, q));
    const summary = el('dl', undefined, 'activity-stats');
    const total = valid.reduce((s, e) => s + e.value, 0);
    const peak = valid.reduce((best, e) => !best || e.value > best.value ? e : best, null);
    for (const [label, value] of [
      [cat === 'all' ? 'TOTAL COMBINED SCORE' : 'TOTAL ACTIVITY', valid.length ? number(total) : 'Unavailable'],
      ['MOST ACTIVE DAY', peak?.value > 0 ? new Date(peak.day.date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : 'No active days'],
      ['AVERAGE DAILY ACTIVITY', valid.length ? number(total / valid.length) : 'Unavailable'],
      ['ACTIVE DAYS', valid.length ? number(valid.filter(e => e.value > 0).length) : 'Unavailable']
    ]) { const item = el('div'); item.append(el('dt', label), el('dd', value)); summary.append(item); }
    $('activitySummary').replaceChildren(summary);
    const availableKeys = cat === 'all' ? keys : [cat];
    const coverage = availableKeys.map(k => `${labels[k]}: ${data.errors[k] || (data.coverage[k] ? 'coverage from ' + data.coverage[k] : 'coverage unavailable')}`).join(' · ');
    $('activityStatus').textContent = `${valid.length} days with valid data${cat === 'all' ? ' (including partial days)' : ''}. ${coverage}. Updated ${new Date(data.generated_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT.`;
    const grid = $('activityGrid'); grid.replaceChildren();
    grid.append(el('span', '', 'activity-month'));
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => grid.append(el('span', d, 'activity-weekday')));
    const offset = new Date(`${selectedYear}-01-01T12:00:00Z`).getUTCDay();
    const weeks = Math.ceil((entries.length + offset) / 7);
    let previousMonth = -1;
    for (let week = 0; week < weeks; week++) {
      const weekEntries = Array.from({ length: 7 }, (_, row) => entries[week * 7 + row - offset]);
      const first = weekEntries.find(Boolean), month = first ? Number(first.day.date.slice(5, 7)) : previousMonth;
      const label = el('span', month !== previousMonth && first ? new Date(first.day.date + 'T12:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) : '', 'activity-month');
      grid.append(label); previousMonth = month;
      for (const entry of weekEntries) {
        if (!entry) { grid.append(el('span')); continue; }
        const button = el('button', undefined, 'activity-day'); button.type = 'button'; button.dataset.date = entry.day.date;
        const n = entry.value;
        button.dataset.level = n === null ? 'unknown' : n === 0 ? '0' : String(1 + thresholds.filter(t => n >= t).length);
        if (entry.partial) button.style.borderStyle = 'dashed';
        button.disabled = !!entry.future; button.setAttribute('aria-label', description(entry, cat));
        button.setAttribute('aria-pressed', String(selectedDate === entry.day.date));
        button.addEventListener('mouseenter', () => showTooltip(button, entry, cat));
        button.addEventListener('focus', () => showTooltip(button, entry, cat));
        button.addEventListener('mouseleave', () => { tooltip.hidden = true; });
        button.addEventListener('blur', () => { tooltip.hidden = true; });
        button.addEventListener('click', () => { tooltip.hidden = true; openDay(entry.day.date, true); });
        // Arrow navigation follows the contribution grid's week/day geometry.
        button.addEventListener('keydown', event => {
          const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
          if (!step) return; event.preventDefault();
          const date = new Date(Date.parse(entry.day.date + 'T12:00:00Z') + step * 864e5).toISOString().slice(0, 10);
          const target = grid.querySelector(`[data-date="${date}"]`); if (target && !target.disabled) target.focus();
        });
        grid.append(button);
      }
    }
  }
  async function get(params) {
    const response = await fetch(`${API}/api/activity?${new URLSearchParams(params)}`);
    if (!response.ok) throw new Error('Activity unavailable');
    return response.json();
  }
  async function openDay(date, scroll = false) {
    selectedDate = date;
    const token = ++detailSequence, panel = $('activityDetail'); panel.hidden = false;
    for (const button of $('activityGrid').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.date === date));
    const heading = el('h2', `CYBERCAB DAILY — ${readable(date)}`);
    const day = data.days.find(d => d.date === date);
    panel.replaceChildren(heading, stats(day, ['registry', 'dmv', 'cybercab', 'model_y', 'sightings', 'cameras']));
    const note = el('p', 'Retrieving daily highlights…', 'activity-muted'); panel.append(note);
    if (scroll) panel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    try {
      const response = await get({ date }); if (token !== detailSequence) return;
      // Use the exact same aggregate as the year response; a new record may have arrived.
      const index = data.days.findIndex(d => d.date === date); data.days[index] = response.day;
      panel.replaceChildren(heading, stats(response.day, ['registry', 'dmv', 'cybercab', 'model_y', 'sightings', 'cameras']));
      const notes = el('p', keys.map(k => response.day[k] === null ? `${labels[k]}: ${response.errors[k] || 'Historical coverage unavailable or today’s DMV poll is pending.'}` : response.day[k] === 0 ? `${labels[k]}: no qualifying activity recorded.` : '').filter(Boolean).join(' '), 'activity-muted'); panel.append(notes);
      panel.append(el('p', 'DMV figures are first-observed roster additions; official registration dates are not published. Registry additions use the date added, not first seen.', 'activity-muted'));
      const list = el('ul');
      for (const v of response.details.vehicles || []) {
        const li = el('li', 'Newly documented vehicle: '), link = el('a', v.license_plate || 'View vehicle'); link.href = '/vehicle/' + encodeURIComponent(v.id); li.append(link); list.append(li);
      }
      for (const sighting of response.details.sightings || []) {
        const at = new Date(sighting.observed_at.replace(' ', 'T') + 'Z').toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
        const li = el('li', `Approved sighting at ${at} CT: `), link = el('a', 'View recorded photo'); link.href = `${API}/api/sightings/${encodeURIComponent(sighting.public_id)}/photo`; li.append(link); list.append(li);
      }
      if (response.details.cameras?.length) {
        list.append(el('li', `Most active camera: ${response.details.cameras[0].camera_name} (${number(response.details.cameras[0].count)} detections). ${response.details.cameras.length} unique cameras detected Cybercabs.`));
      }
      const previous = data.days[index - 1];
      if (previous) {
        const comparisons = keys.filter(k => previous[k] !== null && response.day[k] !== null).map(k => { const change = response.day[k] - previous[k]; return `${labels[k]} ${change >= 0 ? '+' : ''}${number(change)}`; });
        if (comparisons.length) list.append(el('li', `Compared with previous day: ${comparisons.join(' · ')}`));
      }
      if (Object.values(response.details).some(v => v === null)) panel.append(el('p', 'Some daily highlights could not be retrieved.', 'activity-muted'));
      panel.append(list); renderCalendar();
    } catch { if (token === detailSequence) note.textContent = 'Daily highlights are temporarily unavailable. Select this day again to retry.'; }
  }
  async function load() {
    const token = ++sequence;
    fetched = Date.now();
    lastDay = today();
    if (card) {
      $('dailyDate').textContent = readable(lastDay);
      if (!data || data.today !== lastDay) $('dailyStats').replaceChildren(stats(null));
    }
    try {
      const response = await get({ year: card ? lastDay.slice(0, 4) : selectedYear });
      if (token !== sequence) return; data = response; fetched = Date.now();
      if (card) {
        const day = data.days.find(d => d.date === lastDay); $('dailyStats').replaceChildren(stats(day));
      } else {
        const years = data.years.includes(selectedYear) ? data.years : [...data.years, selectedYear].sort((a, b) => b - a);
        $('activityYear').replaceChildren(...years.map(y => { const o = el('option', String(y)); o.value = y; return o; })); $('activityYear').value = selectedYear;
        renderCalendar(); if (selectedDate?.startsWith(String(selectedYear))) openDay(selectedDate);
      }
    } catch {
      if (token !== sequence) return;
      if (card) { $('dailyStats').replaceChildren(stats(null), el('p', 'Activity could not be retrieved. Automatic refresh will retry.', 'activity-muted')); }
      else { data = null; $('activityGrid').replaceChildren(); $('activitySummary').replaceChildren(); $('activityDetail').hidden = true; $('activityStatus').textContent = 'Activity could not be retrieved. Retry or wait for the automatic refresh.'; }
      const retry = el('button', 'Retry', 'activity-retry'); retry.type = 'button'; retry.addEventListener('click', () => { retry.remove(); load(); });
      (card ? $('dailyStats') : $('activitySummary')).append(retry);
    }
  }
  if (calendar) {
    tooltip = el('div', undefined, 'activity-tooltip'); tooltip.hidden = true; tooltip.setAttribute('role', 'tooltip'); document.body.append(tooltip);
    const initialYear = el('option', String(selectedYear)); initialYear.value = selectedYear; $('activityYear').append(initialYear);
    $('activityCategory').addEventListener('change', () => { if (data) renderCalendar(); });
    const changeYear = year => { selectedYear = Number(year); data = null; selectedDate = null; ++detailSequence; $('activityDetail').hidden = true; $('activityGrid').replaceChildren(); $('activitySummary').replaceChildren(); $('activityStatus').textContent = 'Retrieving daily activity…'; load(); };
    $('activityYear').addEventListener('change', event => changeYear(event.target.value));
    $('activityCurrent').addEventListener('click', () => changeYear(today().slice(0, 4)));
    window.addEventListener('scroll', () => { tooltip.hidden = true; }, true);
  }
  function refresh() {
    if (document.hidden) return;
    const current = today();
    if (current !== lastDay || Date.now() - fetched >= 300000) {
      if (calendar && current !== lastDay && selectedYear === Number(lastDay.slice(0, 4))) {
        selectedYear = Number(current.slice(0, 4));
        if (selectedDate && !selectedDate.startsWith(String(selectedYear))) { selectedDate = null; ++detailSequence; $('activityDetail').hidden = true; }
      }
      load();
    }
  }
  setInterval(refresh, 1000); document.addEventListener('visibilitychange', refresh); load();
})();
