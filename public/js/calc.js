/* Cybercab Hunter — pure calculation functions (no DOM). */
const CCC_CALC = (() => {
  function dispatchETA({ areaSqMi, fleetSize, demandFactor, k = 8 }) {
    if (fleetSize <= 0) return Infinity;
    const eta = k * Math.sqrt(areaSqMi / fleetSize) * demandFactor;
    return Math.round(eta * 10) / 10;
  }

  // Austin Robotaxi rate: $3.00 base fare + $1.40/mile.
  function estimateFare({ tripMiles, baseFare = 3.00, pricePerMile = 1.40 }) {
    const fare = baseFare + tripMiles * pricePerMile;
    return Math.round(fare * 100) / 100;
  }

  function fleetFinancials({
    fleetSize, electricityRate, dailyMiles,
    baseFare, perMileRate, avgTripMiles = 5,
    inductiveLossFactor, networkCutPct, costPerCab,
    kwhPerMile = 0.25
  }) {
    const tripsPerDay = avgTripMiles > 0 ? dailyMiles / avgTripMiles : 0;
    const dailyRevenuePerCab = tripsPerDay * (baseFare + perMileRate * avgTripMiles);
    const grossRevenue = dailyRevenuePerCab * fleetSize * 30;
    const teslaCut = grossRevenue * (networkCutPct / 100);
    const monthlyEnergyOverhead =
      dailyMiles * kwhPerMile * electricityRate * fleetSize * 30 * (1 + inductiveLossFactor);
    const netOperatingIncome = grossRevenue - teslaCut - monthlyEnergyOverhead;
    const totalCapital = fleetSize * costPerCab;
    const breakevenMonths = netOperatingIncome > 0
      ? Math.round((totalCapital / netOperatingIncome) * 10) / 10
      : Infinity;
    return { grossRevenue, teslaCut, monthlyEnergyOverhead, netOperatingIncome, breakevenMonths };
  }

  return { dispatchETA, estimateFare, fleetFinancials };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CCC_CALC;
