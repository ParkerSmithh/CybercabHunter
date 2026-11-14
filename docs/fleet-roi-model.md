# Fleet ROI: model and assumptions

The Cybercab ownership and fleet-investment simulator on the Simulation page
(`public/simulation.html`, Fleet ROI tab) and in the iOS app (Simulation →
Fleet ROI). It is the only Fleet ROI calculator (the older "Fleet economics"
quick calculator and the scenario comparison were removed in Nov 2026). One
model, two implementations:

- Website: `public/js/fleet-roi.js` (`CCC_FLEET_ROI`), UI `public/js/fleet-roi-ui.js`
- iOS: `ios-native/CybercabHunter/Features/Simulation/FleetROIModel.swift`, UI `FleetROI2View.swift`

Both are tested against the same fixtures, `tests/fixtures/fleet-roi-cases.json`
(written by `scripts/fleet-roi-fixtures.mjs` from the JavaScript model;
`tests/fleet-roi.test.mjs` and `CybercabHunterTests/FleetROIModelTests.swift`).
Change the model in both places, regenerate the fixtures, and say why.

## Five fixed values

Locked by the owner (Nov 2026). They are shown in the calculator with a lock,
can't be edited, and `sanitize()` enforces them on every input, including
saved configurations made before they were fixed.

| Value | Fixed at | Note |
|---|---|---|
| Price per Cybercab | **$29,990** | before taxes; Tesla's reported order price |
| Order deposit | **$1,000** per Cybercab | part of the price (credited), never added on top |
| Autonomy Subscription | **$300/month** per Cybercab | a fixed calculator assumption; Tesla's reported price is $299 |
| Free Autonomy | **1 month** | the first month after delivery, once |
| Tesla Revenue Share | **25%** of fares | a fixed modeling assumption, not a published Tesla agreement (input key `platformSharePct`, kept for saved configurations) |

**Commercial operation is hypothetical.** Tesla has published no terms for
owners running a Cybercab on its Robotaxi network: no eligibility, revenue
split, insurance requirements or start date. Personal ownership does not
imply permission to operate commercially.

## Inputs

Per vehicle unless noted. Every one is editable; invalid values fall back to
the default and numbers are clamped to their range (`sanitize`).

| Input | Default | Kind |
|---|---|---|
| Mode | Fleet investment | (Personal ownership / Fleet investment) |
| Vehicles | 1 (1–1000) | assumption |
| Price | $29,990 | **fixed** |
| Deposit | $1,000 (part of the price) | **fixed** |
| Sales tax | 6.25% of price | estimate (Texas) |
| Title, registration, fees | $300 | assumption |
| Purchase | Cash | (Cash / Finance) |
| Down payment | 20% | assumption |
| APR | 6.9% | assumption |
| Loan term | 60 months | assumption |
| Autonomy Subscription | $300/mo | **fixed** |
| Free Autonomy | 1 month | **fixed** |
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
| Tesla Revenue Share | 25% of fares | **fixed** (Fleet; Tesla has published none) |
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
- `teslaShare = gross × 25%`
- `miles = Fleet ? rides × milesPerRide × (1 + empty%) : personalMiles`
- `charging = miles × kWh/mi × $/kWh` (Fleet: only while active; Personal: every month)
- `subscription = m > 1 ? $300 : 0` (Free Autonomy: month 1 only, once)
- `insurance`, `maintenance` every month; `cleaning` while active (Fleet)
- `operatingExpenses = teslaShare + charging + subscription + insurance + maintenance + cleaning`
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

## Saved configurations

Kept on the device only (website: `localStorage` key `cchFleetRoiSaved.v1`;
iOS: `UserDefaults` key `cchFleetRoiSaved.v1`). No account, database, API or
sync. Save, rename, duplicate, load, delete, and compare up to three side by side.
Every saved input is read through `sanitize`: an older save with a different
price, deposit, subscription, free period or revenue share gets the five
fixed values, and keeps everything else it saved. Nothing is deleted.

## Open questions about Tesla's terms

- Is the $1,000 deposit credited toward the price? (assumed yes)
- Price and content of the required maintenance subscription
- Whether, when and where personal Cybercabs may join the Robotaxi network;
  the revenue split; who insures commercial rides; who pays for charging,
  cleaning and downtime
- Whether the $299 subscription changes for commercial use
- Taxes and fees outside Texas; incentives
