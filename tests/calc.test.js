const assert = require('assert');
const CCC_CALC = require('../public/js/calc.js');

// fleetFinancials
{
  const r = CCC_CALC.fleetFinancials({
    fleetSize: 43, electricityRate: 0.14, dailyMiles: 180, baseFare: 3, perMileRate: 1.4, avgTripMiles: 5,
    inductiveLossFactor: 0.08, networkCutPct: 20, costPerCab: 35000
  });
  assert.ok(r.grossRevenue > 0, 'gross revenue should be positive');
  assert.ok(r.monthlyEnergyOverhead > 0, 'energy overhead should be positive');
  assert.ok(r.netOperatingIncome < r.grossRevenue, 'NOI should be less than gross revenue');
  assert.ok(r.breakevenMonths > 0, 'breakeven months should be positive');
}
{
  // Losing money: zero fare means negative NOI -> Infinity breakeven
  const r = CCC_CALC.fleetFinancials({
    fleetSize: 43, electricityRate: 0.14, dailyMiles: 180, baseFare: 0, perMileRate: 0, avgTripMiles: 5,
    inductiveLossFactor: 0.08, networkCutPct: 20, costPerCab: 35000
  });
  assert.strictEqual(r.breakevenMonths, Infinity);
}

// ---- Fleet ETA (simulation.html?view=eta; model: docs/fleet-eta-live-data-research.md §3) ----

// ETA range, the report's worked example: 47 public Cybercabs, Typical -> about 6-16 min, most likely ~9
// (the report used the 264 mi² zone; Austin's expanded 272 mi² zone puts the high end at 17).
{
  const r = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'typical' });
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual([r.low, r.likely, r.high], [6, 9, 17]);
  assert.strictEqual(r.highCapped, false);
  assert.ok(r.low <= r.likely && r.likely <= r.high, 'range is ordered');
}
// Scenarios change free cars, not a multiplier: Quiet is faster than Typical, Busy slower.
{
  const q = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'quiet' });
  const t = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'typical' });
  const b = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'busy' });
  assert.ok(q.likely < t.likely && t.likely < b.likely, `quiet ${q.likely} < typical ${t.likely} < busy ${b.likely}`);
  assert.ok(q.likelyFreeCars > t.likelyFreeCars && t.likelyFreeCars > b.likelyFreeCars);
}
// More cars, shorter waits (the square-root law): 4x the fleet halves the travel part.
{
  const one = CCC_CALC.etaRange({ fleetSize: 50 }), four = CCC_CALC.etaRange({ fleetSize: 200 });
  assert.ok(four.likely < one.likely);
}
// The top end is capped at 20 min and flagged.
{
  const r = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'busy' });
  assert.strictEqual(r.high, 20);
  assert.strictEqual(r.highCapped, true);
}
// Too few free cars: no number at all.
{
  const r = CCC_CALC.etaRange({ fleetSize: 5, scenario: 'busy' });
  assert.strictEqual(r.state, 'few-cars');
  assert.strictEqual(r.low, undefined);
}
// No fleet size: no estimate (never a hard-coded fallback).
for (const fleetSize of [0, null, undefined, NaN, -3]) {
  assert.strictEqual(CCC_CALC.etaRange({ fleetSize }).state, 'no-data');
}

// Fares
assert.strictEqual(CCC_CALC.reportedFare(5), 10.00);           // $3.00 + 5 x $1.40
assert.strictEqual(CCC_CALC.reportedFare(0), 3.00);
assert.strictEqual(CCC_CALC.reportedFare(-1), null);
assert.strictEqual(CCC_CALC.measuredFare(5, { per_mile: 3.76 }), 18.8);
assert.strictEqual(CCC_CALC.measuredFare(5, { per_mile: null }), null);   // no measured rides
assert.strictEqual(CCC_CALC.measuredFare(5, null), null);
assert.strictEqual(CCC_CALC.measuredAverageMiles({ average_fare: 9.18, per_mile: 3.76 }), 2.4);   // total miles / rides
assert.strictEqual(CCC_CALC.measuredAverageMiles({ average_fare: null, per_mile: null }), null);

