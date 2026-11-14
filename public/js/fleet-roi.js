/* Fleet ROI: the Cybercab ownership and fleet-investment model.
   One documented model for the website (simulation.html) and the iOS app
   (ios-native/.../FleetROIModel.swift, a line-for-line port). Both are
   tested against the same fixtures (tests/fixtures/fleet-roi-cases.json).
   Formulas and every default: docs/fleet-roi-model.md.

   Five values are FIXED (owner's decision, Nov 2026) and can't be changed
   by an input or a saved configuration: sanitize() always enforces them.
     price            $29,990 per Cybercab
     deposit          $1,000 per Cybercab, part of the price (never added)
     subscription     $300/month per Cybercab (a fixed calculator
                      assumption; Tesla's reported price is $299)
     Free Autonomy    the first month (once, from delivery)
     Tesla Revenue Share  25% of fares (a fixed modeling assumption;
                      Tesla has published no revenue-sharing terms)
   Everything else is an editable estimate or assumption. Commercial
   operation is hypothetical: Tesla has published no terms for owners
   running a Cybercab on its network.

   simulate(input) runs month by month from delivery (month 1) for up to
   120 months. Money paid before delivery (deposit, down payment, tax, fees)
   is month 0. The purchase is counted once: the cash price (or the down
   payment plus loan payments) is the outlay; nothing is also counted as
   "capital". The deposit is part of the price, not an extra charge. */
