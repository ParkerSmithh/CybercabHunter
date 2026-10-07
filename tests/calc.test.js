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

// ETA range, the report's worked example: 47 public Cybercabs, Typical -> about 6-16 min, most likely ~9.
{
  const r = CCC_CALC.etaRange({ fleetSize: 47, scenario: 'typical' });
  assert.strictEqual(r.state, 'ok');
  assert.deepStrictEqual([r.low, r.likely, r.high], [6, 9, 16]);
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

// Service hours: 6:00 AM - 11:00 PM by the clock in America/Chicago, never the visitor's.
{
  const at = iso => CCC_CALC.serviceStatus(new Date(iso));
  assert.strictEqual(at('2026-10-03T10:59:00Z').open, false);   // 5:59 AM CDT
  assert.strictEqual(at('2026-10-03T11:00:00Z').open, true);    // 6:00 AM CDT
  assert.strictEqual(at('2026-10-04T03:59:00Z').open, true);    // 10:59 PM CDT
  assert.strictEqual(at('2026-10-04T04:00:00Z').open, false);   // 11:00 PM CDT
  assert.strictEqual(at('2026-12-15T12:00:00Z').open, true);    // 6:00 AM CST (UTC-6 in winter)
  assert.strictEqual(at('2026-12-15T11:59:00Z').open, false);   // 5:59 AM CST
  assert.strictEqual(at('2026-10-03T08:00:00Z').label, 'Opens 6:00 AM');
  assert.strictEqual(at('2026-10-03T18:00:00Z').label, 'Operating now');
  assert.strictEqual(CCC_CALC.clockLabel(CCC_CALC.SERVICE_HOURS.closeMinute), '11:00 PM');
}

// Dallas (launched Apr 18, 2026): 6 AM to 2 AM crosses midnight; Austin is unchanged.
{
  const cdt = (h, m) => new Date(Date.UTC(2026, 9, 7, h + 5, m));   // Oct 7, 2026 is CDT (UTC-5)
  const dal = (h, m) => CCC_CALC.serviceStatus(cdt(h, m), CCC_CALC.DALLAS_SERVICE_HOURS).open;
  const aus = (h, m) => CCC_CALC.serviceStatus(cdt(h, m)).open;
  assert.deepStrictEqual([dal(1, 30), dal(2, 30), dal(5, 59), dal(6, 0), dal(23, 30)], [true, false, false, true, true]);
  assert.deepStrictEqual([aus(1, 30), aus(6, 0), aus(22, 59), aus(23, 0)], [false, true, true, false]);
  assert.strictEqual(CCC_CALC.reportedFare(5, CCC_CALC.DALLAS_REPORTED_RATE), 8.25);
  assert.strictEqual(CCC_CALC.DALLAS_MODEL_Y_FLEET, 65);
}

assert.deepStrictEqual(Object.keys(CCC_CALC).sort(), [
  'DALLAS_MODEL_Y_FLEET', 'DALLAS_REPORTED_RATE', 'DALLAS_SERVICE_HOURS',
  'ETA_ASSUMPTIONS', 'ETA_CAP_MINUTES', 'ETA_SCENARIOS', 'FARES_STALE_HOURS', 'REPORTED_RATE', 'SERVICE_HOURS',
  'ageHours', 'clockLabel', 'etaRange', 'faresStale', 'fleetFinancials', 'measuredAverageMiles', 'measuredFare', 'reportedFare', 'serviceStatus'
]);

console.log('calc.test.js: all assertions passed');