// Staleness: the daily fare model is stale after 36 hours (or with no timestamp).
{
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.strictEqual(CCC_CALC.faresStale('2026-10-03T11:00:00Z', now), false);
  assert.strictEqual(CCC_CALC.faresStale('2026-10-02T00:30:00Z', now), false);   // 35.5 h
  assert.strictEqual(CCC_CALC.faresStale('2026-10-01T23:00:00Z', now), true);    // 37 h
  assert.strictEqual(CCC_CALC.faresStale(null, now), true);
  assert.strictEqual(Math.round(CCC_CALC.ageHours('2026-10-03T09:00:00Z', now)), 3);
}

// Service hours: 6:00 AM - 2:00 AM (past midnight) by the clock in America/Chicago, never the visitor's.
{
  const at = iso => CCC_CALC.serviceStatus(new Date(iso));
  assert.strictEqual(at('2026-10-03T10:59:00Z').open, false);   // 5:59 AM CDT
  assert.strictEqual(at('2026-10-03T11:00:00Z').open, true);    // 6:00 AM CDT
  assert.strictEqual(at('2026-10-04T03:59:00Z').open, true);    // 10:59 PM CDT
  assert.strictEqual(at('2026-10-04T04:00:00Z').open, true);    // 11:00 PM CDT
  assert.strictEqual(at('2026-10-04T04:59:00Z').open, true);    // 11:59 PM CDT
  assert.strictEqual(at('2026-10-04T05:00:00Z').open, true);    // 12:00 AM CDT (midnight): still running
  assert.strictEqual(at('2026-10-04T05:59:00Z').open, true);    // 12:59 AM CDT
  assert.strictEqual(at('2026-10-04T06:00:00Z').open, true);    // 1:00 AM CDT
  assert.strictEqual(at('2026-10-04T06:59:00Z').open, true);    // 1:59 AM CDT
  assert.strictEqual(at('2026-10-04T07:00:00Z').open, false);   // 2:00 AM CDT: parked
  assert.strictEqual(at('2026-12-15T12:00:00Z').open, true);    // 6:00 AM CST (UTC-6 in winter)
  assert.strictEqual(at('2026-12-15T11:59:00Z').open, false);   // 5:59 AM CST
  assert.strictEqual(at('2026-10-03T08:00:00Z').label, 'Opens 6:00 AM');
  assert.strictEqual(at('2026-10-03T18:00:00Z').label, 'Operating now');
  assert.strictEqual(CCC_CALC.clockLabel(CCC_CALC.SERVICE_HOURS.closeMinute), '2:00 AM');
  // The 24-hour track: two pieces, 6 AM–12 AM then 12 AM–2 AM; a same-day window stays one.
  assert.deepStrictEqual(CCC_CALC.serviceSegments(), [{ start: 360, end: 1440 }, { start: 0, end: 120 }]);
  assert.deepStrictEqual(CCC_CALC.serviceSegments({ openMinute: 360, closeMinute: 1440 }), [{ start: 360, end: 1440 }]);
  assert.deepStrictEqual(CCC_CALC.serviceSegments({ openMinute: 360, closeMinute: 0 }), [{ start: 360, end: 1440 }]);
}

// Dallas (launched Apr 18, 2026): 6 AM to 2 AM, the same as Austin. A window
// that crosses midnight is still handled (open after opening OR before closing).
{
  const cdt = (h, m) => new Date(Date.UTC(2026, 9, 7, h + 5, m));   // Oct 7, 2026 is CDT (UTC-5)
  const dal = (h, m) => CCC_CALC.serviceStatus(cdt(h, m), CCC_CALC.DALLAS_SERVICE_HOURS).open;
  const aus = (h, m) => CCC_CALC.serviceStatus(cdt(h, m)).open;
  assert.deepStrictEqual([dal(0, 0), dal(1, 30), dal(1, 59), dal(2, 0), dal(5, 59), dal(6, 0), dal(22, 59), dal(23, 0), dal(23, 59)], [true, true, true, false, false, true, true, true, true]);
  assert.strictEqual(CCC_CALC.clockLabel(CCC_CALC.DALLAS_SERVICE_HOURS.closeMinute), '2:00 AM');
  const late = { openMinute: 6 * 60, closeMinute: 2 * 60, timeZone: 'America/Chicago' };
  assert.deepStrictEqual([1, 2, 5, 6, 23].map(h => CCC_CALC.serviceStatus(cdt(h, 30), late).open), [true, false, false, true, true]);
  assert.deepStrictEqual([aus(0, 0), aus(1, 30), aus(1, 59), aus(2, 0), aus(6, 0), aus(22, 59), aus(23, 0), aus(23, 59)], [true, true, true, false, true, true, true, true]);
  assert.strictEqual(CCC_CALC.reportedFare(5, CCC_CALC.DALLAS_REPORTED_RATE), 8.25);
  assert.strictEqual(CCC_CALC.DALLAS_MODEL_Y_FLEET, 65);
}

