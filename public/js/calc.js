/* Cybercab Hunter — pure calculation functions (no DOM). */
const CCC_CALC = (() => {
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

  return { fleetFinancials };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CCC_CALC;
