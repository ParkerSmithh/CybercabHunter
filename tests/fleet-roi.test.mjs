// Fleet ROI (public/js/fleet-roi.js, docs/fleet-roi-model.md): the Cybercab
// ownership and fleet-investment model.
//   - five fixed values that no input or saved configuration can change:
//     $29,990 price, $1,000 deposit (part of the price), $300/mo Autonomy
//     Subscription, 1 month Free Autonomy (once), 25% Tesla Revenue Share
//   - the shared fixtures (tests/fixtures/fleet-roi-cases.json; the iOS port
//     is tested against the same file) match the model exactly
//   - formulas: loan amortization, the deposit is never added, the price is
//     counted once, taxes, the free month, downtime, delayed commercial start,
//     payback, one vehicle vs large fleets, zero revenue, negative cash flow
//   - Personal ownership never earns revenue or a payback
//   - invalid inputs fall back or clamp; saved configurations (local only),
//     including older ones with other fixed values
// Run: node tests/fleet-roi.test.mjs

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeCheck } from './helpers/env.mjs';

const require = createRequire(import.meta.url);
const R = require('../public/js/fleet-roi.js');
const t = makeCheck();
const { check } = t;
const near = (a, b, eps = 1e-6) => (a === null && b === null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)));
const sum = (r, k, to) => r.months.slice(0, to).reduce((s, m) => s + m[k], 0);

console.log('1. The five fixed values');
{
  check('fixed: $29,990, $1,000, $300/mo, 1 month free, 25%', R.FIXED.price === 29990 && R.FIXED.deposit === 1000 && R.FIXED.subscriptionMonthly === 300 && R.FIXED.subscriptionIncludedMonths === 1 && R.FIXED.platformSharePct === 25);
  check('each is marked fixed and locked', ['price', 'deposit', 'subscriptionMonthly', 'subscriptionIncludedMonths', 'platformSharePct'].every(k => R.FIELDS[k].kind === 'fixed' && R.FIELDS[k].locked));
  const x = R.sanitize({ price: 35000, deposit: 2500, subscriptionMonthly: 299, subscriptionIncludedMonths: 6, platformSharePct: 30, farePerRide: 14, vehicles: 3 });
  check('an input can\'t change them (and other inputs are kept)', x.price === 29990 && x.deposit === 1000 && x.subscriptionMonthly === 300 && x.subscriptionIncludedMonths === 1 && x.platformSharePct === 25 && x.farePerRide === 14 && x.vehicles === 3);
  check('not even with garbage', R.sanitize({ price: 'x', deposit: NaN, subscriptionMonthly: -1, platformSharePct: 1e9 }).platformSharePct === 25);
  const r = R.simulate({ vehicles: 10, platformSharePct: 0 });
  check('Tesla Revenue Share is always 25% of fares', near(r.steady.platformFee, r.steady.gross * 0.25));
}

console.log('2. Shared fixtures (the iOS model is checked against the same file)');
{
  const f = JSON.parse(fs.readFileSync(new URL('./fixtures/fleet-roi-cases.json', import.meta.url), 'utf8'));
  check('there are fixtures for every required situation', f.cases.length >= 17);
  const bad = [];
  const cmp = (path, a, b) => {
    if (b && typeof b === 'object') { for (const k of Object.keys(b)) cmp(`${path}.${k}`, a?.[k], b[k]); return; }
    if (typeof b === 'number' || b === null) { if (!near(a, b)) bad.push(`${path}: ${a} vs ${b}`); return; }
    if (a !== b) bad.push(`${path}: ${a} vs ${b}`);
  };
  for (const c of f.cases) {
    const r = R.simulate(c.input);
    const got = { input: r.input, purchase: r.purchase, perVehicle: r.perVehicle, steady: r.steady, horizon: r.horizon, paybackMonth: r.paybackMonth, loanBalanceAtPayback: r.loanBalanceAtPayback, cumulativeEnd: r.cumulativeEnd, month1: r.months[0], month12: r.months[11], month60: r.months[59] };
    cmp(c.name, got, c.expected);
  }
  check('every fixture matches the model', bad.length === 0);
  if (bad.length) console.log(bad.slice(0, 5));
  check('every fixture carries the five fixed values', f.cases.every(c => c.expected.input.price === 29990 && c.expected.input.deposit === 1000 && c.expected.input.subscriptionMonthly === 300 && c.expected.input.subscriptionIncludedMonths === 1 && c.expected.input.platformSharePct === 25));
}

