# Fleet ETA: estimate model, data and D1 budget

*October 2026. Replaces the model in `fleet-eta-live-data-research.md` §3 as the page's headline estimate; that model survives as the "fleet-geometry check".*

Code: `worker/fleet-eta-model.js` (pure model), `worker/fleet-eta.js` (daily job, endpoints), `public/js/fleet-compare.js` (page), `public/js/calc.js` (`etaFareRange` / `etaWaitRange`, the browser copies of the range functions), `migrations/0038_fleet_eta_accuracy.sql`. Tests: `tests/fleet-eta.test.mjs`. Measurement: `scripts/measure-fleet-eta-reads.mjs`.

## What the page used to do

| Figure | Old source | Problem |
|---|---|---|
| Cybercab "measured" fare (median, average, $/mi, trip fare = $/mi × miles) | Every counted ride in the city with a fare (`/api/fleet-stats` → `fares`) | Labelled **Cybercab**, but included rides on Model Ys, unknown-type vehicles and rides linked to no vehicle. A flat $/mi × miles has no base fare, so short trips came out too cheap and long trips too dear. Equal weight to a ride from 6 months ago. No range. |
| Model Y fare, "reported rate" | Hard-coded $3.00 + $1.40/mi (Mar 12 2026) | A rate card from March presented as the current price; RobotaxiTracker's observed Austin median ($10.42 at 4.1 mi) is ~19% above it. |
| Pickup wait | Fleet geometry: registry count × assumed 40–80% in service × assumed idle share ÷ 264 mi² | Never calibrated. The registry is "cars ever approved", not cars on the road. Gave ~5–9 min for Austin against field reports of 10–15 min (Jefferies: ~15 min, cars unavailable 50–60% of the time). Waits computed per vehicle type, as if a rider could choose the fleet. |
| Quiet / Typical / Busy | Arbitrary idle-share bands | Not fitted to anything; changed only the wait, never the price. |
| Dallas | Austin's wait model over 81 mi², a launch rate card | Austin's assumptions reused for Dallas; a Dallas Cybercab wait was shown from the registry count even with no evidence of Cybercabs in public service there. |
| Live Cybercab count | `/api/fleet-stats` polled every 5 min | A registry aggregate run on each edge-cache miss (see the budget section). |

## The model now

All of it is computed once a day per city (Austin with `FLEET_STATS_CRON`, Dallas with `TXDMV_CRON`; no new trigger) and stored as one row in `fleet_eta_stats`.

**Observations.** Logged rides (completed, actual fares; one per physical ride; rides on private/ineligible vehicles excluded) plus rider reports a moderator approved (`fare_reports`). Vehicle type comes from the registry vehicle (`Cybercab`, `Model Y`) or the report; everything else is "unknown".

**Cleaning.** Fare $1–$250, 0.2–60 mi, $0.40–$30/mi; duplicates collapse to one; fares older than 180 days are dropped ("outdated pricing"); a fare more than 3.5 robust SDs from the curve (and never within ±60% of it) is an outlier. At most the newest 400 clean fares per city are used.

