(() => {
  const form = document.getElementById('filters');
  const charts = document.getElementById('charts');
  const status = document.getElementById('status');
  const cities = new Map([['all', 'All cities']]);
  const cache = new Map();
  const money = Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateLabel = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' });
  const display = value => value === null ? 'Insufficient data' : money.format(value);
  const element = (tag, text, parent) => {
    const node = document.createElement(tag);
    node.textContent = text;
    parent?.append(node);
    return node;
  };
  let request = 0;
  let observers = [];

  function section(title, n, timestamp) {
    const node = element('section', '', charts);
    node.className = 'chart';
    element('h2', title, node);
    element('p', `n = ${n} · Approved receipts and completed-ride reports · Updated ${timestamp} CT`, node).className = 'caption';
    return node;
  }

  function table(parent, headings, rows) {
    const grid = element('table', '', parent);
    const headers = element('tr', '', element('thead', '', grid));
    headings.forEach(label => { element('th', label, headers).scope = 'col'; });
    const body = element('tbody', '', grid);
    for (const cells of rows) {
      const row = element('tr', '', body);
      cells.forEach(label => element('td', label, row));
    }
    return grid;
  }

  function plot(canvas, series, dates) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    const top = 13, bottom = height - 16, left = 33, right = width - 10;
    const max = Math.max(1, ...series.flatMap(s => s.points.map(point => point.median || 0)));
    const y = value => bottom - value * (bottom - top) / max;
    ctx.font = '10px Inter, sans-serif';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#a7afbd';
    for (const value of [0, max / 2, max]) {
      ctx.strokeStyle = '#2b303a';
      ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
      ctx.fillText('$' + value.toFixed(value < 10 ? 1 : 0), 0, y(value) + 3);
    }
    const short = date => date?.slice(5);
    if (dates.length) {
      ctx.fillText(short(dates[0]), left, height - 2);
      if (dates.length > 1) {
        ctx.textAlign = 'right';
        ctx.fillText(short(dates.at(-1)), right, height - 2);
        ctx.textAlign = 'left';
      }
    }
    for (const { points, color } of series) {
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineWidth = 2;
      let previous = null;
      points.forEach((point, index) => {
        if (point.median === null) { previous = null; return; }
        const x = points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
        const current = y(point.median);
        if (previous) {
          ctx.beginPath(); ctx.moveTo(...previous); ctx.lineTo(x, current); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(x, current, 2.5, 0, 2 * Math.PI); ctx.fill();
        previous = [x, current];
      });
    }
  }

  function trend(parent, series, dates) {
    if (!series.some(s => s.points.some(p => p.median !== null))) {
      element('p', 'Insufficient data', parent).className = 'empty';
    } else {
      const canvas = element('canvas', '', parent);
      canvas.setAttribute('aria-hidden', 'true');
      const observer = new ResizeObserver(() => plot(canvas, series, dates));
      observer.observe(canvas);
      observers.push(observer);
      element('p', series.map(s => s.label).join(' · '), parent).className = 'caption';
    }
    if (!dates.length) return;
    const details = element('details', '', parent);
    element('summary', 'Weekly values and sample sizes', details);
    table(element('div', '', details), ['Week of', 'Series', 'n', 'Median', '25th', '75th'], dates.flatMap((date, index) => series.map(s => {
      const p = s.points[index];
      return [date, s.label, p.n, display(p.median), p.p25 === null ? '—' : money.format(p.p25), p.p75 === null ? '—' : money.format(p.p75)];
    })));
  }

  function render(data, range, type) {
    observers.forEach(observer => observer.disconnect());
    observers = [];
    charts.replaceChildren();
    const filters = data.ranges[range];
    const selected = filters[type];
    const stamp = dateLabel.format(new Date(data.updated_at));
    const city = cities.get(data.city);
    const dates = selected.weeks.map(w => w.week);
    trend(section(`${city} · Median fare`, selected.fare.n, stamp),
      [{ label: 'Fare', color: '#fae030', points: selected.weeks.map(w => w.fare) }], dates);
    trend(section(`${city} · Median per mile`, selected.per_mile.n, stamp),
      [{ label: 'Fare per mile', color: '#fae030', points: selected.weeks.map(w => w.per_mile) }], dates);

    const comparisonTypes = type === 'all' ? ['cybercab', 'model_y'] : [type];
    const comparisonDates = [...new Set(comparisonTypes.flatMap(key => filters[key].weeks.map(w => w.week)))].sort();
    const comparison = comparisonTypes.map(key => {
      const byWeek = new Map(filters[key].weeks.map(w => [w.week, w.fare]));
      return { label: key === 'cybercab' ? 'Cybercab' : 'Model Y', color: key === 'cybercab' ? '#fae030' : '#a7afbd',
        points: comparisonDates.map(week => byWeek.get(week) || { n: 0, median: null, p25: null, p75: null }) };
    });
    const vehicles = section(`${city} · Fare by vehicle`, comparisonTypes.reduce((n, key) => n + filters[key].fare.n, 0), stamp);
    trend(vehicles, comparison, comparisonDates);
    comparison.filter(s => s.points.every(p => p.median === null)).forEach(s =>
      element('p', `${s.label}: Insufficient data`, vehicles).className = 'caption');

    const heat = section(`${city} · Fare by local time`, selected.times.reduce((n, cell) => n + cell.n, 0), stamp);
    if (selected.times.every(cell => cell.median === null)) element('p', 'Insufficient data', heat).className = 'empty';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const grid = table(heat, ['Day', '12–6 AM', '6 AM–noon', 'Noon–6 PM', '6 PM–midnight'], days.map((label, index) =>
      [label, ...selected.times.slice(index * 4, index * 4 + 4).map(cell => cell.median === null ? '—' : money.format(cell.median))]));
    grid.className = 'heat';
    grid.querySelectorAll('tbody tr').forEach((row, day) => [...row.cells].slice(1).forEach((cell, slot) => {
      const item = selected.times[day * 4 + slot];
      cell.title = `n = ${item.n} · ${display(item.median)}`;
      cell.setAttribute('aria-label', cell.title);
      if (item.median !== null) cell.style.setProperty('--heat', Math.min(23, 4 + item.median / 2) + '%');
    }));
  }

  async function update() {
    const sequence = ++request;
    const options = new FormData(form);
    const city = options.get('city'), range = options.get('range'), vehicle = options.get('vehicle');
    const url = new URL(location.href);
    for (const [key, value] of options) url.searchParams.set(key, value);
    history.replaceState(null, '', url);
    status.textContent = 'Loading fare history…';
    try {
      let data = cache.get(city);
      if (!data) {
        const response = await fetch('/api/fare-history?city=' + encodeURIComponent(city));
        if (!response.ok) throw Error('Fare history unavailable');
        data = await response.json();
        cache.set(city, data);
      }
      if (sequence !== request) return;
      render(data, range, vehicle);
      status.textContent = '';
    } catch {
      if (sequence !== request) return;
      charts.replaceChildren();
      status.textContent = 'Fare history is unavailable. Try again in a moment.';
    }
  }

  async function init() {
    try {
      const response = await fetch('/api/service-areas');
      if (!response.ok) throw Error('Service areas unavailable');
      for (const area of (await response.json()).areas) cities.set(area.key, area.name);
    } catch {
      cities.set('austin', 'Austin');
      cities.set('dallas', 'Dallas');
    }
    for (const [key, label] of cities) if (key !== 'all') form.elements.city.add(new Option(label, key));
    const query = new URLSearchParams(location.search);
    for (const select of form.querySelectorAll('select')) {
      const value = query.get(select.name);
      if ([...select.options].some(option => option.value === value)) select.value = value;
    }
    form.addEventListener('change', update);
    form.addEventListener('submit', event => event.preventDefault());
    update();
  }
  init();
})();