console.log('3. Purchase');
{
  const r = R.simulate({ purchase: 'cash' });
  check('cash: $29,990 + 6.25% tax + $300 fees up front = $32,164.38', near(r.purchase.upfront, 29990 + 29990 * 0.0625 + 300));
  check('the $1,000 deposit is part of the price, never added on top', r.purchase.deposit === 1000 && r.purchase.balanceAtDelivery === 28990 && near(r.purchase.upfront, 32164.375));
  const f = R.simulate({ purchase: 'finance' });
  check('financed: 20% down, $23,992 borrowed', near(f.purchase.down, 5998) && near(f.purchase.principal, 23992));
  check('6.9% for 60 months: $473.94 a month (standard amortization)', Math.abs(f.purchase.payment - 473.94) < 0.005);
  check('interest = payments − principal', near(f.purchase.interestTotal, f.purchase.payment * 60 - 23992));
  check('the price is counted once: down payment + principal = price', near(f.purchase.down + f.purchase.principal, 29990));
  check('after the loan, cash and financed differ by exactly the interest paid', near(r.months[59].cumulative - f.months[59].cumulative, f.purchase.interestTotal));
  check('the loan is paid off exactly at the end of its term', f.months[59].loanBalance === 0 && f.months[58].loanBalance > 0 && f.months[60].loan === 0);
  const z = R.simulate({ purchase: 'finance', aprPct: 0, downPaymentPct: 0, loanMonths: 36 });
  check('0% APR: straight-line payments', near(z.purchase.payment, 29990 / 36) && near(z.purchase.interestTotal, 0));
  const big = R.simulate({ vehicles: 25 });
  check('fleet purchase scales: 25 × price, 25 × $1,000 deposits, 25 × tax and fees', near(big.purchase.totalPrice, 749750) && near(big.purchase.totalDeposits, 25000) && near(big.purchase.totalTaxFees, 25 * (29990 * 0.0625 + 300)) && near(big.purchase.upfront, 25 * r.purchase.upfront));
}

console.log('4. The Autonomy Subscription and Free Autonomy');
{
  const r = R.simulate({ horizonMonths: 120 });
  check('month 1 is free; $300 from month 2', r.months[0].subscription === 0 && r.months[1].subscription === 300);
  check('the free month applies once, not every year', [12, 13, 24, 25, 36, 60, 119].every(i => r.months[i].subscription === 300));
  check('10 years: 119 paid months', near(r.horizon.subscription, 119 * 300));
  const ten = R.simulate({ vehicles: 10 });
  check('×10 vehicles: $3,000 a month, still the first month free', ten.months[0].subscription === 0 && ten.months[1].subscription === 3000 && ten.steady.subscription === 3000);
}

console.log('5. Operation');
{
  const r = R.simulate({});
  check('rides: 16/day × 30 days × 90% up = 432 a month', near(r.perVehicle.ridesMonthly, 432));
  check('gross $5,184; Tesla 25% = $1,296; charging on 30% empty miles', near(r.steady.gross, 5184) && near(r.steady.platformFee, 1296) && near(r.steady.charging, 432 * 5 * 1.3 * 0.25 * 0.12));
  check('steady operating profit = gross − all expenses = $3,043.76', near(r.steady.operatingProfit, 5184 - (1296 + 84.24 + 300 + 250 + 60 + 150)));
  check('no revenue, cleaning or charging before the commercial start (+3 months)', [0, 1, 2].every(i => r.months[i].gross === 0 && r.months[i].cleaning === 0 && r.months[i].charging === 0) && r.months[3].gross > 0);
  check('insurance and maintenance are paid while waiting', r.months[0].insurance === 250 && r.months[0].maintenance === 60);
  check('payback: the first month the cumulative cash turns positive', r.paybackMonth === r.months.findIndex(m => m.cumulative >= 0) + 1 && r.months[r.paybackMonth - 2].cumulative < 0);
  const later = R.simulate({ activationDelayMonths: 24 });
  check('a later commercial start delays payback by about the same', later.paybackMonth > r.paybackMonth + 18);
  const big = R.simulate({ vehicles: 100 }), one = R.simulate({ vehicles: 1 });
  check('100 vehicles: 100× every amount, same payback', near(big.steady.operatingProfit, 100 * one.steady.operatingProfit) && near(big.purchase.upfront, 100 * one.purchase.upfront) && big.paybackMonth === one.paybackMonth);
  const zero = R.simulate({ farePerRide: 0 });
  check('zero revenue: losses every month, no payback', zero.steady.gross === 0 && zero.steady.operatingProfit < 0 && zero.paybackMonth === null);
  const down = R.simulate({ downtimePct: 100 });
  check('100% downtime: no rides, no revenue', down.perVehicle.ridesMonthly === 0 && down.steady.gross === 0 && down.paybackMonth === null);
  const neg = R.simulate({ ridesPerDay: 3, insuranceMonthly: 600, purchase: 'finance' });
  check('negative cash flow stays negative, with the loan on top', neg.steady.operatingProfit < 0 && neg.steady.netWithLoan < neg.steady.operatingProfit && neg.paybackMonth === null);
  const fin = R.simulate({ purchase: 'finance' });
  check('financed payback reports the loan still owed then', fin.paybackMonth !== null && fin.loanBalanceAtPayback > 0 && near(fin.loanBalanceAtPayback, fin.months[fin.paybackMonth - 1].loanBalance));
  check('no scenario code is left in the model', !('withScenario' in R) && !('SCENARIOS' in R));
}