**Fare curve.** `fare = a + b × miles`, fitted with recency weights (30-day half-life) by a robust slope median (each fare paired with the one half the sample further along by distance; the weighted median of those slopes; the base is the weighted median of what's left). One huge fare cannot move it.

**Vehicle types.** Cybercab and Model Y get their own curve once each has ≥10 clean fares with that type; otherwise both use the all-robotaxi curve, labelled as such, with confidence capped below High. No discount is ever assumed.

**Demand tiers (Cybercab Hunter's scenarios, not Tesla's labels).** From each fare's ratio to the curve: Quiet = 25th percentile, Typical = median, Busy = 80th percentile, each with the 10th–90th percentile of the spread that remains within comparable time slots (weekday/weekend × morning/midday/afternoon/evening/overnight; Friday evening counts as weekend). Needs ≥30 fares (≥20 effective); otherwise one Typical range (overall 10th–90th percentile). A time slot is labelled Quiet/Busy only if its median is beyond the 35th/65th percentile *and* more than two standard errors from the overall median. "No cars available" in ≥25% of ≥6 reports in a slot marks it Busy. The slot labels are used to pick the assumed tier only if they beat "always Typical" on held-out rides; otherwise the page assumes Typical and says why.

**Waits.** Rider-reported app quotes (≥8 in 90 days), same tier method, with a per-area adjustment shrunk toward the citywide value (only for areas with ≥8 reports). Quoted ETA, rider-timed actual pickup, and the model's estimate are kept separate; the median actual-minus-quoted delay is shown when ≥5 riders timed both. Waits are not split by vehicle type.

**Pickup areas.** From the ZIP code of a receipt's pickup address or the area a reporter picks (Austin: Downtown, South Congress & South Austin, East Austin & Riverside, UT & Central, North Austin, West Austin; Dallas: Downtown & Deep Ellum, Uptown & Oak Lawn, Highland Park & University Park, Lower Greenville & Lakewood, Love Field & Medical District). Approximate groupings; fares get an area adjustment only with ≥15 fares in the area.

**Fallbacks (always Low confidence, labelled "Modeled from published reports").**
- Fares, too few own observations: the latest reported rate card's shape scaled so the tracker's average trip costs the tracker's median (Austin: $3.00 + $1.40/mi × 1.19 → $10.42 at 4.1 mi; Dallas: $3.25 + $1.00/mi × 1.08 → $5.88 at 2.2 mi), tiers from Obi's day-to-day range ($8.31–$14.59 → about −27% / +27%).
- Waits, Austin: published reports (Quiet 5–10, Typical 10–15, Busy 15–26 min). Dallas: none published, so "Insufficient data".
- Dallas Cybercab: "Insufficient data" until a logged Dallas Cybercab ride or an approved completed Cybercab report exists (RobotaxiTracker lists no Cybercab in Dallas public service). Austin's numbers are never reused.

**Calibration.** For every fare group and for waits, the newest 20% of observations are held out, the model is fit on the rest and scored on them: mean and median absolute error, mean % error, share inside the shown range, per assumed tier, by vehicle type, part of day and area, and against the previous page's formulas (measured $/mi × miles; the rate card; the fleet-geometry wait) on the same rides. If fewer than 75% fall inside, the ranges are widened (up to 2×) and the page says so.

**Confidence.** High: ≥40 effective observations, newest ≤14 days, ≥15 held-out with ≥70% inside the range. Medium: ≥12 effective, newest ≤45 days, and (no check possible or ≥55% inside). Low: anything else, and every published-report fallback. Insufficient data: no estimate.

**Fleet layers (never interchangeable).** Documented (public eligible registry vehicles by type), different cars seen in 7 / 30 days (approved sightings + logged rides, each car once), seen but not identifiable (sightings without a plate, camera detections without a sighting; never counted as cars; capped at 1,000), Texas DMV registrations (statewide, latest snapshot), RobotaxiTracker's in-service figure (external, dated), and "free to pick you up now": not known.

## Rider reports

`POST /api/fare-reports` (signed in): city, quote vs completed ride, vehicle type, pickup/drop-off area, distance, trip time, price, quoted wait, actual wait, "no cars available", when. Stored coarsely (area, the hour), pending until a moderator approves it on the Moderation page; only approved reports feed the model. Validation rejects impossible values and combinations; a per-rider and per-IP (hashed with the day, unlinkable across days) limit of 10 a day; a dedupe key blocks resubmits. Reports are deleted with the rider's account. Screenshots are not collected yet (see limitations).

## D1 budget (measured)

`node scripts/measure-fleet-eta-reads.mjs --size current|stress` runs the real handlers against a throwaway local D1 (Wrangler's local engine reports `rows_read` the way production bills it). "current" approximates the site's published counts (135 public vehicles, 600 rides, 300 sightings, 2,000 camera detections); "stress" is ~50× that (530 vehicles, 25,000 rides, 8,000 sightings, 40,000 camera detections, 6,000 reports).

| Step | current | stress |
|---|---|---|
| `GET /api/fleet-eta` (cache miss; 1 h edge cache) | 1 row | 1 row |
| `POST /api/fare-reports` | 4 rows | 4 rows |
| Daily job, Austin | 1,135 rows | 10,784 rows |
| Daily job, Dallas | 366 rows | 8,676 rows |
| Projected day, 2,000 views × 2 cities, every view missing the cache, 50 reports | **5,701** | **23,660** |

Realistic (cache hits): the page reads at most 2 rows per edge location per hour, so a day is about 1.5k (current) to 20k (stress) rows, almost all from the daily job. The budget is 50,000; the target 5,000.

For comparison, the existing `GET /api/fleet-stats` live count reads **3,128 rows per call at "current" size and 121,129 at "stress"**, on every 5-minute edge-cache miss. The Fleet ETA page no longer calls it; the homepage and Zones still do.

Remote, read-only check of the daily job's reads against a real database: `node scripts/measure-fleet-eta-reads.mjs --remote wrangler.preview.jsonc` (SELECTs only; prints counts, never rows).

**CPU.** One city's model takes about 4 ms of CPU (Node, 100 rides + 20 reports), 14 ms (500 + 100) and about 30–40 ms at the read caps (3,000 rides + 1,000 reports). That is above the Workers Free plan's 10 ms guideline once a city has a few hundred rides; each cron run handles one city to halve it. Watch the cron's CPU time in the Cloudflare dashboard; `MAX_FARE_OBS` (fleet-eta-model.js) and `RIDES_READ_CAP` / `REPORTS_READ_CAP` (fleet-eta.js) are the levers.

## Limitations

- No live Tesla pricing, dispatch or availability data exists or is used; every number is an estimate.
- Waits rest entirely on rider reports (none yet) or, in Austin, on a handful of published anecdotes.
- Neighborhood precision needs reports per area; until then everything is citywide.
- Traffic, weather and events are not modeled: no free, reliable source with a demonstrated link to pickup times was available, and none was added.
- Screenshot evidence for reports is not collected (needs an upload path with PII redaction; the R2 evidence bucket and the sighting upload flow are the starting point).
- Vehicle type for logged rides is only known when the registry vehicle has a model; most receipts don't say.
- Dallas service hours: the site shows 6 AM–11 PM (owner-confirmed); RobotaxiTracker lists 6 AM–10 PM.
- The Austin/Dallas Model Y counts (114 / 65) on the fleet mix are still the owner's fixed figures; RobotaxiTracker lists ~170 / 67.
