(() => {
  const form = document.getElementById('history-filters');
  const charts = document.getElementById('history-charts');
  const status = document.getElementById('history-status');
  const milestones = document.getElementById('history-milestones');
  const note = document.getElementById('history-note');
  const cache = new Map();
  const rangeDays = { '30d': 30, '90d': 90, '1y': 365 };
  const definitions = [
    ['Registry fleet size', 'Currently public registry vehicles, counted from their recorded approval.', 1],
    ['Cumulative sightings', 'Dated approved image sightings. Camera detections are shown separately.', 2],
    ['Sightings per day', 'Approved image sightings, grouped by approval date.', 3, true],
    ['Camera detections per day', 'Recorded traffic-camera captures, grouped by capture date.', 4, true],
    ['Texas DMV Cybercabs', 'Statewide Cybercab roster as reported by TxDMV. Missing polls are gaps.', 5]
  ];
  const timeFormat = Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' });
  const number = Intl.NumberFormat('en-US');
  const element = (tag, value, parent) => {
    const node = document.createElement(tag);
    node.textContent = value;
    parent?.append(node);
    return node;
  };
  let observers = [], request = 0;

  function draw(canvas, rows, column, bars, markers) {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const colors = getComputedStyle(document.documentElement);
    // The site's colour tokens (style.css) are RGB triplets ("250 224 48").
    const read = token => { const v = colors.getPropertyValue(token).trim(); return /^\d/.test(v) ? `rgb(${v})` : v; };
    const top = 10, bottom = height - 18, left = 35, right = width - 8;
    const peak = Math.max(1, ...rows.map(row => row[column] ?? 0));
    const x = i => rows.length === 1 ? (left + right) / 2 : left + (right - left) * i / (rows.length - 1);
    const y = value => bottom - value / peak * (bottom - top);
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = read('--n-400');
    ctx.strokeStyle = read('--line');
    for (const value of new Set([0, Math.round(peak / 2), peak])) {
      ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
      ctx.fillText(number.format(value), 0, y(value) + 3);
    }
    ctx.fillText(rows[0][0].slice(5), left, height - 3);
    if (rows.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(rows.at(-1)[0].slice(5), right, height - 3);
      ctx.textAlign = 'left';
    }
    ctx.strokeStyle = read('--n-400');
    ctx.setLineDash([2, 3]);
    rows.forEach((row, index) => {
      if (!markers.some(marker => marker.day === row[0])) return;
      ctx.beginPath(); ctx.moveTo(x(index), top); ctx.lineTo(x(index), bottom); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle = read('--gold');
    ctx.lineWidth = 1.6;
    const size = Math.max(1, Math.min(10, (right - left) / rows.length * .78));
    let prior = null;
    rows.forEach((row, index) => {
      const value = row[column];
      if (value === null) { prior = null; return; }
      const point = [x(index), y(value)];
      if (bars) ctx.fillRect(point[0] - size / 2, point[1], size, bottom - point[1]);
      else {
        if (prior) {
          ctx.beginPath(); ctx.moveTo(...prior); ctx.lineTo(...point); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(...point, 2, 0, 2 * Math.PI); ctx.fill();
        }
        prior = point;
      }
    });
  }

  function addChart([heading, source, column, bars], rows, stamp, markers, starts) {
    const card = element('section', '', charts);
    card.className = 'chart';
    element('h2', heading, card);
    element('p', `${source} Updated ${stamp} CT.`, card).className = 'caption';
    const start = starts[[0, 0, 1, 1, 2, 3][column]];
    if (!rows.some(row => row[column] !== null)) {
      element('p', start ? `No records in this range. History starts ${start}.` : 'No dated records for this city.', card).className = 'caption';
      return;
    }
    if (start) element('p', 'History starts ' + start, card).className = 'caption';
    const canvas = element('canvas', '', card);
    canvas.setAttribute('aria-hidden', 'true');
    const redraw = () => draw(canvas, rows, column, bars, markers);
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    observers.push({ observer, redraw });
    const details = element('details', '', card);
    element('summary', 'Daily values', details);
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('table')) return;
      const table = element('table', '', element('div', '', details));
      const header = element('tr', '', element('thead', '', table));
      element('th', 'Date', header).scope = 'col';
      element('th', 'Count', header).scope = 'col';
      const body = element('tbody', '', table);
      for (const row of rows) {
        const line = element('tr', '', body);
        element('td', row[0], line);
        element('td', row[column] === null ? 'No record' : number.format(row[column]), line);
      }
    });
  }

  function render(data, range) {
    observers.forEach(({ observer }) => observer.disconnect());
    observers = [];
    charts.replaceChildren();
    milestones.replaceChildren();
    const rows = range === 'all' ? data.rows : data.rows.slice(-rangeDays[range]);
    const cutoff = new Date(Date.parse(data.through + 'T00:00:00Z') - (rangeDays[range] - 1) * 86400000);
    const markers = data.milestones.filter(mark => range === 'all' || mark.day >= cutoff.toISOString().slice(0, 10));
    markers.forEach(mark => element('li', mark.day + ' · ' + mark.label, milestones));
    milestones.hidden = markers.length === 0;
    const stamp = timeFormat.format(new Date(data.updated_at));
    definitions.filter(def => def[2] !== 5 || data.city === 'all').forEach(def => addChart(def, rows, stamp, markers, data.starts));
    note.textContent = data.city === 'all'
      ? 'All cities includes records without a city assignment. The Texas DMV roster is statewide. The homepage lifetime counter also counts certain camera detections.'
      : 'Texas DMV registrations are statewide and are available in All cities.';
  }

  async function update({ save = false } = {}) {
    const current = ++request;
    const { city, range } = Object.fromEntries(new FormData(form));
    if (save) try { localStorage.setItem('cch.preferredCity', city); } catch {}
    const url = new URL(location.href);
    url.searchParams.set('city', city);
    url.searchParams.set('range', range);
    history.replaceState(null, '', url);
    status.textContent = 'Loading Fleet History…';
    try {
      let data = cache.get(city);
      if (!data) {
        const response = await fetch('/api/fleet-history?city=' + encodeURIComponent(city));
        if (!response.ok) throw Error('History unavailable');
        data = await response.json();
        cache.set(city, data);
      }
      if (current !== request) return;
      render(data, range);
      status.textContent = '';
    } catch {
      if (current !== request) return;
      charts.replaceChildren();
      milestones.hidden = true;
      note.textContent = '';
      status.textContent = 'Fleet History is unavailable. Try again in a moment.';
    }
  }

  async function init() {
    let cities;
    try {
      const response = await fetch('/api/service-areas');
      if (!response.ok) throw Error('City list unavailable');
      cities = (await response.json()).areas;
    } catch {
      cities = [{ key: 'austin', name: 'Austin' }, { key: 'dallas', name: 'Dallas' }];
    }
    for (const city of cities) form.elements.city.add(new Option(city.name, city.key));
    const query = new URLSearchParams(location.search);
    let saved;
    try { saved = localStorage.getItem('cch.preferredCity'); } catch {}
    for (const select of form.querySelectorAll('select')) {
      const value = query.get(select.name) || (select.name === 'city' ? saved : null);
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
    form.addEventListener('change', event => update({ save: event.target.name === 'city' }));
    form.addEventListener('submit', event => event.preventDefault());
    document.addEventListener('cch:theme', () => observers.forEach(({ redraw }) => redraw()));
    update();
  }
  init();
})();
