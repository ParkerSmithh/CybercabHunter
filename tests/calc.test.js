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

// Only the Fleet ROI calculation remains (the Fleet ETA helpers were removed with that page).
assert.deepStrictEqual(Object.keys(CCC_CALC), ['fleetFinancials']);

console.log('calc.test.js: all assertions passed');
