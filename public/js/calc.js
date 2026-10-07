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

  // ---- Fleet ETA (simulation.html?view=eta) ----
  // Model, inputs and ranges: docs/fleet-eta-live-data-research.md §3.

  // Both fleets' service hours, America/Chicago (owner-confirmed). One place to edit.
  const SERVICE_HOURS = { openMinute: 6 * 60, closeMinute: 23 * 60, timeZone: 'America/Chicago' };
  // Dallas (launched Apr 18, 2026): 6 AM to 2 AM daily, reported by FOX 4 and
  // Dallas Innovates. The window crosses midnight (closeMinute < openMinute).
  const DALLAS_SERVICE_HOURS = { openMinute: 6 * 60, closeMinute: 2 * 60, timeZone: 'America/Chicago' };
  // Dallas's introductory rate as reported at launch (FOX 4, Apr 20, 2026):
  // $3.25 base + $1.00 per mile. Not a published rate card.
  const DALLAS_REPORTED_RATE = { base: 3.25, perMile: 1.00, asOf: '2026-04-20' };
  // Dallas Model Y fleet: a fixed figure set by the owner (no live source).
  const DALLAS_MODEL_Y_FLEET = 65;

  // Tesla's Austin robotaxi rate as reported from the app (not an official rate card):
  // $3.00 base + $1.40/mi since 2026-03-12 (Not a Tesla App / Basenor reporting).
  const REPORTED_RATE = { base: 3.00, perMile: 1.40, asOf: '2026-03-12' };

  // Inputs of the ETA model that are assumptions, not data. Each is a [low, likely, high] band.
  const ETA_ASSUMPTIONS = {
    areaSqMi: 264.1,                 // the Austin geofence (index.html serviceZoneCoords)
    deployedShare: [0.4, 0.6, 0.8],  // share of the registry in service at a given time
    speedMph: [18, 22, 28],          // average driving speed to the pickup
    circuity: 1.35,                  // road distance / straight-line distance
    dispatchMinutes: 1               // matching and departure
  };

  // Demand scenarios: what demand changes is how many in-service cars are free.
  const ETA_SCENARIOS = {
    quiet:   { label: 'Quiet',   idleShare: [0.5, 0.65, 0.8] },
    typical: { label: 'Typical', idleShare: [0.3, 0.5, 0.6] },
    busy:    { label: 'Busy',    idleShare: [0.05, 0.15, 0.3] }
  };

  const ETA_CAP_MINUTES = 20;        // shown as "20+ min" above this
  const FEW_FREE_CARS = 2;           // likely free cars below this: no number, a warning instead

  // Minutes to the nearest free car: idle cars spread over the zone, the mean
  // straight-line distance to the nearest is 0.5 / sqrt(density); times a road
  // detour factor, over an average speed, plus dispatch.
  function pickupMinutes({ fleetSize, deployedShare, idleShare, speedMph, areaSqMi, circuity, dispatchMinutes }) {
    const idleCars = fleetSize * deployedShare * idleShare;
    if (!(idleCars > 0)) return { minutes: Infinity, idleCars: 0 };
    const nearestMiles = circuity * 0.5 / Math.sqrt(idleCars / areaSqMi);
    return { minutes: dispatchMinutes + (nearestMiles / speedMph) * 60, idleCars };
  }

  // The ETA as a range. Low and high are the best and worst corners of the
  // assumption bands; likely is every band at its middle value. Whole minutes;
  // anything above ETA_CAP_MINUTES is reported as capped.
  //   state 'ok'         -> { low, likely, high, highCapped }
  //   state 'few-cars'   -> too few free cars for a number ("Wait could be much longer")
  //   state 'no-data'    -> no fleet size
  function etaRange({ fleetSize, scenario = 'typical', assumptions = ETA_ASSUMPTIONS }) {
    const s = ETA_SCENARIOS[scenario] || ETA_SCENARIOS.typical;
    if (!(Number.isFinite(fleetSize) && fleetSize > 0)) return { state: 'no-data' };
    const a = assumptions;
    const base = { fleetSize, areaSqMi: a.areaSqMi, circuity: a.circuity, dispatchMinutes: a.dispatchMinutes };
    const likely = pickupMinutes({ ...base, deployedShare: a.deployedShare[1], idleShare: s.idleShare[1], speedMph: a.speedMph[1] });
    if (likely.idleCars < FEW_FREE_CARS) return { state: 'few-cars', likelyFreeCars: likely.idleCars };
    const best = pickupMinutes({ ...base, deployedShare: a.deployedShare[2], idleShare: s.idleShare[2], speedMph: a.speedMph[2] });
    const worst = pickupMinutes({ ...base, deployedShare: a.deployedShare[0], idleShare: s.idleShare[0], speedMph: a.speedMph[0] });
    const cap = m => Math.min(Math.round(m), ETA_CAP_MINUTES);
    return {
      state: 'ok',
      low: cap(best.minutes),
      likely: cap(likely.minutes),
      high: cap(worst.minutes),
      highCapped: !(worst.minutes <= ETA_CAP_MINUTES),
      likelyFreeCars: likely.idleCars
    };
  }

  const round2 = n => Math.round(n * 100) / 100;

  // Fare at a distance on the reported rate card.
  function reportedFare(miles, rate = REPORTED_RATE) {
    if (!(miles >= 0)) return null;
    return round2(rate.base + rate.perMile * miles);
  }

  // Fare at a distance from the site's measured rides: the distance-weighted
  // measured rate ($ per mile across all counted rides, base included) times
  // the distance. Null when there is no measured rate.
  function measuredFare(miles, fares) {
    const perMile = fares && Number(fares.per_mile);
    if (!(miles >= 0) || !(perMile > 0)) return null;
    return round2(perMile * miles);
  }

  // The average length of the measured rides: per_mile is total fares / total
  // miles and average_fare is total fares / rides, so their ratio is total
  // miles / rides. Null without measured rides.
  function measuredAverageMiles(fares) {
    const avg = fares && Number(fares.average_fare), perMile = fares && Number(fares.per_mile);
    return avg > 0 && perMile > 0 ? Math.round((avg / perMile) * 10) / 10 : null;
  }

  // Hours since the fare model was computed; stale after FARES_STALE_HOURS
  // (the daily cron missed a run).
  const FARES_STALE_HOURS = 36;
  function ageHours(isoTime, nowMs = Date.now()) {
    const t = Date.parse(isoTime);
    return Number.isFinite(t) ? (nowMs - t) / 3600000 : null;
  }
  function faresStale(computedAt, nowMs = Date.now()) {
    const h = ageHours(computedAt, nowMs);
    return h === null || h > FARES_STALE_HOURS;
  }

  // "6:00 AM" from minutes after midnight.
  function clockLabel(minuteOfDay) {
    const h = Math.floor(minuteOfDay / 60) % 24, m = minuteOfDay % 60;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }

  // Whether the service is running at `date`, by the clock in the service's
  // time zone (never the visitor's): { open, minuteOfDay, label }.
  function serviceStatus(date = new Date(), hours = SERVICE_HOURS) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: hours.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date);
    const get = type => Number((parts.find(p => p.type === type) || {}).value);
    const minuteOfDay = (get('hour') % 24) * 60 + get('minute');
    // A window that crosses midnight (e.g. Dallas, 6 AM to 2 AM) is open after
    // the opening time OR before the closing time.
    const open = hours.closeMinute > hours.openMinute
      ? minuteOfDay >= hours.openMinute && minuteOfDay < hours.closeMinute
      : minuteOfDay >= hours.openMinute || minuteOfDay < hours.closeMinute;
    return {
      open,
      minuteOfDay,
      label: open ? 'Operating now' : `Opens ${clockLabel(hours.openMinute)}`
    };
  }

  return {
    fleetFinancials,
    SERVICE_HOURS, REPORTED_RATE, ETA_ASSUMPTIONS, ETA_SCENARIOS, ETA_CAP_MINUTES, FARES_STALE_HOURS,
    DALLAS_SERVICE_HOURS, DALLAS_REPORTED_RATE, DALLAS_MODEL_Y_FLEET,
    etaRange, reportedFare, measuredFare, measuredAverageMiles, ageHours, faresStale, clockLabel, serviceStatus
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CCC_CALC;