console.log('6. Personal ownership');
{
  const p = R.simulate({ mode: 'personal' });
  check('no revenue, no Tesla share, no cleaning, never a payback', sum(p, 'gross') === 0 && sum(p, 'platformFee') === 0 && sum(p, 'cleaning') === 0 && p.paybackMonth === null);
  check('charging for 1,000 personal miles from the first month', near(p.months[0].charging, 1000 * 0.25 * 0.12));
  check('5-year cost of ownership = upfront + every cost', near(p.horizon.ownershipCost, p.purchase.upfront + sum(p, 'loan', 60) + sum(p, 'charging', 60) + sum(p, 'subscription', 60) + sum(p, 'insurance', 60) + sum(p, 'maintenance', 60)));
  check('Fleet-only inputs are marked as such', ['farePerRide', 'ridesPerDay', 'platformSharePct', 'activationDelayMonths', 'cleaningMonthly', 'downtimePct'].every(k => R.FIELDS[k].fleetOnly));
  check('the commercial start label from the December 2026 delivery', R.startMonthLabel(3) === '2027-03' && R.startMonthLabel(0) === '2026-12' && R.startMonthLabel(13) === '2028-01');
}

console.log('7. Invalid inputs');
{
  const x = R.sanitize({ mode: 'robotaxi', vehicles: -4, farePerRide: 1e9, purchase: 'lease', aprPct: NaN, ridesPerDay: '20', horizonMonths: 7, loanMonths: 61.4 });
  check('unknown choices fall back', x.mode === 'fleet' && x.purchase === 'cash');
  check('numbers clamp to their range; text and NaN fall back', x.vehicles === 1 && x.farePerRide === 100 && x.aprPct === 6.9 && x.ridesPerDay === 20 && x.horizonMonths === 12 && x.loanMonths === 61);
  check('a fully broken input still simulates', Number.isFinite(R.simulate(null).cumulativeEnd) && Number.isFinite(R.simulate({ vehicles: Infinity }).cumulativeEnd));
}

console.log('8. Saved configurations');
{
  const mem = new Map();
  const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const s = R.makeStore(storage);
  const a = s.save('  Ten   cabs  ', { vehicles: 10, farePerRide: 14 });
  check('save: trimmed name, sanitized input', a.name === 'Ten cabs' && a.input.vehicles === 10 && a.input.price === 29990 && s.list().length === 1);
  check('rename', s.rename(a.id, 'Ten cabs, financed') && s.get(a.id).name === 'Ten cabs, financed');
  const b = s.duplicate(a.id);
  check('duplicate: a new id, " copy", right after the original', b.id !== a.id && b.name === 'Ten cabs, financed copy' && s.list()[1].id === b.id && s.list()[1].input.farePerRide === 14);
  check('delete', s.remove(a.id) && !s.get(a.id) && s.list().length === 1 && !s.remove('nope'));
  check('empty names become "Untitled configuration"', s.save('   ', {}).name === 'Untitled configuration');
  // An older save (Fleet ROI 2.0 at release: $299, 30%, editable price).
  mem.set(R.STORE_KEY, JSON.stringify([{ id: 'cfg-old', name: 'Old plan', savedAt: '2026-11-13T20:00:00.000Z', input: { mode: 'fleet', vehicles: 7, price: 31000, deposit: 1500, subscriptionMonthly: 299, subscriptionIncludedMonths: 2, platformSharePct: 30, farePerRide: 13, ridesPerDay: 18, purchase: 'finance', aprPct: 5.5 } }]));
  const old = s.get('cfg-old');
  check('an older save loads with the five fixed values enforced', old.input.price === 29990 && old.input.deposit === 1000 && old.input.subscriptionMonthly === 300 && old.input.subscriptionIncludedMonths === 1 && old.input.platformSharePct === 25);
  check('…and keeps everything else it saved', old.name === 'Old plan' && old.input.vehicles === 7 && old.input.farePerRide === 13 && old.input.ridesPerDay === 18 && old.input.purchase === 'finance' && old.input.aprPct === 5.5);
  const dup = s.duplicate('cfg-old');
  check('a duplicate of an older save is written with the fixed values', JSON.parse(mem.get(R.STORE_KEY)).find(x => x.id === dup.id).input.subscriptionMonthly === 300);
  check('nothing is deleted by the migration', s.list().length === 2 && s.list()[0].id === 'cfg-old');
  mem.set(R.STORE_KEY, '{broken');
  check('a corrupt store reads as empty, never throws', Array.isArray(s.list()) && s.list().length === 0);
  const full = R.makeStore({ getItem: () => '[]', setItem: () => { throw new Error('quota'); } });
  check('a full or blocked storage fails softly', full.save('x', {}) === null);
}

console.log('9. Documentation');
{
  const doc = fs.readFileSync(new URL('../docs/fleet-roi-model.md', import.meta.url), 'utf8');
  check('the formulas and the five fixed values are documented', /## Formulas/.test(doc) && /\$29,990/.test(doc) && /\$300/.test(doc) && /Free Autonomy/.test(doc) && /Tesla Revenue Share/.test(doc) && /25%/.test(doc));
}

t.finish();
