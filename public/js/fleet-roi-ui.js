/* Fleet ROI 2.0 page UI (simulation.html, Fleet ROI tab). The math is
   js/fleet-roi.js (CCC_FLEET_ROI); this file only reads inputs, calls
   simulate(), and draws: the purchase breakdown, the simulator's inputs and
   result cards, the fleet builder, the profit timeline, the scenario table
   and saved configurations (localStorage, this browser only). Every input
   carries its kind (Reported / Estimate / Assumption). Entrances are the
   sitewide AnimatedContent (js/animated-content.js); numbers move with
   CCC.animateCounter, like the rest of the site. No requests. */
(function () {
  'use strict';
  const R = window.CCC_FLEET_ROI;
  const root = document.getElementById('roi2Inputs');
  if (!R || !root) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduce = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---- formatting ----
  const money = (n, dp = 0) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const compact = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: Math.abs(n) >= 1e6 ? 2 : 1 });
  const big = n => (Math.abs(n) >= 1e7 ? compact(n) : money(n));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Month m after delivery (month 1 = December 2026, the reported estimate).
  const monthName = m => { const [y, mo] = R.startMonthLabel(Math.max(0, m - 1)).split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
  const paybackText = (r, short) => r.input.mode !== 'fleet' ? 'n/a' : r.paybackMonth === null ? (short ? 'Not in 10 yrs' : 'Not within 10 years') : `${r.paybackMonth} mo`;

  // ---- the inputs, grouped (labels and display ranges; the model clamps the rest) ----
  const KIND = { reported: 'Reported', estimate: 'Estimate', assumption: 'Assumption' };
  const GROUPS = [
    { title: 'Purchase', rows: [
      { k: 'price', label: 'Price per Cybercab', pre: '$', ui: [15000, 60000], hint: 'Reported price, before taxes' },
      { k: 'deposit', label: 'Order deposit', pre: '$', ui: [0, 5000], hint: 'Nonrefundable; part of the price, not extra' },
      { k: 'salesTaxPct', label: 'Sales tax', post: '%', ui: [0, 12], hint: 'Texas motor vehicle sales tax is 6.25%' },
      { k: 'feesPerVehicle', label: 'Title, registration & fees', pre: '$', ui: [0, 2000] },
      { k: 'purchase', label: 'Pay', seg: [['cash', 'Cash'], ['finance', 'Finance']] },
      { k: 'downPaymentPct', label: 'Down payment', post: '%', ui: [0, 100], when: x => x.purchase === 'finance' },
      { k: 'aprPct', label: 'Interest rate (APR)', post: '%', ui: [0, 15], when: x => x.purchase === 'finance' },
      { k: 'loanMonths', label: 'Loan term', post: 'mo', ui: [12, 96], when: x => x.purchase === 'finance' },
    ] },
    { title: 'Ownership costs (per vehicle, monthly)', rows: [
      { k: 'subscriptionMonthly', label: 'Autonomy Subscription', pre: '$', ui: [0, 600], hint: 'Required; first month included' },
      { k: 'subscriptionIncludedMonths', label: 'Subscription months included', post: 'mo', ui: [0, 12] },
      { k: 'insuranceMonthly', label: 'Insurance', pre: '$', ui: [0, 1500], hint: 'Commercial cover would likely cost more' },
      { k: 'maintenanceMonthly', label: 'Maintenance subscription', pre: '$', ui: [0, 400], hint: 'Required; Tesla hasn\'t shown the price' },
      { k: 'electricityRate', label: 'Electricity', pre: '$', post: '/kWh', ui: [0, 0.5], dp: 2 },
      { k: 'kwhPerMile', label: 'Efficiency', post: 'kWh/mi', ui: [0.1, 0.5], dp: 2 },
      { k: 'personalMilesMonthly', label: 'Miles driven per month', post: 'mi', ui: [0, 4000], when: x => x.mode === 'personal' },
    ] },
    { title: 'Commercial operation (hypothetical)', fleet: true, rows: [
      { k: 'activationDelayMonths', label: 'Commercial start', post: 'mo after delivery', ui: [0, 36], dateOf: true },
      { k: 'farePerRide', label: 'Average fare per ride', pre: '$', ui: [0, 40], dp: 2 },
      { k: 'ridesPerDay', label: 'Rides per vehicle per day', ui: [0, 40] },
      { k: 'operatingDays', label: 'Operating days per month', ui: [0, 31] },
      { k: 'downtimePct', label: 'Downtime', post: '%', ui: [0, 100], hint: 'Charging, cleaning, repairs, no demand' },
      { k: 'milesPerRide', label: 'Miles per ride', post: 'mi', ui: [0.5, 20], dp: 1 },
      { k: 'deadheadPct', label: 'Empty miles between rides', post: '%', ui: [0, 100] },
      { k: 'platformSharePct', label: 'Platform revenue share', post: '%', ui: [0, 60], hint: 'Tesla has published no split; estimates run 25–30%' },
      { k: 'cleaningMonthly', label: 'Cleaning', pre: '$', ui: [0, 800] },
    ] },
  ];

  let x = R.sanitize(R.defaults());
  let horizon = 60;
  const series = { cumulative: true, revenue: true, opex: true };
  let scenEdits = { conservative: {}, expected: {}, optimistic: {} };
  const last = {};
  const store = (() => { try { return R.makeStore(window.localStorage); } catch (e) { return R.makeStore({ getItem: () => null, setItem: () => { throw new Error('no storage'); } }); } })();
  const toast = (m, k) => { if (window.CCC && CCC.toast) CCC.toast(m, k); };

  // ---- build the input rows ----
  const fieldsBox = $('roi2Fields');
  const fmtVal = (row, v) => (row.dp ? Number(v).toFixed(row.dp) : String(v));
  fieldsBox.innerHTML = GROUPS.map((g, gi) => `
    <fieldset class="roi2-group" data-group="${gi}"${g.fleet ? ' data-fleet' : ''}>
      <h3>${esc(g.title)}</h3>
      ${g.rows.map(row => {
        const f = R.FIELDS[row.k];
        const id = 'roi2-' + row.k;
        const kind = f.kind ? `<span class="roi2-kind roi2-kind-${f.kind}">${KIND[f.kind]}</span>` : '';
        if (row.seg) return `<div class="roi2-row" data-row="${row.k}"><div class="top"><span class="roi2-label" id="${id}-l">${esc(row.label)}</span>
            <div class="roi2-seg roi2-seg-sm" role="radiogroup" aria-labelledby="${id}-l" data-seg="${row.k}">${row.seg.map(([v, t]) => `<button type="button" role="radio" data-v="${v}" aria-checked="false">${t}</button>`).join('')}</div></div></div>`;
        const [lo, hi] = row.ui;
        return `<div class="roi2-row" data-row="${row.k}">
          <div class="top"><label class="roi2-label" for="${id}">${esc(row.label)} ${kind}</label>
            <span class="roi2-num-wrap">${row.pre || ''}<input type="number" class="roi2-num" id="${id}" data-field="${row.k}" min="${f.min}" max="${f.max}" step="${f.step}" inputmode="decimal">${row.post ? `<span>${row.post}</span>` : ''}</span></div>
          <input type="range" data-range="${row.k}" min="${lo}" max="${hi}" step="${f.step}" aria-label="${esc(row.label)}" data-elastic>
          ${row.hint || row.dateOf ? `<div class="hint" id="${id}-h">${esc(row.hint || '')}</div>` : ''}
        </div>`;
      }).join('')}
    </fieldset>`).join('');
  const rowsByKey = {};
  GROUPS.forEach(g => g.rows.forEach(r => { rowsByKey[r.k] = r; }));

  // Fleet builder presets
  $('roi2Presets').innerHTML = R.FLEET_PRESETS.map(n => `<button type="button" data-n="${n}" aria-pressed="false">${n}</button>`).join('');

  function setField(k, v, from) {
    x = R.sanitize(Object.assign({}, x, { [k]: v }));
    render(from);
  }

  // Inputs → state. Typed numbers apply as they're typed (when valid) and are
  // tidied on blur; sliders apply on every move.
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.range) setField(t.dataset.range, Number(t.value), t);
    else if (t.dataset.field) { if (t.value === '' || !Number.isFinite(Number(t.value))) return; setField(t.dataset.field, Number(t.value), t); }
  });
  root.addEventListener('change', e => { if (e.target.dataset.field) render(); });
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v && b.parentElement.dataset.seg) setField(b.parentElement.dataset.seg, b.dataset.v);
    else if (b.dataset.n) setField('vehicles', Number(b.dataset.n));
  });
  $('roi2Mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setField('mode', b.dataset.mode); });
  $('roi2Horizon').addEventListener('click', e => { const b = e.target.closest('[data-months]'); if (!b) return; horizon = Number(b.dataset.months); x.horizonMonths = horizon; render(); });
  $('roi2Series').addEventListener('click', e => { const b = e.target.closest('[data-series]'); if (!b) return; series[b.dataset.series] = !series[b.dataset.series]; render(); });
  $('roi2Reset').addEventListener('click', () => { x = R.sanitize(Object.assign(R.defaults(), { mode: x.mode })); horizon = x.horizonMonths; render(); toast('Inputs reset to the defaults.'); });
  // Arrow keys move within a segmented control (radio group pattern).
  document.querySelectorAll('#roi2Mode, #roi2Horizon, [data-seg]').forEach(g => g.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const bs = [...g.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    const nb = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    nb.focus(); nb.click(); e.preventDefault();
  }));

  // ---- render ----
  function animate(el, key, value, fmt) {
    if (!el) return;
    const from = last[key];
    last[key] = value;
    if (window.CCC && CCC.animateCounter && Number.isFinite(from) && Number.isFinite(value) && !reduce()) CCC.animateCounter(el, from, value, 450, fmt);
    else el.textContent = fmt(value);
  }

  function syncInputs(from) {
    for (const row of Object.values(rowsByKey)) {
      const v = x[row.k];
      const el = row.seg ? null : $('roi2-' + row.k);
      if (row.seg) root.querySelectorAll(`[data-seg="${row.k}"] button`).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v)));
      else {
        // Never rewrite the field being typed in; a slider updates its field.
        if (el !== from && (document.activeElement !== el || !from)) el.value = fmtVal(row, v);
        const rg = root.querySelector(`[data-range="${row.k}"]`);
        if (rg && rg !== from) rg.value = String(v);
      }
      const wrap = root.querySelector(`[data-row="${row.k}"]`);
      const fleetOnly = R.FIELDS[row.k].fleetOnly && x.mode !== 'fleet';
      wrap.classList.toggle('is-off', fleetOnly || (row.when ? !row.when(x) : false));
      if (row.dateOf) { const h = $('roi2-' + row.k + '-h'); if (h) h.textContent = `Hypothetical start: ${monthName(x.activationDelayMonths + 1)} (delivery estimate: December 2026)`; }
    }
    root.querySelectorAll('[data-fleet]').forEach(fs => { fs.hidden = x.mode !== 'fleet'; });
    const v = $('roi2-vehicles'); if (v !== from && document.activeElement !== v) v.value = x.vehicles;
    $('roi2Presets').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.n) === x.vehicles)));
    $('roi2Mode').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === x.mode)));
    $('roi2Horizon').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.months) === horizon)));
    $('roi2Series').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(series[b.dataset.series])); b.hidden = x.mode !== 'fleet' && b.dataset.series === 'revenue'; });
    $('roi2ModeNote').textContent = x.mode === 'fleet'
      ? 'Fleet investment is a hypothetical: Tesla has not published terms for owners to run a Cybercab on its Robotaxi network (eligibility, revenue split, insurance, start date), and local rules and approval apply. Revenue, costs and the start date are your assumptions.'
      : 'Personal ownership: what owning and driving a Cybercab costs, with the required Autonomy Subscription. No revenue: owning one doesn\'t mean you may run it as a commercial Robotaxi.';
  }

  function metricCards(r) {
    const fleet = x.mode === 'fleet', s = r.steady, n = x.vehicles;
    const cards = fleet ? [
      ['upfront', 'Upfront cash', r.purchase.upfront, x.purchase === 'finance' ? `Down payment, tax & fees · ${n} vehicle${n > 1 ? 's' : ''}` : `Price, tax & fees · ${n} vehicle${n > 1 ? 's' : ''}`],
      ['gross', 'Gross revenue / mo', s.gross, `${Math.round(r.perVehicle.ridesMonthly).toLocaleString('en-US')} rides per vehicle`],
      ['opex', 'Operating expenses / mo', s.opex, 'Platform share, charging, subscription, insurance, upkeep'],
      ['op', 'Operating profit / mo', s.operatingProfit, 'Before loan payments', true],
      ['net', 'Net cash flow / mo', s.netWithLoan, x.purchase === 'finance' ? `After ${money(s.loan)} loan payments` : 'Cash purchase: no loan'],
      ['payback', 'Hypothetical break-even', null, r.paybackMonth === null ? 'Cumulative cash never turns positive in 10 years' : `${monthName(r.paybackMonth)}${r.loanBalanceAtPayback > 0 ? ` · ${big(r.loanBalanceAtPayback)} still owed on loans` : ''}`],
    ] : [
      ['upfront', 'Upfront cash', r.purchase.upfront, x.purchase === 'finance' ? 'Down payment, tax & fees' : 'Price, tax & fees'],
      ['pmonth', 'Monthly cost', s.opex + s.loan, x.purchase === 'finance' ? `Incl. ${money(s.loan)} loan payment` : 'Subscription, insurance, upkeep, charging', true],
      ['permile', 'Running cost per mile', x.personalMilesMonthly > 0 ? s.opex / n / x.personalMilesMonthly : 0, 'Excludes the purchase'],
      ['tco', `Cost over ${horizon / 12} yr${horizon > 12 ? 's' : ''}`, r.horizon.ownershipCost, 'Everything paid, incl. the purchase'],
      ['tcom', 'Average per month', r.horizon.ownershipPerMonth, `Over ${horizon} months`],
      ['interest', 'Loan interest', r.purchase.interestTotal * n, x.purchase === 'finance' ? `${x.loanMonths} months at ${x.aprPct}% APR` : 'Cash purchase'],
    ];
    const box = $('roi2Metrics');
    if (box.dataset.mode !== x.mode) {
      box.dataset.mode = x.mode;
      box.innerHTML = cards.map(([k, l, , , hi]) => `<div class="roi2-metric${hi ? ' hi' : ''}"><div class="l">${esc(l)}</div><div class="n" data-m="${k}">—</div><div class="s" data-s="${k}"></div></div>`).join('');
      cards.forEach(([k]) => delete last['m-' + k]);
    }
    for (const [k, l, v, sub] of cards) {
      const el = box.querySelector(`[data-m="${k}"]`);
      box.querySelector(`[data-m="${k}"]`).parentElement.querySelector('.l').textContent = l;
      if (k === 'payback') el.textContent = paybackText(r);
      else animate(el, 'm-' + k, v, k === 'permile' ? (z => money(z, 2)) : big);
      el.classList.toggle('neg', v !== null && v < 0);
      box.querySelector(`[data-s="${k}"]`).textContent = sub;
    }
  }

  function breakdown(r) {
    const n = x.vehicles, p = r.purchase, s = r.steady, fleet = x.mode === 'fleet', multi = n > 1;
    const k = kind => kind ? `<span class="roi2-kind roi2-kind-${kind}">${KIND[kind]}</span>` : '';
    const row = (label, kind, per, total, sub, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}${sub ? `<span class="sub">${sub}</span>` : ''}</td><td class="k">${k(kind)}</td><td class="v">${per}</td>${multi ? `<td class="v">${total === undefined ? '' : total}</td>` : ''}</tr>`;
    const per = v => money(v), tot = v => big(v * n);
    const rows = [];
    if (multi) rows.push(`<tr><td></td><td></td><td class="v roi2-sub">Per vehicle</td><td class="v roi2-sub">${n} vehicles</td></tr>`);
    rows.push(row('Vehicle price', 'reported', per(p.price), tot(p.price), 'Before taxes'));
    rows.push(row('Order deposit', 'reported', per(p.deposit), tot(p.deposit), 'Paid when ordering; part of the price'));
    rows.push(row('Sales tax', 'estimate', per(p.tax), tot(p.tax), `${x.salesTaxPct}% of the price`));
    rows.push(row('Title, registration & fees', 'assumption', per(p.fees), tot(p.fees)));
    if (x.purchase === 'finance') {
      rows.push(row('Down payment', 'assumption', per(p.down), tot(p.down), `${x.downPaymentPct}%, including the deposit`));
      rows.push(row('Financed', 'assumption', per(p.principal), tot(p.principal), `${x.loanMonths} months at ${x.aprPct}% APR`));
      rows.push(row('Loan payment / mo', 'assumption', money(p.payment, 2), tot(p.payment), `${money(p.interestTotal)} interest in all`));
    } else rows.push(row('Financing', null, 'Cash', multi ? 'Cash' : undefined));
    rows.push(row('Upfront cash', null, per(p.upfrontPerVehicle), tot(p.upfrontPerVehicle), 'At order and delivery', 'total'));
    rows.push(row('Autonomy Subscription / mo', 'reported', per(x.subscriptionMonthly), tot(x.subscriptionMonthly), `First ${x.subscriptionIncludedMonths === 1 ? 'month' : x.subscriptionIncludedMonths + ' months'} included`));
    rows.push(row('Insurance / mo', 'assumption', per(x.insuranceMonthly), tot(x.insuranceMonthly)));
    rows.push(row('Maintenance subscription / mo', 'assumption', per(x.maintenanceMonthly), tot(x.maintenanceMonthly), 'Required; price not shown by Tesla'));
    rows.push(row('Charging / mo', 'assumption', per(r.perVehicle.chargingMonthly), tot(r.perVehicle.chargingMonthly), `${Math.round(r.perVehicle.milesMonthly).toLocaleString('en-US')} mi at ${money(x.electricityRate, 2)}/kWh`));
    if (fleet) {
      rows.push(row('Cleaning / mo', 'assumption', per(x.cleaningMonthly), tot(x.cleaningMonthly)));
      rows.push(row('Platform share / mo', 'assumption', per(r.perVehicle.platformFeeMonthly), tot(r.perVehicle.platformFeeMonthly), `${x.platformSharePct}% of fares`));
      rows.push(row('Operating expenses / mo', null, per(s.opex / n), tot(s.opex / n), 'Once operating', 'total'));
      rows.push(row('Gross revenue / mo', 'assumption', per(s.gross / n), tot(s.gross / n), 'Hypothetical'));
      rows.push(row('Net operating cash flow / mo', null, per(s.netWithLoan / n), tot(s.netWithLoan / n), x.purchase === 'finance' ? 'After loan payments' : 'Cash purchase', 'total'));
      rows.push(row('Hypothetical break-even', null, paybackText(r, true), multi ? paybackText(r, true) : undefined));
    }
    rows.push(row(`Total cost of ownership, ${horizon / 12} yr${horizon > 12 ? 's' : ''}`, null, per(r.horizon.ownershipCost / n), tot(r.horizon.ownershipCost / n), fleet ? 'Costs only, before any revenue' : 'Purchase and every running cost', 'total'));
    $('roi2Breakdown').innerHTML = rows.join('');
    $('roi2BreakdownSub').textContent = `${multi ? `Per vehicle and for ${n} vehicles` : 'Per vehicle'}, from your inputs below · ${x.mode === 'fleet' ? 'Fleet investment' : 'Personal ownership'}`;
  }

  // ---- profit timeline (SVG; cumulative on the left axis, monthly on the right) ----
  function chart(r) {
    const svg = $('roi2Chart');
    const W = 640, H = 260, L = 58, Rm = 54, T = 14, B = 26;
    const pw = W - L - Rm, ph = H - T - B;
    const ms = [{ m: 0, cumulative: -r.purchase.upfront, gross: 0, opex: 0 }].concat(r.months.slice(0, horizon));
    const xs = m => L + (m / horizon) * pw;
    let lo = Math.min(0, ...ms.map(d => d.cumulative)), hi = Math.max(0, ...ms.map(d => d.cumulative));
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const ys = v => T + (1 - (v - lo) / (hi - lo)) * ph;
    const fleet = x.mode === 'fleet';
    const mMax = Math.max(1, ...ms.map(d => Math.max(fleet ? d.gross : 0, d.opex)));
    const ym = v => T + (1 - v / (mMax * 1.08)) * ph;
    const path = (f, ysF) => ms.map((d, i) => `${i ? 'L' : 'M'}${xs(d.m).toFixed(1)} ${ysF(f(d)).toFixed(1)}`).join(' ');
    const zeroY = ys(0);
    const pb = fleet && r.paybackMonth !== null && r.paybackMonth <= horizon ? r.paybackMonth : null;
    const ticks = [0, Math.round(horizon / 4), Math.round(horizon / 2), Math.round(horizon * 3 / 4), horizon];
    const ensure = (cls, tag = 'path') => { let el = svg.querySelector('.' + cls.split(' ').join('.')); if (!el) { el = document.createElementNS('http://www.w3.org/2000/svg', tag); el.setAttribute('class', cls); svg.appendChild(el); } return el; };
    const setD = (el, d) => { if ('d' in el.style && !reduce()) { el.style.d = `path("${d}")`; } el.setAttribute('d', d); };
    // static parts (axes, labels) redrawn; the three lines persist so they can morph
    let axes = svg.querySelector('g.axes'); if (!axes) { axes = document.createElementNS('http://www.w3.org/2000/svg', 'g'); axes.setAttribute('class', 'axes'); svg.insertBefore(axes, svg.firstChild.nextSibling); }
    axes.innerHTML = `
      <line x1="${L}" x2="${W - Rm}" y1="${zeroY}" y2="${zeroY}" style="stroke:rgb(var(--n-700))" stroke-dasharray="4 4"></line>
      ${pb ? `<polygon points="${xs(0)},${ys(ms[0].cumulative)} ${xs(pb)},${zeroY} ${xs(0)},${zeroY}" fill="rgb(248 113 113 / .10)"></polygon>` : ''}
      <text x="${L - 6}" y="${ys(hi) + 4}" text-anchor="end">${compact(hi)}</text>
      <text x="${L - 6}" y="${zeroY + 4}" text-anchor="end">$0</text>
      <text x="${L - 6}" y="${ys(lo) + 4}" text-anchor="end">${compact(lo)}</text>
      ${(series.revenue && fleet) || series.opex ? `<text x="${W - Rm + 6}" y="${ym(mMax) + 4}">${compact(mMax)}/mo</text>` : ''}
      ${ticks.map(m => `<text x="${xs(m)}" y="${H - 8}" text-anchor="${m === 0 ? 'start' : m === horizon ? 'end' : 'middle'}">${m === 0 ? 'Delivery' : (m % 12 === 0 ? `${m / 12}y` : `${m}mo`)}</text>`).join('')}
      ${fleet && x.activationDelayMonths > 0 && x.activationDelayMonths < horizon ? `<line x1="${xs(x.activationDelayMonths)}" x2="${xs(x.activationDelayMonths)}" y1="${T}" y2="${T + ph}" style="stroke:rgb(var(--n-600))" stroke-dasharray="2 4"></line><text x="${xs(x.activationDelayMonths) + 4}" y="${T + 10}">Commercial start</text>` : ''}
      ${pb ? `<line x1="${xs(pb)}" x2="${xs(pb)}" y1="${T}" y2="${T + ph}" style="stroke:rgb(var(--gold) / .7)" stroke-dasharray="4 3"></line>
             <circle cx="${xs(pb)}" cy="${zeroY}" r="5" fill="rgb(var(--gold))" style="stroke:rgb(var(--bg))" stroke-width="2"></circle>
             <text x="${Math.min(xs(pb) + 6, W - Rm - 4)}" y="${zeroY - 9}" text-anchor="${xs(pb) > W - Rm - 120 ? 'end' : 'start'}" style="fill:rgb(var(--gold-ink));font-weight:700">Break-even · ${monthName(pb)} (hypothetical)</text>` : ''}`;
    const rev = ensure('ln rev'), opex = ensure('ln opex'), cum = ensure('ln cum');
    rev.setAttribute('style', 'stroke:rgb(52 211 153)'); rev.setAttribute('stroke-width', '1.6');
    opex.setAttribute('style', 'stroke:rgb(248 113 113)'); opex.setAttribute('stroke-width', '1.6');
    cum.setAttribute('style', 'stroke:rgb(var(--gold))'); cum.setAttribute('stroke-width', '2.6');
    setD(rev, path(d => d.gross, ym)); setD(opex, path(d => d.opex + (d.loan || 0), ym)); setD(cum, path(d => d.cumulative, ys));
    rev.style.opacity = series.revenue && fleet ? 1 : 0; opex.style.opacity = series.opex ? 1 : 0; cum.style.opacity = series.cumulative ? 1 : 0;
    svg.appendChild(rev); svg.appendChild(opex); svg.appendChild(cum);
    const end = ms[ms.length - 1].cumulative;
    $('roi2ChartDesc').textContent = `Cumulative cash over ${horizon} months: starts at ${money(ms[0].cumulative)}, ends at ${money(end)}. ${pb ? `Hypothetical break-even in month ${pb}.` : fleet ? 'No break-even within this period.' : ''}`;
    $('roi2ChartSub').textContent = fleet ? `Cumulative cash from delivery · ends at ${big(end)} after ${horizon / 12} yr${horizon > 12 ? 's' : ''}` : `What owning costs, cumulative · ${big(-end)} after ${horizon / 12} yr${horizon > 12 ? 's' : ''}`;
    $('roi2ChartNote').textContent = fleet
      ? `Monthly lines use the right-hand scale; expenses include loan payments. Nothing earns before the commercial start (${monthName(x.activationDelayMonths + 1)}), and ${x.downtimePct}% downtime is applied every operating month. Hypothetical, not a forecast.`
      : 'Monthly expenses (right-hand scale) include loan payments. Personal ownership earns no revenue.';
    chart.data = { ms, xs, L, pw, W, fleet };
  }

  // Hover / touch: the month under the pointer.
  (function tip() {
    const svg = $('roi2Chart'), tipEl = $('roi2Tip');
    const show = e => {
      const d = chart.data; if (!d) return;
      const box = svg.getBoundingClientRect();
      const vx = (e.clientX - box.left) / box.width * d.W;
      const m = Math.max(0, Math.min(horizon, Math.round((vx - d.L) / d.pw * horizon)));
      const pt = d.ms[m];
      tipEl.innerHTML = `<b>${m === 0 ? 'At delivery' : `Month ${m} · ${monthName(m)}`}</b><br>Cumulative ${money(pt.cumulative)}${m && d.fleet ? `<br>Revenue ${money(pt.gross)}` : ''}${m ? `<br>Expenses ${money(pt.opex + (pt.loan || 0))}` : ''}`;
      tipEl.classList.remove('hidden');
      const px = (d.xs(m) / d.W) * box.width;
      tipEl.style.left = Math.max(0, Math.min(box.width - tipEl.offsetWidth, px + 10)) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => tipEl.classList.add('hidden'));
  })();

  // ---- scenarios ----
  const SROWS = [
    { k: 'farePerRide', label: 'Fare per ride', pre: '$', step: 0.5 },
    { k: 'ridesPerDay', label: 'Rides / vehicle / day', step: 1 },
    { k: 'downtimePct', label: 'Downtime', post: '%', step: 1 },
    { k: 'platformSharePct', label: 'Platform share', post: '%', step: 1 },
    { k: 'activationDelayMonths', label: 'Commercial start (mo)', step: 1 },
    { k: 'insuranceMonthly', label: 'Insurance / mo', pre: '$', step: 5 },
    { k: 'cleaningMonthly', label: 'Cleaning / mo', pre: '$', step: 5 },
  ];
  const SKEYS = ['conservative', 'expected', 'optimistic'];
  function scenarioInput(key) { return R.withScenario(Object.assign({}, x, { horizonMonths: horizon }), key, scenEdits[key]); }
  function scenarios() {
    const runs = SKEYS.map(k => R.simulate(scenarioInput(k)));
    const val = (k, row) => { const v = scenarioInput(k)[row.k]; return v; };
    const head = `<thead><tr><th>${x.vehicles} vehicle${x.vehicles > 1 ? 's' : ''} · ${x.purchase === 'finance' ? 'financed' : 'cash'}</th>${SKEYS.map(k => `<th>${R.SCENARIOS[k].label}</th>`).join('')}</tr></thead>`;
    const edit = SROWS.map(row => `<tr><td>${row.label}</td>${SKEYS.map(k => `<td>${row.pre || ''}<input type="number" step="${row.step}" data-scen="${k}" data-k="${row.k}" value="${val(k, row)}" aria-label="${R.SCENARIOS[k].label}: ${row.label}">${row.post || ''}</td>`).join('')}</tr>`).join('');
    const res = (label, f, cls) => `<tr class="res${cls ? ' ' + cls : ''}"><td>${label}</td>${runs.map(r => `<td>${f(r)}</td>`).join('')}</tr>`;
    const body = edit
      + `<tr class="sep res"><td>Rides / vehicle / mo</td>${runs.map(r => `<td>${Math.round(r.perVehicle.ridesMonthly).toLocaleString('en-US')}</td>`).join('')}</tr>`
      + res('Gross revenue / mo', r => big(r.steady.gross))
      + res('Operating expenses / mo', r => big(r.steady.opex))
      + res('Operating profit / mo', r => big(r.steady.operatingProfit), 'key')
      + res('Net cash flow / mo', r => big(r.steady.netWithLoan))
      + res('Hypothetical break-even', r => paybackText(r, true), 'key')
      + res(`Cumulative after ${horizon / 12} yr${horizon > 12 ? 's' : ''}`, r => big(r.horizon.cumulative))
      + `<tr><td></td>${SKEYS.map(k => `<td><button type="button" class="roi2-btn" data-use="${k}">Use in simulator</button></td>`).join('')}</tr>`;
    const tbl = $('roi2Scenarios');
    const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.scen ? [document.activeElement.dataset.scen, document.activeElement.dataset.k] : null;
    tbl.innerHTML = head + `<tbody>${body}</tbody>`;
    if (focused) { const el = tbl.querySelector(`[data-scen="${focused[0]}"][data-k="${focused[1]}"]`); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } }
  }
  $('roi2Scenarios').addEventListener('change', e => {
    const t = e.target; if (!t.dataset.scen) return;
    const n = Number(t.value); if (!Number.isFinite(n)) return;
    const s = R.sanitize(Object.assign({}, x, { [t.dataset.k]: n }));
    scenEdits[t.dataset.scen] = Object.assign({}, scenEdits[t.dataset.scen], { [t.dataset.k]: s[t.dataset.k] });
    scenarios();
  });
  $('roi2Scenarios').addEventListener('click', e => {
    const b = e.target.closest('[data-use]'); if (!b) return;
    x = R.sanitize(scenarioInput(b.dataset.use)); render();
    toast(`${R.SCENARIOS[b.dataset.use].label} assumptions are in the simulator.`);
    $('roi2SimHeading').scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
  });
  $('roi2ScenReset').addEventListener('click', () => { scenEdits = { conservative: {}, expected: {}, optimistic: {} }; scenarios(); });

  // ---- saved configurations ----
  const selected = new Set();
  const summary = s => { const i = s.input; return `${i.mode === 'fleet' ? 'Fleet' : 'Personal'} · ${i.vehicles} vehicle${i.vehicles > 1 ? 's' : ''} · ${i.purchase === 'finance' ? `financed ${i.aprPct}%` : 'cash'}${i.mode === 'fleet' ? ` · $${i.farePerRide}/ride, ${i.ridesPerDay}/day` : ''} · saved ${new Date(s.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`; };
  function saved() {
    const list = store.list();
    for (const id of [...selected]) if (!list.some(s => s.id === id)) selected.delete(id);
    $('roi2SavedEmpty').hidden = list.length > 0;
    $('roi2Saved').innerHTML = list.map(s => `<li data-id="${esc(s.id)}">
      <input type="checkbox" aria-label="Compare ${esc(s.name)}" data-pick ${selected.has(s.id) ? 'checked' : ''}>
      <div class="nm"><b>${esc(s.name)}</b><span>${esc(summary(s))}</span></div>
      <div class="acts"><button type="button" data-act="load">Load</button><button type="button" data-act="rename">Rename</button><button type="button" data-act="dup">Duplicate</button><button type="button" data-act="del" class="danger">Delete</button></div></li>`).join('');
    $('roi2Compare').disabled = selected.size < 2;
    $('roi2Compare').textContent = selected.size >= 2 ? `Compare ${selected.size} selected` : 'Compare selected (2–3)';
  }
  function defaultName() { return `${x.vehicles} Cybercab${x.vehicles > 1 ? 's' : ''} · ${x.mode === 'fleet' ? 'fleet' : 'personal'} · ${x.purchase === 'finance' ? 'financed' : 'cash'}`; }
  $('roi2SaveBtn').addEventListener('click', () => {
    const it = store.save(defaultName(), Object.assign({}, x, { horizonMonths: horizon }));
    if (!it) { toast('Couldn\'t save here: this browser is blocking storage.', 'error'); return; }
    saved(); toast('Saved on this device. Rename it below.', 'success');
  });
  $('roi2Saved').addEventListener('change', e => {
    if (!e.target.matches('[data-pick]')) return;
    const id = e.target.closest('li').dataset.id;
    if (e.target.checked) { if (selected.size >= 3) { e.target.checked = false; toast('Compare up to three at a time.'); return; } selected.add(id); } else selected.delete(id);
    saved();
  });
  $('roi2Saved').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const li = b.closest('li'), id = li.dataset.id, it = store.get(id);
    if (!it) return saved();
    if (b.dataset.act === 'load') { x = R.sanitize(it.input); horizon = x.horizonMonths; render(); toast(`Loaded “${it.name}”.`); $('roi2SimHeading').scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' }); }
    else if (b.dataset.act === 'dup') { store.duplicate(id); saved(); }
    else if (b.dataset.act === 'del') { if (window.confirm(`Delete “${it.name}”? This can't be undone.`)) { store.remove(id); selected.delete(id); saved(); renderCompare(); } }
    else if (b.dataset.act === 'rename') {
      const nm = li.querySelector('.nm');
      nm.innerHTML = `<input type="text" maxlength="60" class="roi2-num" style="width:100%;text-align:left" aria-label="New name" value="${esc(it.name)}">`;
      const inp = nm.querySelector('input'); inp.focus(); inp.select();
      let done = false;
      const finish = ok => { if (done) return; done = true; if (ok) store.rename(id, inp.value); saved(); renderCompare(); };
      inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
    }
  });
  function renderCompare() {
    const out = $('roi2CompareOut');
    const items = store.list().filter(s => selected.has(s.id));
    if (out.dataset.open !== '1' || items.length < 2) { out.classList.add('hidden'); out.innerHTML = ''; return; }
    const runs = items.map(s => [s, R.simulate(s.input)]);
    const row = (label, f, cls) => `<tr class="res${cls ? ' ' + cls : ''}"><td>${label}</td>${runs.map(([s, r]) => `<td>${f(r, s.input)}</td>`).join('')}</tr>`;
    out.innerHTML = `<table class="roi2-table"><thead><tr><th>Compare</th>${runs.map(([s]) => `<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>
      ${row('Mode', (r, i) => (i.mode === 'fleet' ? 'Fleet' : 'Personal'))}
      ${row('Vehicles', (r, i) => i.vehicles)}
      ${row('Purchase', (r, i) => (i.purchase === 'finance' ? `${i.downPaymentPct}% down, ${i.aprPct}%` : 'Cash'))}
      ${row('Upfront cash', r => big(r.purchase.upfront))}
      ${row('Gross revenue / mo', r => (r.input.mode === 'fleet' ? big(r.steady.gross) : '—'))}
      ${row('Operating expenses / mo', r => big(r.steady.opex))}
      ${row('Operating profit / mo', r => (r.input.mode === 'fleet' ? big(r.steady.operatingProfit) : '—'), 'key')}
      ${row('Net cash flow / mo', r => big(r.steady.netWithLoan))}
      ${row('Hypothetical break-even', r => paybackText(r, true), 'key')}
      ${row('Cumulative, own horizon', r => big(r.horizon.cumulative))}
    </tbody></table>`;
    out.classList.remove('hidden');
  }
  $('roi2Compare').addEventListener('click', () => { const out = $('roi2CompareOut'); out.dataset.open = '1'; renderCompare(); out.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'nearest' }); });

  // Phones and tablets: the two key figures, pinned above the inputs.
  function peek(r) {
    const el = $('roi2Peek'); if (!el) return;
    const fleet = x.mode === 'fleet';
    el.innerHTML = fleet
      ? `<div>Operating profit / mo<b>${big(r.steady.operatingProfit)}</b></div><div class="r">Hypothetical break-even<b>${paybackText(r, true)}</b></div>`
      : `<div>Monthly cost<b>${big(r.steady.opex + r.steady.loan)}</b></div><div class="r">Cost over ${horizon / 12} yr${horizon > 12 ? 's' : ''}<b>${big(r.horizon.ownershipCost)}</b></div>`;
  }

  function render(from) {
    horizon = x.horizonMonths = R.sanitize({ horizonMonths: horizon }).horizonMonths;
    const r = R.simulate(Object.assign({}, x, { horizonMonths: horizon }));
    syncInputs(from);
    metricCards(r);
    peek(r);
    breakdown(r);
    chart(r);
    scenarios();
  }

  render();
  saved();
  // Simple, documented inputs for tests and the console.
  window.CCC_FLEET_ROI_UI = { get input() { return Object.assign({}, x); }, set(k, v) { setField(k, v); }, render };
})();
