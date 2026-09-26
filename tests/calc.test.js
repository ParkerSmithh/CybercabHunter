const assert = require('assert');
const CCC_CALC = require('../public/js/calc.js');

// dispatchETA
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

// arrivalOdds
{
  const { oddsA, oddsB } = CCC_CALC.arrivalOdds(43, 100);
  assert.strictEqual(oddsA, 30.1);
  assert.strictEqual(oddsB, 69.9);
  assert.strictEqual(Math.round((oddsA + oddsB) * 10) / 10, 100);
}

// fleetFinancials
{
  const r = CCC_CALC.fleetFinancials({
    fleetSize: 43, electricityRate: 0.14, dailyMiles: 180, fare: 1.2,
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
    fleetSize: 43, electricityRate: 0.14, dailyMiles: 180, fare: 0,
    inductiveLossFactor: 0.08, networkCutPct: 20, costPerCab: 35000
  });
  assert.strictEqual(r.breakevenMonths, Infinity);
}

console.log('calc.test.js: all assertions passed');