(function (root) {
  'use strict';

  const FIXED = Object.freeze({
    price: 29990,
    deposit: 1000,
    subscriptionMonthly: 300,
    subscriptionIncludedMonths: 1,   // "Free Autonomy"
    platformSharePct: 25,            // "Tesla Revenue Share" (key kept for saved configurations)
  });
  const DELIVERY_ESTIMATE = '2026-12';   // month 1 of the timeline (reported December 2026)

  // Every input: its default, range, step and what kind of figure it is.
  // kind: fixed | estimate | assumption. fixed = locked to FIXED (not
  // editable, not overridable). fleetOnly: used only in Fleet mode.
  const FIELDS = Object.freeze({
    mode:                 { def: 'fleet', options: ['personal', 'fleet'] },
    vehicles:             { def: 1, min: 1, max: 1000, step: 1, kind: 'assumption' },
    price:                { def: FIXED.price, min: FIXED.price, max: FIXED.price, step: 10, kind: 'fixed', locked: true },
    deposit:              { def: FIXED.deposit, min: FIXED.deposit, max: FIXED.deposit, step: 50, kind: 'fixed', locked: true },
    salesTaxPct:          { def: 6.25, min: 0, max: 15, step: 0.05, kind: 'estimate' },
    feesPerVehicle:       { def: 300, min: 0, max: 5000, step: 10, kind: 'assumption' },
    purchase:             { def: 'cash', options: ['cash', 'finance'] },
    downPaymentPct:       { def: 20, min: 0, max: 100, step: 1, kind: 'assumption' },
    aprPct:               { def: 6.9, min: 0, max: 30, step: 0.1, kind: 'assumption' },
    loanMonths:           { def: 60, min: 12, max: 96, step: 12, kind: 'assumption' },
    subscriptionMonthly:  { def: FIXED.subscriptionMonthly, min: FIXED.subscriptionMonthly, max: FIXED.subscriptionMonthly, step: 1, kind: 'fixed', locked: true },
    subscriptionIncludedMonths: { def: FIXED.subscriptionIncludedMonths, min: FIXED.subscriptionIncludedMonths, max: FIXED.subscriptionIncludedMonths, step: 1, kind: 'fixed', locked: true },
    insuranceMonthly:     { def: 250, min: 0, max: 3000, step: 5, kind: 'assumption' },
    maintenanceMonthly:   { def: 60, min: 0, max: 1000, step: 5, kind: 'assumption' },
    electricityRate:      { def: 0.12, min: 0, max: 0.6, step: 0.01, kind: 'assumption' },
    kwhPerMile:           { def: 0.25, min: 0.1, max: 0.5, step: 0.01, kind: 'assumption' },
    personalMilesMonthly: { def: 1000, min: 0, max: 6000, step: 50, kind: 'assumption' },
    farePerRide:          { def: 12, min: 0, max: 100, step: 0.5, kind: 'assumption', fleetOnly: true },
    ridesPerDay:          { def: 16, min: 0, max: 60, step: 1, kind: 'assumption', fleetOnly: true },
    milesPerRide:         { def: 5, min: 0.5, max: 40, step: 0.5, kind: 'assumption', fleetOnly: true },
    deadheadPct:          { def: 30, min: 0, max: 150, step: 5, kind: 'assumption', fleetOnly: true },
    operatingDays:        { def: 30, min: 0, max: 31, step: 1, kind: 'assumption', fleetOnly: true },
    downtimePct:          { def: 10, min: 0, max: 100, step: 1, kind: 'assumption', fleetOnly: true },
    platformSharePct:     { def: FIXED.platformSharePct, min: FIXED.platformSharePct, max: FIXED.platformSharePct, step: 1, kind: 'fixed', locked: true, fleetOnly: true },
    cleaningMonthly:      { def: 150, min: 0, max: 2000, step: 5, kind: 'assumption', fleetOnly: true },
    activationDelayMonths:{ def: 3, min: 0, max: 60, step: 1, kind: 'assumption', fleetOnly: true },
    horizonMonths:        { def: 60, min: 12, max: 120, step: 12 },
  });

  const MAX_MONTHS = 120;

  function defaults(overrides) {
    const o = {};
    for (const [k, f] of Object.entries(FIELDS)) o[k] = f.def;
    return Object.assign(o, overrides || {});
  }

  // Any input: unknown or invalid values become the default; numbers are
  // clamped to their range; counts are whole numbers.
  function sanitize(input) {
    const out = {};
    const src = input || {};
    for (const [k, f] of Object.entries(FIELDS)) {
      const v = src[k];
      if (f.options) { out[k] = f.options.includes(v) ? v : f.def; continue; }
      if (f.locked) { out[k] = f.def; continue; }   // fixed: never from the input
      let n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) n = f.def;
      n = Math.min(f.max, Math.max(f.min, n));
      if (f.step >= 1 && Number.isInteger(f.step)) n = Math.round(n);
      out[k] = n;
    }
    return out;
  }

  // Monthly payment on a fixed-rate loan (0% APR: straight-line).
  function loanPayment(principal, aprPct, months) {
    if (principal <= 0 || months <= 0) return 0;
    const r = aprPct / 100 / 12;
    if (r === 0) return principal / months;
    return principal * r / (1 - Math.pow(1 + r, -months));
  }

  function simulate(rawInput) {
    const x = sanitize(rawInput);
    const n = x.vehicles;
    const fleet = x.mode === 'fleet';
    const finance = x.purchase === 'finance';

    // ---- Purchase (per vehicle, then the fleet) ----
    const tax = x.price * x.salesTaxPct / 100;
    const deposit = Math.min(x.deposit, x.price);          // credited toward the price
    const down = finance ? x.price * x.downPaymentPct / 100 : x.price;
    const principal = finance ? x.price - down : 0;
    const payment = finance ? loanPayment(principal, x.aprPct, x.loanMonths) : 0;
    const loanMonths = finance && principal > 0 ? x.loanMonths : 0;
    const interestTotal = payment * loanMonths - principal;
    const upfrontPerVehicle = down + tax + x.feesPerVehicle;   // includes the deposit (part of the price)

    // ---- Operation (per vehicle per month) ----
    const activeShare = 1 - x.downtimePct / 100;
    const ridesMonthly = fleet ? x.ridesPerDay * x.operatingDays * activeShare : 0;
    const grossMonthly = ridesMonthly * x.farePerRide;
    const platformFeeMonthly = grossMonthly * x.platformSharePct / 100;
    const milesMonthly = fleet ? ridesMonthly * x.milesPerRide * (1 + x.deadheadPct / 100) : x.personalMilesMonthly;
    const chargingActive = milesMonthly * x.kwhPerMile * x.electricityRate;
    const chargingIdle = fleet ? 0 : chargingActive;          // personal driving doesn't wait for activation
    const cleaningMonthly = fleet ? x.cleaningMonthly : 0;

    const months = [];
    let cumulative = -upfrontPerVehicle * n;
    let paybackMonth = null, balance = principal * n;
    const rate = x.aprPct / 100 / 12;
    const totals = { gross: 0, platformFee: 0, charging: 0, subscription: 0, insurance: 0, maintenance: 0, cleaning: 0, loan: 0, operatingProfit: 0 };
    for (let m = 1; m <= MAX_MONTHS; m++) {
      const active = fleet && m > x.activationDelayMonths;
      const gross = active ? grossMonthly * n : 0;
      const platformFee = active ? platformFeeMonthly * n : 0;
      const charging = (active ? chargingActive : chargingIdle) * n;
      const subscription = m > x.subscriptionIncludedMonths ? x.subscriptionMonthly * n : 0;
      const insurance = x.insuranceMonthly * n;
      const maintenance = x.maintenanceMonthly * n;
      const cleaning = active ? cleaningMonthly * n : 0;
      const opex = platformFee + charging + subscription + insurance + maintenance + cleaning;
      const operatingProfit = gross - opex;
      const loan = m <= loanMonths ? payment * n : 0;
      // What's still owed after this month's payment (0% APR: straight-line).
      if (loan > 0) balance = m === loanMonths ? 0 : Math.max(0, balance * (1 + rate) - loan);
      const net = operatingProfit - loan;
      cumulative += net;
      if (paybackMonth === null && fleet && cumulative >= 0) paybackMonth = m;
      if (m <= x.horizonMonths) {
        totals.gross += gross; totals.platformFee += platformFee; totals.charging += charging;
        totals.subscription += subscription; totals.insurance += insurance; totals.maintenance += maintenance;
        totals.cleaning += cleaning; totals.loan += loan; totals.operatingProfit += operatingProfit;
      }
      months.push({ m, active, gross, platformFee, charging, subscription, insurance, maintenance, cleaning, opex, operatingProfit, loan, net, cumulative, loanBalance: balance });
    }

    // A full month of operation, after activation and the included month(s).
    const steady = {
      gross: grossMonthly * n,
      platformFee: platformFeeMonthly * n,
      charging: chargingActive * n,
      subscription: x.subscriptionMonthly * n,
      insurance: x.insuranceMonthly * n,
      maintenance: x.maintenanceMonthly * n,
      cleaning: cleaningMonthly * n,
    };
    steady.opex = steady.platformFee + steady.charging + steady.subscription + steady.insurance + steady.maintenance + steady.cleaning;
    steady.operatingProfit = steady.gross - steady.opex;
    steady.loan = payment * n;
    steady.netWithLoan = steady.operatingProfit - steady.loan;

    const h = x.horizonMonths;
    const upfront = upfrontPerVehicle * n;
    const ownershipCost = upfront + totals.loan + totals.charging + totals.subscription + totals.insurance + totals.maintenance + totals.cleaning;

    return {
      input: x,
      purchase: {
        price: x.price, deposit, depositCredited: true, balanceAtDelivery: x.price - deposit,
        tax, fees: x.feesPerVehicle, down, principal, payment, loanMonths, interestTotal,
        upfrontPerVehicle, totalPrice: x.price * n, totalDeposits: deposit * n, totalTaxFees: (tax + x.feesPerVehicle) * n,
        upfront, financedTotal: principal * n,
        allInPerVehicle: x.price + tax + x.feesPerVehicle + interestTotal,
      },
      perVehicle: { ridesMonthly, grossMonthly, platformFeeMonthly, milesMonthly, chargingMonthly: chargingActive },
      steady,
      months,
      horizon: { months: h, ...totals, ownershipCost, ownershipPerMonth: ownershipCost / h, cumulative: months[h - 1].cumulative },
      paybackMonth,                          // fleet only; null = not within 10 years
      // Financed: cash back is not the loan paid off. What's still owed then.
      loanBalanceAtPayback: paybackMonth === null ? null : months[paybackMonth - 1].loanBalance,
      cumulativeEnd: months[MAX_MONTHS - 1].cumulative,
    };
  }

  const FLEET_PRESETS = [1, 2, 5, 10, 25, 50, 100];

  // The month the commercial start falls in, from the delivery estimate.
  function startMonthLabel(delayMonths, delivery = DELIVERY_ESTIMATE) {
    const [y, mo] = delivery.split('-').map(Number);
    const t = y * 12 + (mo - 1) + delayMonths;
    return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`;
  }

  // ---- Saved configurations (localStorage on the site; UserDefaults on iOS) ----
  const STORE_KEY = 'cchFleetRoiSaved.v1';
  function makeStore(storage) {
    // Every item is read through sanitize(): an older save with a different
    // price, deposit, subscription, free period or revenue share gets the
    // fixed values; everything else it saved is kept.
    const read = () => { try { const a = JSON.parse(storage.getItem(STORE_KEY) || '[]'); return Array.isArray(a) ? a.filter(s => s && typeof s.id === 'string' && typeof s.name === 'string' && s.input).map(s => Object.assign({}, s, { input: sanitize(s.input) })) : []; } catch (e) { return []; } };
    const write = list => { try { storage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; } };
    const id = () => 'cfg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const clean = name => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled configuration';
    return {
      list: read,
      save(name, input) { const list = read(); const item = { id: id(), name: clean(name), input: sanitize(input), savedAt: new Date().toISOString() }; list.unshift(item); return write(list) ? item : null; },
      rename(sid, name) { const list = read(); const it = list.find(s => s.id === sid); if (!it) return false; it.name = clean(name); return write(list); },
      duplicate(sid) { const list = read(); const it = list.find(s => s.id === sid); if (!it) return null; const copy = { id: id(), name: clean(it.name + ' copy'), input: sanitize(it.input), savedAt: new Date().toISOString() }; list.splice(list.indexOf(it) + 1, 0, copy); return write(list) ? copy : null; },
      remove(sid) { const list = read(); const next = list.filter(s => s.id !== sid); return next.length !== list.length && write(next); },
      get(sid) { return read().find(s => s.id === sid) || null; },
    };
  }

  const API = { FIXED, DELIVERY_ESTIMATE, FIELDS, FLEET_PRESETS, MAX_MONTHS, STORE_KEY, defaults, sanitize, loanPayment, simulate, startMonthLabel, makeStore };
  root.CCC_FLEET_ROI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
