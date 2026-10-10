/* Fleet forecasts for the homepage charts ("Actual + Predictions"): the
   registry's FLEET GROWTH · CYBERCAB (index.html) and TEXAS DMV
   REGISTRATIONS · TESLA (js/dmv-panel.js). Pure functions, no DOM; the page
   computes a forecast from the data it already loaded, so it updates whenever
   that data does. Nothing here is stored or hard-coded.

   The method (explained on the page under "How predictions work"):
     1. Daily additions. The cumulative counts are put on a day grid. Between
        two observations further apart than a day, the change is spread evenly
        over the gap (a missing day is unknown, never "zero added"). A day with
        a real observation and no change counts as zero. Decreases (corrections,
        removals) stay in the history but add nothing to the rate.
     2. Spike damping. One big batch shouldn't set the pace: each day counts
        for at most the larger of the Tukey fence (Q3 + 1.5 x IQR of the
        days with additions) and 2x the mean daily addition.
     3. Rates. The damped daily rate over the last 7 days, the last 30 days
        and the whole history, blended 50% / 30% / 20%.
     4. Projection. Linear, never exponential: each future day adds the
        blended rate, which tapers toward the 30-day rate (half-life 21 days)
        so a recent surge isn't assumed to last. Rounded; never below the
        latest actual count, never decreasing.
     5. Range. An 80% band of 1.28 x the spread of the damped daily
        additions x sqrt(days ahead), wider (x1.5) when the recent history
        includes approximate counts; the lower edge never falls below the
        latest actual count.
   Too little history (under 14 days, or fewer than 3 days with additions)
   -> no forecast, with the reason. */
(function (root) {
  const DAY = 864e5;
  const MIN_SPAN_DAYS = 14;
  const MIN_ACTIVE_DAYS = 3;
  const WEIGHTS = { r7: 0.5, r30: 0.3, all: 0.2 };
  const TAPER_HALF_LIFE = 21;
  const Z80 = 1.28;

  const dayIndex = ms => Math.floor(ms / DAY);
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // observations: [{ t: ms, value: cumulative, approx?: bool }], any order.
  // endMs: the forecast's start (the data is used only up to here).
  // Returns { days: [{ day, add, approx }], last: {day, value}, firstDay } or null.
  function dailyAdditions(observations, endMs) {
    const obs = observations
      .filter(o => Number.isFinite(o.t) && Number.isFinite(o.value) && o.t <= endMs)
      .map(o => ({ day: dayIndex(o.t), value: o.value, approx: !!o.approx }))
      .sort((a, b) => a.day - b.day);
    if (!obs.length) return null;
    // One value per day: the day's last observation.
    const byDay = [];
    for (const o of obs) {
      if (byDay.length && byDay[byDay.length - 1].day === o.day) byDay[byDay.length - 1] = o;
      else byDay.push(o);
    }
    const days = [];
    for (let i = 1; i < byDay.length; i++) {
      const a = byDay[i - 1], b = byDay[i], gap = b.day - a.day;
      const per = Math.max(0, b.value - a.value) / gap;   // a decrease adds nothing
      for (let k = 1; k <= gap; k++) days.push({ day: a.day + k, add: per, approx: a.approx || b.approx || gap > 1 });
    }
    // The latest observation's value holds up to the start day (real zeros:
    // the data is current through endMs).
    const last = byDay[byDay.length - 1], endDay = dayIndex(endMs);
    for (let d = last.day + 1; d <= endDay; d++) days.push({ day: d, add: 0, approx: false });
    return { days, last: { day: last.day, value: last.value }, firstDay: byDay[0].day, endDay };
  }

  function dampCap(adds) {
    const active = adds.filter(v => v > 0).sort((a, b) => a - b);
    if (!active.length) return 0;
    const q1 = quantile(active, 0.25), q3 = quantile(active, 0.75);
    return Math.max(q3 + 1.5 * (q3 - q1), 2 * mean(adds));
  }

  // The forecast for one cumulative series.
  // opts: { horizonDays, endMs (default now) }
  // -> { ok: true, start, current, rate, rates, points: [{ t, value, low, high }], approx }
  //  | { ok: false, reason }
  function forecast(observations, opts = {}) {
    const horizon = Math.max(1, Math.min(365, Math.round(opts.horizonDays || 30)));
    const endMs = Number.isFinite(opts.endMs) ? opts.endMs : Date.now();
    const series = dailyAdditions(observations, endMs);
    if (!series) return { ok: false, reason: 'No history yet, so there is nothing to project from.' };
    const span = series.endDay - series.firstDay;
    const adds = series.days.map(d => d.add);
    const activeDays = series.days.filter(d => d.add > 0).length;
    if (span < MIN_SPAN_DAYS) return { ok: false, reason: `Only ${span} day${span === 1 ? '' : 's'} of history so far; a reliable forecast needs at least ${MIN_SPAN_DAYS}.` };
    if (activeDays < MIN_ACTIVE_DAYS) return { ok: false, reason: `Too few days with new vehicles (${activeDays}) to estimate a growth rate.` };
    const cap = dampCap(adds);
    const damped = adds.map(v => Math.min(v, cap));
    const tail = n => damped.slice(-n);
    const rates = { r7: mean(tail(7)), r30: mean(tail(30)), all: mean(damped) };
    const blended = WEIGHTS.r7 * rates.r7 + WEIGHTS.r30 * rates.r30 + WEIGHTS.all * rates.all;
    const recent = series.days.slice(-30);
    const approx = recent.some(d => d.approx);
    const sd = Math.sqrt(mean(tail(30).map(v => (v - mean(tail(30))) ** 2)));
    const spread = Z80 * sd * (approx ? 1.5 : 1);
    const current = series.last.value;
    const startDay = series.endDay;
    const points = [];
    let cum = current, hi = current, lo = current;
    for (let h = 1; h <= horizon; h++) {
      const rate = rates.r30 + (blended - rates.r30) * Math.pow(0.5, h / TAPER_HALF_LIFE);
      cum += Math.max(0, rate);
      const value = Math.max(current, Math.round(cum));
      const width = spread * Math.sqrt(h);
      lo = Math.max(lo, current, Math.min(value, Math.round(cum - width)));
      hi = Math.max(hi, value, Math.round(cum + width));
      const prev = points.length ? points[points.length - 1].value : current;
      points.push({ t: (startDay + h) * DAY, value: Math.max(prev, value), low: lo, high: hi });
    }
    return {
      ok: true,
      start: startDay * DAY,
      current,
      rate: blended,
      rates,
      cap,
      approx,
      horizonDays: horizon,
      points
    };
  }

  const api = { forecast, dailyAdditions, MIN_SPAN_DAYS, MIN_ACTIVE_DAYS, WEIGHTS, TAPER_HALF_LIFE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CCCForecast = api;
})(typeof window !== 'undefined' ? window : globalThis);