// ---- Fleet ETA estimate display (ranges from the daily model; tests/fleet-eta.test.mjs
// checks these match worker/fleet-eta-model.js).
{
  const m = { a: 3, b: 1.5, tiers: { quiet: { center: 0.9, lo: 0.8, hi: 1 }, typical: { center: 1, lo: 0.85, hi: 1.15 }, busy: { center: 1.2, lo: 1.05, hi: 1.35 } }, area_mult: { downtown: 1.1 } };
  const r = CCC_CALC.etaFareRange(m, 4, 'typical');
  assert.ok(Math.abs(r.center - 9) < 1e-9 && Math.abs(r.lo - 7.65) < 1e-9 && Math.abs(r.hi - 10.35) < 1e-9);
  assert.strictEqual(CCC_CALC.dollarRange(r), '$7–$11');                                   // rounded outward
  assert.ok(CCC_CALC.etaFareRange(m, 4, 'busy').center > CCC_CALC.etaFareRange(m, 4, 'quiet').center);
  assert.ok(Math.abs(CCC_CALC.etaFareRange(m, 4, 'typical', 'downtown').center - 9.9) < 1e-9);
  assert.strictEqual(CCC_CALC.etaFareRange(null, 4), null);
  assert.strictEqual(CCC_CALC.dollarRange({ lo: 9.2, hi: 9.4 }), '$9–$10');                // never narrower than a dollar
  assert.strictEqual(CCC_CALC.minuteRange({ lo: 6.4, hi: 11.2 }), '6–12 min');
  assert.strictEqual(CCC_CALC.minuteRange({ lo: 30, hi: 60 }), '30–45+ min');
  // Saturday 7:30 PM in Austin = 00:30 UTC Sunday (CDT).
  assert.deepStrictEqual(CCC_CALC.etaSlot(new Date('2026-10-11T00:30:00Z')), { key: 'weekend:evening', day: 'Saturday', part: 'evening' });
  assert.strictEqual(CCC_CALC.assumedTier({ slot_tiers: { 'weekend:evening': { tier: 'busy', reasons: ['x'] } } }, new Date('2026-10-11T00:30:00Z')).tier, 'busy');
  assert.strictEqual(CCC_CALC.assumedTier(null).tier, 'typical');
  // Friday 8 PM counts as a weekend evening; Friday noon does not.
  assert.strictEqual(CCC_CALC.etaSlot(new Date('2026-10-10T01:00:00Z')).key, 'weekend:evening');
  assert.strictEqual(CCC_CALC.etaSlot(new Date('2026-10-09T17:00:00Z')).key, 'weekday:midday');
}

assert.deepStrictEqual(Object.keys(CCC_CALC).sort(), [
  'DALLAS_AREA_SQ_MI', 'DALLAS_MODEL_Y_FLEET', 'DALLAS_REPORTED_RATE', 'DALLAS_SERVICE_HOURS',
  'ETA_ASSUMPTIONS', 'ETA_CAP_MINUTES', 'ETA_SCENARIOS', 'ETA_TIERS', 'FARES_STALE_HOURS', 'REPORTED_RATE', 'SERVICE_HOURS',
  'ageHours', 'assumedTier', 'clockLabel', 'dollarRange', 'etaFareRange', 'etaRange', 'etaSlot', 'etaWaitRange', 'faresStale', 'fleetFinancials', 'measuredAverageMiles', 'measuredFare', 'minuteRange', 'reportedFare', 'serviceSegments', 'serviceStatus'
]);

console.log('calc.test.js: all assertions passed');
