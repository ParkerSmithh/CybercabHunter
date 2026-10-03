const assert = require('assert');
const CCC_CALC = require('../public/js/calc.js');

// dispatchETA (Fleet ETA)
{
  const eta = CCC_CALC.dispatchETA({ areaSqMi: 20, fleetSize: 43, demandFactor: 1.0 });
  assert.ok(eta > 5 && eta < 6, `expected ~5.5, got ${eta}`);
}
{
  const eta = CCC_CALC.dispatchETA({ areaSqMi: 20, fleetSize: 100, demandFactor: 1.0 });
  assert.ok(eta > 3 && eta < 4, `expected ~3.6, got ${eta}`);
}
{
  const eta = CCC_CALC.dispatchETA({ areaSqMi: 20, fleetSize: 43, demandFactor: 1.5 });
  const base = CCC_CALC.dispatchETA({ areaSqMi: 20, fleetSize: 43, demandFactor: 1.0 });
  assert.ok(eta > base, 'surge demand should increase ETA');
}
assert.strictEqual(CCC_CALC.dispatchETA({ areaSqMi: 20, fleetSize: 0, demandFactor: 1 }), Infinity);

// estimateFare: $3.00 base + $1.40/mile
assert.strictEqual(CCC_CALC.estimateFare({ tripMiles: 5 }), 10);

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

// Fleet ETA and Fleet ROI helpers, and nothing else.
assert.deepStrictEqual(Object.keys(CCC_CALC), ['dispatchETA', 'estimateFare', 'fleetFinancials']);

console.log('calc.test.js: all assertions passed');
