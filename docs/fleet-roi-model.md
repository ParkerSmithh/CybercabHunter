# Fleet ROI 2.0: model and assumptions

The Cybercab ownership and fleet-investment simulator on the Simulation page
(`public/simulation.html`, Fleet ROI tab) and in the iOS app (Simulation →
Fleet ROI). One model, two implementations:

- Website: `public/js/fleet-roi.js` (`CCC_FLEET_ROI`)
- iOS: `ios-native/CybercabHunter/Features/Simulation/FleetROIModel.swift`

Both are tested against the same fixtures, `tests/fixtures/fleet-roi-cases.json`
(written by `scripts/fleet-roi-fixtures.mjs` from the JavaScript model;
`tests/fleet-roi.test.mjs` and `CybercabHunterTests/FleetROIModelTests.swift`).
Change the model in both places, regenerate the fixtures, and say why.

## What is known, and how sure we are

Three kinds of figure, labeled everywhere they appear:

| Kind | Meaning |
|---|---|
| **Reported** | Shown on Tesla's Cybercab order interface, as reported on Nov 13, 2026 (InsideEVs, Teslarati, Not a Tesla App, citing Tesla's announcement). Not verified on tesla.com. |
| **Estimate** | A public figure we can cite, e.g. Texas motor vehicle sales tax (6.25%). Local fees vary. |
| **Assumption** | An editable guess. Every operating cost and all commercial revenue. |

Reported purchase terms (last verified 2026-11-13):

- Vehicle price **$29,990**, before taxes
- **$1,000** order deposit, nonrefundable. Treated as **part of the price**
  (credited at delivery), not an extra charge, until Tesla's terms say otherwise
- **Autonomy Subscription $299/month**, first month included with purchase
- Regular maintenance subscription required; **price not shown**
- Estimated delivery **December 2026**, Austin, Texas; invitation only

**Commercial operation is hypothetical.** Tesla has published no terms for
owners running a Cybercab on its Robotaxi network: no eligibility, revenue
split, insurance requirements or start date. Personal ownership does not
imply permission to operate commercially. The revenue share default (30% to
the platform) follows third-party estimates (25–30%), not Tesla.

## Inputs

Per vehicle unless noted. Every one is editable; invalid values fall back to
the default and numbers are clamped to their range (`sanitize`).

| Input | Default | Kind |
|---|---|---|
| Mode | Fleet investment | (Personal ownership / Fleet investment) |
| Vehicles | 1 (1–1000) | assumption |
| Price | $29,990 | reported |
| Deposit | $1,000 (part of the price) | reported |
| Sales tax | 6.25% of price | estimate (Texas) |
| Title, registration, fees | $300 | assumption |
| Purchase | Cash | (Cash / Finance) |
| Down payment | 20% | assumption |
| APR | 6.9% | assumption |
| Loan term | 60 months | assumption |
| Autonomy Subscription | $299/mo, 1 month included | reported |
| Insurance | $250/mo | assumption (commercial cover likely costs more) |
| Maintenance subscription | $60/mo | assumption (price not shown) |
| Electricity | $0.12/kWh | assumption |
| Efficiency | 0.25 kWh/mi | assumption |
| Personal miles | 1,000/mo | assumption (Personal mode) |
| Fare per ride | $12 | assumption (Fleet) |
| Rides per day | 16 | assumption (Fleet) |
| Miles per ride | 5 | assumption (Fleet) |
| Empty miles | +30% | assumption (Fleet: driving between rides) |
| Operating days | 30/mo | assumption (Fleet) |
| Downtime | 10% | assumption (Fleet: charging, cleaning, repairs) |
| Platform share | 30% of fares | assumption (Fleet; Tesla has published none) |
| Cleaning | $150/mo | assumption (Fleet, while operating) |
| Commercial start | 3 months after delivery | assumption (Fleet) |
| Horizon | 5 years (1–10) | — |

## Formulas

Month 0 is everything paid before or at delivery. Months 1–120 follow delivery.

**Purchase (per vehicle)**

- `tax = price × salesTax%`
- Cash: `down = price`, `principal = 0`
- Finance: `down = price × down%`, `principal = price − down`
- `payment = principal × r / (1 − (1 + r)^−term)`, `r = APR / 12`; at 0% APR `principal / term`
- `upfront = down + tax + fees`. The deposit is inside `down` (it's part of the price).
- `interest = payment × term − principal`
- The price is counted once: either in `upfront` (cash) or in `upfront` plus
  loan payments (finance). It is never also counted as "capital".

**Each month m (whole fleet = per vehicle × vehicles)**

- `active = Fleet mode and m > commercialStartDelay`
- `rides = ridesPerDay × operatingDays × (1 − downtime%)`
- `gross = active ? rides × fare : 0`
- `platformFee = gross × platformShare%`
- `miles = Fleet ? rides × milesPerRide × (1 + empty%) : personalMiles`
- `charging = miles × kWh/mi × $/kWh` (Fleet: only while active; Personal: every month)
- `subscription = m > includedMonths ? $299 : 0`
- `insurance`, `maintenance` every month; `cleaning` while active (Fleet)
- `operatingExpenses = platformFee + charging + subscription + insurance + maintenance + cleaning`
- `operatingProfit = gross − operatingExpenses`
- `loan = m ≤ term ? payment : 0` (financing cash flow)
- `net = operatingProfit − loan`
- `cumulative = −upfront + Σ net`
- `loanBalance` after the payment: `balance × (1 + r) − payment`, 0 after the last

**Results**

- Steady month: a full month after commercial start and the included
  subscription month(s): gross, expenses, operating profit, loan, net.
- Payback (Fleet only): the first month `cumulative ≥ 0`; none within 10
  years shows as "Not within 10 years". Financed: payback is getting your cash
  back, not the loan paid off; the balance still owed then is shown with it.
- Total cost of ownership over the horizon: `upfront + loan payments + charging + subscription + insurance + maintenance + cleaning`.

## Scenarios (Fleet mode)

Starting points, all editable; they change only the operating assumptions.

| | Conservative | Expected | Optimistic |
|---|---|---|---|
| Fare per ride | $9 | $12 | $15 |
| Rides per day | 10 | 16 | 24 |
| Downtime | 20% | 10% | 5% |
| Platform share | 35% | 30% | 25% |
| Commercial start | +6 mo | +3 mo | +1 mo |
| Insurance | $400 | $250 | $200 |
| Cleaning | $200 | $150 | $100 |

## Saved configurations

Kept on the device only (website: `localStorage` key `cchFleetRoiSaved.v1`;
iOS: `UserDefaults` key `cchFleetRoiSaved.v1`). No account, database, API or
sync. Save, rename, duplicate, delete, and compare up to three side by side.
Saved inputs are re-checked with `sanitize` when loaded.

## Open questions about Tesla's terms

- Is the $1,000 deposit credited toward the price? (assumed yes)
- Price and content of the required maintenance subscription
- Whether, when and where personal Cybercabs may join the Robotaxi network;
  the revenue split; who insures commercial rides; who pays for charging,
  cleaning and downtime
- Whether the $299 subscription changes for commercial use
- Taxes and fees outside Texas; incentives
